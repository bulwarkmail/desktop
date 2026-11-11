import { spawnSync, type ChildProcess } from 'node:child_process';
import { createServer as createHttpServer, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createHash, X509Certificate } from 'node:crypto';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { generateCertificate } from '../src/main/cert';
import { APP_ORIGIN, askInWindows, fakeOsIntegration, launchStandalone, opened, plainRequest, prompts, removeProfile, serverPort, tempProfile, waitForLogin } from './helpers';

let profile = '';
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  profile = tempProfile('guards');
  ({ app, page } = await launchStandalone(profile, '--use-fake-device-for-media-stream'));
  await fakeOsIntegration(app);
  await waitForLogin(page);
});

test.afterAll(async () => {
  const child = app.process();
  // A question still open would hold the quit up, and nobody can click on the hidden desktop:
  // they're answered with their first button (Leave), and an open one goes. Each step has a
  // limit, and what is still running after them is ended.
  await within(fakeOsIntegration(app), 10_000);
  await within(closePrompts(app, true), 10_000);
  await within(app.close(), 30_000);
  endProcess(child);
  removeProfile(profile);
});

/** Waits for `work` at most `ms`, and never fails. */
function within(work: Promise<unknown>, ms: number): Promise<unknown> {
  return Promise.race([work.catch(() => {}), new Promise((resolve) => setTimeout(resolve, ms))]);
}

/** Ends an app still running. On Windows Playwright's process is a cmd.exe with Electron under it. */
function endProcess(child: ChildProcess): void {
  if (child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(child.pid)], { windowsHide: true });
  else child.kill('SIGKILL');
}

const allWindows = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

/** The shell's dialog windows load their page as this (src/main/dialog-window.ts). */
const DIALOG_PAGE = 'data:text/html;charset=utf-8;base64,';

/** The shell's dialog windows there are, as main sees them. One on its way out is gone. */
function leavePrompts(target: ElectronApplication): Promise<number> {
  return target.evaluate(({ BrowserWindow }, prefix) => BrowserWindow.getAllWindows().filter((w) => {
    try {
      return !w.isDestroyed() && !w.webContents.isDestroyed() && w.webContents.getURL().startsWith(prefix);
    } catch {
      return false;
    }
  }).length, DIALOG_PAGE);
}

/** Closes the shell's dialog windows as the OS would (no answer), or destroys them. */
function closePrompts(target: ElectronApplication, destroy = false): Promise<void> {
  return target.evaluate(({ BrowserWindow }, { prefix, hard }) => {
    for (const w of BrowserWindow.getAllWindows()) {
      try {
        if (w.isDestroyed() || w.webContents.isDestroyed() || !w.webContents.getURL().startsWith(prefix)) continue;
        if (hard) w.destroy();
        else w.close();
      } catch {
        // Already going.
      }
    }
  }, { prefix: DIALOG_PAGE, hard: destroy });
}

/** Questions already answered: Playwright may not have seen their windows go yet. */
const seenPrompts = new WeakSet<Page>();

/** The unsaved-changes question's window, drawn and ready for a click. */
async function leavePrompt(target: ElectronApplication): Promise<Page> {
  let found: Page | undefined;
  await expect
    .poll(async () => {
      for (const candidate of target.windows()) {
        if (seenPrompts.has(candidate) || candidate.isClosed() || !candidate.url().startsWith(DIALOG_PAGE)) continue;
        const title = await candidate.locator('#title').textContent().catch(() => '');
        if (title?.includes('unsaved')) {
          found = candidate;
          return true;
        }
      }
      return false;
    }, { timeout: 20_000 })
    .toBe(true);
  expect(await leavePrompts(target), 'one question').toBe(1);
  seenPrompts.add(found!);
  return found!;
}

