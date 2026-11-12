// Files on this computer, main's disk side, with no Electron: paths, which folders may be a
// root, the disk calls against temporary folders, the watcher's batches, the read URLs, and
// what removing, the policy and a wipe take. Only temporary folders.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { FilesExpect, FilesLocalEntry, FilesResult } from '../src/shared/bridge';
import { FilesDisk } from '../src/main/files/disk';
import { FolderRoots } from '../src/main/files/folder-roots';
import { isLockFileName, overlapReason, splitRelative, systemFolders, TEMP_PREFIX, type OverlapRules } from '../src/main/files/paths';
import { FilesReadGrants } from '../src/main/files/read-grants';
import { filesRegistry, type RegisteredRoot } from '../src/main/files/registry';
import { FolderRootStore } from '../src/main/files/store';
import { RootWatcher, type Timers, type WatchHandle } from '../src/main/files/watcher';

const value = <T>(result: FilesResult<T>): T => {
  if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
  return result.value;
};
const errorOf = <T>(result: FilesResult<T>) => (result.ok ? 'ok' : result.error);
const expectOf = (entry: FilesLocalEntry): FilesExpect => ({ fileId: entry.fileId, size: entry.size, mtimeMs: entry.mtimeMs });

const made: string[] = [];
function tempFolder(name: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `bw-ff-${name}-`));
  made.push(dir);
  return dir;
}

test.afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

function rootAt(dir: string, kind: 'folder' | 'drive' = 'folder', id = `root${Math.random().toString(36).slice(2, 10)}`): RegisteredRoot {
  return { root: { id, kind, account: 'acct-1', path: dir, remoteId: null, remoteLabel: 'Files', paused: false, createdAt: 0 }, dir };
}

function diskFor(root: RegisteredRoot, trashed: string[] = [], trash?: (absolute: string) => Promise<void>): FilesDisk {
  return new FilesDisk({
    rootOf: (id) => (id === root.root.id ? root : null),
    trash: trash ?? (async (absolute) => {
      trashed.push(absolute);
      rmSync(absolute, { recursive: true, force: true });
    }),
  });
}

async function writeFile(disk: FilesDisk, root: RegisteredRoot, relative: string, text: string, expectNow: FilesExpect | null = null, mtimeMs = 1_700_000_000_123): Promise<FilesResult<FilesLocalEntry>> {
  const bytes = new TextEncoder().encode(text);
  const begun = await disk.beginWrite(root, relative, { expect: expectNow, mtimeMs, size: bytes.byteLength });
  if (!begun.ok) return begun;
  const half = Math.floor(bytes.byteLength / 2);
  value(await disk.writeChunk(begun.value, bytes.subarray(0, half)));
  value(await disk.writeChunk(begun.value, bytes.subarray(half)));
  return disk.commitWrite(begun.value);
}

const tempsIn = (dir: string) => readdirSync(dir).filter((name) => name.startsWith(TEMP_PREFIX));

test.describe('paths the page names', () => {
  test('a path that leaves the root, or blurs it, is outside', () => {
    for (const bad of ['..', '../x', 'a/../../x', 'a/./b', 'a//b', '/etc/passwd', 'C:/Windows', 'c:x', 'a/']) {
      expect(splitRelative(bad, 'win32'), bad).toEqual({ ok: false, error: 'outside' });
    }
    expect(splitRelative('a\\..\\..\\x', 'win32')).toEqual({ ok: false, error: 'outside' });
    expect(splitRelative('', 'win32')).toEqual({ ok: false, error: 'outside' });
    expect(splitRelative('', 'win32', true)).toEqual({ ok: true, parts: [] });
  });

  test('a name Windows can\'t hold is refused there and fine elsewhere; main\'s temporary names never', () => {
    for (const bad of ['a:b', 'what?', 'CON', 'con.txt', 'LPT1.doc', 'trailing.', 'trailing ', 'x|y']) {
      expect(splitRelative(`docs/${bad}`, 'win32'), bad).toEqual({ ok: false, error: 'name' });
    }
    expect(splitRelative('docs/what?', 'linux')).toEqual({ ok: true, parts: ['docs', 'what?'] });
    expect(splitRelative(`docs/${TEMP_PREFIX}abc`, 'linux')).toEqual({ ok: false, error: 'name' });
    expect(splitRelative('Größe/Bericht (2).pdf', 'win32')).toEqual({ ok: true, parts: ['Größe', 'Bericht (2).pdf'] });
    expect(splitRelative(42, 'win32')).toEqual({ ok: false, error: 'name' });
  });

  test('lock files are told apart from documents', () => {
    expect(isLockFileName('~$Report.docx')).toBe(true);
    expect(isLockFileName('~WRL0001.tmp')).toBe(true);
    expect(isLockFileName('.~lock.Report.odt#')).toBe(true);
    expect(isLockFileName('Report.docx')).toBe(false);
  });
});

