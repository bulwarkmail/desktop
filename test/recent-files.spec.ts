// Recent files for the Attach menu, on the real app, from a folder of shortcuts this file
// makes (--bulwark-test-recent-dir, test builds only). Never the user's own Recent folder.
// Windows: the shortcuts are .lnk files, written with Electron's own shell.writeShortcutLink.
//
// The offline share: TEST-NET-1 (192.0.2.0/24), where nothing answers, so Windows waits about
// 20 seconds before it gives up on a path there. It then remembers the failure for a while
// and answers at once, so each run takes a host of its own, and the shortcut can't be written
// to it (writing one looks the target up): it's written to a share on this computer and
// the host's text is changed in the file afterwards.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { fakeOsIntegration, launch, removeProfile, shownPage, tempProfile, waitForLogin } from './helpers';
import { startHostileInstance as startMenuInstance, type HostileInstance as MenuInstance } from './support/hostile-instance-2';

const win = process.platform === 'win32';
/** Loopback, the same length as the hosts below: a missing share here fails at once. */
const LOCAL_HOST = '127.0.0.101';

/** A host in TEST-NET-1 this run hasn't used, as long as LOCAL_HOST. */
const usedHosts = new Set<string>();
function offlineHost(): string {
  for (;;) {
    const host = `192.0.2.${100 + Math.floor(Math.random() * 155)}`;
    if (!usedHosts.has(host)) {
      usedHosts.add(host);
      return host;
    }
  }
}

/** Every copy of one text in a file, in both of the encodings a shortcut holds names in. */
function replaceInFile(file: string, from: string, to: string): number {
  const bytes = readFileSync(file);
  let count = 0;
  for (const encoding of ['latin1', 'utf16le'] as const) {
    const a = Buffer.from(from, encoding);
    const b = Buffer.from(to, encoding);
    for (let at = bytes.indexOf(a); at >= 0; at = bytes.indexOf(a, at + a.length)) {
      b.copy(bytes, at);
      count += 1;
    }
  }
  writeFileSync(file, bytes);
  return count;
}

interface Listed {
  ok: boolean;
  reason?: string;
  files?: { id: string; name: string; folder: string; path: string; usedAt: number; size?: number; icon?: string }[];
}

interface Attached {
  ok: boolean;
  reason?: string;
  name?: string;
  text?: string;
  bytes?: number;
}

const pageOf = (app: ElectronApplication): Page => app.windows().filter((w) => !w.isClosed()).at(-1)!;

/** A real click main sees, then the call. */
async function clicked<T>(app: ElectronApplication, code: string): Promise<T> {
  const page = pageOf(app);
  await page.mouse.click(200, 400);
  return page.evaluate(code) as Promise<T>;
}

/** No click: a script of the page's own, or a plugin's. */
const noClick = <T>(app: ElectronApplication, code: string): Promise<T> => pageOf(app).evaluate(code) as Promise<T>;

const attachCode = (id: string) => `window.bulwarkDesktop.recentFiles.attach(${JSON.stringify(id)}).then((r) => r.ok
  ? { ok: true, name: r.file.name, bytes: r.file.data.byteLength, text: r.file.data.byteLength < 1000 ? new TextDecoder().decode(r.file.data) : '' }
  : r)`;

async function whenOpen(app: ElectronApplication): Promise<void> {
  await expect.poll(async () => {
    await noClick(app, 'window.bulwarkDesktop.os.setLocked(false)').catch(() => {});
    return app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { hub: { locked: boolean } } }).__bulwarkOs.hub.locked);
  }, { timeout: 60_000 }).toBe(false);
}

interface Fixture {
  root: string;
  recent: string;
  files: string;
  /** Shortcut name → when it was last written. */
  times: Map<string, number>;
  /** The file on the offline share. */
  offline: string;
}