test.describe('the embedded server', () => {
  test('a plain https request without the secret gets 403', async () => {
    const port = await serverPort(app);
    const answer = await plainRequest(port, '/api/health/live');
    expect(answer.status).toBe(403);
    expect(answer.body).toBe('Forbidden');
  });

  test('a wrong secret gets 403 too', async () => {
    const port = await serverPort(app);
    const answer = await plainRequest(port, '/api/config', { 'x-bulwark-launch': 'x'.repeat(43) });
    expect(answer.status).toBe(403);
  });

  test('the secret stays invisible to the page and to Next', async () => {
    const headers = await page.evaluate(async () => {
      const response = await fetch('/api/health/live');
      return { status: response.status, keys: [...response.headers.keys()] };
    });
    expect(headers.status).toBe(200);
    expect(headers.keys).not.toContain('x-bulwark-launch');
  });

  test('the launch secret is in no process argument', async () => {
    test.skip(process.platform !== 'win32', 'reads command lines through PowerShell');
    // The real value, from what Chromium sent.
    const [request] = await Promise.all([page.waitForRequest((r) => r.url().includes('/api/health/live')), page.evaluate(() => fetch('/api/health/live'))]);
    const secret = (await request.allHeaders())['x-bulwark-launch'];
    expect(secret, 'the header is on the wire').toBeTruthy();
    const pids = await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics().map((m) => m.pid));
    const script = `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { @(${pids.join(',')}) -contains $_.ProcessId } | ForEach-Object { $_.CommandLine }`;
    const run = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
    expect(run.stdout.length, 'command lines were read').toBeGreaterThan(100);
    expect(run.stdout).not.toContain(secret);
    expect(run.stdout).not.toContain('BEGIN PRIVATE KEY');
  });

  test('the session secret and admin password are in no environment block', async () => {
    test.skip(process.platform !== 'win32', 'reads the block through a Windows API');
    const server = await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics().find((m) => m.type === 'Utility' && m.name === 'Bulwark mail service')?.pid);
    expect(server, 'the server process').toBeTruthy();
    const run = spawnSync('powershell.exe', ['-NoProfile', '-File', path.join(import.meta.dirname, 'support', 'process-env-names.ps1'), '-TargetPid', String(server)], { encoding: 'utf8' });
    const names = run.stdout.split(/\r?\n/).filter(Boolean);
    expect(names, 'the block was read').toContain('ADMIN_CONFIG_DIR');
    expect(names).not.toContain('SESSION_SECRET');
    expect(names).not.toContain('ADMIN_PASSWORD');
    // And they still got there: the local admin signs in, and cookies are sealed.
    await fakeOsIntegration(app);
    const answer = await page.evaluate(() => (window as unknown as { bulwarkDesktop: { plugins: { install: (s: string) => Promise<unknown> } } }).bulwarkDesktop.plugins.install('bulwark-no-such-plugin-xyz'));
    expect(answer).toMatchObject({ ok: false, error: 'not_found' });
    expect(existsSync(path.join(profile, 'webmail', 'admin-state', '.session-secret')), 'no secret of its own').toBe(false);
  });

  test('the forwarding route refuses a navigation at the server too', async () => {
    const port = await serverPort(app);
    // The secret alone isn't enough: this is what a document request would look like.
    const [request] = await Promise.all([page.waitForRequest((r) => r.url().includes('/api/health/live')), page.evaluate(() => fetch('/api/health/live'))]);
    const secret = (await request.allHeaders())['x-bulwark-launch'];
    const id = Buffer.from('http://127.0.0.1:1').toString('base64url');
    const answer = await plainRequest(port, `/__jmap/${id}/x`, { 'x-bulwark-launch': secret, 'sec-fetch-dest': 'document', 'sec-fetch-site': 'same-origin' });
    expect(answer.status).toBe(403);
  });

  test('it listens on loopback only', async () => {
    const port = await serverPort(app);
    const { networkInterfaces } = await import('node:os');
    const external = Object.values(networkInterfaces()).flat().find((i) => i && !i.internal && i.family === 'IPv4')?.address;
    test.skip(!external, 'no other interface here');
    const code = await new Promise<string>((resolve) => {
      import('node:net').then(({ connect }) => {
        const socket = connect({ host: external, port, timeout: 3000 });
        socket.once('connect', () => { socket.destroy(); resolve('connected'); });
        socket.once('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'error'));
        socket.once('timeout', () => { socket.destroy(); resolve('timeout'); });
      });
    });
    expect(code).not.toBe('connected');
  });

  test('the session cookie secret and admin credential are never in plain text on disk', () => {
    const profileKeys = path.join(profile, 'keys');
    for (const name of ['session-secret.bin', 'admin-credential.bin', 'tls-key.bin']) {
      const raw = readFileSync(path.join(profileKeys, name));
      // DPAPI blobs start with this version header, and hold no PEM or base64url run.
      expect(raw.toString('latin1')).not.toContain('BEGIN PRIVATE KEY');
      expect(raw.length).toBeGreaterThan(40);
    }
  });
});

test.describe('window prefs', () => {
  test('sandboxed, isolated, no node, web security on', async () => {
    const preferences = await app.evaluate(({ BrowserWindow }) => {
      const { sandbox, contextIsolation, nodeIntegration, webSecurity, allowRunningInsecureContent, webviewTag } = (BrowserWindow.getAllWindows()[0].webContents as unknown as { getLastWebPreferences(): Electron.WebPreferences }).getLastWebPreferences();
      return { sandbox, contextIsolation, nodeIntegration, webSecurity, allowRunningInsecureContent, webviewTag };
    });
    expect(preferences).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false });
  });

  test('on the persist:bulwark session', async () => {
    const same = await app.evaluate(({ BrowserWindow, session }) => BrowserWindow.getAllWindows()[0].webContents.session === session.fromPartition('persist:bulwark'));
    expect(same).toBe(true);
  });

  test('the origin is https://app.bulwark.localhost and a secure context', async () => {
    const context = await page.evaluate(() => ({ origin: location.origin, secure: isSecureContext }));
    expect(context).toEqual({ origin: APP_ORIGIN, secure: true });
  });

  test('the page sees the versioned bridge, narrow', async () => {
    const shape = await page.evaluate(() => {
      const b = (window as unknown as { bulwarkDesktop: Record<string, unknown> }).bulwarkDesktop;
      return { version: b.version, platform: b.platform, keys: Object.keys(b).sort() };
    });
    expect(shape.version).toBe(1);
    expect(shape.platform).toBe(process.platform);
    // `keystore` is only there where the native helper loaded: keystore-bridge.spec.ts.
    expect(shape.keys.filter((key: string) => key !== 'keystore')).toEqual(['appLock', 'auth', 'certificates', 'clipboard', 'devTools', 'dialogs', 'edit', 'files', 'httpCache', 'lifecycle', 'localImport', 'menu', 'mode', 'os', 'platform', 'plugins', 'policy', 'print', 'privacy', 'recentFiles', 'saveAs', 'servers', 'shell', 'spellcheck', 'theme', 'updates', 'version', 'windows']);
  });

  test('a frame gets no bridge of its own: a same-origin one can reach the parent\'s, an opaque one cannot', async () => {
    const seen = await page.evaluate(async () => {
      type W = { bulwarkDesktop?: unknown; parent: W };
      const same = document.createElement('iframe');
      same.srcdoc = '<p>frame</p>';
      document.body.appendChild(same);
      await new Promise((resolve) => (same.onload = resolve));
      const own = typeof (same.contentWindow as unknown as W).bulwarkDesktop;
      // Honest about it: this is why nothing on the bridge may do harm on a call alone (ipc.ts).
      const viaParent = typeof (same.contentWindow as unknown as W).parent.bulwarkDesktop;
      same.remove();
      return { own, viaParent };
    });
    // The page's CSP keeps inline script out of a frame, so this one is entered from outside.
    await page.evaluate(() => {
      const opaque = document.createElement('iframe');
      opaque.id = 'opaque-frame';
      opaque.setAttribute('sandbox', 'allow-scripts');
      opaque.srcdoc = '<p>opaque</p>';
      document.body.appendChild(opaque);
    });
    const handle = await page.waitForSelector('#opaque-frame', { state: 'attached' });
    const frame = await handle.contentFrame();
    const opaque = await frame!.evaluate(() => {
      try {
        return typeof (parent as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop;
      } catch (error) {
        return (error as Error).name;
      }
    });
    await handle.evaluate((node) => node.remove());
    expect(seen.own).toBe('undefined');
    expect(seen.viaParent).toBe('object');
    expect(opaque).toBe('SecurityError');
  });

  test('a bridge call from a frame that is not the main frame is refused in main', async () => {
    const denied = await app.evaluate(async ({ BrowserWindow, ipcMain }, origin) => {
      const handler = (ipcMain as unknown as { _invokeHandlers: Map<string, (e: unknown) => unknown> })._invokeHandlers.get('bulwark:windows.list')!;
      const window = BrowserWindow.getAllWindows()[0];
      const outcome = async (senderFrame: unknown) => {
        try {
          await handler({ sender: window.webContents, senderFrame });
          return 'allowed';
        } catch (error) {
          return (error as Error).message;
        }
      };
      return {
        subframe: await outcome({ url: `${origin}/en/login`, parent: { url: origin } }),
        foreign: await outcome({ url: 'https://evil.example/', parent: null }),
        main: await outcome({ url: `${origin}/en/login`, parent: null }),
      };
    }, APP_ORIGIN);
    expect(denied).toEqual({ subframe: 'Not allowed', foreign: 'Not allowed', main: 'allowed' });
  });

  test('each of the import channels goes through the same check', async () => {
    // A raw ipcMain.handle in the feature would answer a frame. These can read files.
    const channels = ['scan', 'grant', 'resume', 'release', 'releaseAll'].map((name) => `bulwark:localImport.${name}`);
    const refused = await app.evaluate(async ({ BrowserWindow, ipcMain }, { origin, channels: names }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (e: unknown) => unknown> })._invokeHandlers;
      const window = BrowserWindow.getAllWindows()[0];
      const outcome = async (name: string, senderFrame: unknown) => {
        const handler = handlers.get(name);
        if (!handler) return 'no handler';
        try {
          await handler({ sender: window.webContents, senderFrame });
          return 'allowed';
        } catch (error) {
          return (error as Error).message;
        }
      };
      const out: Record<string, string[]> = {};
      for (const name of names) {
        out[name] = [
          await outcome(name, { url: `${origin}/en/login`, parent: { url: origin } }),
          await outcome(name, { url: 'https://evil.example/', parent: null }),
        ];
      }
      return out;
    }, { origin: APP_ORIGIN, channels });
    for (const name of channels) expect(refused[name], name).toEqual(['Not allowed', 'Not allowed']);
  });

  test('no reload or devtools from the keyboard', async () => {
    await page.evaluate(() => ((window as unknown as { __marker: number }).__marker = 1));
    for (const key of ['F5', 'Control+R', 'Control+Shift+R', 'Control+Shift+I', 'F12']) await page.keyboard.press(key);
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => (window as unknown as { __marker?: number }).__marker)).toBe(1);
    const devTools = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().sort((x, y) => x.id - y.id)[0].webContents.isDevToolsOpened());
    expect(devTools).toBe(false);
  });

  test('the application menu has no reload or devtools item', async () => {
    const roles = await app.evaluate(({ Menu }) => {
      const walk = (menu: Electron.Menu | null): string[] =>
        (menu?.items ?? []).flatMap((item) => [String(item.role ?? ''), ...walk(item.submenu ?? null)]);
      return walk(Menu.getApplicationMenu());
    });
    const lower = roles.map((role) => role.toLowerCase());
    expect(lower).toContain('copy');
    for (const banned of ['reload', 'forcereload', 'toggledevtools']) expect(lower).not.toContain(banned);
  });
});

