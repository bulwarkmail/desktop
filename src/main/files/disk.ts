/**
 * What the page's sync engine does on the disk, inside one root: scan, stat, write, mkdir,
 * move, remove. No Electron here, so tests can run it against temporary folders.
 *
 * Every path is checked twice: `splitRelative` for its form, then realpath for links. A
 * link or junction anywhere on the way, the last part included, is `outside`: a page that
 * could reach through one could read or overwrite anything this user can. A scan skips them.
 *
 * Nothing here calls the disk synchronously: a root can be on a slow disk, and main must
 * not wait for one. Each answer goes by what the disk says now, not by what main saw
 * before: the user can change anything at any time.
 *
 * Writing goes to a temporary file next to the target (`.bulwark-sync-…`), so a cut-off
 * download never looks like the file, and a commit puts it in place only if the target is
 * still what the page expected. With nothing expected, a hard link puts it there, which
 * fails if something appeared meanwhile. Elsewhere the check and the rename are two steps.
 */

import { randomBytes } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, rename, rm, statfs, unlink, utimes, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import type { FilesError, FilesExpect, FilesLocalEntry, FilesResult } from '../../shared/bridge';
import { removeTree } from '../remove-tree';
import { comparable, isTempName, joinRelative, splitRelative, TEMP_PREFIX } from './paths';
import type { RegisteredRoot } from './registry';

/** Writes going at once. An engine that leaks them gets `busy`, not a full disk of temporary files. */
const MAX_WRITES = 32;
/** How many folders a scan reads at once. */
const SCAN_PARALLEL = 8;

export const ok = <T>(value: T): FilesResult<T> => ({ ok: true, value });
export const fail = <T = never>(error: FilesError): FilesResult<T> => ({ ok: false, error });

export function errorOf(error: unknown, platform: NodeJS.Platform = process.platform): FilesError {
  switch ((error as NodeJS.ErrnoException)?.code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return 'missing';
    case 'EEXIST':
    case 'ENOTEMPTY':
      return 'exists';
    case 'EBUSY':
    case 'ETXTBSY':
      return 'busy';
    // On Windows mostly a file another program has open without letting others delete it.
    case 'EPERM':
      return platform === 'win32' ? 'busy' : 'denied';
    case 'EACCES':
    case 'EROFS':
      return 'denied';
    case 'ENOSPC':
    case 'EDQUOT':
    case 'EFBIG':
      return 'full';
    case 'ENAMETOOLONG':
    case 'EILSEQ':
      return 'name';
    default:
      return 'failed';
  }
}

/** Microseconds first: nanoseconds since 1970 don't fit a double, and a whole millisecond should stay whole. */
export function mtimeMsOf(stats: BigIntStats): number {
  return Number(stats.mtimeNs / 1000n) / 1000;
}

export function fileIdOf(stats: BigIntStats): string {
  return `${stats.dev}:${stats.ino}`;
}

export function entryOf(relative: string, stats: BigIntStats, placeholder?: FilesLocalEntry['placeholder']): FilesLocalEntry {
  const directory = stats.isDirectory();
  return {
    path: relative,
    kind: directory ? 'directory' : 'file',
    // A folder's own size means nothing alike on any two systems.
    size: directory ? 0 : Number(stats.size),
    mtimeMs: mtimeMsOf(stats),
    fileId: fileIdOf(stats),
    ...(placeholder ? { placeholder } : {}),
  };
}

export function validExpect(value: unknown): value is FilesExpect {
  const expect = value as FilesExpect;
  return !!expect && typeof expect === 'object' && typeof expect.fileId === 'string' && Number.isFinite(expect.size) && Number.isFinite(expect.mtimeMs);
}

/**
 * Whether what's at a path now is what the page expected. For a write `null` means nothing may
 * be there (`exists`); for a move or a remove the caller doesn't ask when there's no `expect`.
 */
export function expectProblem(current: BigIntStats | null, expect: FilesExpect | null): FilesError | null {
  if (expect === null) return current ? 'exists' : null;
  if (!current) return 'changed';
  return fileIdOf(current) === expect.fileId && (current.isDirectory() ? 0 : Number(current.size)) === expect.size && mtimeMsOf(current) === expect.mtimeMs ? null : 'changed';
}

