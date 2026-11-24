import { expect, test, type ElectronApplication, type Frame, type Page } from '@playwright/test';
import { fakeOsIntegration, launch, opened, removeProfile, shownPage, tempProfile } from './helpers';

// An inline sidebar app signs in through a pop-up (Mattermost with Entra ID, #1). In the system
// browser the session cookie landed there and the frame stayed signed out; the pop-up now runs
// in a window of the app, on the frame's session. Links from the frame still go to the browser.

const INSTANCE = 'https://bulwark.internal.bulwarkmail.org';
// Another https origin that may be framed, standing in for the app.
const APP = 'https://stalwart-1.internal.bulwarkmail.org';

let profile = '';
let app: ElectronApplication;
let page: Page;
let frame: Frame;

test.beforeAll(async () => {
  profile = tempProfile('framed-app');
  app = await launch(profile, `--instance=${INSTANCE}`);
  page = await shownPage(app);
  await fakeOsIntegration(app);
  await page.locator('#username, [data-testid], main').first().waitFor({ timeout: 60_000 });
  // The webmail lets a user's inline app into frame-src through this cookie, as it does once
  // the app is added.
  await page.evaluate((origin) => {
    document.cookie = `__Host-bulwark_app_frame_origins=${encodeURIComponent(origin)}; path=/; secure; samesite=strict`;
  }, APP);
  await page.reload();
  await page.locator('#username, [data-testid], main').first().waitFor({ timeout: 60_000 });
  await page.evaluate((src) => {
    const iframe = document.createElement('iframe');
    iframe.src = src;
    iframe.name = 'app-under-test';
    // What the webmail gives an inline app (lib/sidebar-apps.ts).
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox');
    document.body.appendChild(iframe);
  }, `${APP}/.well-known/jmap`);
  await expect.poll(() => page.frames().find((f) => f.url().startsWith(APP)) ?? null).not.toBeNull();
  frame = page.frames().find((f) => f.url().startsWith(APP))!;
});

test.afterAll(async () => {
  await app.close();
  removeProfile(profile);
});

const windowCount = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

test('the app\'s sign-in pop-up opens in a window of the app, on the same session, without the bridge', async () => {
  const before = await windowCount();
  const [child] = await Promise.all([
    app.waitForEvent('window'),
    frame.evaluate((url) => {
      window.open(url, 'sign-in', 'width=500,height=600');
    }, `${APP}/account`),
  ]);
  await child.waitForURL(new RegExp(`^${APP}/`));
  expect(await opened(app)).not.toContain(`${APP}/account`);
  expect(await child.evaluate(() => typeof (window as unknown as { bulwarkDesktop?: unknown }).bulwarkDesktop)).toBe('undefined');
  const shown = await app.evaluate(({ BrowserWindow }) => {
    const all = BrowserWindow.getAllWindows();
    const oldest = all.reduce((a, b) => (a.id < b.id ? a : b));
    const newest = all.reduce((a, b) => (a.id > b.id ? a : b));
    return { visible: newest.isVisible(), sameSession: newest.webContents.session === oldest.webContents.session };
  });
  expect(shown).toEqual({ visible: true, sameSession: true });
  // Its opener can close it, as a sign-in pop-up does once it's done.
  await child.evaluate(() => window.close());
  await expect.poll(windowCount).toBe(before);
});

test('an authorize request that comes back to the app opens in the app too', async () => {
  const authorize = new URL(`${INSTANCE}/.well-known/does-not-matter`);
  authorize.host = 'stalwart.internal.bulwarkmail.org';
  authorize.searchParams.set('redirect_uri', `${APP}/signup/openid/complete`);
  const [child] = await Promise.all([
    app.waitForEvent('window'),
    frame.evaluate((url) => {
      window.open(url);
    }, authorize.toString()),
  ]);
  await child.waitForURL(/stalwart\.internal/);
  expect(await opened(app)).not.toContain(authorize.toString());
  await child.close();
});

test('links from the app, links without an opener, and the page\'s own pop-ups to the app still go to the browser', async () => {
  const before = await windowCount();
  await frame.evaluate(() => {
    window.open('https://example.com/from-the-app');
  });
  await expect.poll(() => opened(app)).toContain('https://example.com/from-the-app');

  await frame.evaluate((url) => {
    window.open(url, '_blank', 'noopener');
  }, `${APP}/account?noopener`);
  await expect.poll(() => opened(app)).toContain(`${APP}/account?noopener`);

  // The same address, asked for by the webmail's page itself (a link in a message).
  await page.evaluate((url) => {
    window.open(url);
  }, `${APP}/account?from-page`);
  await expect.poll(() => opened(app)).toContain(`${APP}/account?from-page`);
  await expect.poll(windowCount).toBe(before);
});
