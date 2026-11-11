import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { helperFile, loadHelperModule, type NativeFilesModule } from '../src/main/native-loader';
import { fakeOsIntegration, launch, launchStandalone, prompts, removeProfile, shownPage, tempProfile, waitForLogin } from './helpers';
import { DROPPED, startHostileInstance, type HostileInstance } from './support/hostile-instance-2';

/**
 * The Files drive's channels in the real app: only the main window's page gets them, turning
 * it on takes a click, and a file opened by another program is fetched through the page. The
 * sync root is a test one (`Bulwark Test <pid>`, in a temp folder) and goes in `finally`.
 * test/files-drive-native.spec.ts covers the rest from plain Node.
 */

test.skip(process.platform !== 'win32', 'the Files drive is Windows only');
test.describe.configure({ mode: 'serial' });

const ROOT = path.resolve(import.meta.dirname, '..');
const PROVIDER = `Bulwark Test ${process.pid}`;
const BASE = path.join(tmpdir(), `bulwark-files-test-${process.pid}`);
const POLICY_ROOT = `HKCU\\Software\\BulwarkTest\\Policies\\files${process.pid}`;
const ACCOUNT = 'acct-electron';
const LABEL = 'drive-test@example.org';

const helper = (): NativeFilesModule => {
  const loaded = loadHelperModule(helperFile({ packaged: false, mainDir: path.join(ROOT, 'dist'), platform: process.platform, arch: process.arch }));
  if (!loaded?.filesDriveRoots) throw new Error('run npm run build:native');
  return loaded as unknown as NativeFilesModule;
};

const ourRoots = async () => (await helper().filesDriveRoots()).filter((root) => root.id.startsWith(`${PROVIDER}!`));

const bytesFor = (length: number) => Buffer.from(Array.from({ length }, (_, index) => (index * 7) % 256));

function readElsewhere(file: string): Promise<string> {
  const code = `try { process.stdout.write(require('crypto').createHash('sha256').update(require('fs').readFileSync(process.argv[1])).digest('hex')) } catch (e) { process.stdout.write('ERR ' + e.code) }`;
  return new Promise((resolve) => execFile(process.execPath, ['-e', code, file], { timeout: 60_000 }, (_error, stdout) => resolve(String(stdout))));
}

/** The test plays the page's engine: it claims the files bridge once, as the page does. */
const CLAIM = `window.__files ??= window.bulwarkDesktop.files.claim(); window.__files !== null`;

let profile: string;
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  profile = tempProfile('files-drive');
  ({ app, page } = await launchStandalone(profile, `--bulwark-test-files-provider=${PROVIDER}`, `--bulwark-test-files-drive-dir=${path.join(BASE, 'drive')}`, '--bulwark-test-files-letters=off', '--bulwark-test-files-fetch-timeout=5000', `--bulwark-test-policy-root=${POLICY_ROOT}`, '--bulwark-test-policy-poll=250'));
  await waitForLogin(page);
  // A webmail with the sync engine claims the files bridge in its first render, as it should.
  // These tests play the engine, so they take it in a same-origin document that doesn't.
  await page.goto(new URL('/pst-worker.js', page.url()).toString());
  expect(await page.evaluate(CLAIM)).toBe(true);
});

test.afterAll(async () => {
  await page?.evaluate(`window.__files?.drive?.disable(${JSON.stringify(ACCOUNT)}, 'user')`).catch(() => {});
  await app?.close().catch(() => {});
  for (const root of await ourRoots()) await helper().filesDriveUnregister(root.id).catch(() => {});
  rmSync(BASE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  removeProfile(profile);
  spawnSync('reg.exe', ['delete', POLICY_ROOT, '/f'], { windowsHide: true });
  expect(await ourRoots()).toEqual([]);
});

test('only the main window gets the drive: a pop-out of the same origin is refused in main', async () => {
  expect(await page.evaluate('window.__files.drive.state()')).toMatchObject({ supported: true, forcedOff: false, wanted: [] });
  const opened = app.waitForEvent('window');
  await page.evaluate(() => void window.open('/en/popout/compose?files-probe=1', 'files-probe'));
  const popout = await opened;
  await popout.waitForLoadState('domcontentloaded');
  await expect.poll(() => popout.evaluate('typeof window.bulwarkDesktop?.files?.claim')).toBe('function');
  const answer = await popout.evaluate(`(async () => {
    const files = window.bulwarkDesktop.files.claim();
    const tries = [() => files.drive.state(), () => files.drive.enable('x', 'x@example.org'), () => files.drive.place('r', []), () => files.drive.supply('f', 0, new Uint8Array(1))];
    const out = [];
    for (const call of tries) out.push(await call().then(() => 'answered', (error) => String(error.message)));
    return out;
  })()`);
  expect(answer).toEqual(Array(4).fill(expect.stringContaining('Not allowed')));
  await popout.close();
  expect(await ourRoots()).toEqual([]);
});

test('turning the drive on takes a real click and the yes to main\'s question; a script alone gets gesture and nothing registers', async () => {
  expect(await page.evaluate(`window.__files.drive.enable(${JSON.stringify(ACCOUNT)}, ${JSON.stringify(LABEL)})`)).toEqual({ ok: false, error: 'gesture' });
  expect(await ourRoots()).toEqual([]);

  // The user says yes when asked, and the question names the folder.
  await fakeOsIntegration(app, 0);
  await page.mouse.click(200, 400);
  const on = (await page.evaluate(`window.__files.drive.enable(${JSON.stringify(ACCOUNT)}, ${JSON.stringify(LABEL)})`)) as { ok: boolean; value: { id: string; path: string; kind: string } };
  expect(on).toMatchObject({ ok: true, value: { kind: 'drive', path: path.join(BASE, 'drive', LABEL) } });
  expect(await ourRoots()).toHaveLength(1);
  expect(await page.evaluate('window.__files.drive.state().then((state) => state.wanted)')).toEqual([ACCOUNT]);
  const asked = await prompts(app);
  expect(asked).toHaveLength(1);
  expect(asked[0].detail).toContain(path.join(BASE, 'drive', LABEL));

  // Explorer opens on the folder only on a click main saw.
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __openedPaths: string[] };
    g.__openedPaths = [];
    shell.openPath = async (target: string) => {
      g.__openedPaths.push(target);
      return '';
    };
  });
  expect(await page.evaluate(`window.__files.showInFolder(${JSON.stringify(on.value.id)}, '')`)).toBe(false);
  expect(await app.evaluate(() => (globalThis as unknown as { __openedPaths: string[] }).__openedPaths)).toEqual([]);
});

