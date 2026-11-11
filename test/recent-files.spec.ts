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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { askInWindows, fakeOsIntegration, launch, prompts, removeProfile, shownPage, tempProfile, waitForLogin } from './helpers';
import { startHostileInstance, type HostileInstance } from './support/hostile-instance';
import { startHostileInstance as startMenuInstance, type HostileInstance as MenuInstance } from './support/hostile-instance-2';
import { startInputInstance, type InputInstance } from './support/input-instance';

/** The shell's question before a server's first list, in English. */
const ASKED_APP = 'Show the files you opened recently on this computer when you attach a file?';

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
    // The user says yes when the first list asks.
    await fakeOsIntegration(app, 0);
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
    // The first list asked, in the shell's own words; a yes is kept.
    expect((await prompts(app)).map((asked) => asked.message)).toEqual([ASKED_APP]);
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
    // Asked once, for the first list only.
    expect(await prompts(app)).toHaveLength(1);
  });

  test('a yes taken back: an id from a list before is refused, and the next list asks again', async () => {
    const listed = await clicked<Listed>(app, 'window.bulwarkDesktop.recentFiles.list()');
    const id = listed.files!.find((file) => file.name === 'notes.txt')!.id;
    const asked = (await prompts(app)).length;
    await app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { recent: { forget: (origin?: string) => void } } }).__bulwarkOs.recent.forget());
    expect(await clicked<Attached>(app, attachCode(id))).toEqual({ ok: false, reason: 'unknown' });
    expect((await clicked<Listed>(app, 'window.bulwarkDesktop.recentFiles.list()')).ok).toBe(true);
    expect(await prompts(app)).toHaveLength(asked + 1);
  });
});