test.describe('which folders may be a root', () => {
  const home = 'C:\\Users\\ann';
  const env = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', ProgramData: 'C:\\ProgramData', APPDATA: `${home}\\AppData\\Roaming`, LOCALAPPDATA: `${home}\\AppData\\Local`, PUBLIC: 'C:\\Users\\Public' };
  const rules = (extra: Partial<OverlapRules> = {}): OverlapRules => ({
    platform: 'win32',
    home,
    appFolders: [`${home}\\AppData\\Roaming\\Bulwark`, 'C:\\Program Files\\Bulwark', `${home}\\Bulwark Files`],
    ...systemFolders('win32', env, home),
    roots: [`${home}\\Documents\\Synced`],
    ...extra,
  });

  test('a folder of the user\'s own is fine', () => {
    expect(overlapReason(`${home}\\Pictures\\Holiday`, rules())).toBeNull();
    expect(overlapReason(`${home}\\Documents\\Other`, rules())).toBeNull();
    expect(overlapReason('D:\\Projects', rules())).toBeNull();
    // Inside the app data folders is somebody's choice; the folders themselves aren't.
    expect(overlapReason(`${home}\\AppData\\Local\\Temp\\bw-test`, rules())).toBeNull();
  });

  test('inside or around another root, the drive\'s folder, the app or the profile: overlap', () => {
    expect(overlapReason(`${home}\\Documents\\Synced\\Sub`, rules())).toBe('root');
    expect(overlapReason(`${home}\\documents\\synced`, rules())).toBe('root');
    expect(overlapReason(`${home}\\Documents`, rules())).toBe('root');
    expect(overlapReason(`${home}\\Bulwark Files\\x`, rules())).toBe('app');
    expect(overlapReason(`${home}\\AppData\\Roaming\\Bulwark\\files-sync`, rules())).toBe('app');
    expect(overlapReason('C:\\Program Files\\Bulwark\\resources', rules())).toBe('app');
    expect(overlapReason(home, rules())).toBe('home');
    expect(overlapReason('C:\\Users', rules())).toBe('home');
  });

  test('system folders, whole volumes and network shares: overlap', () => {
    expect(overlapReason('C:\\Windows\\System32', rules())).toBe('system');
    expect(overlapReason('C:\\Program Files (x86)\\Game', rules())).toBe('system');
    expect(overlapReason('C:\\ProgramData', rules())).toBe('system');
    expect(overlapReason(`${home}\\AppData\\Roaming`, rules({ appFolders: [] }))).toBe('system');
    expect(overlapReason(`${home}\\AppData`, rules({ appFolders: [] }))).toBe('system');
    expect(overlapReason('D:\\', rules())).toBe('volume');
    expect(overlapReason('\\\\nas\\share\\Docs', rules())).toBe('network');
    // A mapped drive resolves to its share: the caller resolves first.
    expect(overlapReason('\\\\10.0.0.1\\Daten', rules())).toBe('network');
  });

  test('macOS and Linux have their own system folders', () => {
    const mac = { platform: 'darwin' as const, home: '/Users/ann', appFolders: [], roots: [], ...systemFolders('darwin', {}, '/Users/ann') };
    expect(overlapReason('/Users/ann/Documents/Synced', mac)).toBeNull();
    expect(overlapReason('/Users/ann/Library/Mail', mac)).toBe('system');
    expect(overlapReason('/Applications', mac)).toBe('system');
    expect(overlapReason('/Volumes', mac)).toBe('system');
    const linux = { platform: 'linux' as const, home: '/home/ann', appFolders: [], roots: [], ...systemFolders('linux', {}, '/home/ann') };
    expect(overlapReason('/home/ann/Sync', linux)).toBeNull();
    expect(overlapReason('/etc', linux)).toBe('system');
    expect(overlapReason('/home', linux)).toBe('home');
    expect(overlapReason('/', linux)).toBe('volume');
  });
});

