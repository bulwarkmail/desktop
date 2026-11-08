// dialogs.show: a short question in a window of the app's own, modal to the page's window.
// Runs on the sign-in page, which has the bridge; no account needed.
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { launchStandalone, removeProfile, SCREENSHOTS, tempProfile, waitForLogin } from './helpers';

let profile = '';
let app: ElectronApplication;
let page: Page;

const QUESTION = {
  id: 'trash',
  title: 'Empty trash?',
  message: [{ text: 'All 12 messages in Trash will be deleted for good.' }],
  icon: 'warning',
  buttons: [{ label: 'Cancel', variant: 'secondary' }, { label: 'Empty trash', variant: 'destructive' }],
  defaultIndex: 0,
};

/** Starts a question without waiting for it; `answer(id)` waits. */
async function ask(request: Record<string, unknown>): Promise<void> {
  await page.evaluate((r) => {
    const w = window as unknown as { __answers?: Record<string, Promise<unknown>>; bulwarkDesktop: { dialogs: { show(r: unknown): Promise<unknown> } } };
    w.__answers ??= {};
    w.__answers[r.id as string] = w.bulwarkDesktop.dialogs.show(r);
  }, request);
}

/** A key that answers: the window goes on keydown, so the keyup has no page left to go to. */
async function pressAnswering(dialog: Page, key: string): Promise<void> {
  await dialog.keyboard.press(key).catch((error: Error) => {
    if (!/closed/.test(error.message)) throw error;
  });
}

function answer(id: string): Promise<unknown> {
  return page.evaluate((key) => (window as unknown as { __answers: Record<string, Promise<unknown>> }).__answers[key], id);
}

/** The dialog windows there are now, as main sees them. */
function dialogWindows() {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .filter((w) => !w.isDestroyed() && w.webContents?.getURL().startsWith('data:'))
      .map((w) => ({ visible: w.isVisible(), modal: w.isModal(), parent: w.getParentWindow()?.id ?? null, resizable: w.isResizable(), title: w.getTitle(), bounds: w.getBounds() })),
  );
}

const used = new WeakSet<Page>();

/** The dialog that is showing now: a page not handed out before. */
async function dialogPage(): Promise<Page> {
  await expect.poll(async () => (await dialogWindows()).filter((w) => w.visible).length, { timeout: 15_000 }).toBe(1);
  const fresh = () => app.windows().find((candidate) => !used.has(candidate) && !candidate.isClosed() && candidate.url().startsWith('data:'));
  await expect.poll(() => Boolean(fresh()), { timeout: 15_000 }).toBe(true);
  const found = fresh()!;
  used.add(found);
  return found;
}

test.beforeAll(async () => {
  profile = tempProfile('dlg');
  ({ app, page } = await launchStandalone(profile));
  await waitForLogin(page);
});

test.afterAll(async () => {
  await app.close().catch(() => {});
  removeProfile(profile);
});

test('a question opens a modal child window drawn like the app, and answers with the button', async () => {
  await ask(QUESTION);
  const dialog = await dialogPage();
  const [shown] = await dialogWindows();
  const mainId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && Boolean(w.webContents?.getURL().startsWith('https://app.bulwark.localhost')))!.id);
  expect(shown.parent).toBe(mainId);
  if (process.platform !== 'darwin') expect(shown.modal).toBe(true);
  expect(shown.resizable).toBe(false);
  expect(shown.title).toBe('Empty trash?');
  // Centred on its parent, and sized to the card: a card's width and its shadow, not a default window.
  const parent = await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.getBounds(), mainId);
  expect(Math.abs(shown.bounds.x + shown.bounds.width / 2 - (parent.x + parent.width / 2))).toBeLessThanOrEqual(2);
  expect(shown.bounds.width).toBeLessThan(600);
  expect(shown.bounds.height).toBeLessThan(400);
  // The parent can't be used meanwhile.
  expect(await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.isEnabled(), mainId)).toBe(false);

  await expect(dialog.locator('h2')).toHaveText('Empty trash?');
  await expect(dialog.locator('#message')).toHaveText('All 12 messages in Trash will be deleted for good.');
  await expect(dialog.locator('.badge svg')).toHaveCount(1);
  // The focus starts on the button Enter takes: Cancel, for a destructive question.
  await expect(dialog.locator('button.button').first()).toBeFocused();
  if (process.env.BULWARK_SCREENSHOTS) await dialog.screenshot({ path: `${SCREENSHOTS}/dialog-window-confirm.png`, omitBackground: true });
  await dialog.getByRole('button', { name: 'Empty trash' }).click();
  expect(await answer('trash')).toEqual({ button: 1 });
  await expect.poll(async () => (await dialogWindows()).length).toBe(0);
  expect(await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.isEnabled(), mainId)).toBe(true);
});