test.describe('the question before a server\'s first list', () => {
  test.skip(!win, 'Windows shortcuts');

  test('its words are the shell\'s own: labels the page sends translate the menus, never this question or the beta channel\'s', async () => {
    const fixture = newFixture();
    const profile = tempProfile('recent-words');
    const app = await launch(profile, '--standalone', `--bulwark-test-recent-dir=${fixture.recent}`);
    try {
      await waitForLogin(await shownPage(app));
      await fakeOsIntegration(app, 1);
      await whenOpen(app);
      await makeShortcuts(app, fixture);
      await noClick(app, `window.bulwarkDesktop.shell.setLanguages({ ui: 'en', composer: [], labels: ${JSON.stringify({
        menuFile: 'Fichier',
        recentAskDetail: 'Nothing to see here.',
        recentAskAllow: 'OK',
        recentAskDeny: 'Show me',
        updateBetaTitle: 'Nothing to see here.',
        updateBetaDetail: 'Nothing to see here.',
        updateBetaConfirm: 'OK',
        updateOlderTitle: 'Nothing to see here.',
        updateOlderConfirm: 'OK',
      })} })`);
      await expect.poll(() => app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.items[0].label.replace('&', ''))).toBe('Fichier');
      await noClick(app, "window.bulwarkDesktop.updates.setChannel('beta')");
      expect(await clicked<Listed>(app, 'window.bulwarkDesktop.recentFiles.list()')).toEqual({ ok: false, reason: 'gesture' });
      const asked = (await prompts(app)) as unknown as { message: string; detail: string; buttons: string[] }[];
      expect(asked.map(({ message, detail, buttons }) => ({ message, detail, buttons }))).toEqual([
        { message: 'Switch to beta versions?', detail: expect.stringContaining('You get new versions earlier'), buttons: ['Switch to beta', 'Cancel'] },
        { message: ASKED_APP, detail: expect.stringContaining('The page gets the names, folders and sizes'), buttons: ['Show recent files', "Don't allow"] },
      ]);
    } finally {
      await app.close().catch(() => {});
      removeProfile(profile);
      rmSync(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    }
  });

  test('a no: no list, one question for two lists while it\'s up, and none again for a while', async () => {
    const fixture = newFixture();
    const profile = tempProfile('recent-no');
    const app = await launch(profile, '--standalone', `--bulwark-test-recent-dir=${fixture.recent}`);
    try {
      await waitForLogin(await shownPage(app));
      await fakeOsIntegration(app, 1);
      // The question stays up until the test answers it.
      await app.evaluate(({ dialog }) => {
        const g = globalThis as unknown as { __prompts: unknown[]; __answer?: (response: number) => void };
        dialog.showMessageBox = ((...args: unknown[]) => {
          g.__prompts.push(args[args.length - 1]);
          return new Promise((resolve) => {
            g.__answer = (response: number) => resolve({ response, checkboxChecked: false });
          });
        }) as typeof dialog.showMessageBox;
      });
      await whenOpen(app);
      await makeShortcuts(app, fixture);
      const page = pageOf(app);
      await page.mouse.click(200, 400);
      await page.evaluate('void (window.__first = window.bulwarkDesktop.recentFiles.list())');
      await expect.poll(async () => (await prompts(app)).length).toBe(1);
      expect((await prompts(app))[0]).toMatchObject({ message: ASKED_APP, buttons: ['Show recent files', "Don't allow"], defaultId: 1, cancelId: 1 });
      await page.mouse.click(200, 400);
      await page.evaluate('void (window.__second = window.bulwarkDesktop.recentFiles.list())');
      await page.waitForTimeout(500);
      expect(await prompts(app), 'one question, not two').toHaveLength(1);
      await app.evaluate(() => (globalThis as unknown as { __answer: (response: number) => void }).__answer(1));
      expect(await page.evaluate('Promise.all([window.__first, window.__second])')).toEqual([{ ok: false, reason: 'gesture' }, { ok: false, reason: 'gesture' }]);
      for (let call = 0; call < 5; call += 1) expect(await clicked<Listed>(app, 'window.bulwarkDesktop.recentFiles.list()')).toEqual({ ok: false, reason: 'gesture' });
      expect(await prompts(app), 'no second question while the no holds').toHaveLength(1);
    } finally {
      await app.close().catch(() => {});
      removeProfile(profile);
      rmSync(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    }
  });
});

test.describe('clicks on an instance\'s page are not a yes to reading recent files', () => {
  // An instance whose page asks for recent files at every click (test/support/hostile-instance.ts),
  // from its own script and from a same-origin frame. Every question is answered no.
  test.skip(!win, 'Windows shortcuts');
  let hostile: HostileInstance;
  let root = '';
  let recent = '';
  let files = '';

  test.beforeAll(async () => {
    hostile = await startHostileInstance(3842);
    root = mkdtempSync(path.join(tmpdir(), 'bw-recent-hostile-'));
    recent = path.join(root, 'Recent');
    files = path.join(root, 'Documents');
    mkdirSync(recent);
    mkdirSync(files);
    writeFileSync(path.join(files, 'salary-2026.xlsx'), 'FAKE-SECRET salary table');
    writeFileSync(path.join(files, 'passwords.txt'), 'FAKE-SECRET not a real password list');
  });
  test.afterAll(() => {
    hostile?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  });

  const lootOf = (kind: string) => hostile.loot.filter((entry) => entry.kind === kind).map((entry) => entry.body);

  for (const mode of ['recent-page', 'recent-frame'] as const) {
    test(`${mode}: five clicks on the page give it no file name, path or content`, async () => {
      const profile = tempProfile('recent-hostile');
      hostile.loot.length = 0;
      hostile.mode = mode;
      const app = await launch(profile, `--instance=${hostile.origin}/`, '--ignore-certificate-errors', '--bulwark-test-no-native', `--bulwark-test-recent-dir=${recent}`);
      try {
        const page = await shownPage(app);
        await app.evaluate(({ app: electronApp, shell }) => {
          electronApp.relaunch = () => undefined;
          shell.openExternal = async () => undefined;
        });
        await fakeOsIntegration(app, 1);
        const names = ['salary-2026.xlsx', 'passwords.txt'];
        await app.evaluate(({ shell }, list) => list.map(([lnk, target]) => shell.writeShortcutLink(lnk, 'create', { target })),
          names.map((name) => [path.join(recent, `${name}.lnk`), path.join(files, name)]));
        names.forEach((name, index) => {
          const at = (Date.now() - (index + 1) * 60_000) / 1000;
          utimesSync(path.join(recent, `${name}.lnk`), at, at);
        });
        await expect.poll(() => lootOf('bridge').length).toBeGreaterThan(0);
        await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { hub: { locked: boolean } } }).__bulwarkOs.hub.locked), { timeout: 30_000 }).toBe(false);
        const at = mode === 'recent-page' ? { x: 400, y: 500 } : { x: 120, y: 120 };
        for (let click = 0; click < 5; click += 1) {
          await page.mouse.click(at.x, at.y);
          await page.waitForTimeout(700);
        }
        // Whatever the page was told, nothing of the user's files is in it.
        const everything = JSON.stringify(hostile.loot);
        expect(everything).not.toContain('FAKE-SECRET');
        expect(everything).not.toContain('salary-2026');
        expect(everything).not.toContain('passwords.txt');
        expect(lootOf('recent-file')).toEqual([]);
        // It asked once, naming the server, and the no holds.
        expect((await prompts(app)).map((asked) => asked.message)).toEqual([`Let ${new URL(hostile.origin).host} see the files you opened recently on this computer?`]);
      } finally {
        await app.close().catch(() => {});
        removeProfile(profile);
      }
    });
  }
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

