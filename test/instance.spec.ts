import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { fakeOsIntegration, launch, opened, prompts, removeProfile, SCREENSHOTS, shownPage, tempProfile } from './helpers';

const INSTANCE = 'https://bulwark.internal.bulwarkmail.org';

let profile = '';
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  profile = tempProfile('instance');
  app = await launch(profile, `--instance=${INSTANCE}`);
  page = await shownPage(app);
  await fakeOsIntegration(app);
  await page.locator('#username, [data-testid], main').first().waitFor({ timeout: 60_000 });
});

test.afterAll(async () => {
  await app.close();
  removeProfile(profile);
});

const bridgeType = (target: Page = page) => target.evaluate(() => typeof (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop);

test('it shows the instance, in a session of its own, with no embedded server', async () => {
  expect(new URL(page.url()).origin).toBe(INSTANCE);
  const info = await app.evaluate(({ BrowserWindow, session, app: electronApp }, instance) => {
    const window = BrowserWindow.getAllWindows()[0];
    return {
      isAppSession: window.webContents.session === session.fromPartition('persist:bulwark'),
      isDefault: window.webContents.session === session.defaultSession,
      partition: `persist:instance-${Buffer.from(instance).toString('base64url')}`,
      same: window.webContents.session === session.fromPartition(`persist:instance-${Buffer.from(instance).toString('base64url')}`),
      utility: electronApp.getAppMetrics().filter((m) => m.type === 'Utility' && m.name === 'Bulwark mail service').length,
    };
  }, INSTANCE);
  expect(info.isAppSession).toBe(false);
  expect(info.isDefault).toBe(false);
  expect(info.same).toBe(true);
  expect(info.utility).toBe(0);
  await page.screenshot({ path: path.join(SCREENSHOTS, 'desktop-instance-login.png') });
});

test('the bridge is there on the instance, but without the standalone parts', async () => {
  expect(await bridgeType()).toBe('object');
  const keys = await page.evaluate(() => Object.keys((window as unknown as { bulwarkDesktop: object }).bulwarkDesktop).sort());
  // `keystore` is only there where the native helper loaded: the next test.
  expect(keys.filter((key) => key !== 'keystore')).toEqual(['appLock', 'auth', 'certificates', 'clipboard', 'dialogs', 'edit', 'lifecycle', 'localImport', 'menu', 'mode', 'os', 'platform', 'policy', 'privacy', 'shell', 'spellcheck', 'theme', 'updates', 'version', 'windows']);
});

test.describe('the OS keystore on an instance', () => {
  test.skip(process.platform !== 'win32', 'the helper is built on Windows here');

  type Member = { list(): Promise<unknown[]>; accessState(): Promise<string>; revokeAccess(): Promise<void> };
  const call = (target: Page, method: keyof Member) =>
    target.evaluate(async (name) => {
      const member = (window as unknown as { bulwarkDesktop: { keystore: Member } }).bulwarkDesktop.keystore;
      try {
        const out = await member[name]();
        return Array.isArray(out) ? 'listed' : (out ?? 'done');
      } catch (error) {
        return (error as Error).message;
      }
    }, method);
  const stored = (target: ElectronApplication) => target.evaluate(({ app: electronApp }) => {
    const { readFileSync } = process.getBuiltinModule('node:fs');
    const { join } = process.getBuiltinModule('node:path');
    return JSON.parse(readFileSync(join(electronApp.getPath('userData'), 'shell-state.json'), 'utf8')).keystoreOrigins ?? [];
  });

  test('is off until the user says yes: Deny sticks and stores nothing', async () => {
    expect(await call(page, 'accessState')).toBe('off');
    await fakeOsIntegration(app, 1);
    expect(await call(page, 'list')).toBe('keystore:cancelled');
    expect(await call(page, 'list')).toBe('keystore:cancelled');
    const asked = await prompts(app);
    expect(asked).toHaveLength(1);
    expect(`${asked[0].message} ${asked[0].detail}`).toContain(new URL(INSTANCE).host);
    expect((asked[0] as unknown as { buttons: string[] }).buttons).toHaveLength(2);
    expect(await call(page, 'accessState')).toBe('off');
  });

  test('yes is stored per origin, survives a restart, and can be taken back', async () => {
    const own = tempProfile('instance-keystore');
    let second = await launch(own, `--instance=${INSTANCE}`);
    try {
      let shown = await shownPage(second);
      await fakeOsIntegration(second, 0);
      expect(await call(shown, 'list')).toBe('listed');
      expect((await prompts(second)).length, 'one question, not two').toBe(1);
      expect(await call(shown, 'accessState')).toBe('stored');
      await expect.poll(() => stored(second)).toEqual([INSTANCE]);

      await second.close();
      second = await launch(own, `--instance=${INSTANCE}`);
      shown = await shownPage(second);
      expect(await call(shown, 'accessState')).toBe('stored');
      await fakeOsIntegration(second, 2);
      // The first-use question is gone. The session's list grant still applies on top.
      expect(await call(shown, 'list')).toBe('keystore:cancelled');
      expect((await prompts(second)).length).toBe(1);
      expect((await prompts(second))[0].message).toContain('see your certificates');

      expect(await call(shown, 'revokeAccess')).toBe('done');
      expect(await call(shown, 'accessState')).toBe('off');
      await expect.poll(() => stored(second)).toEqual([]);
    } finally {
      await second.close().catch(() => undefined);
      removeProfile(own);
    }
  });
});

test('the same preload on a foreign origin exposes no bridge', async () => {
  const foreign = 'https://stalwart-1.internal.bulwarkmail.org/.well-known/oauth-authorization-server';
  await app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows()[0].webContents.loadURL(url), foreign);
  await page.waitForURL(foreign);
  expect(await bridgeType()).toBe('undefined');
  await app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows()[0].webContents.loadURL(url), `${INSTANCE}/`);
  await page.waitForURL(new RegExp(`^${INSTANCE}/`));
  expect(await bridgeType()).toBe('object');
});

