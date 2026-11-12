import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchStandalone, removeProfile, tempProfile } from './helpers';

/**
 * Files on this computer, the folders side, against the real app: the bridge called as the
 * page's sync engine calls it, from the main window. The folder picker and the OS's trash
 * are stood in for, so nothing opens on this desktop and nothing goes to the user's trash.
 * Only temporary folders.
 */

const POLICY_ROOT = `HKCU\\Software\\BulwarkTest\\Policies\\files${process.pid}`;

interface Answer<T = unknown> { ok: boolean; value?: T; error?: string }
interface Root { id: string; kind: string; account: string; path: string; paused: boolean }
interface Entry { path: string; kind: string; size: number; mtimeMs: number; fileId: string }

let app: ElectronApplication;
let page: Page;
let profile: string;
let base: string;
const junctions: string[] = [];

/** One of the controls, on the page given. Claimed once per document, as the page does. */
function files<T>(target: Page, member: string, ...args: unknown[]): Promise<T> {
  return target.evaluate(async ([name, values]) => {
    const w = window as unknown as { __files?: Record<string, (...a: unknown[]) => unknown> | null; bulwarkDesktop: { files: { claim: () => Record<string, (...a: unknown[]) => unknown> | null } } };
    if (w.__files === undefined) w.__files = w.bulwarkDesktop.files.claim();
    if (!w.__files) throw new Error('claimed already');
    return w.__files[name as string](...(values as unknown as unknown[]));
  }, [member, args] as const) as Promise<T>;
}

/** A real click first, which reaches main as input and no script can make. */
async function clicked<T>(member: string, ...args: unknown[]): Promise<T> {
  await page.mouse.click(5, 300);
  return files<T>(page, member, ...args);
}

async function standIns(target: ElectronApplication): Promise<void> {
  await target.evaluate(({ dialog, shell }) => {
    const g = globalThis as unknown as { __pick: string | null; __picks: number; __trashed: string[]; __shown: string[]; __trashFails: boolean };
    g.__pick = null;
    g.__picks = 0;
    g.__trashed = [];
    g.__shown = [];
    g.__trashFails = false;
    const fs = process.getBuiltinModule('node:fs');
    dialog.showOpenDialog = (async () => {
      g.__picks += 1;
      return g.__pick ? { canceled: false, filePaths: [g.__pick] } : { canceled: true, filePaths: [] };
    }) as typeof dialog.showOpenDialog;
    shell.trashItem = async (file: string) => {
      if (g.__trashFails) throw new Error('no trash');
      g.__trashed.push(file);
      fs.rmSync(file, { recursive: true, force: true });
    };
    shell.showItemInFolder = (file: string) => {
      g.__shown.push(file);
    };
    shell.openPath = async (file: string) => {
      g.__shown.push(file);
      return '';
    };
  });
}

const pick = (folder: string | null) => app.evaluate((_electron, chosen) => {
  (globalThis as unknown as { __pick: string | null }).__pick = chosen;
}, folder);
const mainGlobal = <T>(name: string) => app.evaluate((_electron, key) => (globalThis as unknown as Record<string, unknown>)[key], name) as Promise<T>;

function reg(...args: string[]): void {
  const result = spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`reg ${args.join(' ')}: ${result.stderr}`);
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  test.skip(process.platform !== 'win32', 'junctions and the policy come from Windows here');
  profile = tempProfile('files');
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'bw-files-')));
  ({ app, page } = await launchStandalone(profile, `--bulwark-test-policy-root=${POLICY_ROOT}`, '--bulwark-test-policy-poll=250'));
  await standIns(app);
  // A webmail with the sync engine claims the files bridge in its first render, as it should.
  // These tests play the engine, so they take it in a same-origin document that doesn't.
  await page.goto(new URL('/pst-worker.js', page.url()).toString());
});

test.afterAll(async () => {
  await app?.close().catch(() => {});
  spawnSync('reg.exe', ['delete', POLICY_ROOT, '/f'], { windowsHide: true });
  for (const link of junctions) if (existsSync(link)) unlinkSync(link);
  if (base) rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  if (profile) removeProfile(profile);
});