test.describe('on the disk', () => {
  test('a write lands whole, with its time, and leaves no temporary file', async () => {
    const dir = tempFolder('write');
    const root = rootAt(dir);
    const disk = diskFor(root);
    value(await disk.mkdir(root, 'docs'));
    const entry = value(await writeFile(disk, root, 'docs/a.txt', 'hello world'));
    expect(readFileSync(path.join(dir, 'docs', 'a.txt'), 'utf8')).toBe('hello world');
    expect(entry).toMatchObject({ path: 'docs/a.txt', kind: 'file', size: 11 });
    expect(entry.mtimeMs).toBe(1_700_000_000_123);
    expect(tempsIn(path.join(dir, 'docs'))).toEqual([]);
    expect(value(await disk.stat(root, 'docs/a.txt'))).toEqual(entry);
  });

  test('a write never takes what came meanwhile, or what changed since the page looked', async () => {
    const dir = tempFolder('expect');
    const root = rootAt(dir);
    const disk = diskFor(root);
    const bytes = new TextEncoder().encode('from the server');
    // Nothing expected, and the user saves a file of that name while the download runs.
    const begun = value(await disk.beginWrite(root, 'report.txt', { expect: null, mtimeMs: 1000, size: bytes.byteLength }));
    value(await disk.writeChunk(begun, bytes));
    writeFileSync(path.join(dir, 'report.txt'), 'the user\'s');
    expect(errorOf(await disk.commitWrite(begun))).toBe('exists');
    expect(readFileSync(path.join(dir, 'report.txt'), 'utf8')).toBe('the user\'s');
    expect(tempsIn(dir)).toEqual([]);

    // Expected a version, and the user saved another meanwhile.
    const before = value(await disk.stat(root, 'report.txt'))!;
    const second = value(await disk.beginWrite(root, 'report.txt', { expect: expectOf(before), mtimeMs: 1000, size: bytes.byteLength }));
    value(await disk.writeChunk(second, bytes));
    writeFileSync(path.join(dir, 'report.txt'), 'the user\'s, saved again');
    utimesSync(path.join(dir, 'report.txt'), new Date(), new Date(Date.now() + 5000));
    expect(errorOf(await disk.commitWrite(second))).toBe('changed');
    expect(readFileSync(path.join(dir, 'report.txt'), 'utf8')).toBe('the user\'s, saved again');

    // What it expected is still there: replaced.
    const now = value(await disk.stat(root, 'report.txt'))!;
    expect(value(await writeFile(disk, root, 'report.txt', 'from the server', expectOf(now))).size).toBe(bytes.byteLength);
    expect(readFileSync(path.join(dir, 'report.txt'), 'utf8')).toBe('from the server');
    // Up front too: expecting nothing where something is.
    expect(errorOf(await disk.beginWrite(root, 'report.txt', { expect: null, mtimeMs: 1, size: 1 }))).toBe('exists');
    expect(tempsIn(dir)).toEqual([]);
  });

  test('a write past its size is cut off, and an aborted one leaves nothing', async () => {
    const dir = tempFolder('cap');
    const root = rootAt(dir);
    const disk = diskFor(root);
    const begun = value(await disk.beginWrite(root, 'big.bin', { expect: null, mtimeMs: 1, size: 4 }));
    expect(errorOf(await disk.writeChunk(begun, new Uint8Array(5)))).toBe('failed');
    expect(errorOf(await disk.commitWrite(begun))).toBe('missing');
    const short = value(await disk.beginWrite(root, 'short.bin', { expect: null, mtimeMs: 1, size: 4 }));
    value(await disk.writeChunk(short, new Uint8Array(2)));
    expect(errorOf(await disk.commitWrite(short))).toBe('failed');
    const aborted = value(await disk.beginWrite(root, 'gone.bin', { expect: null, mtimeMs: 1, size: 4 }));
    await disk.abortWrite(aborted);
    expect(readdirSync(dir)).toEqual([]);
    expect(disk.writeCount).toBe(0);
  });

  test('a move never overwrites, and a case-only rename works on this disk', async () => {
    const dir = tempFolder('move');
    const root = rootAt(dir);
    const disk = diskFor(root);
    const a = value(await writeFile(disk, root, 'a.txt', 'a'));
    const b = value(await writeFile(disk, root, 'b.txt', 'b'));
    expect(errorOf(await disk.move(root, 'a.txt', 'b.txt', null))).toBe('exists');
    expect(readFileSync(path.join(dir, 'b.txt'), 'utf8')).toBe('b');
    const renamed = value(await disk.move(root, 'a.txt', 'A.txt', expectOf(a)));
    expect(renamed.fileId).toBe(a.fileId);
    if (process.platform !== 'linux') expect(readdirSync(dir).sort()).toEqual(['A.txt', 'b.txt']);
    // Changed since the page looked: refused.
    writeFileSync(path.join(dir, 'b.txt'), 'b, longer now');
    expect(errorOf(await disk.move(root, 'b.txt', 'c.txt', expectOf(b)))).toBe('changed');
    value(await disk.mkdir(root, 'sub'));
    expect(value(await disk.move(root, 'b.txt', 'sub/b.txt', null)).path).toBe('sub/b.txt');
    expect(errorOf(await disk.move(root, 'sub', 'sub/inner', null))).toBe('failed');
  });

  test('remove goes to the trash in a folder root, says when it deleted, and checks first', async () => {
    const dir = tempFolder('remove');
    const root = rootAt(dir);
    const trashed: string[] = [];
    const disk = diskFor(root, trashed);
    const entry = value(await writeFile(disk, root, 'old.txt', 'x'));
    expect(errorOf(await disk.remove(root, 'old.txt', { ...expectOf(entry), size: 2 }))).toBe('changed');
    expect(existsSync(path.join(dir, 'old.txt'))).toBe(true);
    expect(value(await disk.remove(root, 'old.txt', expectOf(entry)))).toBe('trash');
    expect(trashed).toEqual([path.join(dir, 'old.txt')]);
    expect(errorOf(await disk.remove(root, '', null))).toBe('denied');

    const refusing = diskFor(root, [], async () => {
      throw new Error('no trash here');
    });
    value(await writeFile(refusing, root, 'other.txt', 'y'));
    expect(value(await refusing.remove(root, 'other.txt', null))).toBe('deleted');
    expect(existsSync(path.join(dir, 'other.txt'))).toBe(false);

    // The drive's files are never put in the trash.
    const driveRoot = rootAt(dir, 'drive');
    const driveTrashed: string[] = [];
    const driveDisk = diskFor(driveRoot, driveTrashed);
    value(await writeFile(driveDisk, driveRoot, 'placeholder.txt', 'z'));
    expect(value(await driveDisk.remove(driveRoot, 'placeholder.txt', null))).toBe('deleted');
    expect(driveTrashed).toEqual([]);
  });

  test('a link or junction is outside: not listed, not read through, not written or deleted through', async () => {
    const dir = tempFolder('links');
    const elsewhere = tempFolder('elsewhere');
    writeFileSync(path.join(elsewhere, 'secret.txt'), 'not yours');
    mkdirSync(path.join(dir, 'real'));
    writeFileSync(path.join(dir, 'real', 'mine.txt'), 'mine');
    symlinkSync(elsewhere, path.join(dir, 'way-out'), 'junction');
    symlinkSync(elsewhere, path.join(dir, 'real', 'nested-way-out'), 'junction');
    const root = rootAt(dir);
    const disk = diskFor(root);

    const listed = value(await disk.scan(root)).map((entry) => entry.path).sort();
    expect(listed).toEqual(['real', 'real/mine.txt']);
    expect(errorOf(await disk.stat(root, 'way-out'))).toBe('outside');
    expect(errorOf(await disk.stat(root, 'way-out/secret.txt'))).toBe('outside');
    expect(errorOf(await disk.scan(root, 'way-out'))).toBe('outside');
    expect(errorOf(await disk.beginWrite(root, 'way-out/new.txt', { expect: null, mtimeMs: 1, size: 1 }))).toBe('outside');
    expect(errorOf(await disk.mkdir(root, 'way-out/new'))).toBe('outside');
    expect(errorOf(await disk.move(root, 'real/mine.txt', 'way-out/mine.txt', null))).toBe('outside');
    expect(errorOf(await disk.remove(root, 'way-out', null))).toBe('outside');
    // A folder with a junction in it isn't deleted either: that's how a delete reaches through.
    expect(errorOf(await disk.remove(root, 'real', null))).toBe('outside');
    expect(readdirSync(elsewhere)).toEqual(['secret.txt']);
    expect(existsSync(path.join(dir, 'real', 'mine.txt'))).toBe(true);

    // The root itself turned into a junction after it was picked: nothing answers.
    const moved = tempFolder('moved');
    rmSync(moved, { recursive: true });
    symlinkSync(dir, moved, 'junction');
    const swapped = rootAt(moved);
    expect(errorOf(await diskFor(swapped).scan(swapped))).toBe('inactive');
    // Junctions out before the folders go, so no cleanup can follow one.
    for (const link of [moved, path.join(dir, 'way-out'), path.join(dir, 'real', 'nested-way-out')]) unlinkSync(link);
    expect(readdirSync(elsewhere)).toEqual(['secret.txt']);
  });

  test('scans skip main\'s temporary files, and the next start removes those a crash left', async () => {
    const dir = tempFolder('temps');
    const root = rootAt(dir);
    const disk = diskFor(root);
    mkdirSync(path.join(dir, 'deep', 'er'), { recursive: true });
    writeFileSync(path.join(dir, 'deep', 'er', `${TEMP_PREFIX}left-by-a-crash`), 'half a download');
    writeFileSync(path.join(dir, 'keep.txt'), 'keep');
    const active = value(await disk.beginWrite(root, 'deep/now.txt', { expect: null, mtimeMs: 1, size: 3 }));
    expect(value(await disk.scan(root)).map((entry) => entry.path).sort()).toEqual(['deep', 'deep/er', 'keep.txt']);
    expect(await disk.cleanTemps(root)).toBe(1);
    expect(readdirSync(path.join(dir, 'deep', 'er'))).toEqual([]);
    // The write going on now keeps its file.
    expect(tempsIn(path.join(dir, 'deep'))).toHaveLength(1);
    value(await disk.writeChunk(active, new Uint8Array([1, 2, 3])));
    value(await disk.commitWrite(active));
    expect(tempsIn(path.join(dir, 'deep'))).toEqual([]);
    expect(await disk.cleanTemps(rootAt(path.join(dir, 'not-there')))).toBe(-1);
  });

  test('a paused root or one that\'s gone answers inactive', async () => {
    const dir = tempFolder('paused');
    const root = rootAt(dir);
    const disk = diskFor(root);
    expect(errorOf(await disk.scan({ ...root, root: { ...root.root, paused: true } }))).toBe('inactive');
    expect(errorOf(await disk.scan(rootAt(path.join(dir, 'unplugged'))))).toBe('inactive');
  });
});