// macOS: Electron disables a window by hanging a half-clear sheet over it, and on macOS 27
// the question above it can't be answered. The test build plays the Mac here.
test('the macOS way: the window behind stays enabled, and focusing it hands the focus back', async () => {
  await app.evaluate(() => ((globalThis as { __bulwarkMacDialogs?: boolean }).__bulwarkMacDialogs = true));
  try {
    await ask({ ...QUESTION, id: 'mac' });
    const dialog = await dialogPage();
    const [shown] = await dialogWindows();
    expect(shown.modal).toBe(false);
    const mainId = shown.parent!;
    expect(await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.isEnabled(), mainId)).toBe(true);
    const focusedIsDialog = () =>
      app.evaluate(({ BrowserWindow }) => Boolean(BrowserWindow.getFocusedWindow()?.webContents.getURL().startsWith('data:')));
    await expect.poll(focusedIsDialog).toBe(true);
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.focus(), mainId);
    await expect.poll(focusedIsDialog).toBe(true);
    await dialog.getByRole('button', { name: 'Empty trash' }).click();
    expect(await answer('mac')).toEqual({ button: 1 });
    await expect.poll(async () => (await dialogWindows()).length).toBe(0);
    // Let go: the window behind keeps the focus now.
    await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.focus(), mainId);
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.id ?? null)).toBe(mainId);
  } finally {
    await app.evaluate(() => ((globalThis as { __bulwarkMacDialogs?: boolean }).__bulwarkMacDialogs = false));
  }
});

test('Escape closes it without an answer; Enter takes the default button', async () => {
  await ask({ ...QUESTION, id: 'esc' });
  let dialog = await dialogPage();
  await pressAnswering(dialog, 'Escape');
  expect(await answer('esc')).toBeNull();
  await expect.poll(async () => (await dialogWindows()).length).toBe(0);

  await ask({ ...QUESTION, id: 'enter', icon: undefined, buttons: [{ label: 'Cancel', variant: 'secondary' }, { label: 'Continue' }], defaultIndex: 1 });
  dialog = await dialogPage();
  await expect(dialog.getByRole('button', { name: 'Continue' })).toBeFocused();
  // Tab goes round the card: Cancel, then back to Continue.
  await dialog.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await dialog.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Continue' })).toBeFocused();
  await dialog.locator('#message').click();
  await pressAnswering(dialog, 'Enter');
  expect(await answer('enter')).toEqual({ button: 1 });
});

test('the window follows the page\'s zoom, and the whole text fits without scrolling', async () => {
  const setZoom = (zoom: number) => app.evaluate(({ BrowserWindow }, z) => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && Boolean(w.webContents?.getURL().startsWith('https://app.bulwark.localhost')))!.webContents.setZoomFactor(z), zoom);
  for (const zoom of [1.25, 0.9]) {
    await setZoom(zoom);
    await ask({ ...QUESTION, id: `zoom-${zoom}`, message: [{ text: 'You\'re about to visit github.com.\n\nhttps://github.com/bulwarkmail/webmail/releases\n\nThis domain isn\'t on your trusted list. Only continue if you recognise it.' }] });
    const dialog = await dialogPage();
    const fits = await dialog.evaluate(() => {
      const body = document.getElementById('body')!;
      const card = document.getElementById('card')!.getBoundingClientRect();
      return { scrolls: body.scrollHeight - body.clientHeight > 2, inside: card.right <= innerWidth && card.bottom <= innerHeight };
    });
    expect(fits).toEqual({ scrolls: false, inside: true });
    const [shown] = await dialogWindows();
    // The card's width and the room for its shadow (40 px a side) at the page's zoom (Chromium may round the zoom a little).
    expect(Math.abs(shown.bounds.width / (528 * zoom) - 1)).toBeLessThan(0.03);
    await pressAnswering(dialog, 'Escape');
    expect(await answer(`zoom-${zoom}`)).toBeNull();
  }
  await setZoom(1);
});

test('closing the window (Alt+F4) is no answer', async () => {
  await ask({ ...QUESTION, id: 'altf4' });
  await dialogPage();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents?.getURL().startsWith('data:'))!.close());
  expect(await answer('altf4')).toBeNull();
});

test('a plugin is named in the shell\'s own line, and its markup shows as text', async () => {
  await ask({
    id: 'plugin',
    title: 'Open external link?',
    source: 'From the plugin External Link Warning',
    message: [{ text: 'You\'re about to visit ' }, { text: 'github.com', bold: true }, { text: '.\n\n<img src=x onerror="document.title=1"><b>trusted</b>' }],
    buttons: [{ label: 'Cancel', variant: 'secondary' }, { label: 'Continue' }],
    defaultIndex: 1,
    menu: { label: 'Options for External Link Warning', items: [{ id: 'turn-off', label: 'Turn off External Link Warning', destructive: true }] },
  });
  const dialog = await dialogPage();
  await expect(dialog.locator('[data-dialog-source]')).toHaveText('From the plugin External Link Warning');
  await expect(dialog.locator('#message strong')).toHaveText('github.com');
  await expect(dialog.locator('#message img, #message b')).toHaveCount(0);
  await expect(dialog.locator('#message')).toContainText('<img src=x onerror="document.title=1"><b>trusted</b>');
  // The plugin's options: the ⋮ menu, as in the page.
  await dialog.getByRole('button', { name: 'Options for External Link Warning' }).click();
  await expect(dialog.getByRole('menuitem', { name: 'Turn off External Link Warning' })).toBeFocused();
  await dialog.keyboard.press('Escape');
  await expect(dialog.getByRole('menuitem')).toBeHidden();
  await dialog.getByRole('button', { name: 'Options for External Link Warning' }).click();
  await dialog.getByRole('menuitem', { name: 'Turn off External Link Warning' }).click();
  expect(await answer('plugin')).toEqual({ menu: 'turn-off' });
});