test.describe('window-open guard', () => {
  test('an external URL goes to the system browser, with no new window', async () => {
    const before = await allWindows();
    const handle = await page.evaluate(() => window.open('https://example.com/from-app', '_blank') === null);
    expect(handle).toBe(true);
    await expect.poll(() => opened(app)).toContain('https://example.com/from-app');
    expect(await allWindows()).toBe(before);
  });

  test('javascript: and file: are refused and opened nowhere', async () => {
    const before = (await opened(app)).length;
    const windows = await allWindows();
    await page.evaluate(() => {
      window.open('javascript:alert(1)');
      window.open('file:///C:/Windows/win.ini');
    });
    await page.waitForTimeout(400);
    expect((await opened(app)).length).toBe(before);
    expect(await allWindows()).toBe(windows);
  });

  test('about:blank opens, document.write works (print needs both), and it has no bridge', async () => {
    const result = await Promise.all([
      app.waitForEvent('window'),
      page.evaluate(() => {
        const child = window.open('', '_blank')!;
        child.document.write('<title>printed</title><p id="x">body</p>');
        child.document.close();
        return { wrote: child.document.getElementById('x')?.textContent, bridge: typeof (child as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop };
      }),
    ]);
    expect(result[1]).toEqual({ wrote: 'body', bridge: 'undefined' });
    await result[0].close();
  });

  test('a blob: preview opens, with noopener as the webmail does it', async () => {
    const [child] = await Promise.all([
      app.waitForEvent('window'),
      page.evaluate(() => {
        const url = URL.createObjectURL(new Blob(['<p id="b">preview</p>'], { type: 'text/html' }));
        return window.open(url, '_blank', 'noopener,noreferrer') === null;
      }),
    ]);
    await child.waitForLoadState();
    expect(await child.textContent('#b')).toBe('preview');
    expect(await child.evaluate(() => typeof (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop)).toBe('undefined');
    // Past when the frame check runs: it stays this window.
    await child.waitForTimeout(2000).catch(() => undefined);
    expect(child.isClosed()).toBe(false);
    await child.close();
  });

  test('a /popout/ route opens in the app, on the app session', async () => {
    const before = await allWindows();
    const [child] = await Promise.all([
      app.waitForEvent('window'),
      page.evaluate(() => {
        window.open('/en/login?popout=1', 'bulwark-message-test1', 'popup=yes,width=500,height=500');
      }),
    ]);
    expect(await allWindows()).toBe(before + 1);
    await child.close();
  });
});

test.describe('the window manager', () => {
  async function closeAllButMain() {
    await app.evaluate(({ BrowserWindow }) => {
      // getAllWindows has no fixed order. The main window is the oldest.
      const all = BrowserWindow.getAllWindows();
      const oldest = Math.min(...all.map((w) => w.id));
      for (const window of all) if (window.id !== oldest) window.destroy();
    });
  }

  test.afterEach(closeAllButMain);

  const bridgeOpen = (url: string, name: string) =>
    page.evaluate(
      ([u, n]) => (window as unknown as { bulwarkDesktop: { windows: { open: (url: string, o: object) => void } } }).bulwarkDesktop.windows.open(u, { name: n, width: 700, height: 600 }),
      [url, name],
    );

  const listed = () => page.evaluate(() => (window as unknown as { bulwarkDesktop: { windows: { list: () => Promise<{ type: string; title: string }[]> } } }).bulwarkDesktop.windows.list());

  test('one window per message: opening it again focuses the same one', async () => {
    const before = await allWindows();
    await bridgeOpen('/popout/message/m1?x=1', 'bulwark-message-m1');
    await expect.poll(allWindows).toBe(before + 1);
    expect((await listed()).map((w) => w.type)).toContain('message');
    await bridgeOpen('/popout/message/m1?x=1', 'bulwark-message-m1');
    await page.waitForTimeout(300);
    expect(await allWindows()).toBe(before + 1);
    await bridgeOpen('/popout/message/m2', 'bulwark-message-m2');
    await expect.poll(allWindows).toBe(before + 2);
  });

  test('openMessage keys on the message', async () => {
    const before = await allWindows();
    const open = (id: string) =>
      page.evaluate(
        (emailId) => (window as unknown as { bulwarkDesktop: { windows: { openMessage: (t: object) => void } } }).bulwarkDesktop.windows.openMessage({ url: `/popout/message/${emailId}`, emailId }),
        id,
      );
    await open('m9');
    await open('m9');
    await expect.poll(allWindows).toBe(before + 1);
  });

  test('a bridge call can only open the app\'s own routes', async () => {
    const before = await allWindows();
    await bridgeOpen('https://example.com/phish', 'x');
    await bridgeOpen('file:///C:/Windows/win.ini', 'y');
    await bridgeOpen('/api/health/live', 'z');
    await bridgeOpen('/__jmap/abc/mail.html', 'j');
    await page.waitForTimeout(300);
    expect(await allWindows()).toBe(before);
  });

  test('new windows of a type cascade', async () => {
    await bridgeOpen('/popout/message/c1', 'c1');
    await bridgeOpen('/popout/message/c2', 'c2');
    await expect.poll(allWindows).toBe(3);
    const bounds = await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().sort((x, y) => y.id - x.id).slice(0, 2).map((w) => w.getBounds()),
    );
    expect(Math.abs(bounds[0].x - bounds[1].x)).toBeGreaterThan(0);
    expect(Math.abs(bounds[0].y - bounds[1].y)).toBeGreaterThan(0);
  });

  test('new windows are hidden until they have painted, with the theme\'s background', async () => {
    const seen = await app.evaluate(async ({ BrowserWindow, app: electronApp }) => {
      const result: { visibleOnCreate?: boolean; visibleAtReady?: boolean; background?: string } = {};
      void electronApp;
      const created = new Promise<void>((resolve) => {
        const listener = (_event: unknown, window: Electron.BrowserWindow) => {
          electronApp.removeListener('browser-window-created', listener);
          result.visibleOnCreate = window.isVisible();
          result.background = window.getBackgroundColor();
          window.once('ready-to-show', () => {
            result.visibleAtReady = window.isVisible();
            resolve();
          });
        };
        electronApp.on('browser-window-created', listener);
      });
      const main = BrowserWindow.getAllWindows().sort((x, y) => x.id - y.id)[0];
      void main.webContents.executeJavaScript(
        "window.bulwarkDesktop.windows.open('/en/login?flash=1', {name:'flash', width: 500, height: 500})",
      );
      await created;
      return result;
    });
    expect(seen.visibleOnCreate).toBe(false);
    expect(seen.visibleAtReady).toBe(false);
    expect(seen.background).toMatch(/^#[0-9A-F]{6,8}$/i);
  });

  test('a window that is closed comes back with its size', async () => {
    await bridgeOpen('/popout/message/s1', 's1');
    await expect.poll(allWindows).toBe(2);
    await app.evaluate(async ({ BrowserWindow }) => {
      const newest = BrowserWindow.getAllWindows().sort((x, y) => y.id - x.id)[0];
      newest.setBounds({ width: 777, height: 555 });
      await new Promise((resolve) => setTimeout(resolve, 100));
      newest.close();
    });
    await expect.poll(allWindows).toBe(1);
    await bridgeOpen('/popout/message/s2', 's2');
    await expect.poll(allWindows).toBe(2);
    const size = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().sort((x, y) => y.id - x.id)[0].getBounds());
    // Device pixels: one off is rounding on a scaled display.
    expect(Math.abs(size.width - 777)).toBeLessThanOrEqual(4);
    expect(Math.abs(size.height - 555)).toBeLessThanOrEqual(4);

    // And it doesn't creep from one window to the next.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().sort((x, y) => y.id - x.id)[0].close());
    await expect.poll(allWindows).toBe(1);
    await bridgeOpen('/popout/message/s3', 's3');
    await expect.poll(allWindows).toBe(2);
    const again = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().sort((x, y) => y.id - x.id)[0].getBounds());
    expect(again.width).toBe(size.width);
    expect(again.height).toBe(size.height);
  });
});