async function makeShortcuts(app: ElectronApplication, fixture: Fixture): Promise<void> {
  const { recent, files } = fixture;
  writeFileSync(path.join(files, 'notes.txt'), 'the notes');
  writeFileSync(path.join(files, 'Quarterly report.docx'), 'the report');
  writeFileSync(path.join(files, 'Budget 2027.xlsx'), 'the budget');
  writeFileSync(path.join(files, 'gone.pdf'), 'deleted below');
  writeFileSync(path.join(files, 'big.bin'), '');
  // Past the 100 MB a file from "Open with" may have.
  truncateSync(path.join(files, 'big.bin'), 100 * 1024 * 1024 + 1);
  mkdirSync(path.join(files, 'Project folder'));
  const now = Date.now();
  const shortcuts: [string, string, number][] = [
    ['offline.docx.lnk', `\\\\${LOCAL_HOST}\\bw-no-such-share\\offline.docx`, 1],
    ['notes.txt.lnk', path.join(files, 'notes.txt'), 2],
    ['Project folder.lnk', path.join(files, 'Project folder'), 3],
    ['gone.pdf.lnk', path.join(files, 'gone.pdf'), 4],
    ['Quarterly report.docx.lnk', path.join(files, 'Quarterly report.docx'), 5],
    ['Budget 2027.xlsx.lnk', path.join(files, 'Budget 2027.xlsx'), 6],
    ['big.bin.lnk', path.join(files, 'big.bin'), 7],
    // The same file again, older: once in the list, at its newest.
    ['Quarterly report (2).docx.lnk', path.join(files, 'Quarterly report.docx'), 10],
  ];
  const written = await app.evaluate(({ shell }, list) => list.map(([lnk, target]) => shell.writeShortcutLink(lnk, 'create', { target })),
    shortcuts.map(([name, target]) => [path.join(recent, name), target]));
  expect(written.every(Boolean)).toBe(true);
  rmSync(path.join(files, 'gone.pdf'));
  fixture.offline = `\\\\${offlineHost()}\\bw-no-such-share\\offline.docx`;
  expect(replaceInFile(path.join(recent, 'offline.docx.lnk'), LOCAL_HOST, fixture.offline.slice(2, 2 + LOCAL_HOST.length))).toBeGreaterThan(0);
  expect((await app.evaluate(({ shell }, lnk) => shell.readShortcutLink(lnk).target, path.join(recent, 'offline.docx.lnk')))).toBe(fixture.offline);
  for (const [name, , minutesAgo] of shortcuts) {
    const at = now - minutesAgo * 60_000;
    utimesSync(path.join(recent, name), at / 1000, at / 1000);
    fixture.times.set(name, at);
  }
}

function newFixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), 'bw-recent-'));
  const fixture = { root, recent: path.join(root, 'Recent'), files: path.join(root, 'files'), times: new Map<string, number>(), offline: '' };
  mkdirSync(fixture.recent);
  mkdirSync(fixture.files);
  return fixture;
}