test('a second question waits for the first; the page can take one back', async () => {
  await ask({ ...QUESTION, id: 'first' });
  await ask({ ...QUESTION, id: 'second', title: 'Second?' });
  await ask({ ...QUESTION, id: 'third', title: 'Third?' });
  const first = await dialogPage();
  await expect(first.locator('h2')).toHaveText('Empty trash?');
  expect(await dialogWindows()).toHaveLength(1);
  // Over the limit: no window, no answer.
  await ask({ ...QUESTION, id: 'fourth' });
  expect(await answer('fourth')).toBeNull();
  await page.evaluate(() => (window as unknown as { bulwarkDesktop: { dialogs: { cancel(id: string): void } } }).bulwarkDesktop.dialogs.cancel('second'));
  expect(await answer('second')).toBeNull();
  await first.getByRole('button', { name: 'Cancel' }).click();
  expect(await answer('first')).toEqual({ button: 0 });
  const third = await dialogPage();
  await expect(third.locator('h2')).toHaveText('Third?');
  await pressAnswering(third, 'Escape');
  expect(await answer('third')).toBeNull();
});

test('nothing but a question gets through', async () => {
  const refused = await page.evaluate(() =>
    (window as unknown as { bulwarkDesktop: { dialogs: { show(r: unknown): Promise<unknown> } } }).bulwarkDesktop.dialogs.show({ id: 'x', title: '', buttons: [] }).then(() => 'answered', () => 'refused'),
  );
  expect(refused).toBe('refused');
  expect(await dialogWindows()).toHaveLength(0);
});

test('a page that goes away takes its questions with it', async () => {
  await ask({ ...QUESTION, id: 'reload-a' });
  await ask({ ...QUESTION, id: 'reload-b' });
  await dialogPage();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && Boolean(w.webContents?.getURL().startsWith('https://app.bulwark.localhost')))!.webContents.reload());
  await expect.poll(async () => (await dialogWindows()).length, { timeout: 10_000 }).toBe(0);
  // The second one doesn't come up after the first went.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  expect(await dialogWindows()).toHaveLength(0);
  await waitForLogin(page);
});

test('closing the parent window cancels its questions', async () => {
  // A second window of the app's, so the app stays when it goes.
  const before = app.windows().length;
  await page.evaluate(() => (window as unknown as { bulwarkDesktop: { windows: { open(url: string, o: unknown): void } } }).bulwarkDesktop.windows.open('/settings', { name: 'dialog-parent' }));
  await expect.poll(() => app.windows().filter((p) => !p.isClosed()).length, { timeout: 30_000 }).toBeGreaterThan(before);
  const second = app.windows().filter((p) => !p.isClosed() && p !== page && !p.url().startsWith('data:')).at(-1)!;
  // Signed out, it goes on to the sign-in page: a new document, which would take the questions with it.
  await waitForLogin(second);
  const appWindows = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && Boolean(w.webContents?.getURL().startsWith('https://app.bulwark.localhost'))).map((w) => w.id));
  await second.evaluate(() => ((window as unknown as { __mark: string }).__mark = 'second'));
  const secondId = await app.evaluate(async ({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed() && (await w.webContents.executeJavaScript('window.__mark').catch(() => null)) === 'second') return w.id;
    }
    return -1;
  });
  expect((await appWindows()).length).toBe(2);
  await second.evaluate((requests) => {
    const d = (window as unknown as { bulwarkDesktop: { dialogs: { show(r: unknown): Promise<unknown> } } }).bulwarkDesktop;
    for (const r of requests) void d.dialogs.show(r);
  }, [{ ...QUESTION, id: 'close-a' }, { ...QUESTION, id: 'close-b' }]);
  await dialogPage();
  expect((await dialogWindows())[0].parent).toBe(secondId);
  await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)!.destroy(), secondId);
  await expect.poll(async () => (await dialogWindows()).length, { timeout: 10_000 }).toBe(0);
  // The second question doesn't come up once the first went.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  expect(await dialogWindows()).toHaveLength(0);
  // The main window can ask again.
  await ask({ ...QUESTION, id: 'after-close' });
  await (await dialogPage()).getByRole('button', { name: 'Cancel' }).click();
  expect(await answer('after-close')).toEqual({ button: 0 });
});