test("a file another program opens is fetched through the page's supply", async () => {
  const rootId = (await page.evaluate(`window.__files.drive.enable(${JSON.stringify(ACCOUNT)}, ${JSON.stringify(LABEL)}).then((answer) => answer.value.id)`)) as string;
  const size = 700_000;
  expect(await page.evaluate(`window.__files.drive.place(${JSON.stringify(rootId)}, [
    { path: 'Ordner mit Ümlaut', kind: 'directory', size: 0, mtimeMs: Date.now(), identity: 'd1' },
    { path: 'Ordner mit Ümlaut/Datei mit Leerzeichen.bin', kind: 'file', size: ${size}, mtimeMs: Date.now(), identity: 'f1' },
  ])`)).toEqual({ ok: true, value: [{ path: 'Ordner mit Ümlaut' }, { path: 'Ordner mit Ümlaut/Datei mit Leerzeichen.bin' }] });
  // The page's engine: on a fetch, the blob's bytes, from 0, in pieces.
  await page.evaluate(`(() => {
    window.__fetches = [];
    window.__files.drive.onFetch(async (request) => {
      window.__fetches.push(request);
      const data = new Uint8Array(request.total).map((_, index) => (index * 7) % 256);
      for (let at = 0; at < data.length; at += 200000) {
        if (!(await window.__files.drive.supply(request.fetchId, at, data.subarray(at, Math.min(at + 200000, data.length))))) return;
      }
    });
  })()`);
  const file = path.join(BASE, 'drive', LABEL, 'Ordner mit Ümlaut', 'Datei mit Leerzeichen.bin');
  expect(await readElsewhere(file)).toBe(createHash('sha256').update(bytesFor(size)).digest('hex'));
  expect(await page.evaluate('window.__fetches.map((request) => [request.path, request.identity, request.total])')).toEqual([['Ordner mit Ümlaut/Datei mit Leerzeichen.bin', 'f1', size]]);
});

test('turned off by the user: the sync root and its folder go, and the wish with them', async () => {
  await page.evaluate(`window.__files.drive.disable(${JSON.stringify(ACCOUNT)}, 'user')`);
  expect(await ourRoots()).toEqual([]);
  expect(existsSync(path.join(BASE, 'drive', LABEL))).toBe(false);
  expect(await page.evaluate('window.__files.drive.state().then((state) => state.wanted)')).toEqual([]);
});