test.describe('recent files on Windows', () => {
  test.skip(!win, 'Windows shortcuts');
  test.describe.configure({ mode: 'serial' });

  let app: ElectronApplication;
  let profile = '';
  let fixture: Fixture;

  test.beforeAll(async () => {
    fixture = newFixture();
    profile = tempProfile('recent');
    app = await launch(profile, '--standalone', `--bulwark-test-recent-dir=${fixture.recent}`);
    await waitForLogin(await shownPage(app));
    await whenOpen(app);
    await makeShortcuts(app, fixture);
  });

  test.afterAll(async () => {
    await app?.close().catch(() => {});
    removeProfile(profile);
    rmSync(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  });

  test('a click lists the files, newest first, without folders, gone files or doubles, and doesn\'t wait for the offline share', async () => {
    const started = Date.now();
    const result = await clicked<Listed>(app, 'window.bulwarkDesktop.recentFiles.list()');
    const took = Date.now() - started;
    expect(result.ok).toBe(true);
    const files = result.files!;
    expect(files.map((file) => file.name)).toEqual(['notes.txt', 'Quarterly report.docx', 'Budget 2027.xlsx', 'big.bin']);
    // The check gives each path 1.5 s; the share would take 20.
    expect(took).toBeLessThan(5_000);
    for (const file of files) {
      expect(file.folder).toBe(fixture.files);
      expect(file.path).toBe(path.join(fixture.files, file.name));
      expect(file.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(Math.abs(file.usedAt - fixture.times.get(`${file.name}.lnk`)!)).toBeLessThan(2_000);
    }
    expect(files[0].icon).toMatch(/^data:image\/png;base64,/);
    // Only what the menu shows.
    expect(Object.keys(files[0]).sort()).toEqual(['folder', 'icon', 'id', 'name', 'path', 'size', 'usedAt']);
    // The size, so the page can grey out a file larger than the server takes.
    expect(files.find((file) => file.name === 'Quarterly report.docx')?.size).toBe(10);
  });

  test('a host like the offline share\'s really doesn\'t answer for seconds', () => {
    // Another host of the same kind: this one is now remembered as failed.
    const probe = spawnSync(process.execPath, ['-e', 'require("fs").statSync(process.argv[1])', `\\\\${offlineHost()}\\share\\x.docx`], { timeout: 4_000, windowsHide: true });
    expect(probe.error && (probe.error as NodeJS.ErrnoException).code).toBe('ETIMEDOUT');
  });

  test('a script with no click, or a locked app, gets no list', async () => {
    expect(await noClick<Listed>(app, 'window.bulwarkDesktop.recentFiles.list()')).toEqual({ ok: false, reason: 'gesture' });
    // What gives a page's own script a user gesture isn't a click either.
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.isVisible())!.webContents.executeJavaScript('window.bulwarkDesktop.recentFiles.list()', true)))
      .toEqual({ ok: false, reason: 'gesture' });
    await noClick(app, 'window.bulwarkDesktop.os.setLocked(true)');
    try {
      await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { hub: { locked: boolean } } }).__bulwarkOs.hub.locked)).toBe(true);
      expect(await clicked<Listed>(app, 'window.bulwarkDesktop.recentFiles.list()')).toEqual({ ok: false, reason: 'locked' });
    } finally {
      await whenOpen(app);
    }
  });

  test('attaching reads the file behind an id of the last list, with a click, and nothing else', async () => {
    const listed = await clicked<Listed>(app, 'window.bulwarkDesktop.recentFiles.list()');
    const byName = new Map(listed.files!.map((file) => [file.name, file.id]));

    expect(await clicked<Attached>(app, attachCode(byName.get('Quarterly report.docx')!))).toEqual({ ok: true, name: 'Quarterly report.docx', bytes: 10, text: 'the report' });
    // Again, from the same list: the menu can be opened twice on one list.
    expect(await clicked<Attached>(app, attachCode(byName.get('notes.txt')!))).toMatchObject({ ok: true, name: 'notes.txt', text: 'the notes' });

    expect(await noClick<Attached>(app, attachCode(byName.get('notes.txt')!))).toEqual({ ok: false, reason: 'gesture' });
    expect(await clicked<Attached>(app, attachCode('made-up'))).toEqual({ ok: false, reason: 'unknown' });
    // A path is not an id: the page can't name a file of its own choosing.
    expect(await clicked<Attached>(app, attachCode(path.join(fixture.files, 'notes.txt')))).toEqual({ ok: false, reason: 'unknown' });
    expect(await clicked<Attached>(app, attachCode('C:\\Windows\\win.ini'))).toEqual({ ok: false, reason: 'unknown' });

    // The same limit as a file from "Open with".
    expect(await clicked<Attached>(app, attachCode(byName.get('big.bin')!))).toEqual({ ok: false, reason: 'too-large' });

    // Gone since the menu opened.
    rmSync(path.join(fixture.files, 'Budget 2027.xlsx'));
    expect(await clicked<Attached>(app, attachCode(byName.get('Budget 2027.xlsx')!))).toEqual({ ok: false, reason: 'missing' });

    // A new list, new ids: the old ones are done.
    const again = await clicked<Listed>(app, 'window.bulwarkDesktop.recentFiles.list()');
    expect(again.files!.map((file) => file.name)).toEqual(['notes.txt', 'Quarterly report.docx', 'big.bin']);
    expect(await clicked<Attached>(app, attachCode(byName.get('notes.txt')!))).toEqual({ ok: false, reason: 'unknown' });
  });
});