export interface Resolved {
  absolute: string;
  /** Null: nothing there yet (its folder is). */
  stats: BigIntStats | null;
  parts: string[];
}

interface Write {
  id: string;
  rootId: string;
  parts: string[];
  absolute: string;
  temp: string;
  handle: FileHandle;
  size: number;
  written: number;
  expect: FilesExpect | null;
  mtimeMs: number;
  queue: Promise<void>;
  failed: FilesError | null;
  touchedAt: number;
  closing: boolean;
}

export interface DiskOptions {
  platform?: NodeJS.Platform;
  /** The root as it is now, or null when it's gone. A commit looks again. */
  rootOf: (id: string) => RegisteredRoot | null;
  /** The OS's trash, for a folder root's files. Throws when it can't. */
  trash?: (absolute: string) => Promise<void>;
  now?: () => number;
}

export class FilesDisk {
  private readonly writes = new Map<string, Write>();
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;

  constructor(private readonly options: DiskOptions) {
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? Date.now;
  }

  private same(a: string, b: string): boolean {
    return comparable(a, this.platform) === comparable(b, this.platform);
  }

  /** The root's own folder: still there, and still no link. */
  private async rootProblem(root: RegisteredRoot): Promise<FilesError | null> {
    if (root.root.paused) return 'inactive';
    try {
      return this.same(await realpath(root.dir), root.dir) ? null : 'inactive';
    } catch {
      return 'inactive';
    }
  }

  /**
   * Where a relative path is, checked: no link on the way, the last part included. With
   * nothing there, its folder must be there and be a real folder in the root.
   */
  async resolve(root: RegisteredRoot, relative: unknown, allowRoot = false): Promise<FilesResult<Resolved>> {
    const split = splitRelative(relative, this.platform, allowRoot);
    if (!split.ok) return fail(split.error);
    const problem = await this.rootProblem(root);
    if (problem) return fail(problem);
    const { parts } = split;
    const absolute = path.join(root.dir, ...parts);
    try {
      const stats = await lstat(absolute, { bigint: true });
      if (stats.isSymbolicLink()) return fail('outside');
      // A link further up: lstat went through it, realpath says where to.
      if (!this.same(await realpath(absolute), absolute)) return fail('outside');
      return ok({ absolute, stats, parts });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') return fail(code === 'ENOTDIR' ? 'missing' : errorOf(error, this.platform));
    }
    const parent = path.dirname(absolute);
    try {
      const stats = await lstat(parent, { bigint: true });
      if (stats.isSymbolicLink()) return fail('outside');
      if (!stats.isDirectory()) return fail('missing');
      if (!this.same(await realpath(parent), parent)) return fail('outside');
    } catch (error) {
      return fail(errorOf(error, this.platform));
    }
    return ok({ absolute, stats: null, parts });
  }

  private placeholderOf(root: RegisteredRoot, absolute: string): FilesLocalEntry['placeholder'] {
    return root.placeholderState?.(absolute) ?? undefined;
  }

  async stat(root: RegisteredRoot, relative: unknown): Promise<FilesResult<FilesLocalEntry | null>> {
    const found = await this.resolve(root, relative, true);
    if (!found.ok) return found.error === 'missing' ? ok(null) : found;
    const { stats, absolute, parts } = found.value;
    return ok(stats ? entryOf(joinRelative(parts), stats, this.placeholderOf(root, absolute)) : null);
  }

  /**
   * Everything under a folder, without links and without main's own temporary files. A folder
   * that can't be read fails the whole scan: leaving it out would read as everything in it
   * deleted.
   */
  async scan(root: RegisteredRoot, under: unknown = ''): Promise<FilesResult<FilesLocalEntry[]>> {
    const found = await this.resolve(root, under ?? '', true);
    if (!found.ok) return found;
    const { stats, absolute, parts } = found.value;
    if (!stats) return fail('missing');
    if (!stats.isDirectory()) return ok([entryOf(joinRelative(parts), stats, this.placeholderOf(root, absolute))]);
    const entries: FilesLocalEntry[] = [];
    const walked = await this.walk(absolute, parts, async (child, childParts, childStats) => {
      entries.push(entryOf(joinRelative(childParts), childStats, this.placeholderOf(root, child)));
    });
    return walked ? fail(walked) : ok(entries);
  }