test('only the main window\'s page is answered', async () => {
  expect(await files<Root[]>(page, 'roots')).toEqual([]);
  const before = app.windows().length;
  await page.evaluate(() => (window as unknown as { bulwarkDesktop: { windows: { open: (url: string, o: object) => void } } }).bulwarkDesktop.windows.open('/', { name: 'second-main', width: 700, height: 500 }));
  await expect.poll(() => app.windows().length, { timeout: 60_000 }).toBeGreaterThan(before);
  const second = app.windows().at(-1)!;
  await second.waitForLoadState('domcontentloaded');
  // The webmail in that window claims the bridge itself, as it should, so its calls are made
  // here as Electron delivers them: from that window's own main frame, through ipc.ts.
  const contentsId = await (await app.browserWindow(second)).evaluate((window) => window.webContents.id);
  const channels: Record<string, string> = { roots: 'bulwark:files.roots', scan: 'bulwark:files.scan', loadState: 'bulwark:files.loadState', addFolder: 'bulwark:files.addFolder' };
  for (const [member, args] of [['roots', []], ['scan', ['any-root-id', '']], ['loadState', ['any-root-id']], ['addFolder', [{ account: 'a', remoteId: null, remoteLabel: 'x' }, true]]] as const) {
    const answer = await app.evaluate(async ({ ipcMain, webContents }, [id, channel, values]) => {
      const contents = webContents.fromId(id as number)!;
      const handler = (ipcMain as unknown as { _invokeHandlers: Map<string, (event: unknown, ...a: unknown[]) => unknown> })._invokeHandlers.get(channel as string)!;
      try {
        await handler({ senderFrame: contents.mainFrame, sender: contents }, ...(values as unknown as unknown[]));
        return 'answered';
      } catch (error) {
        return (error as Error).message;
      }
    }, [contentsId, channels[member], args] as const);
    // Main's own word, not ipc.ts's frame check: the second window is the app's, on its origin.
    expect(answer, member).toContain('files calls come from the main window');
  }
  await second.close();
});

test('adding a folder takes a real click, and the same folder twice overlaps', async () => {
  const sync = path.join(base, 'Sync');
  mkdirSync(sync);
  writeFileSync(path.join(sync, 'already-here.txt'), 'mine');
  await pick(sync);
  const request = { account: 'acct-1', remoteId: 'node-7', remoteLabel: 'Projects' };
  expect(await files<Answer>(page, 'addFolder', request)).toEqual({ ok: false, error: 'gesture' });
  expect(await mainGlobal<number>('__picks')).toBe(0);
  const added = await clicked<Answer<Root>>('addFolder', request);
  expect(added.ok).toBe(true);
  expect(added.value).toMatchObject({ kind: 'folder', account: 'acct-1', path: sync, remoteId: 'node-7', remoteLabel: 'Projects', paused: false });
  // The click went into adding the folder: nothing is left of it to open Explorer with.
  expect(await files<boolean>(page, 'showInFolder', added.value!.id, '')).toBe(false);
  expect(await mainGlobal<string[]>('__shown')).toEqual([]);
  expect((await files<Root[]>(page, 'roots')).map((root) => root.id)).toEqual([added.value!.id]);
  expect(await clicked<Answer>('addFolder', { ...request, account: 'acct-2' })).toEqual({ ok: false, error: 'overlap' });
  mkdirSync(path.join(sync, 'inner'));
  await pick(path.join(sync, 'inner'));
  expect(await clicked<Answer>('addFolder', request)).toEqual({ ok: false, error: 'overlap' });
  await pick(null);
  expect(await clicked<Answer>('addFolder', request)).toEqual({ ok: false, error: 'cancelled' });
  // Kept for the next start, in the app's own folder.
  const stored = JSON.parse(readFileSync(path.join(profile, 'files-sync', 'roots.json'), 'utf8')) as { roots: { id: string; dir: string }[] };
  expect(stored.roots.map((root) => [root.id, root.dir])).toEqual([[added.value!.id, sync]]);
});

test('the folder on this computer first: a click picks it, its Files side comes after without another picker (settings-p3-4)', async () => {
  const docs = path.join(base, 'Docs');
  mkdirSync(docs);
  await pick(docs);
  expect(await files<Answer>(page, 'chooseFolder')).toEqual({ ok: false, error: 'gesture' });
  const chosen = await clicked<Answer<{ token: string; name: string }>>('chooseFolder');
  expect(chosen).toMatchObject({ ok: true, value: { name: 'Docs' } });
  const picks = await mainGlobal<number>('__picks');
  const request = { account: 'acct-3', remoteId: 'n-docs', remoteLabel: 'Docs', chosen: chosen.value!.token };
  // No click needed now: the pick had one.
  const added = await files<Answer<Root>>(page, 'addFolder', request);
  expect(added).toMatchObject({ ok: true, value: { path: docs, remoteId: 'n-docs', account: 'acct-3' } });
  expect(await mainGlobal<number>('__picks')).toBe(picks);
  // A token works once.
  expect(await files<Answer>(page, 'addFolder', request)).toEqual({ ok: false, error: 'gesture' });
  expect(await files<Answer>(page, 'addFolder', { ...request, chosen: 'made-up' })).toEqual({ ok: false, error: 'gesture' });
  await files(page, 'removeRoot', added.value!.id);
});