test.describe('a same-origin frame running menu lines', () => {
  // A frame of an instance's page (test/support/hostile-instance-2.ts) reaches the bridge
  // through `parent`, runs lines of the menu bar with no input, and asks for recent files.
  test.skip(!win, 'Windows shortcuts');
  let instance: MenuInstance;
  let root = '';

  test.beforeAll(async () => {
    instance = await startMenuInstance(3841);
    root = mkdtempSync(path.join(tmpdir(), 'bw-recent-frame-'));
    mkdirSync(path.join(root, 'Recent'));
    mkdirSync(path.join(root, 'Documents'));
    writeFileSync(path.join(root, 'Documents', 'salary-2026.xlsx'), 'FAKE-SECRET salary table');
  });
  test.afterAll(() => {
    instance?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  });

  test('no mouse, no key: the frame gets no recent files', async () => {
    const lootOf = (kind: string) => instance.loot.filter((entry) => entry.kind === kind).map((entry) => entry.body);
    const profile = tempProfile('recent-frame');
    instance.loot.length = 0;
    instance.mode = 'idle';
    const app = await launch(profile, `--instance=${instance.origin}/`, '--ignore-certificate-errors', '--bulwark-test-no-native', `--bulwark-test-recent-dir=${path.join(root, 'Recent')}`);
    try {
      const page = await shownPage(app);
      await app.evaluate(({ app: electronApp, shell }) => {
        electronApp.relaunch = () => undefined;
        shell.openExternal = async () => undefined;
      });
      await fakeOsIntegration(app, 1);
      const made = await app.evaluate(({ shell }, [lnk, target]) => shell.writeShortcutLink(lnk, 'create', { target }), [path.join(root, 'Recent', 'salary-2026.xlsx.lnk'), path.join(root, 'Documents', 'salary-2026.xlsx')]);
      expect(made).toBe(true);
      await expect.poll(() => lootOf('bridge').length).toBeGreaterThan(0);
      await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { hub: { locked: boolean } } }).__bulwarkOs.hub.locked), { timeout: 30_000 }).toBe(false);
      instance.loot.length = 0;
      instance.mode = 'menu-frame';
      await page.reload();
      await expect.poll(() => lootOf('menu-done').length, { timeout: 60_000 }).toBe(1);
      expect.soft(lootOf('recent-list'), 'recent files handed to the frame').toEqual([]);
      expect.soft(lootOf('recent-file'), 'file contents handed to the frame').toEqual([]);
      expect(JSON.stringify(instance.loot)).not.toContain('FAKE-SECRET');
    } finally {
      await app.close().catch(() => {});
      removeProfile(profile);
    }
  });
});

test.describe('the RecentFilesInAttach policy', () => {
  test.skip(!win, 'Windows registry');

  test.afterAll(() => {
    // The parents this file made, if nothing else is in them.
    for (const parent of ['HKCU\\Software\\BulwarkTest\\Policies', 'HKCU\\Software\\BulwarkTest']) {
      const answer = spawnSync('reg.exe', ['query', parent], { encoding: 'utf8', windowsHide: true });
      if (answer.status === 0 && answer.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).length <= 1) spawnSync('reg.exe', ['delete', parent, '/f'], { windowsHide: true });
    }
  });

  test('forced off, there\'s no list and nothing to attach', async () => {
    const policyRoot = `HKCU\\Software\\BulwarkTest\\Policies\\recent-${process.pid}`;
    const reg = (...args: string[]) => spawnSync('reg.exe', args, { windowsHide: true });
    reg('add', `${policyRoot}\\Machine`, '/v', 'RecentFilesInAttach', '/t', 'REG_DWORD', '/d', '0', '/f');
    const fixture = newFixture();
    const profile = tempProfile('recent-off');
    const app = await launch(profile, '--standalone', `--bulwark-test-recent-dir=${fixture.recent}`, `--bulwark-test-policy-root=${policyRoot}`);
    try {
      await waitForLogin(await shownPage(app));
      await whenOpen(app);
      await makeShortcuts(app, fixture);
      expect(await noClick(app, 'window.bulwarkDesktop.policy.get().RecentFilesInAttach')).toMatchObject({ value: false, locked: true });
      expect(await clicked<Listed>(app, 'window.bulwarkDesktop.recentFiles.list()')).toEqual({ ok: false, reason: 'policy' });
      expect(await clicked<Attached>(app, attachCode('anything'))).toEqual({ ok: false, reason: 'policy' });
    } finally {
      await app.close().catch(() => {});
      reg('delete', policyRoot, '/f');
      removeProfile(profile);
      rmSync(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    }
  });
});