  /** Every file and folder below, links and temporary files left out. Answers the first error. */
  private async walk(
    start: string,
    startParts: string[],
    visit: (absolute: string, parts: string[], stats: BigIntStats) => Promise<void>,
    options: { temps?: (absolute: string) => Promise<void>; links?: () => void } = {},
  ): Promise<FilesError | null> {
    const queue: { absolute: string; parts: string[] }[] = [{ absolute: start, parts: startParts }];
    let problem: FilesError | null = null;
    const readOne = async (folder: { absolute: string; parts: string[] }) => {
      let names: import('node:fs').Dirent[];
      try {
        names = await readdir(folder.absolute, { withFileTypes: true });
      } catch (error) {
        // Gone while this looked: it's as good as listed.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') problem ??= errorOf(error, this.platform);
        return;
      }
      for (const dirent of names) {
        const absolute = path.join(folder.absolute, dirent.name);
        if (isTempName(dirent.name)) {
          if (options.temps && !dirent.isDirectory()) await options.temps(absolute);
          continue;
        }
        // Not the entry's type: on Windows it calls every reparse point a link, the drive's
        // placeholders too. lstat below reads the tag and knows a link from a placeholder.
        let stats: BigIntStats;
        try {
          stats = await lstat(absolute, { bigint: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') problem ??= errorOf(error, this.platform);
          continue;
        }
        if (stats.isSymbolicLink()) {
          options.links?.();
          continue;
        }
        if (!stats.isFile() && !stats.isDirectory()) continue;
        const parts = [...folder.parts, dirent.name];
        await visit(absolute, parts, stats);
        if (stats.isDirectory()) queue.push({ absolute, parts });
      }
    };
    const running = new Set<Promise<void>>();
    while ((queue.length > 0 || running.size > 0) && !problem) {
      while (queue.length > 0 && running.size < SCAN_PARALLEL) {
        const next = readOne(queue.shift()!).finally(() => running.delete(next));
        running.add(next);
      }
      if (running.size > 0) await Promise.race(running);
    }
    await Promise.all(running);
    return problem;
  }

  /** `.bulwark-sync-…` files a crash left, outside any write going on now. Answers how many went, -1 when the root isn't there. */
  async cleanTemps(root: RegisteredRoot): Promise<number> {
    if (await this.rootProblem({ ...root, root: { ...root.root, paused: false } })) return -1;
    const active = new Set([...this.writes.values()].map((write) => comparable(write.temp, this.platform)));
    let removed = 0;
    await this.walk(root.dir, [], async () => {}, {
      temps: async (absolute) => {
        if (active.has(comparable(absolute, this.platform))) return;
        try {
          await rm(absolute, { force: true });
          removed += 1;
        } catch {
          // Held by a scanner for a moment: the next start.
        }
      },
    });
    return removed;
  }

  async mkdir(root: RegisteredRoot, relative: unknown): Promise<FilesResult<FilesLocalEntry>> {
    const found = await this.resolve(root, relative);
    if (!found.ok) return found;
    const { absolute, stats, parts } = found.value;
    if (stats) return stats.isDirectory() ? ok(entryOf(joinRelative(parts), stats)) : fail('exists');
    try {
      await mkdir(absolute);
      return ok(entryOf(joinRelative(parts), await lstat(absolute, { bigint: true })));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const now = await lstat(absolute, { bigint: true }).catch(() => null);
        if (now?.isDirectory() && !now.isSymbolicLink()) return ok(entryOf(joinRelative(parts), now));
      }
      return fail(errorOf(error, this.platform));
    }
  }

  /** Never over something else. Onto itself under another case is a case-only rename, which a case-insensitive disk allows. */
  async move(root: RegisteredRoot, from: unknown, to: unknown, expect: unknown): Promise<FilesResult<FilesLocalEntry>> {
    if (expect !== null && expect !== undefined && !validExpect(expect)) return fail('failed');
    const source = await this.resolve(root, from);
    if (!source.ok) return source;
    if (!source.value.stats) return fail('missing');
    if (expect && expectProblem(source.value.stats, expect as FilesExpect)) return fail('changed');
    const target = await this.resolve(root, to);
    if (!target.ok) return target;
    const { absolute, parts } = target.value;
    if (target.value.stats) {
      const sameFile = fileIdOf(target.value.stats) === fileIdOf(source.value.stats);
      if (!sameFile) return fail('exists');
      // The same name exactly: nothing to do.
      if (source.value.absolute === absolute) return ok(entryOf(joinRelative(parts), target.value.stats));
    }
    if (source.value.stats.isDirectory() && this.inside(source.value.absolute, absolute)) return fail('failed');
    try {
      await rename(source.value.absolute, absolute);
      return ok(entryOf(joinRelative(parts), await lstat(absolute, { bigint: true })));
    } catch (error) {
      return fail(errorOf(error, this.platform));
    }
  }

  private inside(folder: string, target: string): boolean {
    const relative = path.relative(comparable(folder, this.platform), comparable(target, this.platform));
    return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
  }

  /**
   * A folder root's file or folder goes to the OS's trash, and to a plain delete when there's
   * none or it refused (`deleted` says which). A folder with a link anywhere in it is refused:
   * a delete must never reach through one.
   */
  async remove(root: RegisteredRoot, relative: unknown, expect: unknown): Promise<FilesResult<'trash' | 'deleted'>> {
    if (relative === '') return fail('denied');
    if (expect !== null && expect !== undefined && !validExpect(expect)) return fail('failed');
    const found = await this.resolve(root, relative);
    if (!found.ok) return found;
    const { absolute, stats } = found.value;
    if (!stats) return fail('missing');
    if (expect && expectProblem(stats, expect as FilesExpect)) return fail('changed');
    if (stats.isDirectory()) {
      let links = 0;
      const walked = await this.walk(absolute, [], async () => {}, { links: () => { links += 1; } });
      if (links > 0) return fail('outside');
      if (walked) return fail(walked);
    }
    if (root.root.kind === 'folder' && this.options.trash) {
      try {
        await this.options.trash(absolute);
        return ok('trash');
      } catch {
        // No trash on that disk, or it said no: deleted, and the answer says so.
      }
    }
    try {
      // A folder never through a link, whatever came in since the walk above (remove-tree.ts).
      if (stats.isDirectory()) removeTree(absolute, { root: root.dir, tries: 3 });
      else await rm(absolute, { force: false, maxRetries: 2, retryDelay: 100 });
      return ok('deleted');
    } catch (error) {
      return fail(errorOf(error, this.platform));
    }
  }

  async beginWrite(root: RegisteredRoot, relative: unknown, options: unknown): Promise<FilesResult<string>> {
    const { expect = null, mtimeMs, size } = (options ?? {}) as { expect?: unknown; mtimeMs?: unknown; size?: unknown };
    if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) return fail('failed');
    if (typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs) || mtimeMs < 0) return fail('failed');
    if (expect !== null && !validExpect(expect)) return fail('failed');
    if (this.writes.size >= MAX_WRITES) return fail('busy');
    const found = await this.resolve(root, relative);
    if (!found.ok) return found;
    const { absolute, stats, parts } = found.value;
    if (stats?.isDirectory()) return fail('exists');
    const problem = expectProblem(stats, expect as FilesExpect | null);
    if (problem) return fail(problem);
    const folder = path.dirname(absolute);
    try {
      const space = await statfs(folder, { bigint: true });
      if (space.bavail * space.bsize < BigInt(size)) return fail('full');
    } catch {
      // Not every disk says: the write finds out.
    }
    const temp = path.join(folder, `${TEMP_PREFIX}${randomBytes(8).toString('hex')}`);
    let handle: FileHandle;
    try {
      handle = await open(temp, 'wx');
    } catch (error) {
      return fail(errorOf(error, this.platform));
    }
    const id = randomBytes(16).toString('base64url');
    this.writes.set(id, {
      id, rootId: root.root.id, parts, absolute, temp, handle, size, written: 0,
      expect: expect as FilesExpect | null, mtimeMs, queue: Promise.resolve(), failed: null, touchedAt: this.now(), closing: false,
    });
    return ok(id);
  }

  async writeChunk(id: unknown, data: unknown): Promise<FilesResult<null>> {
    const write = typeof id === 'string' ? this.writes.get(id) : undefined;
    if (!write || write.closing) return fail('missing');
    if (!(data instanceof Uint8Array)) return fail('failed');
    write.touchedAt = this.now();
    write.queue = write.queue.then(async () => {
      if (write.failed) return;
      if (write.written + data.byteLength > write.size) {
        write.failed = 'failed';
        return;
      }
      let done = 0;
      while (done < data.byteLength) {
        const { bytesWritten } = await write.handle.write(data, done, data.byteLength - done, write.written + done);
        done += bytesWritten;
      }
      write.written += done;
    }).catch((error: unknown) => {
      write.failed ??= errorOf(error, this.platform);
    });
    await write.queue;
    if (write.failed) {
      const failed = write.failed;
      await this.abortWrite(id);
      return fail(failed);
    }
    return ok(null);
  }

  async commitWrite(id: unknown): Promise<FilesResult<FilesLocalEntry>> {
    const write = typeof id === 'string' ? this.writes.get(id) : undefined;
    if (!write || write.closing) return fail('missing');
    write.closing = true;
    try {
      await write.queue;
      if (write.failed) return fail(write.failed);
      if (write.written !== write.size) return fail('failed');
      try {
        await write.handle.sync();
        await write.handle.close();
        await utimes(write.temp, new Date(this.now()), write.mtimeMs / 1000);
      } catch (error) {
        return fail(errorOf(error, this.platform));
      }
      const root = this.options.rootOf(write.rootId);
      if (!root) return fail('inactive');
      const found = await this.resolve(root, joinRelative(write.parts));
      if (!found.ok) return found;
      const { absolute, stats, parts } = found.value;
      if (stats?.isDirectory()) return fail('exists');
      const problem = expectProblem(stats, write.expect);
      if (problem) return fail(problem);
      try {
        await this.putInPlace(write, absolute);
      } catch (error) {
        return fail(errorOf(error, this.platform));
      }
      return ok(entryOf(joinRelative(parts), await lstat(absolute, { bigint: true })));
    } finally {
      this.writes.delete(write.id);
      await write.handle.close().catch(() => {});
      await rm(write.temp, { force: true }).catch(() => {});
    }
  }

  /**
   * Nothing expected: a hard link, which fails if a file came meanwhile, then the temporary
   * name goes. A disk without hard links (FAT, a sync root) gets the check and the rename.
   */
  private async putInPlace(write: Write, absolute: string): Promise<void> {
    if (write.expect !== null) {
      await rename(write.temp, absolute);
      return;
    }
    try {
      await link(write.temp, absolute);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') throw error;
      if (await lstat(absolute).then(() => true, () => false)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
      await rename(write.temp, absolute);
      return;
    }
    // A second name of the same file: if it stays, it's a temporary name, and goes at the next start.
    await unlink(write.temp).catch(() => {});
  }

  async abortWrite(id: unknown): Promise<void> {
    const write = typeof id === 'string' ? this.writes.get(id) : undefined;
    if (!write || write.closing) return;
    write.closing = true;
    this.writes.delete(write.id);
    await write.queue.catch(() => {});
    await write.handle.close().catch(() => {});
    await rm(write.temp, { force: true }).catch(() => {});
  }

  async abortWrites(filter: (rootId: string) => boolean = () => true): Promise<void> {
    await Promise.all([...this.writes.values()].filter((write) => filter(write.rootId)).map((write) => this.abortWrite(write.id)));
  }

  /** Writes nobody touched for this long: the page that started them is gone. */
  async abortIdle(maxIdleMs: number): Promise<void> {
    const before = this.now() - maxIdleMs;
    await Promise.all([...this.writes.values()].filter((write) => write.touchedAt < before).map((write) => this.abortWrite(write.id)));
  }

  /** For tests. */
  get writeCount(): number {
    return this.writes.size;
  }
}