/** Timers the test moves by hand. */
function manualTimers(): Timers & { advance: (ms: number) => void } {
  let now = 0;
  let next = 1;
  const pending = new Map<number, { at: number; callback: () => void }>();
  return {
    set: (callback, ms) => {
      const id = next++;
      pending.set(id, { at: now + ms, callback });
      return id;
    },
    clear: (handle) => {
      pending.delete(handle as number);
    },
    now: () => now,
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].callback();
      }
      now = until;
    },
  };
}

function fakeWatch() {
  const made: { dir: string; listener: (event: string, file: string | null) => void; errors: ((error: Error) => void)[]; closed: boolean }[] = [];
  let failNext = 0;
  const watch = (dir: string, listener: (event: string, file: string | Buffer | null) => void): WatchHandle => {
    if (failNext > 0) {
      failNext -= 1;
      throw Object.assign(new Error('gone'), { code: 'ENOENT' });
    }
    const handle = { dir, listener: listener as (event: string, file: string | null) => void, errors: [] as ((error: Error) => void)[], closed: false };
    made.push(handle);
    return {
      close: () => {
        handle.closed = true;
      },
      on: (_event: 'error', listener: (error: Error) => void) => handle.errors.push(listener),
    };
  };
  return { watch, made, failNext: (count: number) => (failNext = count) };
}