test('main checks the sender too: a foreign page on the channel gets refused', async () => {
  const denied = await app.evaluate(async ({ BrowserWindow, ipcMain }, channel) => {
    // What the handler does when a frame on another origin calls it.
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (e: unknown) => unknown> })._invokeHandlers;
    const handler = handlers.get(channel)!;
    const window = BrowserWindow.getAllWindows()[0];
    try {
      await handler({ sender: window.webContents, senderFrame: { url: 'https://evil.example/', parent: null } });
      return 'allowed';
    } catch (error) {
      return (error as Error).message;
    }
  }, 'bulwark:windows.list');
  expect(denied).toBe('Not allowed');
});

test('other links open in the system browser, and the SSO chain stays in the window', async () => {
  await page.evaluate(() => {
    location.href = 'https://example.com/elsewhere';
  });
  await expect.poll(() => opened(app)).toContain('https://example.com/elsewhere');
  expect(new URL(page.url()).origin).toBe(INSTANCE);

  // An authorize request that comes back to the instance isn't "elsewhere".
  const authorize = new URL('https://stalwart-1.internal.bulwarkmail.org/.well-known/jmap');
  authorize.searchParams.set('redirect_uri', `${INSTANCE}/en/auth/callback`);
  await page.evaluate((url) => {
    location.href = url;
  }, authorize.toString());
  await page.waitForURL(/stalwart-1\.internal/);
  expect((await opened(app))).not.toContain(authorize.toString());
  await page.evaluate((url) => {
    location.href = url;
  }, `${INSTANCE}/`);
  await page.waitForURL(new RegExp(`^${INSTANCE}/`));

  // The chain ended with the return: leaving again is stopped.
  await page.evaluate(() => {
    location.href = 'https://example.com/after-chain';
  });
  await expect.poll(() => opened(app)).toContain('https://example.com/after-chain');
  expect(new URL(page.url()).origin).toBe(INSTANCE);
});

test('a plugin sign-in opens in the app only through the bridge; the same address as a link goes to the browser', async () => {
  const authorize = new URL('https://stalwart-1.internal.bulwarkmail.org/.well-known/jmap');
  authorize.searchParams.set('redirect_uri', `${INSTANCE}/en/plugins/oauth/callback`);

  // A link in a message opens this way: the system browser, no window.
  await page.evaluate((url) => {
    window.open(url, '_blank', 'noopener,noreferrer');
  }, authorize.toString());
  await expect.poll(() => opened(app)).toContain(authorize.toString());

  const call = (url: string) =>
    app.evaluate(async ({ BrowserWindow, ipcMain }, { url: target, instance }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (e: unknown, ...args: unknown[]) => unknown> })._invokeHandlers;
      const window = BrowserWindow.getAllWindows().reduce((a, b) => (a.id < b.id ? a : b));
      return handlers.get('bulwark:auth.pluginSignIn')!({ sender: window.webContents, senderFrame: { url: `${instance}/en/`, parent: null } }, target);
    }, { url, instance: INSTANCE });

  expect(await call('https://example.com/?redirect_uri=' + encodeURIComponent(`${INSTANCE}/en/auth/callback`))).toBe(false);
  const [child, answer] = await Promise.all([app.waitForEvent('window'), call(authorize.toString())]);
  expect(answer).toBe(true);
  await child.waitForURL(/stalwart-1\.internal/);
  expect(await child.evaluate(() => typeof (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop)).toBe('undefined');
  const sameSession = await app.evaluate(({ BrowserWindow }) => {
    const all = BrowserWindow.getAllWindows();
    const oldest = all.reduce((a, b) => (a.id < b.id ? a : b));
    const newest = all.reduce((a, b) => (a.id > b.id ? a : b));
    return newest.webContents.session === oldest.webContents.session;
  });
  expect(sameSession).toBe(true);
  // Back on the instance, the page parks the payload and the window closes.
  await child.evaluate((url) => {
    location.href = url;
  }, `${INSTANCE}/en/plugins/oauth/callback?code=c&state=s`);
  await child.waitForEvent('close', { timeout: 20_000 });
});

test('an instance that predates the integrated chrome gets a native frame, remembered', async () => {
  const knows = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--titlebar-right-inset') !== '');
  const remembered = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  const { readFileSync } = await import('node:fs');
  await expect.poll(() => JSON.parse(readFileSync(path.join(remembered, 'shell-state.json'), 'utf8')).overlayByOrigin?.[INSTANCE]).toBe(knows);
});
