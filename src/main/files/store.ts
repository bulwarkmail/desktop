/**
 * What main keeps about files roots between runs: the folders the user picked, and the sync
 * engine's own record of each root (`loadState`/`saveState`). One folder of the app's,
 * private to this user: `roots.json` and `state/<root id>.json`. No Electron here, so tests
 * can use it on a temporary folder.
 *
 * Only ever the app's own files. Removing a root, a wipe or the policy take these, never
 * anything in the folders the user picked.
 */

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { removeOwn } from '../remove-tree';

export interface StoredFolderRoot {
  id: string;
  account: string;
  /** The page's origin: an account id means something only there. */
  origin: string;
  /** Resolved when it was picked. */
  dir: string;
  remoteId: string | null;
  remoteLabel: string;
  paused: boolean;
  createdAt: number;
}

const ROOT_ID = /^[A-Za-z0-9_-]{8,64}$/;
/** The engine's record of a big tree is big, but not this big. */
export const MAX_STATE_CHARS = 128 * 1024 * 1024;

export function validRootId(id: unknown): id is string {
  return typeof id === 'string' && ROOT_ID.test(id);
}

function validStored(value: unknown): value is StoredFolderRoot {
  const root = value as StoredFolderRoot;
  return !!root && typeof root === 'object'
    && validRootId(root.id)
    && typeof root.account === 'string' && root.account.length > 0
    && typeof root.origin === 'string'
    && typeof root.dir === 'string' && path.isAbsolute(root.dir)
    && (root.remoteId === null || typeof root.remoteId === 'string')
    && typeof root.remoteLabel === 'string'
    && typeof root.paused === 'boolean'
    && typeof root.createdAt === 'number';
}

export class FolderRootStore {
  private chain: Promise<unknown> = Promise.resolve();
  private privateReady: Promise<boolean> | null = null;

  constructor(
    readonly folder: string,
    /** Makes the folder this user's only (os-edit.ts). True once it is. */
    private readonly makePrivate: (folder: string) => Promise<boolean> = async (folder) => {
      await mkdir(folder, { recursive: true, mode: 0o700 });
      return true;
    },
  ) {}

  private get rootsFile(): string {
    return path.join(this.folder, 'roots.json');
  }

  stateFile(id: string): string {
    if (!validRootId(id)) throw new Error('Not a root id');
    return path.join(this.folder, 'state', `${id}.json`);
  }

  /** One change at a time: two saves of the list mustn't cross. */
  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => {});
    return next;
  }

  private async ready(): Promise<void> {
    this.privateReady ??= this.makePrivate(this.folder);
    if (!(await this.privateReady)) {
      this.privateReady = null;
      throw new Error('The folder for files sync could not be made private');
    }
  }

  /** Temp and rename: a crash mid-write leaves the old file. */
  private async writeAtomic(file: string, text: string): Promise<void> {
    await this.ready();
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
    try {
      await writeFile(temp, text, { mode: 0o600 });
      await rename(temp, file);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  private async readAll(): Promise<StoredFolderRoot[]> {
    try {
      const parsed = JSON.parse(await readFile(this.rootsFile, 'utf8')) as { roots?: unknown };
      return Array.isArray(parsed.roots) ? parsed.roots.filter(validStored) : [];
    } catch {
      // None yet, or cut off: as good as none. The folders themselves are untouched.
      return [];
    }
  }

  private writeAll(roots: StoredFolderRoot[]): Promise<void> {
    return this.writeAtomic(this.rootsFile, JSON.stringify({ roots }));
  }

  /** Every origin's. */
  list(): Promise<StoredFolderRoot[]> {
    return this.serial(() => this.readAll());
  }

  add(root: StoredFolderRoot): Promise<void> {
    return this.serial(async () => this.writeAll([...(await this.readAll()).filter((other) => other.id !== root.id), root]));
  }

  update(id: string, patch: Partial<Pick<StoredFolderRoot, 'paused' | 'remoteLabel'>>): Promise<void> {
    return this.serial(async () => {
      const all = await this.readAll();
      if (!all.some((root) => root.id === id)) return;
      await this.writeAll(all.map((root) => (root.id === id ? { ...root, ...patch } : root)));
    });
  }

  /** Those that match go, with their state files. Answers which went. */
  removeWhere(match: (root: StoredFolderRoot) => boolean): Promise<StoredFolderRoot[]> {
    return this.serial(async () => {
      const all = await this.readAll();
      const gone = all.filter(match);
      if (gone.length > 0) await this.writeAll(all.filter((root) => !match(root)));
      for (const root of gone) await rm(this.stateFile(root.id), { force: true });
      return gone;
    });
  }

  loadState(id: string): Promise<string | null> {
    return this.serial(async () => {
      try {
        return await readFile(this.stateFile(id), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    });
  }

  saveState(id: string, state: string): Promise<void> {
    if (state.length > MAX_STATE_CHARS) return Promise.reject(new Error('Too large'));
    return this.serial(() => this.writeAtomic(this.stateFile(id), state));
  }

  removeState(id: string): Promise<void> {
    return this.serial(() => rm(this.stateFile(id), { force: true }));
  }

  /** Everything here, for a wipe. */
  removeAll(): Promise<void> {
    return this.serial(async () => {
      // Never through a link someone put in it (remove-tree.ts).
      removeOwn(this.folder);
      this.privateReady = null;
    });
  }
}