test.describe('the watcher', () => {
  test('a burst of changes is one batch, without main\'s temporary files or lock files', () => {
    const timers = manualTimers();
    const fake = fakeWatch();
    const batches: (string[] | null)[] = [];
    const watcher = new RootWatcher('C:\\root', (paths) => batches.push(paths), { watch: fake.watch, timers, debounceMs: 300, maxWaitMs: 2000 });
    watcher.start();
    const emit = fake.made[0].listener;
    emit('change', 'docs\\a.txt');
    timers.advance(100);
    emit('rename', 'docs\\a.txt');
    emit('rename', `docs\\${TEMP_PREFIX}1234`);
    emit('change', 'docs\\~$a.docx');
    emit('rename', 'b.txt');
    expect(batches).toEqual([]);
    timers.advance(299);
    expect(batches).toEqual([]);
    timers.advance(1);
    expect(batches).toEqual([['docs/a.txt', 'b.txt']]);
    // Only ignored ones: nothing goes out.
    emit('change', `${TEMP_PREFIX}5678`);
    timers.advance(1000);
    expect(batches).toHaveLength(1);
    watcher.stop();
  });

  test('a folder that never goes quiet still reports within the longest wait', () => {
    const timers = manualTimers();
    const fake = fakeWatch();
    const batches: (string[] | null)[] = [];
    const watcher = new RootWatcher('/root', (paths) => batches.push(paths), { watch: fake.watch, timers, debounceMs: 300, maxWaitMs: 1000 });
    watcher.start();
    for (let i = 0; i < 10; i += 1) {
      fake.made[0].listener('change', `f${i}`);
      timers.advance(200);
    }
    expect(batches.length).toBeGreaterThanOrEqual(1);
    expect(batches[0]).toEqual(['f0', 'f1', 'f2', 'f3', 'f4']);
    watcher.stop();
  });

  test('too many at once, or no name, means scan everything', () => {
    const timers = manualTimers();
    const fake = fakeWatch();
    const batches: (string[] | null)[] = [];
    const watcher = new RootWatcher('/root', (paths) => batches.push(paths), { watch: fake.watch, timers, maxPaths: 3 });
    watcher.start();
    for (const name of ['a', 'b', 'c', 'd']) fake.made[0].listener('change', name);
    timers.advance(5000);
    fake.made[0].listener('change', null);
    timers.advance(5000);
    expect(batches).toEqual([null, null]);
    watcher.stop();
  });

  test('an error says scan everything and watches again, and so does coming back after the folder was away', () => {
    const timers = manualTimers();
    const fake = fakeWatch();
    const batches: (string[] | null)[] = [];
    const watcher = new RootWatcher('/root', (paths) => batches.push(paths), { watch: fake.watch, timers, rearmMs: 1000 });
    watcher.start();
    fake.failNext(2);
    fake.made[0].errors[0](new Error('overflow'));
    expect(fake.made[0].closed).toBe(true);
    expect(batches).toEqual([null]);
    expect(watcher.watching).toBe(false);
    timers.advance(1000);
    timers.advance(2000);
    expect(fake.made).toHaveLength(1);
    timers.advance(4000);
    expect(fake.made).toHaveLength(2);
    expect(watcher.watching).toBe(true);
    expect(batches).toEqual([null, null]);
    fake.made[1].listener('change', 'x');
    timers.advance(1000);
    expect(batches).toEqual([null, null, ['x']]);
    watcher.stop();
    fake.made[1].listener('change', 'y');
    timers.advance(1000);
    expect(batches).toHaveLength(3);
  });

  test('with the real watcher, a file saved in the folder is reported', async () => {
    const dir = tempFolder('watch');
    const batches: (string[] | null)[] = [];
    const watcher = new RootWatcher(dir, (paths) => batches.push(paths), { debounceMs: 100 });
    watcher.start();
    mkdirSync(path.join(dir, 'sub'));
    await new Promise((resolve) => setTimeout(resolve, 200));
    writeFileSync(path.join(dir, 'sub', 'saved.txt'), 'x');
    await expect.poll(() => batches.flat(), { timeout: 10_000 }).toContain('sub/saved.txt');
    watcher.stop();
  });
});