test.describe('the theme', () => {
  test('a page colour reaches the window and the stored theme, and a bad value is ignored', async () => {
    const setTheme = (theme: unknown) =>
      page.evaluate((value) => (window as unknown as { bulwarkDesktop: { theme: { set: (t: unknown) => void } } }).bulwarkDesktop.theme.set(value), theme);
    await setTheme({ dark: true, background: 'rgb(16, 32, 48)' });
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().sort((x, y) => x.id - y.id)[0].getBackgroundColor())).toBe('#102030');
    await setTheme({ dark: false, background: 'url(evil)' });
    await page.waitForTimeout(200);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().sort((x, y) => x.id - y.id)[0].getBackgroundColor())).toBe('#102030');
  });

  test('the OS switching themes reaches the page', async () => {
    await page.evaluate(() => {
      const w = window as unknown as { __system?: unknown; bulwarkDesktop: { theme: { onSystemChange: (f: (s: unknown) => void) => void } } };
      w.bulwarkDesktop.theme.onSystemChange((system) => (w.__system = system));
    });
    const expected = await app.evaluate(({ nativeTheme }) => {
      const dark = !nativeTheme.shouldUseDarkColors;
      nativeTheme.themeSource = dark ? 'dark' : 'light';
      return dark;
    });
    await expect.poll(() => page.evaluate(() => (window as unknown as { __system?: { dark: boolean } }).__system?.dark)).toBe(expected);
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = 'system';
    });
  });
});