test('a path through a junction is refused, and a scan leaves the junction out', async () => {
  const [root] = await files<Root[]>(page, 'roots');
  const elsewhere = path.join(base, 'Elsewhere');
  mkdirSync(elsewhere);
  writeFileSync(path.join(elsewhere, 'secret.txt'), 'not in the folder');
  const link = path.join(root.path, 'way-out');
  symlinkSync(elsewhere, link, 'junction');
  junctions.push(link);
  expect(await files<Answer>(page, 'stat', root.id, 'way-out/secret.txt')).toEqual({ ok: false, error: 'outside' });
  expect(await files<Answer>(page, 'openRead', root.id, 'way-out/secret.txt')).toEqual({ ok: false, error: 'outside' });
  expect(await files<Answer>(page, 'beginWrite', root.id, 'way-out/planted.txt', { expect: null, mtimeMs: 1, size: 1 })).toEqual({ ok: false, error: 'outside' });
  expect(await files<Answer>(page, 'remove', root.id, 'way-out', null)).toEqual({ ok: false, error: 'outside' });
  expect(await clicked<Answer>('showInFolder', root.id, 'way-out/secret.txt')).toBe(false);
  const scanned = await files<Answer<Entry[]>>(page, 'scan', root.id);
  expect(scanned.value!.map((entry) => entry.path).sort()).toEqual(['already-here.txt', 'inner']);
  expect(readdirSync(elsewhere)).toEqual(['secret.txt']);
  unlinkSync(link);
});