test('FilesDriveEnabled forced off, live: the drive goes at once and the wish stays for when it is on again', async () => {
  // Turned off by the user before: turning it on asks again, and the user says yes.
  await fakeOsIntegration(app, 0);
  await page.mouse.click(200, 400);
  expect(await page.evaluate(`window.__files.drive.enable(${JSON.stringify(ACCOUNT)}, ${JSON.stringify(LABEL)}).then((answer) => answer.ok)`)).toBe(true);
  expect(await ourRoots()).toHaveLength(1);
  // The page is asked to upload what waits first, and says when it's done (files-p3-2).
  await page.evaluate(`window.__files.drive.onFlush((request) => {
    window.__flushes = (window.__flushes || []).concat([request.accounts]);
    window.__files.drive.flushed(request.requestId, 'working');
    setTimeout(() => window.__files.drive.flushed(request.requestId), 300);
  })`);
  const set = spawnSync('reg.exe', ['add', `${POLICY_ROOT}\\Machine`, '/v', 'FilesDriveEnabled', '/t', 'REG_DWORD', '/d', '0', '/f'], { windowsHide: true });
  expect(set.status).toBe(0);
  await expect.poll(ourRoots, { timeout: 30_000 }).toEqual([]);
  expect(await page.evaluate('window.__flushes')).toEqual([[ACCOUNT]]);
  expect(existsSync(path.join(BASE, 'drive', LABEL))).toBe(false);
  expect(await page.evaluate('window.__files.drive.state()')).toMatchObject({ forcedOff: true, wanted: [ACCOUNT] });
  expect(await page.evaluate(`window.__files.drive.enable(${JSON.stringify(ACCOUNT)}, ${JSON.stringify(LABEL)})`)).toEqual({ ok: false, error: 'policy' });

  spawnSync('reg.exe', ['delete', `${POLICY_ROOT}\\Machine`, '/v', 'FilesDriveEnabled', '/f'], { windowsHide: true });
  await expect.poll(() => page.evaluate('window.__files.drive.state().then((state) => state.forcedOff)'), { timeout: 30_000 }).toBe(false);
  // Back on: the wish brings it back without a click, as at a sign-in.
  expect(await page.evaluate(`window.__files.drive.enable(${JSON.stringify(ACCOUNT)}, ${JSON.stringify(LABEL)}).then((answer) => answer.ok)`)).toBe(true);
  expect(await ourRoots()).toHaveLength(1);
});

test.describe('clicks on an instance\'s page are not a yes to a folder of its files on this computer', () => {
  // An instance whose page turns the drive on at any click and writes files into it
  // (test/support/hostile-instance-2.ts). Every question is answered no.
  const ASK_PROVIDER = `Bulwark Test Ask ${process.pid}`;
  const ASK_BASE = path.join(tmpdir(), `bulwark-files-ask-${process.pid}`);
  const askRoots = async () => (await helper().filesDriveRoots()).filter((root) => root.id.startsWith(`${ASK_PROVIDER}!`));
  let hostile: HostileInstance;

  test.beforeAll(async () => {
    hostile = await startHostileInstance(3843);
  });
  test.afterAll(async () => {
    hostile?.close();
    for (const root of await askRoots()) await helper().filesDriveUnregister(root.id).catch(() => {});
    rmSync(ASK_BASE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  test('five clicks, every question answered no: no sync root, none of the page\'s files on disk, no Explorer window', async () => {
    const lootOf = (kind: string) => hostile.loot.filter((entry) => entry.kind === kind).map((entry) => entry.body);
    const askProfile = tempProfile('files-drive-ask');
    hostile.loot.length = 0;
    hostile.mode = 'drive';
    const instance = await launch(askProfile, `--instance=${hostile.origin}/`, '--ignore-certificate-errors', `--bulwark-test-files-provider=${ASK_PROVIDER}`, `--bulwark-test-files-drive-dir=${path.join(ASK_BASE, 'drive')}`, '--bulwark-test-files-letters=off');
    try {
      const shown = await shownPage(instance);
      await instance.evaluate(({ app: electronApp, shell }) => {
        electronApp.relaunch = () => undefined;
        const g = globalThis as unknown as { __openedPaths: string[] };
        g.__openedPaths = [];
        shell.openPath = async (target: string) => {
          g.__openedPaths.push(target);
          return '';
        };
        shell.showItemInFolder = (target: string) => {
          g.__openedPaths.push(target);
        };
      });
      await fakeOsIntegration(instance, 1);
      await expect.poll(() => lootOf('bridge').length).toBeGreaterThan(0);
      for (let click = 0; click < 5; click += 1) {
        await shown.mouse.click(400, 500);
        await shown.waitForTimeout(700);
      }
      // Time for the page's writes, had they been allowed.
      await shown.waitForTimeout(3000);
      const folder = path.join(ASK_BASE, 'drive', 'Invoices 2026');
      const found = existsSync(folder) ? readdirSync(folder) : [];
      expect.soft(found.filter((name) => DROPPED.some((file) => file.path === name)), 'files the page wrote').toEqual([]);
      expect.soft(await askRoots(), 'sync roots registered with Windows').toEqual([]);
      expect.soft(await instance.evaluate(() => (globalThis as unknown as { __openedPaths: string[] }).__openedPaths), 'folders Explorer was asked to open').toEqual([]);
      // Asked once, naming the server and the folder; the no holds for the clicks after it.
      const asked = await prompts(instance);
      expect(asked.map((question) => question.message)).toEqual([`Let ${new URL(hostile.origin).host} keep a folder of your files on this computer?`]);
      expect(asked[0].detail).toContain(path.join(ASK_BASE, 'drive', 'Invoices 2026'));
    } finally {
      await instance.close().catch(() => {});
      removeProfile(askProfile);
    }
  });
});