test.describe('leaving a page with unsaved changes', () => {
  // The real question: a Bulwark window (src/main/message-box.ts), clicked as the user would.
  test.beforeAll(() => askInWindows(app, true));
  test.afterAll(() => askInWindows(app, false));

  /** Chromium only asks after the user touched the page. */
  async function makeDirty(target = page) {
    await target.click('body', { position: { x: 5, y: 5 } });
    await target.evaluate(() => window.addEventListener('beforeunload', (event) => event.preventDefault()));
  }

  async function dirtyPage(query = 'dirty=1') {
    await page.goto(`${APP_ORIGIN}/en/login?${query}`);
    await waitForLogin(page);
    await makeDirty();
  }

  /** The page's own navigation, which waits for the question: not awaited. */
  function go(target: Page, script: () => void) {
    void target.evaluate(script).catch(() => {});
  }

  async function answer(prompt: Page, button: 'Leave' | 'Stay', target = app) {
    await prompt.locator('button.button', { hasText: button }).click();
    await expect.poll(() => leavePrompts(target)).toBe(0);
  }

  test('a page going elsewhere asks in a Bulwark window: Stay keeps the page, Leave goes where it was going', async () => {
    await dirtyPage();
    go(page, () => location.assign('/en/login?left=1'));
    await answer(await leavePrompt(app), 'Stay');
    expect(page.url()).toContain('dirty=1');

    go(page, () => location.assign('/en/login?left=1'));
    await answer(await leavePrompt(app), 'Leave');
    await expect(page).toHaveURL(/left=1/);
    await waitForLogin(page);
    expect(await prompts(app), 'nothing went to the OS dialog').toEqual([]);
  });

  test('Esc and closing the question are Stay', async () => {
    await dirtyPage();
    go(page, () => location.assign('/en/login?left=1'));
    const first = await leavePrompt(app);
    // The window goes on the key's way down: its way up has nowhere to go.
    await first.keyboard.press('Escape').catch(() => {});
    await expect.poll(() => leavePrompts(app)).toBe(0);
    expect(page.url()).toContain('dirty=1');

    go(page, () => location.replace('/en/login?left=2'));
    await leavePrompt(app);
    await closePrompts(app);
    await expect.poll(() => leavePrompts(app)).toBe(0);
    await page.waitForTimeout(500);
    expect(page.url()).toContain('dirty=1');

    // Still unsaved: a replace goes too, and takes the entry's place.
    const entries = await page.evaluate(() => history.length);
    go(page, () => location.replace('/en/login?left=2'));
    await answer(await leavePrompt(app), 'Leave');
    await expect(page).toHaveURL(/left=2/);
    expect(await page.evaluate(() => history.length)).toBe(entries);
    await waitForLogin(page);
  });

  test('a reload reloads and a step back goes back', async () => {
    await page.goto(`${APP_ORIGIN}/en/login?before=1`);
    await waitForLogin(page);
    await dirtyPage();
    await page.evaluate(() => ((window as unknown as { __here?: boolean }).__here = true));
    // The menu's Reload: the shell starts it.
    void app.evaluate(({ BrowserWindow }) => {
      for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().includes('dirty=1')) w.webContents.reload();
    });
    await answer(await leavePrompt(app), 'Leave');
    await expect.poll(() => page.evaluate(() => (window as unknown as { __here?: boolean }).__here ?? false).catch(() => true)).toBe(false);
    expect(page.url()).toContain('dirty=1');
    await waitForLogin(page);

    await makeDirty();
    go(page, () => history.back());
    await answer(await leavePrompt(app), 'Leave');
    await expect(page).toHaveURL(/before=1/);
    await waitForLogin(page);
  });

  test('quitting while it asks keeps the question: Stay keeps the app, Leave quits', async () => {
    const own = tempProfile('leave-quit');
    const launched = await launchStandalone(own);
    const child = launched.app.process();
    const quit = () => void launched.app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => {});
    try {
      await launched.app.evaluate(({ shell }) => {
        shell.openExternal = async () => {};
      });
      await launched.page.goto(`${APP_ORIGIN}/en/login?dirty=1`);
      await waitForLogin(launched.page);
      await makeDirty(launched.page);
      go(launched.page, () => location.assign('/en/login?left=1'));
      const asked = await leavePrompt(launched.app);
      // The tray's Quit, say. The quit closes nothing while the page asks.
      quit();
      await launched.page.waitForTimeout(3000);
      expect(asked.isClosed(), 'the same question').toBe(false);
      expect(await leavePrompts(launched.app)).toBe(1);
      await answer(asked, 'Stay', launched.app);
      await launched.page.waitForTimeout(2000);
      expect(child.exitCode, 'Stay keeps the app').toBeNull();
      expect(launched.page.url()).toContain('dirty=1');

      // Quitting asks on its own now, and Leave quits.
      quit();
      const again = await leavePrompt(launched.app);
      await again.locator('button.button', { hasText: 'Leave' }).click();
      await expect.poll(() => child.exitCode, { timeout: 30_000 }).not.toBeNull();
    } finally {
      endProcess(child);
      removeProfile(own);
    }
  });

  test('quitting while it asks, then Leave, quits', async () => {
    const own = tempProfile('leave-quit');
    const launched = await launchStandalone(own);
    const child = launched.app.process();
    try {
      await launched.app.evaluate(({ shell }) => {
        shell.openExternal = async () => {};
      });
      await launched.page.goto(`${APP_ORIGIN}/en/login?dirty=1`);
      await waitForLogin(launched.page);
      await makeDirty(launched.page);
      go(launched.page, () => location.assign('/en/login?left=1'));
      const asked = await leavePrompt(launched.app);
      void launched.app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => {});
      await launched.page.waitForTimeout(3000);
      expect(child.exitCode).toBeNull();
      await asked.locator('button.button', { hasText: 'Leave' }).click();
      await expect.poll(() => child.exitCode, { timeout: 30_000 }).not.toBeNull();
    } finally {
      endProcess(child);
      removeProfile(own);
    }
  });
});