test('write, read, move and remove go round, and the watcher reports what changed', async () => {
  const [root] = await files<Root[]>(page, 'roots');
  await page.evaluate(() => {
    const w = window as unknown as { __events: unknown[]; __files: { onChange: (listener: (event: unknown) => void) => void } };
    w.__events = [];
    w.__files.onChange((event) => w.__events.push(event));
  });
  expect((await files<Answer<Entry>>(page, 'mkdir', root.id, 'docs')).ok).toBe(true);
  const written = await page.evaluate(async (rootId) => {
    const f = (window as unknown as { __files: Record<string, (...a: unknown[]) => Promise<{ ok: boolean; value?: unknown; error?: string }>> }).__files;
    const bytes = new TextEncoder().encode('hello world');
    const begun = await f.beginWrite(rootId, 'docs/a.txt', { expect: null, mtimeMs: 1_700_000_000_000, size: bytes.byteLength });
    if (!begun.ok) return begun;
    await f.writeChunk(begun.value, bytes.subarray(0, 6));
    await f.writeChunk(begun.value, bytes.subarray(6));
    return f.commitWrite(begun.value);
  }, root.id) as Answer<Entry>;
  expect(written).toMatchObject({ ok: true, value: { path: 'docs/a.txt', size: 11, mtimeMs: 1_700_000_000_000 } });
  expect(readFileSync(path.join(root.path, 'docs', 'a.txt'), 'utf8')).toBe('hello world');
  expect(readdirSync(path.join(root.path, 'docs'))).toEqual(['a.txt']);

  const opened = await files<Answer<{ url: string; entry: Entry }>>(page, 'openRead', root.id, 'docs/a.txt');
  expect(opened.value!.url).toMatch(/^bulwark-files:\/\/r\//);
  const read = (url: string) => page.evaluate(async (address) => {
    const response = await fetch(address, { headers: { Range: 'bytes=6-10' } });
    return { status: response.status, text: await response.text() };
  }, url);
  expect(await read(opened.value!.url)).toEqual({ status: 206, text: 'world' });
  expect((await read(opened.value!.url)).status).toBe(404);

  const entry = written.value!;
  const expectOf = (e: Entry) => ({ fileId: e.fileId, size: e.size, mtimeMs: e.mtimeMs });
  const moved = await files<Answer<Entry>>(page, 'move', root.id, 'docs/a.txt', 'docs/A.txt', expectOf(entry));
  expect(moved).toMatchObject({ ok: true, value: { path: 'docs/A.txt', fileId: entry.fileId } });
  expect(readdirSync(path.join(root.path, 'docs'))).toEqual(['A.txt']);
  writeFileSync(path.join(root.path, 'docs', 'B.txt'), 'b');
  expect(await files<Answer>(page, 'move', root.id, 'docs/A.txt', 'docs/B.txt', null)).toEqual({ ok: false, error: 'exists' });

  // Explorer opens only on a click main saw: a script alone opens nothing, the folder itself included.
  expect(await files<boolean>(page, 'showInFolder', root.id, 'docs/A.txt')).toBe(false);
  expect(await files<boolean>(page, 'showInFolder', root.id, '')).toBe(false);
  expect(await mainGlobal<string[]>('__shown')).toEqual([]);
  expect(await clicked<boolean>('showInFolder', root.id, 'docs/A.txt')).toBe(true);
  expect(await mainGlobal<string[]>('__shown')).toEqual([path.join(root.path, 'docs', 'A.txt')]);
  // One click, one Explorer window: the next call on the same click opens nothing.
  expect(await files<boolean>(page, 'showInFolder', root.id, '')).toBe(false);
  expect(await mainGlobal<string[]>('__shown')).toHaveLength(1);

  expect(await files<Answer>(page, 'remove', root.id, 'docs/A.txt', { ...expectOf(moved.value!), size: 99 })).toEqual({ ok: false, error: 'changed' });
  expect(await files<Answer>(page, 'remove', root.id, 'docs/A.txt', expectOf(moved.value!))).toEqual({ ok: true, value: 'trash' });
  expect(await mainGlobal<string[]>('__trashed')).toEqual([path.join(root.path, 'docs', 'A.txt')]);
  await app.evaluate(() => {
    (globalThis as unknown as { __trashFails: boolean }).__trashFails = true;
  });
  expect(await files<Answer>(page, 'remove', root.id, 'docs/B.txt', null)).toEqual({ ok: true, value: 'deleted' });
  expect(readdirSync(path.join(root.path, 'docs'))).toEqual([]);

  writeFileSync(path.join(root.path, 'saved-elsewhere.txt'), 'from another program');
  await expect.poll(async () => {
    const events = await page.evaluate(() => (window as unknown as { __events: { rootId: string; paths: string[] | null }[] }).__events);
    return events.some((event) => event.rootId === root.id && (event.paths === null || event.paths.includes('saved-elsewhere.txt')));
  }, { timeout: 15_000 }).toBe(true);

  expect(await files<string | null>(page, 'loadState', root.id)).toBeNull();
  await files(page, 'saveState', root.id, '{"synced":true}');
  expect(await files<string | null>(page, 'loadState', root.id)).toBe('{"synced":true}');
  expect(readFileSync(path.join(profile, 'files-sync', 'state', `${root.id}.json`), 'utf8')).toBe('{"synced":true}');
});

test('the policy forced off removes the folder live; its files stay', async () => {
  const [root] = await files<Root[]>(page, 'roots');
  reg('add', `${POLICY_ROOT}\\Machine`, '/v', 'FilesFolderSyncEnabled', '/t', 'REG_DWORD', '/d', '0', '/f');
  try {
    await expect.poll(() => files<Root[]>(page, 'roots'), { timeout: 30_000 }).toEqual([]);
    expect(existsSync(path.join(root.path, 'already-here.txt'))).toBe(true);
    expect(existsSync(path.join(root.path, 'saved-elsewhere.txt'))).toBe(true);
    expect(existsSync(path.join(profile, 'files-sync', 'state', `${root.id}.json`))).toBe(false);
    expect(await files<string | null>(page, 'loadState', root.id)).toBeNull();
    await pick(root.path);
    expect(await clicked<Answer>('addFolder', { account: 'acct-1', remoteId: null, remoteLabel: 'Files' })).toEqual({ ok: false, error: 'policy' });
  } finally {
    reg('delete', `${POLICY_ROOT}\\Machine`, '/v', 'FilesFolderSyncEnabled', '/f');
  }
});

test('a wipe of one account forgets its folder and record, and keeps its files', async () => {
  const sync = path.join(base, 'Sync');
  await pick(sync);
  await expect.poll(async () => (await clicked<Answer<Root>>('addFolder', { account: 'acct-9', remoteId: null, remoteLabel: 'Files' })).ok, { timeout: 30_000 }).toBe(true);
  const [root] = await files<Root[]>(page, 'roots');
  await files(page, 'saveState', root.id, 'record');
  // Another account's folder stays: the wipe is for one account only.
  const other = path.join(base, 'OtherAccount');
  mkdirSync(other, { recursive: true });
  await pick(other);
  await expect.poll(async () => (await clicked<Answer<Root>>('addFolder', { account: 'acct-8', remoteId: null, remoteLabel: 'Files' })).ok, { timeout: 30_000 }).toBe(true);
  // The webmail's page took the wipe call already; a same-origin document without it can take it.
  await page.goto(new URL('/pst-worker.js', page.url()).toString());
  const failed = await page.evaluate(async (account) => {
    const lock = (window as unknown as { bulwarkDesktop?: { appLock?: { claim: () => { localWipe: (request: object) => Promise<{ failed: string[] }> } | null } } }).bulwarkDesktop?.appLock?.claim();
    if (!lock) return ['no claim'];
    return (await lock.localWipe({ reason: 'settings', account })).failed;
  }, 'acct-9');
  expect(failed).toEqual([]);
  expect((await files<Root[]>(page, 'roots')).map((entry) => entry.account)).toEqual(['acct-8']);
  expect(existsSync(path.join(profile, 'files-sync', 'state', `${root.id}.json`))).toBe(false);
  expect(existsSync(path.join(sync, 'already-here.txt'))).toBe(true);
});