test.describe('the question before recent files, on an instance\'s page', () => {
  // An instance's page asks for recent files at a click (test/support/input-instance.ts), on two
  // ports of one host. The shortcuts point at files this file makes.
  test.skip(!win, 'Windows shortcuts');
  const NAMES = ['salary-2026.xlsx', 'passwords.txt', 'notes.txt'];
  let first: InputInstance;
  let second: InputInstance;
  let root = '';
  let recent = '';

  test.beforeAll(async () => {
    first = await startInputInstance(3847);
    second = await startInputInstance(3848);
    root = mkdtempSync(path.join(tmpdir(), 'bw-recent-ask-'));
    recent = path.join(root, 'Recent');
    mkdirSync(recent);
    mkdirSync(path.join(root, 'Documents'));
    for (const name of NAMES) writeFileSync(path.join(root, 'Documents', name), `FAKE-SECRET ${name}`);
  });
  test.afterAll(() => {
    first?.close();
    second?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  });

  const lootOf = (instance: InputInstance, kind: string) => instance.loot.filter((entry) => entry.kind === kind).map((entry) => entry.body);
  const askedFor = (host: string) => `Let ${host} see the files you opened recently on this computer?`;

  /** The page in `mode` at `address`, three recent files to find, no lock, every question answered with `answer`. */
  async function openInstance(instance: InputInstance, profile: string, mode: InputInstance['mode'], answer: number, address = `${instance.origin}/`): Promise<{ app: ElectronApplication; page: Page }> {
    instance.loot.length = 0;
    instance.mode = 'idle';
    const app = await launch(profile, `--instance=${address}`, '--ignore-certificate-errors', '--bulwark-test-no-native', `--bulwark-test-recent-dir=${recent}`);
    const page = await shownPage(app);
    await app.evaluate(({ app: electronApp, shell }) => {
      electronApp.relaunch = () => undefined;
      shell.openPath = async () => '';
      shell.showItemInFolder = () => undefined;
    });
    await fakeOsIntegration(app, answer);
    const made = await app.evaluate(({ shell }, list) => list.map(([lnk, target]) => shell.writeShortcutLink(lnk, 'create', { target })), NAMES.map((name) => [path.join(recent, `${name}.lnk`), path.join(root, 'Documents', name)]));
    expect(made).toEqual([true, true, true]);
    NAMES.forEach((name, index) => {
      const at = (Date.now() - (index + 1) * 60_000) / 1000;
      utimesSync(path.join(recent, `${name}.lnk`), at, at);
    });
    await expect.poll(() => lootOf(instance, 'bridge').length).toBeGreaterThan(0);
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { hub: { locked: boolean } } }).__bulwarkOs.hub.locked), { timeout: 30_000 }).toBe(false);
    instance.loot.length = 0;
    instance.mode = mode;
    await page.reload();
    return { app, page };
  }

  test('a no holds through a reload, the question is the shell\'s, and its safe button is the default', async () => {
    const profile = tempProfile('recent-ask-no');
    const { app, page } = await openInstance(first, profile, 'recent-each-click', 1);
    try {
      await expect.poll(() => lootOf(first, 'ready').length, { timeout: 30_000 }).toBe(1);
      await page.mouse.click(400, 500);
      await expect.poll(() => lootOf(first, 'recent').length, { timeout: 20_000 }).toBe(1);
      expect(lootOf(first, 'recent')[0]).toEqual({ ok: false, reason: 'gesture' });
      const asked = (await prompts(app)) as unknown as { message: string; buttons: string[]; defaultId: number; cancelId: number }[];
      expect(asked).toHaveLength(1);
      expect(asked[0].message).toBe(askedFor(new URL(first.origin).host));
      expect(asked[0].buttons).toEqual(['Show recent files', "Don't allow"]);
      expect(asked[0].defaultId).toBe(1);
      expect(asked[0].cancelId).toBe(1);
      // The page loads again and asks at each of three more clicks: no question.
      await page.reload();
      await expect.poll(() => lootOf(first, 'ready').length, { timeout: 30_000 }).toBe(2);
      for (let click = 0; click < 3; click += 1) {
        await page.mouse.click(400, 500);
        await page.waitForTimeout(600);
      }
      expect(await prompts(app)).toHaveLength(1);
      expect(JSON.stringify(first.loot)).not.toContain('salary');
      const state = path.join(profile, 'shell-state.json');
      if (existsSync(state)) expect(JSON.parse(readFileSync(state, 'utf8')).recentFilesOrigins ?? []).toEqual([]);
    } finally {
      await app.close().catch(() => {});
      removeProfile(profile);
    }
  });

  test('a yes is for that scheme, host and port; after it one click is one list or one file', async () => {
    test.setTimeout(240_000);
    const profile = tempProfile('recent-ask-yes');
    let { app, page } = await openInstance(first, profile, 'recent-two-on-one', 0);
    try {
      await expect.poll(() => lootOf(first, 'ready').length, { timeout: 30_000 }).toBe(1);
      await page.mouse.click(400, 500);
      await expect.poll(() => lootOf(first, 'first-click').length, { timeout: 20_000 }).toBe(1);
      // The list took the click: the file the page asks for on it is refused.
      expect(lootOf(first, 'first-click')[0]).toEqual({ list: true, names: 3, attachOnSameClick: 'gesture' });
      expect(await prompts(app)).toHaveLength(1);
      await page.mouse.click(400, 500);
      await expect.poll(() => lootOf(first, 'second-click').length, { timeout: 20_000 }).toBe(1);
      expect(lootOf(first, 'second-click')[0]).toEqual({ one: 'ok', two: 'gesture' });
      await app.close();
      const state = JSON.parse(readFileSync(path.join(profile, 'shell-state.json'), 'utf8')) as { recentFilesOrigins?: string[] };
      expect(state.recentFilesOrigins).toEqual([first.origin]);

      // The same profile on another port of the same host: asked again, and a no there.
      ({ app, page } = await openInstance(second, profile, 'recent-each-click', 1));
      await expect.poll(() => lootOf(second, 'ready').length, { timeout: 30_000 }).toBe(1);
      await page.mouse.click(400, 500);
      await expect.poll(() => lootOf(second, 'recent').length, { timeout: 20_000 }).toBe(1);
      expect(lootOf(second, 'recent')[0]).toEqual({ ok: false, reason: 'gesture' });
      expect((await prompts(app)).map((asked) => asked.message)).toEqual([askedFor(new URL(second.origin).host)]);
    } finally {
      await app.close().catch(() => {});
      removeProfile(profile);
    }
  });

  // The question as the shell draws it, in a window of its own: for a long name that starts like
  // a trusted one, and for one whose first letter is Cyrillic.
  const LONG = `mail.example.com.${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.evil-domain.localhost`;
  const LOOKALIKE = 'аpple.localhost';
  for (const [name, host, end] of [['a long', LONG, '.evil-domain.localhost:3847'], ['a look-alike', LOOKALIKE, 'xn--pple-43d.localhost:3847']] as const) {
    test(`the question for ${name} name shows the end of the name on screen, and its safe button has the keys`, async () => {
      const profile = tempProfile('recent-ask-host');
      const { app, page } = await openInstance(first, profile, 'recent-each-click', 1, `https://${host}:3847/`);
      try {
        await askInWindows(app, true);
        await expect.poll(() => lootOf(first, 'ready').length, { timeout: 30_000 }).toBe(1);
        await page.mouse.click(400, 500);
        let dialog: Page | undefined;
        await expect.poll(() => {
          dialog = app.windows().find((other) => other !== page && !other.isClosed() && other.url().startsWith('data:'));
          return Boolean(dialog);
        }, { timeout: 20_000 }).toBe(true);
        await dialog!.waitForFunction(() => document.querySelector('#title')?.textContent);
        await dialog!.waitForTimeout(500);
        const facts = await dialog!.evaluate((tail) => {
          const title = document.querySelector('#title') as HTMLElement;
          const node = [...title.childNodes].find((child) => child.nodeType === Node.TEXT_NODE && (child.textContent ?? '').includes(tail)) ?? title.firstChild!;
          const at = (node.textContent ?? '').lastIndexOf(tail);
          const range = document.createRange();
          range.setStart(node, Math.max(0, at));
          range.setEnd(node, Math.max(0, at) + tail.length);
          const part = range.getBoundingClientRect();
          const box = title.getBoundingClientRect();
          return {
            title: title.textContent ?? '',
            endInView: part.bottom <= box.bottom + 1 && part.top >= box.top - 1,
            focused: document.activeElement?.textContent ?? null,
          };
        }, end);
        expect(facts.title).toContain(end);
        expect(facts.endInView, `the end of the name is on screen without scrolling: ${facts.title}`).toBe(true);
        expect(facts.focused, 'the button that has the keys').toBe("Don't allow");
        await dialog!.locator('button.button', { hasText: "Don't allow" }).click();
        await expect.poll(() => lootOf(first, 'recent')).toEqual([{ ok: false, reason: 'gesture' }]);
      } finally {
        await app.close().catch(() => {});
        removeProfile(profile);
      }
    });
  }
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

  test('turned off after the user said yes: no list and nothing to attach', async () => {
    const policyRoot = `HKCU\\Software\\BulwarkTest\\Policies\\recent-later-${process.pid}`;
    const reg = (...args: string[]) => spawnSync('reg.exe', args, { windowsHide: true });
    reg('add', `${policyRoot}\\Machine`, '/f');
    const fixture = newFixture();
    const profile = tempProfile('recent-later');
    const app = await launch(profile, '--standalone', `--bulwark-test-recent-dir=${fixture.recent}`, `--bulwark-test-policy-root=${policyRoot}`, '--bulwark-test-policy-poll=250');
    try {
      await waitForLogin(await shownPage(app));
      await fakeOsIntegration(app, 0);
      await whenOpen(app);
      await makeShortcuts(app, fixture);
      const listed = await clicked<Listed>(app, 'window.bulwarkDesktop.recentFiles.list()');
      expect(listed.ok).toBe(true);
      reg('add', `${policyRoot}\\Machine`, '/v', 'RecentFilesInAttach', '/t', 'REG_DWORD', '/d', '0', '/f');
      await expect.poll(() => noClick(app, 'window.bulwarkDesktop.policy.get().RecentFilesInAttach.value'), { timeout: 30_000 }).toBe(false);
      expect(await clicked<Listed>(app, 'window.bulwarkDesktop.recentFiles.list()')).toEqual({ ok: false, reason: 'policy' });
      expect(await clicked<Attached>(app, attachCode(listed.files![0].id))).toEqual({ ok: false, reason: 'policy' });
    } finally {
      await app.close().catch(() => {});
      reg('delete', policyRoot, '/f');
      removeProfile(profile);
      rmSync(fixture.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    }
  });
});