test.describe('navigation guard', () => {
  test('leaving the origin is stopped, and goes to the system browser', async () => {
    const url = page.url();
    await page.evaluate(() => {
      location.href = 'https://example.org/left-the-app';
    });
    await expect.poll(() => opened(app)).toContain('https://example.org/left-the-app');
    expect(page.url()).toBe(url);
  });

  test('the forwarding route never loads as a page, whether by navigation or window.open', async () => {
    const url = page.url();
    const before = (await opened(app)).length;
    const windows = await allWindows();
    await page.evaluate(() => {
      location.href = '/__jmap/aHR0cDovL3g/evil.html';
    });
    const handle = await page.evaluate(() => window.open('/__jmap/aHR0cDovL3g/evil.html', '_blank') === null);
    await page.waitForTimeout(500);
    expect(handle).toBe(true);
    expect(page.url()).toBe(url);
    expect(await allWindows()).toBe(windows);
    expect((await opened(app)).length).toBe(before);
  });

  test('tel: and sms: links open through the OS on a click, xmpp: never, and none from a script alone', async () => {
    const before = (await opened(app)).length;
    await page.evaluate(() => {
      for (const href of ['tel:+4900001', 'sms:+4900001', 'xmpp:b@example.org']) window.open(href, '_blank');
    });
    await page.waitForTimeout(500);
    expect((await opened(app)).slice(before), 'opened by a script alone').toEqual([]);
    for (const href of ['tel:+4912345', 'sms:+4912345', 'xmpp:a@example.org']) {
      // A real click first, which main sees reach the window.
      await page.mouse.click(5, 300);
      await page.evaluate((target) => void window.open(target, '_blank'), href);
    }
    await expect.poll(() => opened(app)).toEqual(expect.arrayContaining(['tel:+4912345', 'sms:+4912345']));
    expect(await opened(app)).not.toContain('xmpp:a@example.org');
  });

  test('a provider logout that is blocked does not leave the window stuck', async () => {
    await page.goto(`${APP_ORIGIN}/en/login?stuck=1`);
    await waitForLogin(page);
    await page.evaluate(() => {
      location.href = 'https://idp.example/oidc/logout?post_logout_redirect_uri=https%3A%2F%2Fother.example';
    });
    await expect.poll(() => opened(app)).toContain('https://idp.example/oidc/logout?post_logout_redirect_uri=https%3A%2F%2Fother.example');
    await expect(page).not.toHaveURL(/stuck=1/);
    await expect(page).toHaveURL(new RegExp(`^${APP_ORIGIN}/`));
  });
});

test.describe('permissions', () => {
  test('granted only for what the app uses, by the handler itself', async () => {
    await page.goto(`${APP_ORIGIN}/en/login`);
    await page.bringToFront();
    const results = await page.evaluate(async () => {
      const state = async (name: string) => (await navigator.permissions.query({ name: name as PermissionName })).state;
      const denied = async (fn: () => Promise<unknown>) => fn().then(() => 'granted', (e) => e.name);
      return {
        notifications: await Notification.requestPermission(),
        persist: await navigator.storage.persist(),
        // A fake camera exists (launch switch), so a refusal can only be the handler's.
        devices: (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput').length,
        camera: await denied(() => navigator.mediaDevices.getUserMedia({ video: true })),
        clipboardRead: await denied(() => navigator.clipboard.readText()),
        queryCamera: await state('camera'),
        queryGeo: await state('geolocation'),
        queryNotifications: await state('notifications'),
        geo: await new Promise((resolve) => navigator.geolocation.getCurrentPosition(() => resolve('granted'), (e) => resolve(e.code), { timeout: 3000 })),
      };
    });
    expect(results.notifications).toBe('granted');
    expect(results.persist).toBe(true);
    expect(results.queryNotifications).toBe('granted');
    expect(results.devices).toBeGreaterThan(0);
    expect(results.camera).toBe('NotAllowedError');
    expect(results.clipboardRead).toBe('NotAllowedError');
    expect(results.queryCamera).toBe('denied');
    expect(results.queryGeo).toBe('denied');
    expect(results.geo).toBe(1); // PERMISSION_DENIED, not a timeout
  });

  test('a same-origin frame gets nothing, even what its origin may have', async () => {
    const result = await page.evaluate(async () => {
      const frame = document.createElement('iframe');
      frame.srcdoc = '<p>frame</p>';
      document.body.appendChild(frame);
      await new Promise((resolve) => (frame.onload = resolve));
      const w = frame.contentWindow as unknown as Window & typeof globalThis;
      const query = (await w.navigator.permissions.query({ name: 'notifications' })).state;
      const top = (await navigator.permissions.query({ name: 'notifications' })).state;
      frame.remove();
      return { query, top };
    });
    expect(result.top).toBe('granted');
    expect(result.query).toBe('denied');
  });
});

test.describe('the local admin', () => {
  test('the admin cookie is never in the renderer\'s jar, after a real admin call', async () => {
    await fakeOsIntegration(app);
    const answer = await page.evaluate(() => (window as unknown as { bulwarkDesktop: { plugins: { install: (s: string) => Promise<unknown> } } }).bulwarkDesktop.plugins.install('bulwark-no-such-plugin-xyz'));
    expect(answer).toMatchObject({ ok: false, error: 'not_found' });
    // Nothing to name, so nothing to ask about.
    expect(await prompts(app)).toEqual([]);
    const cookies = await app.evaluate(async ({ session }) => (await session.fromPartition('persist:bulwark').cookies.get({})).map((c) => c.name));
    expect(cookies).not.toContain('admin_session');
    expect(cookies).not.toContain('admin_device');
  });

  test('a real plugin from the directory installs through the admin route, with its checks', async () => {
    await fakeOsIntegration(app);
    const answer = (await page.evaluate(() =>
      (window as unknown as { bulwarkDesktop: { plugins: { install: (s: string) => Promise<unknown> } } }).bulwarkDesktop.plugins.install('languagetool'),
    )) as { ok: boolean; id?: string; error?: string };
    expect(answer, JSON.stringify(answer)).toMatchObject({ ok: true });
    // It asked first, naming it, who it's from and what it may do, with Cancel on Enter.
    const asked = (await prompts(app)) as unknown as { message: string; detail: string; defaultId: number; cancelId: number; buttons: string[]; type: string }[];
    expect(asked).toHaveLength(1);
    expect(asked[0].message).toContain('Proofreading (LanguageTool)');
    expect(asked[0].detail).toContain('Bulwark');
    expect(asked[0].detail).toContain('Check what you write');
    expect(asked[0].defaultId).toBe(1);
    expect(asked[0].cancelId).toBe(1);
    expect(asked[0].buttons[1]).toBe('Cancel');
    const installed = path.join(profile, 'webmail', 'admin', 'plugins');
    expect(readdirSync(installed).join()).toContain(answer.id);
    // Signed with this install's own key, in the profile.
    expect(existsSync(path.join(profile, 'webmail', 'admin', 'plugin-signing.key'))).toBe(true);
    const cookies = await app.evaluate(async ({ session }) => (await session.fromPartition('persist:bulwark').cookies.get({})).map((c) => c.name));
    expect(cookies).not.toContain('admin_session');
  });

  test('a declined prompt installs nothing', async () => {
    await fakeOsIntegration(app, 1);
    const answer = await page.evaluate(() => (window as unknown as { bulwarkDesktop: { plugins: { install: (s: string) => Promise<unknown> } } }).bulwarkDesktop.plugins.install('languagetool'));
    expect(answer).toEqual({ ok: false, error: 'cancelled' });
    await fakeOsIntegration(app);
  });

  test('the renderer has no way in by itself', async () => {
    const status = await page.evaluate(() => fetch('/api/admin/plugins').then((r) => r.status));
    expect(status).toBe(401);
  });

  test('page script cannot burn the admin login attempts and lock main out', async () => {
    const statuses = await page.evaluate(async () => {
      const out: number[] = [];
      for (let i = 0; i < 7; i += 1) {
        out.push((await fetch('/api/admin/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"password":"wrong"}' })).status);
      }
      return out;
    });
    expect(new Set(statuses)).toEqual(new Set([403]));
    // Main signed in before this test, so make it sign in again: a new session's worth.
    const answer = await page.evaluate(() => (window as unknown as { bulwarkDesktop: { plugins: { install: (s: string) => Promise<unknown> } } }).bulwarkDesktop.plugins.install('bulwark-no-such-plugin-xyz'));
    expect(answer).toMatchObject({ error: 'not_found' });
  });
});