test.describe('read URLs', () => {
  async function setup() {
    const dir = tempFolder('read');
    const root = rootAt(dir);
    const disk = diskFor(root);
    const entry = value(await writeFile(disk, root, 'doc.txt', '0123456789'));
    const grants = new FilesReadGrants('https://app.example', async (_rootId, relative) => {
      const found = await disk.resolve(root, relative);
      return found.ok && found.value.stats ? found.value.absolute : null;
    });
    return { dir, root, disk, entry, grants };
  }
  test('a range comes back once, with CORS for the app only', async () => {
    const { grants, entry } = await setup();
    const url = grants.add('r', entry);
    expect(url).toMatch(/^bulwark-files:\/\/r\/[A-Za-z0-9_-]{43}$/);
    // Request() won't take a custom scheme here: serve() matches the scheme it gets.
    const serve = (target: string, range?: string) => grants.serve({ method: 'GET', url: target, headers: new Headers(range ? { range } : {}) } as unknown as Request);
    const first = await serve(url, 'bytes=2-5');
    expect(first.status).toBe(206);
    expect(await first.text()).toBe('2345');
    expect(first.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(first.headers.get('access-control-allow-origin')).toBe('https://app.example');
    expect((await serve(url, 'bytes=2-5')).status).toBe(404);
    const whole = await serve(grants.add('r', entry));
    expect(whole.status).toBe(200);
    expect(await whole.text()).toBe('0123456789');
    expect((await serve(grants.add('r', entry), 'bytes=20-')).status).toBe(416);
  });

  test('a file that changed after openRead, or a token revoked, is not served', async () => {
    const { grants, entry, dir } = await setup();
    const serve = (target: string) => grants.serve({ method: 'GET', url: target, headers: new Headers() } as unknown as Request);
    const url = grants.add('r', entry);
    writeFileSync(path.join(dir, 'doc.txt'), 'changed!!!!');
    expect((await serve(url)).status).toBe(409);
    const revoked = grants.add('r', entry);
    grants.revokeRoot('r');
    expect((await serve(revoked)).status).toBe(404);
    expect((await serve('bulwark-files://r/not-a-token')).status).toBe(404);
  });
});

test.describe('the folders, the policy and a wipe', () => {
  test.afterEach(() => {
    for (const entry of filesRegistry.list()) filesRegistry.remove(entry.root.id);
  });

  async function world(allowed = { value: true }) {
    const data = tempFolder('data');
    const store = new FolderRootStore(path.join(data, 'files-sync'));
    const disk = new FilesDisk({ rootOf: (id) => filesRegistry.get(id) });
    const grants = new FilesReadGrants('https://app.example', async () => null);
    const folders = new FolderRoots({ store, registry: filesRegistry, disk, grants, origin: 'https://app.example', allowed: () => allowed.value });
    return { data, store, disk, grants, folders, allowed };
  }

  test('a folder is kept across a restart, and removing it keeps its files', async () => {
    const { store, disk, grants, folders } = await world();
    const picked = tempFolder('picked');
    writeFileSync(path.join(picked, 'mine.txt'), 'mine');
    const root = await folders.add(picked, { account: 'acct-1', remoteId: 'node-1', remoteLabel: 'Projects' });
    await store.saveState(root.id, '{"seen":1}');
    for (const entry of filesRegistry.list()) filesRegistry.remove(entry.root.id);

    const again = new FolderRoots({ store, registry: filesRegistry, disk, grants, origin: 'https://app.example', allowed: () => true });
    await again.load();
    expect(filesRegistry.list().map((entry) => entry.root)).toEqual([root]);
    // Another origin's folder isn't this page's.
    const other = new FolderRoots({ store, registry: filesRegistry, disk, grants, origin: 'https://other.example', allowed: () => true });
    for (const entry of filesRegistry.list()) filesRegistry.remove(entry.root.id);
    await other.load();
    expect(filesRegistry.list()).toEqual([]);
    await again.load();

    const write = value(await disk.beginWrite(filesRegistry.get(root.id)!, 'half.txt', { expect: null, mtimeMs: 1, size: 10 }));
    await again.remove([root.id]);
    expect(filesRegistry.list()).toEqual([]);
    expect(await store.list()).toEqual([]);
    expect(await store.loadState(root.id)).toBeNull();
    expect(errorOf(await disk.commitWrite(write))).toBe('missing');
    expect(readdirSync(picked)).toEqual(['mine.txt']);
  });

  test('pausing is kept, and stops writes going on', async () => {
    const { store, disk, folders } = await world();
    const picked = tempFolder('pause');
    const root = await folders.add(picked, { account: 'acct-1', remoteId: null, remoteLabel: 'Files' });
    const write = value(await disk.beginWrite(filesRegistry.get(root.id)!, 'x.txt', { expect: null, mtimeMs: 1, size: 1 }));
    await folders.setPaused(root.id, true);
    expect(filesRegistry.get(root.id)!.root.paused).toBe(true);
    expect((await store.list())[0].paused).toBe(true);
    expect(errorOf(await disk.writeChunk(write, new Uint8Array(1)))).toBe('missing');
    expect(readdirSync(picked)).toEqual([]);
  });

  test('the policy forced off takes every folder root, live and stored, and their records; the files stay', async () => {
    const allowed = { value: true };
    const { store, folders } = await world(allowed);
    const one = tempFolder('pol1');
    const two = tempFolder('pol2');
    writeFileSync(path.join(one, 'a.txt'), 'a');
    const first = await folders.add(one, { account: 'acct-1', remoteId: null, remoteLabel: 'A' });
    await folders.add(two, { account: 'acct-2', remoteId: null, remoteLabel: 'B' });
    await store.saveState(first.id, 'state');
    // Another origin's folder, not listed in this run: the policy is the machine's.
    await store.add({ id: 'other-origin-root', account: 'acct-1', origin: 'https://other.example', dir: tempFolder('pol3'), remoteId: null, remoteLabel: 'C', paused: false, createdAt: 0 });
    const drive = rootAt(tempFolder('drive'), 'drive', 'drive-root-1');
    filesRegistry.add(drive);
    allowed.value = false;
    await folders.applyPolicy();
    expect(filesRegistry.list().map((entry) => entry.root.id)).toEqual(['drive-root-1']);
    expect(await store.list()).toEqual([]);
    expect(await store.loadState(first.id)).toBeNull();
    expect(readFileSync(path.join(one, 'a.txt'), 'utf8')).toBe('a');
    // At the next start too.
    await folders.load();
    expect(filesRegistry.list().map((entry) => entry.root.id)).toEqual(['drive-root-1']);
  });

  test('a wipe of one account takes its roots and records only; a full wipe takes all of them; files stay', async () => {
    const { store, folders, data } = await world();
    const mine = tempFolder('wipe1');
    const theirs = tempFolder('wipe2');
    writeFileSync(path.join(mine, 'keep.txt'), 'keep');
    const a = await folders.add(mine, { account: 'acct-1', remoteId: null, remoteLabel: 'A' });
    const b = await folders.add(theirs, { account: 'acct-2', remoteId: null, remoteLabel: 'B' });
    const drive = rootAt(tempFolder('wdrive'), 'drive', 'drive-root-2');
    filesRegistry.add(drive);
    for (const id of [a.id, b.id, drive.root.id]) await store.saveState(id, `state of ${id}`);

    await folders.wipe('acct-1', 'https://app.example');
    expect(filesRegistry.list().map((entry) => entry.root.id).sort()).toEqual([b.id, 'drive-root-2'].sort());
    expect((await store.list()).map((stored) => stored.id)).toEqual([b.id]);
    expect(await store.loadState(a.id)).toBeNull();
    // The drive root of that account: the drive removes it, its record goes here.
    expect(await store.loadState('drive-root-2')).toBeNull();
    expect(await store.loadState(b.id)).toBe(`state of ${b.id}`);

    await folders.wipe(null, null);
    expect(filesRegistry.list().map((entry) => entry.root.id)).toEqual(['drive-root-2']);
    expect(existsSync(path.join(data, 'files-sync'))).toBe(false);
    expect(readFileSync(path.join(mine, 'keep.txt'), 'utf8')).toBe('keep');
  });

  test("a server's wipe takes its page's folder roots and their records, and leaves another page's", async () => {
    const { store, folders } = await world();
    const mine = tempFolder('own1');
    writeFileSync(path.join(mine, 'keep.txt'), 'keep');
    const a = await folders.add(mine, { account: 'acct-1', remoteId: null, remoteLabel: 'A' });
    const b = await folders.add(tempFolder('own2'), { account: 'acct-2', remoteId: null, remoteLabel: 'B' });
    const other = { id: 'other-origin-root', account: 'acct-1', origin: 'https://other.example', dir: tempFolder('own3'), remoteId: null, remoteLabel: 'C', paused: false, createdAt: 0 };
    await store.add(other);
    for (const id of [a.id, b.id, other.id]) await store.saveState(id, `state of ${id}`);

    // Another page's wipe, from here: this run's roots stay listed, that page's record goes.
    await folders.wipe(null, 'https://other.example');
    expect(filesRegistry.list().map((entry) => entry.root.id).sort()).toEqual([a.id, b.id].sort());
    expect((await store.list()).map((stored) => stored.id).sort()).toEqual([a.id, b.id].sort());
    expect(await store.loadState(other.id)).toBeNull();

    await store.add(other);
    await store.saveState(other.id, 'state of the other');
    await folders.wipe(null, 'https://app.example');
    expect(filesRegistry.list()).toEqual([]);
    expect((await store.list()).map((stored) => stored.id)).toEqual([other.id]);
    expect(await store.loadState(other.id)).toBe('state of the other');
    expect(await store.loadState(a.id)).toBeNull();
    expect(readFileSync(path.join(mine, 'keep.txt'), 'utf8')).toBe('keep');
  });
});