test.describe('the desktop profile', () => {
  test('setup is skipped, custom servers are on, and plugins are on with no local approval', async () => {
    const config = await page.evaluate(() => fetch('/api/config').then((r) => r.json()));
    expect(config.allowCustomJmapEndpoint).toBe(true);
    const policy = await page.evaluate(() => fetch('/api/admin/policy').then((r) => r.json()));
    expect(policy.features?.pluginsEnabled ?? policy.pluginsEnabled).toBe(true);
    const seeded = JSON.parse(readFileSync(path.join(profile, 'webmail', 'admin', 'policy.json'), 'utf8'));
    expect(seeded.features).toMatchObject({ pluginsEnabled: true, pluginsUploadEnabled: true, requirePluginApproval: false });
    expect(page.url()).not.toContain('/setup');
  });

  test('pairing and hand-off are gone', async () => {
    const statuses = await page.evaluate(async () => {
      const out: Record<string, number> = {};
      for (const route of ['pair/status?code=x', 'pair/redeem', 'handoff/redeem', 'pair/create']) {
        out[route] = await fetch(`/api/auth/${route}`, { method: route.includes('?') ? 'GET' : 'POST' }).then((r) => r.status);
      }
      return out;
    });
    for (const [route, status] of Object.entries(statuses)) expect(status, route).toBe(404);
  });
});

test.describe('CORS for an account\'s server', () => {
  const certificate = generateCertificate('127.0.0.1');
  let server: ReturnType<typeof createHttpsServer>;
  let origin = '';
  let options = 0;

  test.beforeAll(async () => {
    server = createHttpsServer({ key: certificate.keyPem, cert: certificate.certPem }, (req, res) => {
      if (req.method === 'OPTIONS') {
        options += 1;
        res.writeHead(405).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ reached: true, authorization: req.headers.authorization }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `https://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // The test server isn't publicly trusted: let this session accept it alone.
    const appCert = readFileSync(path.join(profile, 'keys', 'app-cert.pem'), 'utf8');
    const fingerprint = `sha256/${createHash('sha256').update(new X509Certificate(appCert).raw).digest('base64')}`;
    await app.evaluate(({ session }, pin) => {
      session.fromPartition('persist:bulwark').setCertificateVerifyProc((request, callback) => {
        if (request.hostname === 'app.bulwark.localhost') callback(request.certificate.fingerprint === pin ? 0 : -2);
        else if (request.hostname === '127.0.0.1') callback(0);
        else callback(-3);
      });
    }, fingerprint);
  });

  test.afterAll(() => {
    server.close();
    server.closeAllConnections();
  });

  const post = (url: string) =>
    page.evaluate(
      (target) => fetch(target, { method: 'POST', headers: { Authorization: 'Bearer abc', 'Content-Type': 'application/json' }, body: '{}' }).then((r) => r.json(), (e) => `blocked: ${e.message}`),
      url,
    );

  test('blocked before the server is an account\'s, like any cross-origin fetch', async () => {
    expect(String(await post(`${origin}/jmap/`))).toContain('blocked');
  });

  test('works once it is one: preflight answered, Authorization allowed, though the server sends no CORS at all', async () => {
    await fakeOsIntegration(app);
    await page.evaluate((url) => (window as unknown as { bulwarkDesktop: { servers: { prepare: (u: string) => Promise<unknown> } } }).bulwarkDesktop.servers.prepare(url), origin);
    const before = options;
    expect(await post(`${origin}/jmap/`)).toEqual({ reached: true, authorization: 'Bearer abc' });
    expect(options).toBeGreaterThan(before);
  });

  test('a wildcard is no server: no prompt, no list entry, and every other host stays closed', async () => {
    await fakeOsIntegration(app);
    for (const url of ['https://*', 'https://*.example.org', 'https://a*b.com']) {
      const answer = await page.evaluate((u) => (window as unknown as { bulwarkDesktop: { servers: { prepare: (u: string) => Promise<unknown> } } }).bulwarkDesktop.servers.prepare(u), url);
      expect(answer, url).toEqual({ ok: false, reason: 'invalid' });
    }
    expect(await prompts(app)).toEqual([]);
    const state = JSON.parse(readFileSync(path.join(profile, 'shell-state.json'), 'utf8'));
    expect(JSON.stringify(state.corsOrigins)).not.toContain('*');
  });

  test('what prepare added is not stored until a session came back, and a failure takes it back', async () => {
    const stored = () => JSON.parse(readFileSync(path.join(profile, 'shell-state.json'), 'utf8')).corsOrigins as string[];
    const call = (method: string, ...args: unknown[]) =>
      page.evaluate(
        ([m, a]) => (window as unknown as { bulwarkDesktop: { servers: Record<string, (...x: unknown[]) => unknown> } }).bulwarkDesktop.servers[m as string](...(a as unknown[])),
        [method, args] as [string, unknown[]],
      );
    const other = createHttpsServer({ key: certificate.keyPem, cert: certificate.certPem }, (_req, res) => res.end('{"reached":true}'));
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    const otherOrigin = `https://127.0.0.1:${(other.address() as AddressInfo).port}`;

    await fakeOsIntegration(app);
    await call('prepare', otherOrigin);
    expect(await post(`${otherOrigin}/`)).toEqual({ reached: true });
    await page.waitForTimeout(700);
    expect(stored()).not.toContain(otherOrigin);

    await call('forget', otherOrigin, 'failed');
    expect(String(await post(`${otherOrigin}/`))).toContain('blocked');

    await call('prepare', otherOrigin);
    await call('noteSession', otherOrigin, { apiUrl: `${otherOrigin}/jmap/` });
    await expect.poll(stored).toContain(otherOrigin);

    await call('forget', otherOrigin, 'signed-out');
    await expect.poll(stored).not.toContain(otherOrigin);
    expect(String(await post(`${otherOrigin}/`))).toContain('blocked');
    other.close();
    other.closeAllConnections();
  });

  test('another origin a session names needs the user, and a private one never gets in', async () => {
    const call = (method: string, ...args: unknown[]) =>
      page.evaluate(
        ([m, a]) => (window as unknown as { bulwarkDesktop: { servers: Record<string, (...x: unknown[]) => unknown> } }).bulwarkDesktop.servers[m as string](...(a as unknown[])),
        [method, args] as [string, unknown[]],
      );
    const stored = () => JSON.parse(readFileSync(path.join(profile, 'shell-state.json'), 'utf8')).corsOrigins as string[];
    await fakeOsIntegration(app, 1); // decline
    await call('noteSession', origin, { downloadUrl: 'https://downloads.example.org/{blobId}', uploadUrl: 'https://192.168.7.7/up' });
    await expect.poll(async () => (await prompts(app)).length).toBe(1);
    expect((await prompts(app))[0].detail).toContain('downloads.example.org');
    await page.waitForTimeout(700);
    expect(stored()).not.toContain('https://downloads.example.org');
    expect(stored()).not.toContain('https://192.168.7.7');

    // Asked once only, and the private one not at all.
    await call('noteSession', origin, { downloadUrl: 'https://downloads.example.org/{blobId}', uploadUrl: 'https://192.168.7.7/up' });
    await page.waitForTimeout(300);
    expect(await prompts(app)).toHaveLength(1);

    await fakeOsIntegration(app, 0); // allow, on a new origin
    await call('noteSession', origin, { downloadUrl: 'https://cdn.example.net/{blobId}', uploadUrl: 'https://192.168.7.7/up' });
    await expect.poll(stored).toContain('https://cdn.example.net');
    expect(stored()).not.toContain('https://192.168.7.7');
  });

  test('other origins stay under normal CORS', async () => {
    const other = createHttpsServer({ key: certificate.keyPem, cert: certificate.certPem }, (_req, res) => res.end('{}'));
    await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
    const otherOrigin = `https://127.0.0.1:${(other.address() as AddressInfo).port}`;
    expect(String(await post(`${otherOrigin}/`))).toContain('blocked');
    other.close();
    other.closeAllConnections();
  });
});

test.describe('a plain http server', () => {
  let upstream: Server;
  let origin = '';

  test.beforeAll(async () => {
    upstream = createHttpServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ path: req.url, cookie: req.headers.cookie ?? null }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  });

  test.afterAll(() => {
    upstream.close();
    upstream.closeAllConnections();
  });

  const route = () => `/__jmap/${Buffer.from(origin).toString('base64url')}/jmap/session`;
  const viaRoute = () => page.evaluate((url) => fetch(url).then(async (r) => ({ status: r.status, body: await r.text() })), route());
  const prepare = () => page.evaluate((url) => (window as unknown as { bulwarkDesktop: { servers: { prepare: (u: string) => Promise<unknown> } } }).bulwarkDesktop.servers.prepare(url), origin);

  test('no forwarding before the user allowed it', async () => {
    expect((await viaRoute()).status).toBe(403);
  });

  test('declined: still nothing, and the page hears why', async () => {
    await fakeOsIntegration(app, 1);
    expect(await prepare()).toEqual({ ok: false, reason: 'declined' });
    expect((await prompts(app))[0].message).toMatch(/encryption/i);
    expect((await viaRoute()).status).toBe(403);
  });

  test('allowed: forwarded, without the app\'s cookies, and kept across a reload', async () => {
    await fakeOsIntegration(app, 0);
    expect(await prepare()).toEqual({ ok: true, approved: true });
    const answer = await viaRoute();
    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toEqual({ path: '/jmap/session', cookie: null });
    await page.reload();
    await waitForLogin(page);
    expect((await viaRoute()).status).toBe(200);
    // Asked once only.
    await fakeOsIntegration(app, 1);
    expect(await prepare()).toEqual({ ok: true, approved: true });
    expect(await prompts(app)).toEqual([]);
  });
});
