import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { appPathOfDeepLink, deepLinkFromArgv, LinkRateLimit, parseDeepLink } from '../src/main/deep-link';
import { AltTracker } from '../src/main/features/window-input';
import { assignMnemonics, barItemsOf, escapeMenuLabel, findBarItem, labelParts, lineMnemonics, linkOffersOpen, pdfFileName, pickSpellLanguages, safeFileName, safeImageName, shownAccelerator, tidySeparators, toMenuTemplate, windowMenuNames, type BarSourceItem } from '../src/main/menu-text';
import { LABEL_KEY } from '../src/main/label-keys';
import { accentHex, highContrastColours } from '../src/main/chrome-colours';
import { nextInCycle, sumAnswers } from '../src/main/window-logic';
import { nextZoomLevel } from '../src/main/zoom';
import { closeDictionaryDownloads, DEAD_DICTIONARY_URL } from '../src/main/spellcheck';
import { APP_ORIGIN, fakeOsIntegration, launch, shownPage, launchStandalone, prompts, removeProfile, tempProfile, waitForLogin } from './helpers';
import { clickMenuItem, lastMenu, menuCount, menuItem, pageWith, pickNext, recordMenus, type SeenItem } from './native-helpers';
import { startHostileInstance, type HostileInstance } from './support/hostile-instance-2';
import { startInputInstance, type InputInstance } from './support/input-instance';

test.describe('the pure parts', () => {
  test('a deep link is parsed down to a message or a folder', () => {
    // A real login id: generateAccountId in the webmail's lib/account-utils.ts.
    const login = 'ent-alice@example.org@stalwart-1.internal.bulwarkmail.org';
    expect(parseDeepLink(`bulwark://message/abc-123?account=${encodeURIComponent(login)}&owner=o1`)).toEqual({ kind: 'message', emailId: 'abc-123', account: login, owner: 'o1' });
    expect(parseDeepLink(`bulwark://message/abc-123?account=${login}`)).toEqual({ kind: 'message', emailId: 'abc-123', account: login, owner: undefined });
    expect(parseDeepLink(`bulwark://message/${encodeURIComponent(login)}/abc-123`)).toEqual({ kind: 'message', emailId: 'abc-123', account: login, owner: undefined });
    expect(parseDeepLink(`bulwark://message/${login}/abc-123`)).toEqual({ kind: 'message', emailId: 'abc-123', account: login, owner: undefined });
    expect(parseDeepLink('bulwark://folder/sent')).toEqual({ kind: 'folder', folder: 'sent' });
    expect(parseDeepLink('bulwark://mailbox/b3x')).toEqual({ kind: 'folder', folder: 'b3x' });
  });

  test('anything else from outside is refused', () => {
    for (const bad of [
      'bulwark://message/../../api/admin',
      'bulwark://message/a/b',
      'bulwark://message/',
      'bulwark://settings/x',
      'bulwark://message/a%2Fb',
      'bulwark://folder/%2e%2e',
      'https://example.com/message/a',
      'bulwark://message/a b',
      `bulwark://message/${'x'.repeat(3000)}`,
      42,
    ]) {
      expect(parseDeepLink(bad), String(bad)).toBeNull();
    }
    // A hostile query doesn't come along, and a login that isn't one isn't taken for it.
    expect(parseDeepLink('bulwark://message/a?account=../x')).toEqual({ kind: 'message', emailId: 'a', account: undefined, owner: undefined });
    expect(parseDeepLink('bulwark://message/a?account=a1')).toEqual({ kind: 'message', emailId: 'a', account: undefined, owner: undefined });
    expect(parseDeepLink('bulwark://message/a%40b%2F..%2Fc/d')).toBeNull();
    expect(parseDeepLink('bulwark://message/nologin/d')).toBeNull();
  });

  test('a link only ever becomes the app\'s own pop-out or folder address', () => {
    expect(appPathOfDeepLink({ kind: 'message', emailId: 'a1', account: 'u@h' })).toBe('/popout/message/a1?account=u%40h&via=link');
    expect(appPathOfDeepLink({ kind: 'folder', folder: 'sent' })).toBe('/mail/folder/sent');
  });

  test('every message a link opens says it came from one: it may show, not act', () => {
    expect(appPathOfDeepLink({ kind: 'message', emailId: 'a1' })).toContain('via=link');
  });

  test('links are rate limited: a page firing them in a loop gets five', () => {
    const limit = new LinkRateLimit();
    const results = Array.from({ length: 7 }, () => limit.allow(1000));
    expect(results.filter(Boolean)).toHaveLength(5);
    expect(limit.allow(1000 + 10_001)).toBe(true);
  });

  test('a hostile image keeps nothing but its base name, and its type decides the extension', () => {
    expect(safeImageName('invoice.exe', 'image/png')).toBe('invoice.png');
    expect(safeImageName('..\\..\\evil.bat', 'image/jpeg; charset=x')).toBe('_.._evil.jpg');
    expect(safeImageName('con.txt', 'image/gif')).toBe('_con.gif');
    expect(safeImageName('', 'image/webp')).toBe('attachment.webp');
    // Not an image, whatever it's called: nothing to save.
    expect(safeImageName('photo.png', 'application/x-msdownload')).toBeNull();
    expect(safeImageName('photo.png', 'text/html')).toBeNull();
    expect(safeImageName('photo.png', '')).toBeNull();
  });

  test('a link gets Open and Copy only if the OS can open it and it leaves the app', () => {
    const origin = 'https://app.bulwark.localhost';
    expect(linkOffersOpen('https://example.org/a', origin)).toBe(true);
    expect(linkOffersOpen('mailto:a@example.org', origin)).toBe(true);
    expect(linkOffersOpen(`${origin}/settings`, origin)).toBe(false);
    expect(linkOffersOpen(`blob:${origin}/abc`, origin)).toBe(false);
    expect(linkOffersOpen('file:///C:/Windows/win.ini', origin)).toBe(false);
    expect(linkOffersOpen('javascript:alert(1)', origin)).toBe(false);
    expect(linkOffersOpen('https://user:pw@example.org/', origin)).toBe(false);
  });

  test('the menu bar gets a letter for Alt in any language, none twice', () => {
    expect(assignMnemonics(['&File', '&Edit'])).toEqual(['&File', '&Edit']);
    expect(assignMnemonics(['Datei', 'Bearbeiten', 'Ansicht', 'Nachricht', 'Gehe zu', 'Fenster', 'Hilfe'])).toEqual(['&Datei', '&Bearbeiten', '&Ansicht', '&Nachricht', '&Gehe zu', '&Fenster', '&Hilfe']);
    expect(assignMnemonics(['Fichier', 'Fenêtre'])).toEqual(['&Fichier', 'F&enêtre']);
    expect(assignMnemonics(['ファイル', '編集'])).toEqual(['&ファイル', '&編集']);
  });

  test('the drawn bar gets each menu line with its key, state, shortcut and Alt letter', () => {
    const line = (label: string, extra: Partial<BarSourceItem> = {}): BarSourceItem => ({ label, type: 'normal', enabled: true, visible: true, checked: false, ...extra });
    const items = barItemsOf([
      line('New message', { accelerator: 'CmdOrCtrl+N', id: 'file.newMessage' }),
      line('', { type: 'separator' }),
      line('', { type: 'separator' }),
      line('Hidden', { visible: false }),
      line('Notes', { enabled: false }),
      line('Undo', { role: 'undo', getDefaultRoleAccelerator: () => 'CommandOrControl+Z' }),
      line('R&&D', {}),
      line('Reading pane', { submenu: { items: [line('On the right', { type: 'radio', checked: true }), line('Off', { type: 'radio' })] } }),
      line('Always show the menu bar', { type: 'checkbox', checked: true }),
      line('', { type: 'separator' }),
    ], '2');
    expect(items.map((item) => [item.key, item.label, item.type])).toEqual([
      ['2/0', 'New message', 'normal'],
      ['2/1', '', 'separator'],
      ['2/4', 'Notes', 'normal'],
      ['2/5', 'Undo', 'normal'],
      ['2/6', 'R&D', 'normal'],
      ['2/7', 'Reading pane', 'submenu'],
      ['2/8', 'Always show the menu bar', 'checkbox'],
    ]);
    expect(items[0].accelerator).toBe('CmdOrCtrl+N');
    expect(items[0].id, 'the page draws its icon by it').toBe('file.newMessage');
    expect(items[3].id, 'a role line is named by its role').toBe('role.undo');
    expect(items[3].accelerator, 'a role shows its own key').toBe('CommandOrControl+Z');
    expect(items[2].enabled).toBe(false);
    expect(items[6].checked).toBe(true);
    expect(items[5].items?.map((item) => [item.key, item.label, item.checked])).toEqual([['2/7/0', 'On the right', true], ['2/7/1', 'Off', false]]);
    // r is taken by R&D, so Reading pane gets its e.
    expect(items.filter((item) => item.type !== 'separator').map((item) => item.label[item.mnemonic ?? -1])).toEqual(['N', 'o', 'U', 'R', 'e', 'A']);
  });

  test('a pick finds the same line only while it still says the same', () => {
    const plain = (label: string): BarSourceItem => ({ label, type: 'normal', enabled: true, visible: true, checked: false });
    const menus: BarSourceItem[] = [{ ...plain('File'), type: 'submenu', submenu: { items: [plain('New message'), plain('Window && more')] } }];
    expect(findBarItem(menus, '0/0', 'New message')?.label).toBe('New message');
    expect(findBarItem(menus, '0/1', 'Window & more')?.label).toBe('Window && more');
    expect(findBarItem(menus, '0/0', 'Delete'), 'the menu changed under it').toBeNull();
    expect(findBarItem(menus, '0', 'File'), 'a menu is not a command').toBeNull();
    expect(findBarItem(menus, '0/9', 'New message')).toBeNull();
    expect(findBarItem(menus, '../0', 'New message')).toBeNull();
  });

  test('a label reads as text, with its marked letter', () => {
    expect(labelParts('&File')).toEqual({ text: 'File', mnemonic: 0 });
    expect(labelParts('Fi&le')).toEqual({ text: 'File', mnemonic: 2 });
    expect(labelParts('R&&D')).toEqual({ text: 'R&D', mnemonic: -1 });
    expect(lineMnemonics(['Open', 'Over', '…', 'Ölen'])).toEqual([0, 1, -1, 0]);
  });

  test('the page may translate the tray as it does the menus', () => {
    for (const key of ['trayNewMessage', 'trayOpen', 'trayExit', 'trayPause', 'menuShowMenuBar', 'menuExit']) expect(LABEL_KEY.test(key), key).toBe(true);
  });

  test('a menu the page built shows the keys the page answers, apart from the label, never registered', () => {
    expect(shownAccelerator('D', 'win32')).toBe('D');
    expect(shownAccelerator('Shift+I', 'linux')).toBe('Shift+I');
    expect(shownAccelerator('Ctrl+Shift+Enter', 'win32')).toBe('Ctrl+Shift+Enter');
    expect(shownAccelerator('Delete', 'win32')).toBe('Delete');
    // A Mac menu shows only keys it runs itself.
    expect(shownAccelerator('D', 'darwin')).toBeUndefined();
    for (const bad of ['Ctrl+Alt+Shift+Super+X', 'Day', 'Ctrl+', '<b>D</b>', 'D'.repeat(41), 42, null]) {
      expect(shownAccelerator(bad, 'win32'), String(bad)).toBeUndefined();
    }
    const [day, week] = toMenuTemplate([{ id: 'd', label: 'Day', accelerator: 'D' }, { id: 'w', label: 'Week', accelerator: 'not a key' }], () => {});
    if (process.platform !== 'darwin') expect(day).toMatchObject({ label: 'Day', accelerator: 'D', registerAccelerator: false });
    expect(week.accelerator).toBeUndefined();
  });

  test('no two lines in a row where a hidden line stood between them, and none at an end', () => {
    const sep = { type: 'separator' };
    const shown = (label: string): { label: string; type?: string; visible?: boolean } => ({ label });
    const hidden = (label: string) => ({ label, visible: false });
    const labels = (items: { type?: string; label?: string }[]) => items.map((item) => item.type === 'separator' ? '-' : item.label);
    expect(labels(tidySeparators([shown('Refresh'), hidden('F5'), sep, hidden('Reading pane'), sep, shown('Zoom in')]))).toEqual(['Refresh', 'F5', '-', 'Reading pane', 'Zoom in']);
    expect(labels(tidySeparators([sep, shown('A'), sep, sep, shown('B'), sep, hidden('C')]))).toEqual(['A', '-', 'B', 'C']);
    const [withSub] = tidySeparators([{ label: 'Sub', submenu: [sep, shown('x'), sep] }]);
    expect(labels(withSub.submenu as { label?: string }[])).toEqual(['x']);
  });

  test('Window menu names: as the page gives them, cut with an ellipsis, numbered when two read alike, only kinds while locked', () => {
    const kinds = { main: 'Bulwark', message: 'Message', composer: 'New message', settings: 'Settings' };
    const subject = 'Invoice 2026-118 (3) - alice@example.org - Bulwark';
    const list = [
      { type: 'main', title: subject, menuName: 'Inbox - alice@example.org' },
      { type: 'message', title: subject, menuName: 'Invoice 2026-118 (3)' },
      { type: 'message', title: 'x', menuName: 'Invoice 2026-118 (3)' },
      { type: 'composer', title: 'New message - a@example.org - Bulwark', menuName: 'New message' },
      { type: 'composer', title: '', menuName: '' },
      { type: 'message', title: 'An older page' },
      { type: 'message', title: '', menuName: 'A subject that goes on and on and on, far longer than any menu should be' },
    ];
    const names = windowMenuNames(list, kinds);
    expect(names.slice(0, 6)).toEqual(['Inbox - alice@example.org', 'Invoice 2026-118 (3)', 'Invoice 2026-118 (3) (2)', 'New message', 'New message (2)', 'An older page']);
    expect(Array.from(names[6]).length).toBeLessThanOrEqual(50);
    expect(names[6].endsWith('…')).toBe(true);
    expect(new Set(names).size).toBe(names.length);
    expect(windowMenuNames(list.slice(0, 2), kinds, true)).toEqual(['Bulwark', 'Message']);
  });

  test('a second launch finds its link among the arguments', () => {
    expect(deepLinkFromArgv(['bulwark.exe', '--flag', 'bulwark://folder/inbox'])).toEqual({ kind: 'folder', folder: 'inbox' });
    expect(deepLinkFromArgv(['bulwark.exe', '--flag'])).toBeNull();
  });

  test('Alt alone toggles the strip, Alt plus a letter opens that menu, AltGr types', () => {
    const entries = [{ id: 'file', label: 'File', mnemonic: 'f' }, { id: 'edit', label: 'Edit', mnemonic: 'e' }];
    const down = (key: string, extra = {}) => ({ type: 'keyDown' as const, key, alt: false, control: false, meta: false, shift: false, ...extra });
    const up = (key: string, extra = {}) => ({ ...down(key, extra), type: 'keyUp' as const });

    const alone = new AltTracker();
    expect(alone.feed(down('Alt', { alt: true }), entries).type).toBe('none');
    expect(alone.feed(up('Alt'), entries).type).toBe('toggle');

    const letter = new AltTracker();
    letter.feed(down('Alt', { alt: true }), entries);
    expect(letter.feed(down('f', { alt: true }), entries)).toEqual({ type: 'open', id: 'file' });
    expect(letter.feed(up('Alt'), entries).type).toBe('none');

    // AltGr arrives as Ctrl+Alt on Windows: someone typing @ on a German keyboard.
    const altGr = new AltTracker();
    expect(altGr.feed(down('Alt', { alt: true, control: true }), entries).type).toBe('none');
    expect(altGr.feed(down('q', { alt: true, control: true }), entries).type).toBe('none');
    expect(altGr.feed(up('Alt', { control: true }), entries).type).toBe('none');

    // Something else in between: no strip.
    const chord = new AltTracker();
    chord.feed(down('Alt', { alt: true }), entries);
    chord.feed(down('Tab', { alt: true }), entries);
    expect(chord.feed(up('Alt'), entries).type).toBe('none');
  });

  test('Ctrl+` goes round the windows', () => {
    expect(nextInCycle([1, 2, 3], 1, 1)).toBe(2);
    expect(nextInCycle([1, 2, 3], 3, 1)).toBe(1);
    expect(nextInCycle([1, 2, 3], 1, -1)).toBe(3);
    expect(nextInCycle([1], 1, 1)).toBeNull();
    expect(nextInCycle([], undefined, 1)).toBeNull();
    expect(nextInCycle([4, 5], undefined, 1)).toBe(4);
  });

  test('saving answers add up: a failure, or a page out of time, counts as unsaved', () => {
    expect(sumAnswers([{ failed: 1 }, { failed: 0 }, {}])).toEqual({ failed: 1, unsent: 0 });
    expect(sumAnswers([{ timedOut: true }])).toEqual({ failed: 1, unsent: 0 });
    expect(sumAnswers([{ unsent: 2 }, { unsent: 2 }])).toEqual({ failed: 0, unsent: 2 });
  });

  test('zoom stays in range and 0 resets', () => {
    expect(nextZoomLevel(0, 1)).toBe(0.5);
    expect(nextZoomLevel(5, 1)).toBe(5);
    expect(nextZoomLevel(-3, -1)).toBe(-3);
    expect(nextZoomLevel(2, 0)).toBe(0);
  });

  test('names are safe for a menu and a file', () => {
    expect(escapeMenuLabel('R&D')).toBe('R&&D');
    expect(pdfFileName('Re: a/b <c>?')).toBe('Re a b c.pdf');
    expect(pdfFileName('...')).toBe('Bulwark.pdf');
    expect(safeFileName('..\\..\\evil.exe')).toBe('_.._evil.exe');
    expect(safeFileName('')).toBe('attachment');
  });

  test('spellcheck takes the closest dictionary there is', () => {
    expect(pickSpellLanguages(['de', 'en-GB'], ['en-US', 'en-GB', 'de-DE'])).toEqual(['de-DE', 'en-GB']);
    expect(pickSpellLanguages(['xx'], ['en-US'])).toEqual([]);
    expect(pickSpellLanguages(['de', 'de-AT'], ['de-DE'])).toEqual(['de-DE']);
  });

  test('colours: the OS accent and a contrast theme', () => {
    expect(accentHex('0078d4ff')).toBe('#0078d4');
    expect(accentHex('nonsense')).toBeNull();
    expect(highContrastColours('#000000', '#ffff00', false)).toEqual({ background: '#000000', symbol: '#ffff00', dark: true });
    expect(highContrastColours(null, null, true).background).toBe('#000000');
    expect(highContrastColours(null, null, false).symbol).toBe('#000000');
  });
});

test.describe('the app menu and windows', () => {
  let profile = '';
  let app: ElectronApplication;
  let page: Page;

  test.beforeAll(async () => {
    profile = tempProfile('menu');
    ({ app, page } = await launchStandalone(profile));
    await fakeOsIntegration(app);
    await recordMenus(app);
    await waitForLogin(page);
  });

  test.afterAll(async () => {
    await app.close();
    removeProfile(profile);
  });

  const setState = (state: Record<string, unknown>, on: Page = page) =>
    on.evaluate((value) => (window as unknown as { bulwarkDesktop: { menu: { setState: (s: unknown) => void } } }).bulwarkDesktop.menu.setState(value), state);

  const openPopout = async (id: string) => {
    await page.evaluate(
      (emailId) => (window as unknown as { bulwarkDesktop: { windows: { openMessage: (t: object) => void } } }).bulwarkDesktop.windows.openMessage({ url: `/popout/message/${emailId}`, emailId }),
      id,
    );
    return pageWith(app, `/popout/message/${id}`);
  };

  test('has the app\'s menus, in order, and nothing that reloads or opens developer tools', async () => {
    const tree = await app.evaluate(({ Menu }) => {
      type Item = { label: string; role?: string; submenu?: { items: Item[] } };
      const walk = (items: Item[]): { label: string; role?: string; children?: unknown }[] =>
        items.map((item) => ({ label: item.label, role: item.role, children: item.submenu ? walk(item.submenu.items) : undefined }));
      return walk(Menu.getApplicationMenu()!.items as unknown as Item[]);
    });
    expect(tree.map((item) => item.label.replace('&', ''))).toEqual(['File', 'Edit', 'View', 'Message', 'Go', 'Window', 'Help']);
    const roles = JSON.stringify(tree);
    expect(roles).not.toMatch(/reload/i);
    expect(roles).not.toMatch(/toggledevtools/i);
    expect(roles).not.toContain('Develop');
  });

  test('chords are real accelerators', async () => {
    expect(await menuItem(app, 'file.newMessage')).toMatchObject({ accelerator: 'CmdOrCtrl+N' });
    expect((await menuItem(app, 'file.newMessage'))?.registerAccelerator).not.toBe(false);
    expect(await menuItem(app, 'view.zoomIn')).toMatchObject({ accelerator: 'CmdOrCtrl+Plus' });
    expect(await menuItem(app, 'window.cycle')).toMatchObject({ accelerator: 'Ctrl+`' });
  });

  test('the page\'s menu bar gets the app menu, runs its items, and the controls fit the bar\'s row', async () => {
    test.skip(process.platform === 'darwin', 'macOS has the system bar');
    type Bar = {
      menus: () => Promise<{ id: string; label: string; items: { key: string; label: string; type: string; checked?: boolean; accelerator?: string }[] }[]>;
      run: (key: string, label: string) => void;
      report: (report: { height: number; active: boolean }) => void;
    };
    const menus = await page.evaluate(() => (window as unknown as { bulwarkDesktop: { menu: { bar: Bar } } }).bulwarkDesktop.menu.bar.menus());
    expect(menus.map((m) => m.label)).toEqual(['File', 'Edit', 'View', 'Message', 'Go', 'Window', 'Help']);
    const file = menus.find((m) => m.id === 'file')!;
    expect(file.items.find((i) => i.label === 'New message')?.accelerator).toBe('CmdOrCtrl+N');
    const view = menus.find((m) => m.id === 'view')!;
    const always = view.items.find((i) => i.label === 'Always show the menu bar')!;
    expect(always).toMatchObject({ type: 'checkbox', checked: false });
    // A line runs only on the click that picked it, which main sees reach the window.
    const pick = async (key: string, label: string) => {
      await page.mouse.click(4, 300);
      await page.evaluate(([k, l]) => (window as unknown as { bulwarkDesktop: { menu: { bar: Bar } } }).bulwarkDesktop.menu.bar.run(k, l), [key, label]);
    };
    // A line whose text changed since is refused.
    await pick(always.key, 'Something else');
    await page.waitForTimeout(300);
    expect((await menuItem(app, 'view.menuBar'))?.checked).toBe(false);
    await pick(always.key, always.label);
    await expect.poll(async () => (await menuItem(app, 'view.menuBar'))?.checked).toBe(true);
    await pick(always.key, always.label);
    await expect.poll(async () => (await menuItem(app, 'view.menuBar'))?.checked).toBe(false);

    const controlsHeight = () => page.evaluate(() => (navigator as unknown as { windowControlsOverlay: { getTitlebarAreaRect: () => DOMRect } }).windowControlsOverlay.getTitlebarAreaRect().height);
    // Back to the toolbar's height once the always-shown bar has gone again.
    await expect.poll(controlsHeight).toBeGreaterThan(40);
    const tall = await controlsHeight();
    await page.evaluate(() => (window as unknown as { bulwarkDesktop: { menu: { bar: Bar } } }).bulwarkDesktop.menu.bar.report({ height: 32, active: true }));
    await expect.poll(controlsHeight).toBe(32);
    await page.evaluate(() => (window as unknown as { bulwarkDesktop: { menu: { bar: Bar } } }).bulwarkDesktop.menu.bar.report({ height: 0, active: false }));
    await expect.poll(controlsHeight).toBe(tall);
  });

  test('Settings is in File, where Windows and Linux mail apps have it, and Windows says Exit', async () => {
    test.skip(process.platform === 'darwin', 'the app menu has them on a Mac');
    expect(await menuItem(app, 'file.settings')).toMatchObject({ accelerator: 'Ctrl+,' });
    expect(await menuItem(app, 'help.settings')).toBeNull();
    expect((await menuItem(app, 'file.quit'))?.label).toBe(process.platform === 'win32' ? 'Exit' : 'Quit');
    // The keys the page has for spam and the shortcut list, as people type them.
    expect(await menuItem(app, 'message.spam')).toMatchObject({ accelerator: '!' });
    expect(await menuItem(app, 'help.shortcuts')).toMatchObject({ accelerator: '?' });
    expect((await menuItem(app, 'view.menuBar'))?.type).toBe('checkbox');
  });

  test('Ctrl+F forwards with a message selected, and searches without one', async () => {
    test.skip(process.platform === 'darwin', 'a Mac keeps Cmd+F for finding');
    const seen: string[] = [];
    await page.exposeFunction('__menuSeen', (id: string) => { seen.push(id); });
    await page.evaluate(() => (window as unknown as { bulwarkDesktop: { menu: { onCommand(l: (id: string) => void): void } } }).bulwarkDesktop.menu.onCommand((id) => (window as unknown as { __menuSeen(id: string): void }).__menuSeen(id)));
    const enabled = () => app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('edit.forwardOrSearch')?.enabled ?? null);
    await setState({ 'message.forward': true, 'edit.search': true });
    await expect.poll(enabled).toBe(true);
    await clickMenuItem(app, 'edit.forwardOrSearch');
    await expect.poll(() => seen.at(-1)).toBe('message.forward');
    await setState({ 'message.forward': false, 'edit.search': true });
    await expect.poll(async () => (await menuItem(app, 'message.forward'))?.enabled).toBe(false);
    await clickMenuItem(app, 'edit.forwardOrSearch');
    await expect.poll(() => seen.at(-1)).toBe('edit.search');
    // A composer: neither, so the key is the editor's.
    await setState({ 'message.forward': false, 'edit.search': false });
    await expect.poll(enabled).toBe(false);
    await setState({});
  });

  // desktop-p3-14: on a starred message the item still said "Star".
  test('Star says Remove star while the message is starred', async () => {
    await setState({ 'message.star': { enabled: true, checked: true } });
    await expect.poll(async () => (await menuItem(app, 'message.star'))?.label).toBe('Remove star');
    expect(await menuItem(app, 'message.star')).toMatchObject({ enabled: true });
    await setState({ 'message.star': { enabled: true, checked: false } });
    await expect.poll(async () => (await menuItem(app, 'message.star'))?.label).toBe('Star');
    await setState({});
  });

  // desktop-p3-16: Ctrl+E in Settings read "Search mail" and searched mail.
  test('Edit > Search names the settings search in Settings', async () => {
    await setState({ 'section.settings': true, 'edit.search': true });
    await expect.poll(async () => (await menuItem(app, 'edit.search'))?.label).toBe('Search settings');
    await setState({});
    await expect.poll(async () => (await menuItem(app, 'edit.search'))?.label).toBe('Search mail');
  });

  // desktop-p3-15: in month view none of Day, Week, Month and Agenda was ticked.
  test('Calendar\'s views are ticked as the page says, also when the menu is built in that view', async () => {
    const views = ['day', 'week', 'month', 'agenda'];
    const state = (current: string) => ({ 'section.calendar': true, ...Object.fromEntries(views.map((view) => [`view.calendar.${view}`, { enabled: true, checked: view === current }])) });
    const ticked = () => app.evaluate(({ Menu }, ids) => ids.filter((id) => Menu.getApplicationMenu()?.getMenuItemById(id)?.checked), views.map((view) => `view.calendar.${view}`));
    await setState(state('month'));
    await expect.poll(ticked).toEqual(['view.calendar.month']);
    await setState(state('agenda'));
    await expect.poll(ticked).toEqual(['view.calendar.agenda']);
    await setState(state('day'));
    await expect.poll(ticked).toEqual(['view.calendar.day']);
    await setState({});
    // Back in Mail, with its Message menu, for the tests after this one.
    await expect.poll(() => menuItem(app, 'message.star')).not.toBeNull();
  });

  test('single keys only show: the page has them, and knows when someone types', async () => {
    const star = await menuItem(app, 'message.star');
    expect(star).toMatchObject({ accelerator: 'S', registerAccelerator: false });
    await setState({ 'shortcuts.singleKeys': false });
    await expect.poll(async () => (await menuItem(app, 'message.star'))?.accelerator).toBeFalsy();
    // Delete is no character key, so that setting leaves it on, and the chords stay.
    expect(await menuItem(app, 'message.delete')).toMatchObject({ accelerator: 'Delete', registerAccelerator: false });
    expect(await menuItem(app, 'message.reply')).toMatchObject({ accelerator: 'CmdOrCtrl+R' });
    await setState({});
    await expect.poll(async () => (await menuItem(app, 'message.star'))?.accelerator).toBe('S');
  });

  test('the keys Outlook users press: chords that run, and Ctrl+Q marks as read on Windows', async () => {
    test.skip(process.platform === 'darwin', 'a Mac keeps its own keys');
    const registered = async (id: string, accelerator: string) => {
      const item = await menuItem(app, id);
      expect(item, id).toMatchObject({ accelerator });
      expect(item?.registerAccelerator, id).not.toBe(false);
    };
    await registered('message.reply', 'CmdOrCtrl+R');
    await registered('message.replyAll', 'CmdOrCtrl+Shift+R');
    await registered('message.forwardAlt', 'Ctrl+Shift+F');
    // Ctrl+F shows on Forward and runs through a hidden line: Forward, or search where there's nothing to forward.
    expect(await menuItem(app, 'message.forward')).toMatchObject({ accelerator: 'Ctrl+F', registerAccelerator: false });
    await registered('edit.forwardOrSearch', 'Ctrl+F');
    await registered('message.markUnread', 'Ctrl+U');
    await registered('edit.search', 'Ctrl+E');
    await registered('view.refresh', 'F9');
    await registered('view.refreshAlt', 'F5');
    await registered('file.newMessageAlt', 'Ctrl+Shift+M');
    await registered('go.mail', 'Ctrl+1');
    await registered('go.calendar', 'Ctrl+2');
    await registered('go.contacts', 'Ctrl+3');
    await registered('go.files', 'Ctrl+4');
    if (process.platform === 'win32') {
      await registered('message.markRead', 'Ctrl+Q');
      expect((await menuItem(app, 'file.quit'))?.accelerator).toBeFalsy();
    } else {
      expect(await menuItem(app, 'file.quit')).toMatchObject({ accelerator: 'Ctrl+Q' });
    }
    // A hidden twin follows the command it stands for.
    await setState({ 'file.newMessage': false });
    await expect.poll(async () => (await menuItem(app, 'file.newMessageAlt'))?.enabled).toBe(false);
    await setState({ 'file.newMessage': true });
    await expect.poll(async () => (await menuItem(app, 'file.newMessageAlt'))?.enabled).toBe(true);
    await setState({});
  });

  test('the menus follow the part of the app on screen, and a composer adds its own lines', async () => {
    const topLabels = () => app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.items.filter((item) => item.visible).map((item) => item.label.replace('&', '')));
    const visible = (id: string) => app.evaluate(({ Menu }, wanted) => Menu.getApplicationMenu()?.getMenuItemById(wanted)?.visible ?? null, id);
    expect(await menuItem(app, 'file.newEvent')).not.toBeNull();
    expect(await menuItem(app, 'file.newContact')).not.toBeNull();
    expect(await menuItem(app, 'file.newTask')).not.toBeNull();
    expect(await menuItem(app, 'file.import')).not.toBeNull();

    await setState({ 'section.calendar': true, 'view.calendar.week': { enabled: true, checked: true }, 'edit.search': true });
    await expect.poll(topLabels).not.toContain('Message');
    expect(await menuItem(app, 'view.calendar.week')).toMatchObject({ type: 'radio', checked: true, enabled: true });
    if (process.platform !== 'darwin') expect(await menuItem(app, 'view.calendar.day')).toMatchObject({ accelerator: 'D', registerAccelerator: false });
    expect(await visible('view.readingPane')).toBe(false);
    expect((await menuItem(app, 'edit.search'))?.label).toBe('Search events');

    await setState({ 'compose.send': true, 'compose.saveDraft': true, 'compose.attach': true });
    await expect.poll(topLabels).toContain('Message');
    expect(await menuItem(app, 'compose.send')).toMatchObject({ label: 'Send', enabled: true });
    if (process.platform !== 'darwin') expect(await menuItem(app, 'compose.send')).toMatchObject({ accelerator: 'CmdOrCtrl+Enter', registerAccelerator: false });
    expect(await menuItem(app, 'compose.saveDraft')).toMatchObject({ accelerator: 'CmdOrCtrl+S', enabled: true });
    expect(await menuItem(app, 'compose.attach')).toMatchObject({ label: 'Attach files…', enabled: true });
    expect(await visible('view.readingPane')).toBe(true);

    await setState({});
    await expect.poll(async () => menuItem(app, 'compose.send')).toBeNull();
    expect(await topLabels()).toContain('Message');
  });

  test('outside Mail the View menu has no two lines in a row where Reading pane is hidden', async () => {
    const viewLines = () => app.evaluate(({ Menu }) => {
      const view = Menu.getApplicationMenu()!.items.find((item) => item.label.replace('&', '') === 'View')!;
      return view.submenu!.items.filter((item) => item.visible).map((item) => item.type);
    });
    await setState({ 'section.settings': true });
    try {
      await expect.poll(() => app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('view.readingPane')?.visible ?? false)).toBe(false);
      expect((await viewLines()).join(',')).not.toContain('separator,separator');
      expect((await viewLines())[0]).not.toBe('separator');
    } finally {
      await setState({});
      // Mail again before the next test reads the menus.
      await expect.poll(() => app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('view.readingPane')?.visible ?? false)).toBe(true);
    }
  });

  test('View and Go fit the screen: Refresh reloads Calendar, Contacts and Files, and Go leaves mail out there', async () => {
    const lines = (menu: string) => app.evaluate(({ Menu }, wanted) => {
      const top = Menu.getApplicationMenu()!.items.find((item) => item.label.replace('&', '') === wanted)!;
      return top.submenu!.items.filter((item) => item.visible).map((item) => (item.type === 'separator' ? '-' : item.id || item.label));
    }, menu);
    const searchLabels = { calendar: 'Search events', contacts: 'Search contacts', files: 'Search files' } as const;
    const goMail = ['go.inbox', 'go.sent', 'go.drafts', 'go.nextMessage', 'go.previousMessage', 'go.nextUnread'];
    try {
      for (const section of ['calendar', 'contacts', 'files'] as const) {
        await setState({ [`section.${section}`]: true, 'view.refresh': true, 'go.today': true, 'go.nextPeriod': true, 'go.previousPeriod': true });
        // The menu is built anew for each part of the app: wait for that part's search line.
        await expect.poll(async () => (await menuItem(app, 'edit.search'))?.label).toBe(searchLabels[section]);
        await expect.soft.poll(async () => (await menuItem(app, 'view.refresh'))?.label, { message: section, timeout: 5_000 }).toBe('Refresh');
        expect.soft(await menuItem(app, 'view.refresh'), section).toMatchObject({ enabled: true });
        if (process.platform !== 'darwin') expect.soft(await menuItem(app, 'view.refresh'), section).toMatchObject({ accelerator: 'F9' });
        const go = await lines('Go');
        for (const id of goMail) expect.soft(go, `${section} ${id}`).not.toContain(id);
        const calendarGo = ['go.today', 'go.nextPeriod', 'go.previousPeriod'];
        for (const id of calendarGo) {
          if (section === 'calendar') expect.soft(go, `${section} ${id}`).toContain(id);
          else expect.soft(go, `${section} ${id}`).not.toContain(id);
        }
        for (const menu of ['View', 'Go']) {
          const shown = await lines(menu);
          expect.soft(shown.join(','), `${section} ${menu}`).not.toContain('-,-');
          expect.soft(shown[0], `${section} ${menu}`).not.toBe('-');
          expect.soft(shown[shown.length - 1], `${section} ${menu}`).not.toBe('-');
        }
      }
      if (process.platform !== 'darwin') expect.soft(await menuItem(app, 'go.today')).toBeNull();
      await setState({ 'section.calendar': true, 'go.today': true, 'go.nextPeriod': true, 'go.previousPeriod': true });
      await expect.poll(async () => (await menuItem(app, 'go.today'))?.label).toBe('Today');
      if (process.platform !== 'darwin') expect(await menuItem(app, 'go.today')).toMatchObject({ accelerator: 'T', registerAccelerator: false, enabled: true });
      expect(await menuItem(app, 'go.nextPeriod')).toMatchObject({ label: 'Next period', enabled: true });
      expect(await menuItem(app, 'go.previousPeriod')).toMatchObject({ label: 'Previous period', enabled: true });
      // Mail keeps its own: check for new mail, and the folders and messages in Go.
      await setState({ 'view.refresh': true });
      await expect.poll(async () => (await menuItem(app, 'view.refresh'))?.label).toBe('Check for new mail');
      const mailGo = await lines('Go');
      for (const id of goMail) expect(mailGo).toContain(id);
      expect(mailGo).not.toContain('go.today');
    } finally {
      await setState({});
    }
  });

  test('Window > Minimise has no Ctrl+M off a Mac: Windows apps don\'t minimise on it', async () => {
    test.skip(process.platform === 'darwin', 'a Mac minimises on Cmd+M');
    const minimise = await app.evaluate(({ Menu }) => {
      const windowMenu = Menu.getApplicationMenu()!.items.find((item) => item.label.replace('&', '') === 'Window')!;
      const item = windowMenu.submenu!.items[0];
      return { label: item.label, role: item.role ?? null, accelerator: item.accelerator ?? null, roleKey: (item as unknown as { getDefaultRoleAccelerator?: () => string | null }).getDefaultRoleAccelerator?.() ?? null };
    });
    expect(minimise).toMatchObject({ label: 'Minimize', role: null, accelerator: null, roleKey: null });
  });

  test('each part of the app searches itself, only Mail has a Message menu, and File > Import has each app\'s import', async () => {
    // Every top-level menu, hidden or not: a hidden one can still take a letter or show in a native bar.
    const allLabels = () => app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.items.map((item) => item.label.replace('&', '')));
    const imports = { 'file.import': true, 'file.importCalendar': true, 'file.importContacts': true };
    const searches = { mail: 'Search mail', calendar: 'Search events', contacts: 'Search contacts', files: 'Search files', settings: 'Search mail' } as const;
    for (const [section, label] of Object.entries(searches)) {
      await setState({ [`section.${section}`]: true, 'edit.search': true, ...imports });
      await expect.soft.poll(async () => (await menuItem(app, 'edit.search'))?.label, { message: section, timeout: 5_000 }).toBe(label);
      expect.soft(await menuItem(app, 'edit.search'), section).toMatchObject({ enabled: true });
      if (section === 'mail') expect.soft(await allLabels()).toContain('Message');
      else expect.soft(await allLabels(), section).not.toContain('Message');
      expect.soft(await menuItem(app, 'message.reply'), section).toEqual(section === 'mail' ? expect.anything() : null);
    }

    const importMenu = await app.evaluate(({ Menu }) => {
      const item = Menu.getApplicationMenu()?.getMenuItemById('file.importMenu');
      return item ? { label: item.label, lines: item.submenu?.items.map((line) => ({ id: line.id, label: line.label, enabled: line.enabled })) } : null;
    });
    expect.soft(importMenu).toEqual({
      label: 'Import',
      lines: [
        { id: 'file.import', label: 'Mail…', enabled: true },
        { id: 'file.importCalendar', label: 'Calendar…', enabled: true },
        { id: 'file.importContacts', label: 'Contacts…', enabled: true },
      ],
    });
    // An older page that doesn't know the calendar and contacts import leaves them grey.
    await setState({ 'file.import': true });
    await expect.poll(async () => (await menuItem(app, 'file.importCalendar'))?.enabled).toBe(false);
    expect(await menuItem(app, 'file.import')).toMatchObject({ enabled: true });

    await page.evaluate(() => {
      const g = window as unknown as { __imports: string[]; bulwarkDesktop: { menu: { onCommand: (l: (id: string) => void) => void } } };
      g.__imports = [];
      g.bulwarkDesktop.menu.onCommand((id) => { if (id.startsWith('file.import')) g.__imports.push(id); });
    });
    await setState(imports);
    await expect.poll(async () => (await menuItem(app, 'file.importContacts'))?.enabled).toBe(true);
    await clickMenuItem(app, 'file.importCalendar');
    await clickMenuItem(app, 'file.importContacts');
    await expect.poll(() => page.evaluate(() => (window as unknown as { __imports: string[] }).__imports)).toEqual(['file.importCalendar', 'file.importContacts']);
    await setState({});
  });

  test('Settings opens in the main window, as the rail\'s button does: no second window', async () => {
    test.skip(process.platform === 'darwin', 'the app menu has it on a Mac');
    // What the shell sends the main window, read on the shell's side: a listener in the page would outlive this test.
    await app.evaluate(({ BrowserWindow }) => {
      const { webContents } = BrowserWindow.getAllWindows()[0];
      const g = globalThis as unknown as { __sent: unknown[][]; __send?: typeof webContents.send };
      g.__sent = [];
      g.__send = webContents.send.bind(webContents);
      webContents.send = ((channel: string, ...args: unknown[]) => {
        g.__sent.push([channel, ...args]);
        g.__send!(channel, ...args);
      }) as typeof webContents.send;
    });
    try {
      await setState({ 'file.settings': true });
      await expect.poll(async () => (await menuItem(app, 'file.settings'))?.enabled).toBe(true);
      await clickMenuItem(app, 'file.settings');
      await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __sent: unknown[][] }).__sent.map((args) => args[1]))).toContain('go.settings');
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    } finally {
      await app.evaluate(({ BrowserWindow }) => {
        const g = globalThis as unknown as { __send?: (channel: string, ...args: unknown[]) => void };
        if (g.__send) BrowserWindow.getAllWindows()[0].webContents.send = g.__send;
      });
      await setState({});
    }
  });

  test('File > Add account… and Change connection… go to the page of the main window, which asks first: no restart from the menu', async () => {
    test.skip(process.platform === 'darwin', 'the app menu has them on a Mac');
    await app.evaluate(({ BrowserWindow }) => {
      const { webContents } = BrowserWindow.getAllWindows()[0];
      const g = globalThis as unknown as { __sent: unknown[][]; __send?: typeof webContents.send; __quits: number };
      g.__sent = [];
      g.__quits = 0;
      g.__send = webContents.send.bind(webContents);
      webContents.send = ((channel: string, ...args: unknown[]) => {
        g.__sent.push([channel, ...args]);
        g.__send!(channel, ...args);
      }) as typeof webContents.send;
    });
    try {
      expect((await menuItem(app, 'file.addAccount'))?.label).toBe('Add account…');
      await setState({ 'file.addAccount': true, 'file.switchMode': true });
      await expect.poll(async () => (await menuItem(app, 'file.addAccount'))?.enabled).toBe(true);
      await clickMenuItem(app, 'file.addAccount');
      await clickMenuItem(app, 'file.switchMode');
      await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __sent: unknown[][] }).__sent.map((args) => args[1]))).toEqual(expect.arrayContaining(['file.addAccount', 'file.switchMode']));
      // Nothing quit: still the one app window. A page that asks (this branch's webmail)
      // adds its question window, a data: page; an older one asks nothing here.
      const urls = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.webContents.getURL()));
      await page.waitForTimeout(1000);
      expect((await urls()).filter((url) => !url.startsWith('data:'))).toHaveLength(1);
      await app.evaluate(({ BrowserWindow }) => {
        for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().startsWith('data:')) w.destroy();
      });
    } finally {
      await app.evaluate(({ BrowserWindow }) => {
        const g = globalThis as unknown as { __send?: (channel: string, ...args: unknown[]) => void };
        if (g.__send) BrowserWindow.getAllWindows()[0].webContents.send = g.__send;
      });
      await setState({});
    }
  });

  test('items go on and off with what the page reports', async () => {
    expect((await menuItem(app, 'message.reply'))?.enabled).toBe(false);
    await setState({ 'message.reply': true, 'view.layout.horizontal': { enabled: true, checked: true } });
    await expect.poll(async () => (await menuItem(app, 'message.reply'))?.enabled).toBe(true);
    await expect.poll(async () => (await menuItem(app, 'view.layout.horizontal'))?.checked).toBe(true);
    await setState({ 'message.reply': false });
    await expect.poll(async () => (await menuItem(app, 'message.reply'))?.enabled).toBe(false);
  });

  test('a page that never reports has no page commands, which is an older instance', async () => {
    expect((await menuItem(app, 'message.delete'))?.enabled).toBe(false);
    expect((await menuItem(app, 'file.newWindow'))?.enabled).toBe(true);
  });

  test('a command reaches the page in the focused window', async () => {
    await page.evaluate(() => {
      const g = window as unknown as { __commands: string[]; bulwarkDesktop: { menu: { onCommand: (l: (id: string) => void) => void } } };
      g.__commands = [];
      g.bulwarkDesktop.menu.onCommand((id) => g.__commands.push(id));
    });
    await setState({ 'message.reply': true });
    await expect.poll(async () => (await menuItem(app, 'message.reply'))?.enabled).toBe(true);
    await clickMenuItem(app, 'message.reply');
    await expect.poll(() => page.evaluate(() => (window as unknown as { __commands: string[] }).__commands)).toEqual(['message.reply']);
  });

  test('zoom: the keys\' items step it on every window and it\'s stored', async () => {
    const other = await openPopout('zoom1');
    await clickMenuItem(app, 'view.zoomIn');
    const levels = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.webContents.getZoomLevel()));
    await expect.poll(levels).toEqual([0.5, 0.5]);
    await clickMenuItem(app, 'view.zoomOut');
    await clickMenuItem(app, 'view.zoomOut');
    await expect.poll(levels).toEqual([-0.5, -0.5]);
    await clickMenuItem(app, 'view.zoomReset');
    await expect.poll(levels).toEqual([0, 0]);
    await clickMenuItem(app, 'view.zoomIn');
    await other.close();
  });

  test('Ctrl+wheel goes the same way as the menu', async () => {
    const before = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomLevel());
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.emit('zoom-changed', {}, 'in');
    });
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomLevel())).toBe(before + 0.5);
    await clickMenuItem(app, 'view.zoomReset');
  });

  test('no reload on F5 or Ctrl+R, and no developer tools', async () => {
    await page.evaluate(() => {
      (window as unknown as { __stillHere: boolean }).__stillHere = true;
    });
    await page.keyboard.press('F5');
    await page.keyboard.press('Control+R');
    await page.keyboard.press('Control+Shift+R');
    await page.keyboard.press('Control+Shift+I');
    await page.keyboard.press('F12');
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => (window as unknown as { __stillHere?: boolean }).__stillHere)).toBe(true);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.isDevToolsOpened())).toBe(false);
  });

  test('the mouse\'s back button goes through the app\'s history, and only that', async () => {
    const start = page.url();
    await page.evaluate(() => history.pushState(null, '', '/en/login?step=2'));
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].emit('app-command', {}, 'browser-backward');
    });
    await expect.poll(() => page.url()).toBe(start);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].emit('app-command', {}, 'browser-forward');
    });
    await expect.poll(() => page.url()).toContain('step=2');
    await page.goBack();
    // A pop-out has no history: nothing happens, and nothing throws.
    const other = await openPopout('back1');
    const url = other.url();
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.emit('app-command', {}, 'browser-backward');
    });
    await other.waitForTimeout(300);
    expect(other.url()).toBe(url);
    await other.close();
  });

  test('the Window menu lists what\'s open and picks one', async () => {
    const other = await openPopout('list1');
    const list = () => app.evaluate(({ Menu }) => {
      const windowMenu = Menu.getApplicationMenu()!.items.find((item) => item.label.replace('&', '') === 'Window');
      return windowMenu!.submenu!.items.filter((item) => item.id?.startsWith('window.focus.')).map((item) => item.label);
    });
    await expect.poll(list).toHaveLength(2);
    // A title with & must show as one, not turn the next letter into a mnemonic.
    // Set again each time: the page sets its own title as it loads.
    await expect.poll(async () => {
      await other.evaluate(() => {
        document.title = 'A & B';
      });
      return (await list()).some((label) => label === 'A && B');
    }).toBe(true);
    const focused = await app.evaluate(({ Menu, BrowserWindow }) => {
      const seen: number[] = [];
      const original = BrowserWindow.prototype.focus;
      BrowserWindow.prototype.focus = function focus(this: Electron.BrowserWindow) {
        seen.push(this.id);
        return original.call(this);
      };
      const windowMenu = Menu.getApplicationMenu()!.items.find((item) => item.label.replace('&', '') === 'Window')!;
      windowMenu.submenu!.items.find((item) => item.label === 'A && B')!.click();
      BrowserWindow.prototype.focus = original;
      return seen;
    });
    expect(focused).toHaveLength(1);
    await other.close();
  });

  test('a page that names its window is listed by that name, not by its title', async () => {
    const other = await openPopout('named1');
    const list = () => app.evaluate(({ Menu }) => {
      const windowMenu = Menu.getApplicationMenu()!.items.find((item) => item.label.replace('&', '') === 'Window');
      return windowMenu!.submenu!.items.filter((item) => item.id?.startsWith('window.focus.')).map((item) => item.label);
    });
    // Set again each time: the page names itself as it loads, and a new page starts unnamed.
    await expect.poll(async () => {
      await other.evaluate(() => (window as unknown as { bulwarkDesktop: { windows: { setMenuName(name: string): void } } }).bulwarkDesktop.windows.setMenuName('Quarterly budget'));
      return (await list()).includes('Quarterly budget');
    }).toBe(true);
    await other.close();
  });

  test('Next Window focuses another window', async () => {
    const other = await openPopout('cycle1');
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((w) => w.isVisible())), { timeout: 30_000 }).toBe(true);
    const seen = await app.evaluate(({ Menu, BrowserWindow }) => {
      const ids: number[] = [];
      const original = BrowserWindow.prototype.focus;
      BrowserWindow.prototype.focus = function focus(this: Electron.BrowserWindow) {
        ids.push(this.id);
        return original.call(this);
      };
      Menu.getApplicationMenu()!.getMenuItemById('window.cycle')!.click();
      BrowserWindow.prototype.focus = original;
      return ids;
    });
    expect(seen).toHaveLength(1);
    await other.close();
  });

  test('a page\'s report goes with the page: loading another starts over', async () => {
    await setState({ 'message.reply': true });
    await expect.poll(async () => (await menuItem(app, 'message.reply'))?.enabled).toBe(true);
    // A page that reports nothing: the old report mustn't live on under it.
    const before = page.url();
    await page.goto(new URL('/api/health/live', before).toString());
    await expect.poll(async () => (await menuItem(app, 'message.reply'))?.enabled).toBe(false);
    await page.goto(before);
    await waitForLogin(page);
    await expect.poll(async () => (await menuItem(app, 'message.reply'))?.enabled).toBe(false);
  });

  test('New Window is a second main window, cascaded from the first', async () => {
    await clickMenuItem(app, 'file.newWindow');
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(2);
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().every((w) => w.isVisible())), { timeout: 30_000 }).toBe(true);
    const bounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getBounds()));
    expect(bounds[0].x).not.toBe(bounds[1].x);
    await app.evaluate(({ BrowserWindow }) => {
      // The newest: the list isn't in the order they opened.
      BrowserWindow.getAllWindows().sort((x, y) => y.id - x.id)[0].close();
    });
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  });

  test('Save as PDF prints what the print CSS makes of the page, and names it after the window', async () => {
    const savePdf = async () => {
      const target = path.join(tmpdir(), `bulwark-test-${Date.now()}-${Math.random().toString(36).slice(2)}.pdf`);
      await app.evaluate(({ dialog, Menu, BrowserWindow }, file) => {
        const g = globalThis as unknown as { __save: { defaultPath?: string } };
        dialog.showSaveDialog = (async (...args: unknown[]) => {
          g.__save = args[args.length - 1] as { defaultPath?: string };
          return { canceled: false, filePath: file };
        }) as typeof dialog.showSaveDialog;
        const window = BrowserWindow.getAllWindows()[0];
        window.setTitle('A/B report');
        // The menu acts on the focused window, and the one before it has just closed.
        window.focus();
        Menu.getApplicationMenu()!.getMenuItemById('file.savePdf')!.click();
      }, target);
      await expect.poll(() => existsSync(target) && readFileSync(target).subarray(0, 5).toString(), { timeout: 30_000 }).toBe('%PDF-');
      // Written in one go, but give it a moment to be whole.
      await page.waitForTimeout(200);
      const size = readFileSync(target).length;
      rmSync(target, { force: true });
      return size;
    };
    // A lot of text that the print CSS takes away, as app/print.css takes the app away.
    await page.evaluate(() => {
      const bulk = document.createElement('div');
      bulk.id = 'not-for-paper';
      bulk.textContent = Array.from({ length: 4000 }, (_, i) => `line${i * 7919}`).join(' ');
      document.body.appendChild(bulk);
    });
    const withBulk = await savePdf();
    await page.evaluate(() => {
      const style = document.createElement('style');
      style.id = 'print-rule';
      style.textContent = '@media print { #not-for-paper { display: none !important; } }';
      document.head.appendChild(style);
    });
    const printed = await savePdf();
    expect(printed).toBeLessThan(withBulk * 0.9);
    expect(await app.evaluate(() => (globalThis as unknown as { __save: { defaultPath?: string } }).__save.defaultPath)).toBe('A B report.pdf');
    await page.evaluate(() => {
      document.getElementById('not-for-paper')?.remove();
      document.getElementById('print-rule')?.remove();
    });
  });

  test('Print and Save as PDF are off under the device policy, and refuse if called anyway', async () => {
    await setState({ 'file.print': false, 'file.savePdf': false });
    await expect.poll(async () => (await menuItem(app, 'file.print'))?.enabled).toBe(false);
    expect((await menuItem(app, 'file.savePdf'))?.enabled).toBe(false);
    const called = await app.evaluate(({ Menu, BrowserWindow, dialog }) => {
      const g = { asked: 0, printed: 0 };
      const { webContents } = BrowserWindow.getAllWindows()[0];
      const print = webContents.print;
      webContents.print = (() => { g.printed += 1; }) as typeof webContents.print;
      const save = dialog.showSaveDialog;
      dialog.showSaveDialog = (async () => { g.asked += 1; return { canceled: true, filePath: '' }; }) as typeof dialog.showSaveDialog;
      const menu = Menu.getApplicationMenu()!;
      // A disabled item's click is what the accelerator can't reach; go round it.
      (menu.getMenuItemById('file.print') as unknown as { enabled: boolean }).enabled = true;
      (menu.getMenuItemById('file.savePdf') as unknown as { enabled: boolean }).enabled = true;
      menu.getMenuItemById('file.print')!.click();
      menu.getMenuItemById('file.savePdf')!.click();
      webContents.print = print;
      dialog.showSaveDialog = save;
      return g;
    });
    expect(called).toEqual({ asked: 0, printed: 0 });
    await setState({});
  });

  test('Print goes to the OS\'s print dialog, with the page\'s colours', async () => {
    await setState({});
    await expect.poll(async () => (await menuItem(app, 'file.print'))?.enabled).toBe(true);
    const options = await app.evaluate(({ Menu, BrowserWindow }) => {
      const { webContents } = BrowserWindow.getAllWindows()[0];
      const print = webContents.print;
      let seen: unknown = null;
      webContents.print = ((value: unknown) => { seen = value; }) as typeof webContents.print;
      Menu.getApplicationMenu()!.getMenuItemById('file.print')!.click();
      webContents.print = print;
      return seen;
    });
    expect(options).toMatchObject({ printBackground: true });
    expect((options as { silent?: boolean }).silent).not.toBe(true);
  });

  test('Ctrl+P in a bare preview prints the preview, not the window behind it', async () => {
    const printed = await app.evaluate(({ BrowserWindow, Menu }) => {
      const preview = new BrowserWindow({ show: false });
      const original = BrowserWindow.getFocusedWindow;
      BrowserWindow.getFocusedWindow = () => preview;
      const seen: string[] = [];
      preview.webContents.print = (() => { seen.push('preview'); }) as typeof preview.webContents.print;
      const main = BrowserWindow.getAllWindows().find((w) => w !== preview)!;
      const mainPrint = main.webContents.print;
      main.webContents.print = (() => { seen.push('main'); }) as typeof main.webContents.print;
      Menu.getApplicationMenu()!.getMenuItemById('file.print')!.click();
      BrowserWindow.getFocusedWindow = original;
      main.webContents.print = mainPrint;
      preview.destroy();
      return seen;
    });
    expect(printed).toEqual(['preview']);
  });

  test('the menus take the page\'s translations, and keep English for the rest', async () => {
    await page.evaluate(() => (window as unknown as { bulwarkDesktop: { shell: { setLanguages: (l: object) => void } } }).bulwarkDesktop.shell.setLanguages({
      ui: 'fr',
      labels: { menuReply: 'Répondre', menuFile: 'Fichier', evil: 'x', windowNames: 'x', menuForward: 42 },
    }));
    await expect.poll(async () => (await menuItem(app, 'message.reply'))?.label).toBe('Répondre');
    expect((await menuItem(app, 'message.forward'))?.label).toBe('Forward');
    const names = await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.items.map((item) => item.label));
    expect(names[0]).toBe('&Fichier');
    await page.evaluate(() => (window as unknown as { bulwarkDesktop: { shell: { setLanguages: (l: object) => void } } }).bulwarkDesktop.shell.setLanguages({ ui: 'en' }));
    await expect.poll(async () => (await menuItem(app, 'message.reply'))?.label).toBe('Reply');
  });

  test.describe('right-click', () => {
    test('a real right-click in a field gets cut, copy, paste', async () => {
      const count = await menuCount(app);
      await page.fill('#username', 'someone');
      await page.click('#username', { button: 'right' });
      await expect.poll(() => menuCount(app)).toBeGreaterThan(count);
      const labels = (await lastMenu(app))!.map((item: SeenItem) => item.label);
      expect(labels).toEqual(expect.arrayContaining(['Cut', 'Copy', 'Paste', 'Select all']));
    });

    test('nothing on bare chrome, where a native app shows nothing', async () => {
      const count = await menuCount(app);
      await page.evaluate(() => getSelection()?.removeAllRanges());
      await page.mouse.click(4, 300, { button: 'right' });
      await page.waitForTimeout(400);
      expect(await menuCount(app)).toBe(count);
    });

    const contextMenuAt = (params: Record<string, unknown>) => app.evaluate(({ BrowserWindow }, p) => {
      const base = { x: 1, y: 1, linkURL: '', linkText: '', srcURL: '', pageURL: '', frameURL: '', selectionText: '', mediaType: 'none', hasImageContents: false, isEditable: false, misspelledWord: '', dictionarySuggestions: [], editFlags: { canCut: false, canCopy: false, canPaste: false, canSelectAll: false, canUndo: false, canRedo: false, canDelete: false, canEditRichly: false } };
      BrowserWindow.getAllWindows()[0].webContents.emit('context-menu', {}, { ...base, ...p });
    }, params);

    test('a misspelled word has suggestions and goes in the dictionary', async () => {
      await pickNext(app, 'Add "teh" to dictionary');
      await contextMenuAt({ isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the', 'tea'], editFlags: { canPaste: true } });
      const labels = (await lastMenu(app))!.map((item) => item.label);
      expect(labels.slice(0, 2)).toEqual(['the', 'tea']);
      expect(labels).toContain('Paste');
      await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.session.listWordsInSpellCheckerDictionary())).toContain('teh');
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.session.removeWordFromSpellCheckerDictionary('teh'));
    });

    test('Open Link goes to the page, past its checks, when the page has them', async () => {
      await page.evaluate(() => {
        const w = window as unknown as { __links: string[]; bulwarkDesktop: { menu: { onCommand: (l: (id: string) => void) => void } } };
        w.__links = [];
        w.bulwarkDesktop.menu.onCommand((id) => w.__links.push(id));
      });
      await setState({ 'link.check': true });
      await pickNext(app, 'Open link');
      await contextMenuAt({ linkURL: 'https://example.org/open', linkText: 'click here' });
      await expect.poll(() => page.evaluate(() => (window as unknown as { __links: string[] }).__links.at(-1))).toBe(`link.open:${JSON.stringify({ url: 'https://example.org/open', text: 'click here' })}`);
      // And the page's own path does the rest, once.
      await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened.at(-1))).toBe('https://example.org/open');
      await setState({});
    });

    test('an older page with no such path: straight to the browser, by the same rules', async () => {
      await setState({});
      await pickNext(app, 'Open link');
      await contextMenuAt({ linkURL: 'https://example.org/open2' });
      await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened.at(-1))).toBe('https://example.org/open2');
    });

    test('Copy Link copies', async () => {
      await pickNext(app, 'Copy link');
      await contextMenuAt({ linkURL: 'https://example.org/a?b=1' });
      expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('https://example.org/a?b=1');
    });

    test('selected text gets Copy, Select all and Search mail, and the search goes to the page', async () => {
      await page.evaluate(() => {
        const w = window as unknown as { __searches: string[]; bulwarkDesktop: { menu: { onCommand: (l: (id: string) => void) => void } } };
        w.__searches = [];
        w.bulwarkDesktop.menu.onCommand((id) => {
          if (id.startsWith('mail.searchText:')) w.__searches.push(id);
        });
      });
      await setState({ 'mail.searchText': true });
      const label = 'Search mail for "Are you free at 12? Sam"';
      await pickNext(app, label);
      await contextMenuAt({ selectionText: 'Are you free at 12?\n\nSam', editFlags: { canCopy: true, canSelectAll: true } });
      const seen = (await lastMenu(app))!;
      expect(seen.map((item) => (item.type === 'separator' ? '-' : item.label))).toEqual(['Copy', 'Select all', '-', label]);
      await expect.poll(() => page.evaluate(() => (window as unknown as { __searches: string[] }).__searches.at(-1))).toBe(`mail.searchText:${JSON.stringify('Are you free at 12? Sam')}`);
      // A long selection is quoted short; the search gets more of it.
      await pickNext(app, '');
      await contextMenuAt({ selectionText: 'word '.repeat(80), editFlags: { canCopy: true, canSelectAll: true } });
      const long = (await lastMenu(app))!.at(-1)!.label;
      expect(long.length).toBeLessThan(60);
      expect(long).toContain('…');
      await setState({});
    });

    test('selected text on a page with no mail search: no Search entry', async () => {
      await setState({});
      await contextMenuAt({ selectionText: 'Sam', editFlags: { canCopy: true, canSelectAll: true } });
      expect((await lastMenu(app))!.map((item) => item.label)).toEqual(['Copy', 'Select all']);
    });

    test('no link section for a link inside the app, or a blob', async () => {
      for (const linkURL of [`${APP_ORIGIN}/settings`, `blob:${APP_ORIGIN}/abc`, 'file:///C:/Windows/win.ini', 'javascript:alert(1)']) {
        const count = await menuCount(app);
        await contextMenuAt({ linkURL });
        await page.waitForTimeout(100);
        expect(await menuCount(app), linkURL).toBe(count);
      }
    });

    test('Save Image: the type decides, whatever the sender called it', async () => {
      const run = (filename: string, mime: string) => app.evaluate(({ BrowserWindow, session }, [name, type, partition]) => {
        const { webContents } = BrowserWindow.getAllWindows()[0];
        const original = webContents.downloadURL;
        webContents.downloadURL = (() => {}) as typeof webContents.downloadURL;
        const url = `https://mail.example.org/${Math.random()}`;
        const seen: { cancelled: boolean; options?: { defaultPath?: string } } = { cancelled: false };
        (globalThis as unknown as { __pick: string }).__pick = 'Save image…';
        webContents.emit('context-menu', {}, { x: 1, y: 1, linkURL: '', linkText: '', srcURL: url, pageURL: '', frameURL: '', selectionText: '', mediaType: 'image', hasImageContents: true, isEditable: false, misspelledWord: '', dictionarySuggestions: [], editFlags: {} });
        webContents.session.emit('will-download', {}, {
          getURL: () => url,
          getFilename: () => name,
          getMimeType: () => type,
          cancel: () => { seen.cancelled = true; },
          setSaveDialogOptions: (options: { defaultPath?: string }) => { seen.options = options; },
        });
        webContents.downloadURL = original;
        void session;
        void partition;
        return seen;
      }, [filename, mime, ''] as const);
      expect((await run('invoice.exe', 'image/png')).options?.defaultPath).toBe('invoice.png');
      expect((await run('..\\..\\evil.bat', 'image/jpeg')).options?.defaultPath).toBe('_.._evil.jpg');
      const notAnImage = await run('photo.png', 'application/x-msdownload');
      expect(notAnImage.cancelled).toBe(true);
      expect(notAnImage.options).toBeUndefined();
    });

    test('a mail address copies as an address', async () => {
      await pickNext(app, 'Copy address');
      await contextMenuAt({ linkURL: 'mailto:someone@example.org?subject=x' });
      expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('someone@example.org');
    });

    test('a link with a scheme the OS shouldn\'t run stays closed', async () => {
      await pickNext(app, 'Open link');
      const before = await app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened.length);
      await contextMenuAt({ linkURL: 'file:///C:/Windows/win.ini' });
      await page.waitForTimeout(150);
      expect(await app.evaluate(() => (globalThis as unknown as { __opened: string[] }).__opened.length)).toBe(before);
    });

    test('an image: Save and Copy, unless the organisation turned downloads off', async () => {
      await contextMenuAt({ mediaType: 'image', hasImageContents: true, srcURL: `${APP_ORIGIN}/x.png` });
      expect((await lastMenu(app))!.map((item) => item.label)).toEqual(['Save image…', 'Copy image']);
      const count = await menuCount(app);
      await setState({ 'policy.download': false });
      await expect.poll(() => app.evaluate(() => true)).toBe(true);
      await page.waitForTimeout(100);
      await contextMenuAt({ mediaType: 'image', hasImageContents: true, srcURL: `${APP_ORIGIN}/x.png` });
      await page.waitForTimeout(150);
      // Nothing left to offer: no menu at all.
      expect(await menuCount(app)).toBe(count);
      await setState({});
    });
  });

  test.describe('a menu the page built', () => {
    const popup = (items: unknown[], at?: unknown) =>
      page.evaluate(([list, point]) => (window as unknown as { bulwarkDesktop: { menu: { popup: (i: unknown, a: unknown) => Promise<string | null> } } }).bulwarkDesktop.menu.popup(list, point), [items, at] as const);

    test('shows what it was given and answers with what was picked, also from a submenu', async () => {
      await pickNext(app, 'Inbox');
      const picked = await popup([
        { id: 'a', label: 'Reply' },
        { type: 'separator' },
        { label: 'Move to', submenu: [{ id: 'b', label: 'Inbox' }, { id: 'c', label: 'R&D' }] },
        { id: 'd', label: 'Later', enabled: false },
        { id: 'e', label: 'Mine', type: 'checkbox', checked: true },
      ]);
      expect(picked).toBe('b');
      const seen = (await lastMenu(app))!;
      expect(seen.map((item) => item.label || item.type)).toEqual(['Reply', 'separator', 'Move to', 'Later', 'Mine']);
      expect(seen[2].submenu!.map((item) => item.label)).toEqual(['Inbox', 'R&&D']);
      expect(seen[3].enabled).toBe(false);
      expect(seen[4].checked).toBe(true);
    });

    test('a pick counts as a user action for the page, so a file picker in it isn\'t refused', async () => {
      await app.evaluate(({ BrowserWindow }) => {
        const { webContents } = BrowserWindow.getAllWindows()[0];
        const original = webContents.executeJavaScript.bind(webContents);
        (globalThis as unknown as { __gestures: boolean[] }).__gestures = [];
        webContents.executeJavaScript = ((code: string, gesture?: boolean) => {
          (globalThis as unknown as { __gestures: boolean[] }).__gestures.push(!!gesture);
          return original(code, gesture);
        }) as typeof webContents.executeJavaScript;
      });
      await pickNext(app, 'Attach');
      expect(await popup([{ id: 'a', label: 'Attach' }])).toBe('a');
      expect(await app.evaluate(() => (globalThis as unknown as { __gestures: boolean[] }).__gestures)).toEqual([true]);
      // Dismissed, nothing happened that the page should get credit for.
      expect(await popup([{ id: 'a', label: 'Attach' }])).toBeNull();
      expect(await app.evaluate(() => (globalThis as unknown as { __gestures: boolean[] }).__gestures)).toEqual([true]);
    });

    test('dismissed, it answers null', async () => {
      expect(await popup([{ id: 'a', label: 'Reply' }])).toBeNull();
    });

    test('junk is dropped, and an empty menu never shows', async () => {
      const count = await menuCount(app);
      expect(await popup([null, 5, { label: '' }, { type: 'separator' }, { label: 'No id' }, { label: 'Empty', submenu: [] }])).toBeNull();
      expect(await menuCount(app)).toBe(count);
    });

    test('one absurdly long or deep menu can\'t take the app down', async () => {
      let deep: unknown = { id: 'x', label: 'Bottom' };
      for (let i = 0; i < 50; i += 1) deep = { label: 'Level', submenu: [deep] };
      await popup([deep, { id: 'long', label: 'y'.repeat(100_000) }]);
      const seen = (await lastMenu(app))!;
      expect(seen.at(-1)!.label.length).toBeLessThanOrEqual(300);
    });
  });

  test('an attachment copied as a file is what Explorer pastes', async () => {
    test.skip(process.platform !== 'win32', 'the Windows file clipboard');
    // The test build's own clipboard writer: the user's clipboard stays as it is. What the helper
    // puts on the real clipboard is checked in a window station of its own (native-system.spec.ts).
    await app.evaluate(() => {
      const g = globalThis as unknown as { __clip: string[]; __bulwarkClipboardWriter: (paths: string[]) => Promise<boolean> };
      g.__clip = [];
      g.__bulwarkClipboardWriter = async (paths) => {
        g.__clip.push(...paths);
        return true;
      };
    });
    const copied = await page.evaluate(() => (window as unknown as { bulwarkDesktop: { clipboard: { copyFile: (n: string, d: ArrayBuffer) => Promise<boolean> } } }).bulwarkDesktop.clipboard.copyFile('../report: q3?.txt', new TextEncoder().encode('hello').buffer));
    expect(copied).toBe(true);
    const handed = await app.evaluate(() => (globalThis as unknown as { __clip: string[] }).__clip);
    expect(handed).toHaveLength(1);
    const file = handed[0];
    expect(path.basename(file)).toBe('_report_ q3_.txt');
    // In this profile, never next to something else, and it holds the bytes.
    expect(file.toLowerCase().startsWith(path.join(profile, 'clipboard-files').toLowerCase())).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('hello');
  });

  test('refuses anything but bytes', async () => {
    const refused = await page.evaluate(() => (window as unknown as { bulwarkDesktop: { clipboard: { copyFile: (n: string, d: unknown) => Promise<boolean> } } }).bulwarkDesktop.clipboard.copyFile('a.txt', 'not bytes'));
    expect(refused).toBe(false);
  });

  test.describe('native questions', () => {
    const confirm = (options: unknown) =>
      page.evaluate((value) => (window as unknown as { bulwarkDesktop: { dialogs: { confirm: (o: unknown) => Promise<number> } } }).bulwarkDesktop.dialogs.confirm(value), options);

    test('answer with the button, and the last one is the way out', async () => {
      const answer = await confirm({ message: 'Discard this draft?', detail: 'It goes for good.', buttons: ['Discard', 'Cancel'], defaultId: 1, type: 'warning' });
      expect(answer).toBe(0);
      const prompt = (await prompts(app)).at(-1) as unknown as { message: string; buttons: string[]; cancelId: number; defaultId: number; type: string };
      expect(prompt).toMatchObject({ message: 'Discard this draft?', buttons: ['Discard', 'Cancel'], cancelId: 1, defaultId: 1, type: 'warning' });
    });

    test('refuse what isn\'t a question', async () => {
      await expect(confirm({ buttons: [] })).rejects.toThrow();
    });
  });
});

test.describe('closing', () => {
  let profile = '';
  let app: ElectronApplication;
  let page: Page;
  const setCloseToTray = (closeToTray: boolean) => page.evaluate((value) => (window as unknown as { bulwarkDesktop: { os: { setSettings: (patch: unknown) => Promise<unknown> } } }).bulwarkDesktop.os.setSettings({ closeToTray: value }), closeToTray);

  test.beforeEach(async () => {
    profile = tempProfile('close');
    ({ app, page } = await launchStandalone(profile));
    await fakeOsIntegration(app);
    await waitForLogin(page);
    // These are about an app with nothing to stay running in. The tray is the next test's.
    await setCloseToTray(false);
  });

  test.afterEach(async () => {
    await app.close().catch(() => {});
    removeProfile(profile);
  });

  const openPopout = async (id: string) => {
    await page.evaluate(
      (emailId) => (window as unknown as { bulwarkDesktop: { windows: { openMessage: (t: object) => void } } }).bulwarkDesktop.windows.openMessage({ url: `/popout/message/${emailId}`, emailId }),
      id,
    );
    return pageWith(app, `/popout/message/${id}`);
  };
  const windowCount = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  const closeFirst = () => app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/login'))!.close();
  });
  // By its id: with nobody signed in here, a pop-out's page moves on to the login page by itself.
  const newestId = () => app.evaluate(({ BrowserWindow }) => Math.max(...BrowserWindow.getAllWindows().map((w) => w.id)));
  const closeById = (id: number) => app.evaluate(({ BrowserWindow }, windowId) => {
    BrowserWindow.fromId(windowId)?.close();
  }, id);

  const onFlush = (on: Page, answer: unknown) => on.evaluate((value) => {
    (window as unknown as { bulwarkDesktop: { lifecycle: { onFlushRequest: (h: () => Promise<unknown>) => void } } }).bulwarkDesktop.lifecycle.onFlushRequest(async () => value);
  }, answer);

  test('closing the main window with a pop-out open only hides it, and the pop-out keeps its session source', async () => {
    const other = await openPopout('m1');
    await closeFirst();
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/login'))?.isVisible())).toBe(false);
    expect(await windowCount()).toBe(2);
    expect(await other.evaluate(() => (window as unknown as { bulwarkDesktop: { windows: { list: () => Promise<{ visible: boolean; type: string }[]> } } }).bulwarkDesktop.windows.list()))
      .toEqual(expect.arrayContaining([expect.objectContaining({ type: 'main', visible: false })]));
  });

  test('a second launch brings the hidden main window back', async () => {
    await openPopout('m2');
    await closeFirst();
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length)).toBe(1);
    await app.evaluate(({ app: electronApp }) => {
      electronApp.emit('second-instance', {}, ['bulwark.exe'], '');
    });
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length)).toBe(2);
  });

  test('a pop-out closed before its first paint takes nothing down', async () => {
    for (const id of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) {
      const other = await openPopout(id);
      const windowId = await newestId();
      await onFlush(other, {});
      await closeById(windowId);
      await expect.poll(windowCount, { timeout: 30_000 }).toBe(1);
    }
    expect(await page.evaluate(() => 1)).toBe(1);
  });

  test('a page closing its own window as it finishes loading takes nothing down', async () => {
    for (const id of ['q1', 'q2', 'q3', 'q4', 'q5', 'q6']) {
      const other = await openPopout(id);
      const windowId = await newestId();
      // No 'close' event on the window for this. Chromium ignores it once the page has moved on.
      await other.evaluate(() => window.close()).catch(() => undefined);
      await other.waitForTimeout(300).catch(() => undefined);
      await closeById(windowId);
      await expect.poll(windowCount, { timeout: 30_000 }).toBe(1);
    }
    expect(await page.evaluate(() => 1)).toBe(1);
  });

  test('closing the last pop-out with the main window minimised leaves the app running', async () => {
    await openPopout('m9');
    const windowId = await newestId();
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/login'))!.minimize();
    });
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/login'))!.isMinimized())).toBe(true);
    await closeById(windowId);
    await expect.poll(windowCount).toBe(1);
    // Long enough for a close of the main window to have gone through.
    await page.waitForTimeout(1500);
    expect(await windowCount()).toBe(1);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isMinimized())).toBe(true);
  });

  test('when the last pop-out goes too, so does the hidden main window, and the app quits', async () => {
    await openPopout('m3');
    const windowId = await newestId();
    await closeFirst();
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length)).toBe(1);
    const gone = new Promise<void>((resolve) => app.process().once('exit', () => resolve()));
    await closeById(windowId).catch(() => undefined);
    await gone;
  });

  test('with close to tray on, the last pop-out going leaves the hidden main window running', async () => {
    await setCloseToTray(true);
    await openPopout('t1');
    const windowId = await newestId();
    await closeFirst();
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length)).toBe(1);
    await closeById(windowId).catch(() => undefined);
    await expect.poll(windowCount).toBe(1);
    await page.waitForTimeout(1500);
    expect(await windowCount()).toBe(1);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(false);
  });

  test('a hidden main window asking shows itself first, so Stay leaves something on screen', async () => {
    await fakeOsIntegration(app, 1);
    await onFlush(page, { failed: 1 });
    const other = await openPopout('h1');
    await closeFirst();
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/login'))?.isVisible())).toBe(false);
    // The last pop-out goes, so the hidden main goes too, and its save failed.
    await other.close();
    await expect.poll(async () => (await prompts(app)).length).toBe(1);
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/login'))?.isVisible())).toBe(true);
    await fakeOsIntegration(app, 0);
  });

  test('the OS ending the session saves every window, with no question', async () => {
    await page.evaluate(() => {
      (window as unknown as { bulwarkDesktop: { lifecycle: { onFlushRequest: (h: () => Promise<unknown>) => void } } }).bulwarkDesktop.lifecycle.onFlushRequest(async () => {
        localStorage.setItem('saved-at-end', 'yes');
        return { failed: 1 };
      });
    });
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].emit('session-end', {});
    });
    await expect.poll(() => page.evaluate(() => localStorage.getItem('saved-at-end'))).toBe('yes');
    await page.waitForTimeout(200);
    expect(await prompts(app)).toEqual([]);
  });

  test('a pop-out whose page dies comes back, and one that keeps dying goes', async () => {
    const other = await openPopout('crash1');
    const crash = () => app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('crash1'))?.webContents.forcefullyCrashRenderer();
    });
    await other.waitForLoadState();
    await crash();
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('crash1'))?.webContents.isCrashed()), { timeout: 15_000 }).toBe(false);
    await page.waitForTimeout(1500);
    await crash();
    await page.waitForTimeout(1500);
    await crash();
    await expect.poll(windowCount, { timeout: 15_000 }).toBe(1);
    expect(page.isClosed()).toBe(false);
  });

  test('a window that asks to close itself isn\'t asked to save again', async () => {
    const other = await openPopout('m4');
    await other.evaluate(() => {
      const w = window as unknown as { bulwarkDesktop: { lifecycle: { onFlushRequest: (h: () => Promise<unknown>) => void }; windows: { closeSelf: () => void } } };
      w.bulwarkDesktop.lifecycle.onFlushRequest(async () => {
        localStorage.setItem('asked-to-save', 'yes');
        return {};
      });
      w.bulwarkDesktop.windows.closeSelf();
    });
    await expect.poll(windowCount).toBe(1);
    expect(await page.evaluate(() => localStorage.getItem('asked-to-save'))).toBeNull();
  });

  test('a window closed as its page finishes loading isn\'t shown on its way out', async () => {
    // Showing it then took the whole app down, about one close in five.
    await app.evaluate(({ BrowserWindow }) => {
      const g = globalThis as unknown as { __late: number };
      g.__late = 0;
      const show = BrowserWindow.prototype.show;
      BrowserWindow.prototype.show = function patched(this: Electron.BrowserWindow) {
        if ((this as unknown as { __closingNow?: boolean }).__closingNow) g.__late += 1;
        return show.call(this);
      };
    });
    for (let round = 0; round < 3; round++) {
      await page.evaluate(
        (name) => (window as unknown as { bulwarkDesktop: { windows: { open: (u: string, o: object) => void } } }).bulwarkDesktop.windows.open(`/en/login?${name}=1`, { name, width: 500, height: 500 }),
        `late${round}`,
      );
      await expect.poll(windowCount).toBe(2);
      await app.evaluate(({ BrowserWindow }) => {
        const late = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('late') || !w.isVisible())!;
        (late as unknown as { __closingNow: boolean }).__closingNow = true;
        late.close();
        // It finishes painting right then.
        late.emit('ready-to-show');
      });
      await expect.poll(windowCount).toBe(1);
    }
    expect(await app.evaluate(() => (globalThis as unknown as { __late: number }).__late)).toBe(0);
    expect(await page.evaluate(() => 1)).toBe(1);
  });

  test('the X asks the page to save, once', async () => {
    const other = await openPopout('m5');
    const windowId = await newestId();
    await other.evaluate(() => {
      const w = window as unknown as { bulwarkDesktop: { lifecycle: { onFlushRequest: (h: () => Promise<unknown>) => void } } };
      w.bulwarkDesktop.lifecycle.onFlushRequest(async () => {
        localStorage.setItem('saves', String(Number(localStorage.getItem('saves') ?? 0) + 1));
        return {};
      });
    });
    await closeById(windowId);
    await expect.poll(windowCount).toBe(1);
    expect(await page.evaluate(() => localStorage.getItem('saves'))).toBe('1');
    expect(await prompts(app)).toEqual([]);
  });

  test('a save that failed asks before the window goes, and Stay keeps it', async () => {
    await fakeOsIntegration(app, 1);
    const other = await openPopout('m6');
    const windowId = await newestId();
    await onFlush(other, { failed: 1 });
    const closeIt = () => closeById(windowId);
    await closeIt();
    await expect.poll(async () => (await prompts(app)).length).toBe(1);
    expect((await prompts(app))[0].message).toBe('A draft could not be saved');
    expect(await windowCount()).toBe(2);
    // And Close anyway does.
    await fakeOsIntegration(app, 0);
    await closeIt();
    await expect.poll(windowCount).toBe(1);
  });

  test('a page that hangs can\'t keep a window open past its limit, and that counts as unsaved', async () => {
    const other = await openPopout('m7');
    await other.evaluate(() => {
      (window as unknown as { bulwarkDesktop: { lifecycle: { onFlushRequest: (h: () => Promise<unknown>) => void } } }).bulwarkDesktop.lifecycle.onFlushRequest(() => new Promise(() => {}));
    });
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('/popout/'))!.close();
    });
    await expect.poll(async () => (await prompts(app)).length, { timeout: 8000 }).toBe(1);
    await expect.poll(windowCount).toBe(1);
  });

  test('quit: with nothing unsaved there\'s no question', async () => {
    const gone = new Promise<void>((resolve) => app.process().once('exit', () => resolve()));
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await gone;
  });

  test('quit with mail waiting asks natively, and Stay calls it off with everything still there', async () => {
    await fakeOsIntegration(app, 1);
    await onFlush(page, { unsent: 2 });
    const other = await openPopout('q1');
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await expect.poll(async () => (await prompts(app)).length).toBe(1);
    expect((await prompts(app))[0]).toMatchObject({ message: 'Some mail has not been sent yet' });
    expect((await prompts(app))[0].detail).toContain('2 messages');
    await page.waitForTimeout(300);
    expect(await windowCount()).toBe(2);
    expect(other.isClosed()).toBe(false);
    // The second time, Quit.
    await fakeOsIntegration(app, 0);
    const gone = new Promise<void>((resolve) => app.process().once('exit', () => resolve()));
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await gone;
  });

  test('closing the last window with mail waiting asks too', async () => {
    await fakeOsIntegration(app, 1);
    await onFlush(page, { unsent: 1 });
    await closeFirst();
    await expect.poll(async () => (await prompts(app)).length).toBe(1);
    expect((await prompts(app))[0].detail).toContain('One message');
    expect(await windowCount()).toBe(1);
    // The next one, from the test's own clean-up, goes through.
    await fakeOsIntegration(app, 0);
  });
});

test('a deep link waits for a session, opens through the window manager, and is rate limited', async () => {
  const profile = tempProfile('deep');
  const login = 'ent-alice@example.org@stalwart-1.internal.bulwarkmail.org';
  const { app, page } = await launchStandalone(profile, `bulwark://message/${login}/abc1`);
  const types = () => page.evaluate(() => (window as unknown as { bulwarkDesktop: { windows: { list: () => Promise<{ type: string }[]> } } }).bulwarkDesktop.windows.list().then((list) => list.map((w) => w.type).sort()));
  const urls = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.webContents.getURL()));
  const secondLaunch = (link: string) => app.evaluate(({ app: electronApp }, url) => {
    electronApp.emit('second-instance', {}, ['bulwark.exe', url], '');
  }, link);
  try {
    await waitForLogin(page);
    // Nobody signed in: a pop-out would have no session to borrow, so the link waits.
    await page.waitForTimeout(500);
    expect(await types()).toEqual(['main']);
    // One from a second launch waits too, and takes the place of the first.
    await secondLaunch(`bulwark://message/${login}/abc1`);
    await page.waitForTimeout(500);
    expect(await types()).toEqual(['main']);

    const opening = app.evaluate(({ BrowserWindow }) => new Promise<string>((resolve) => {
      const known = new Set(BrowserWindow.getAllWindows().map((w) => w.id));
      const timer = setInterval(() => {
        const fresh = BrowserWindow.getAllWindows().find((w) => !known.has(w.id));
        if (!fresh) return;
        clearInterval(timer);
        fresh.webContents.once('did-start-navigation', (details) => resolve(details.url));
        const pending = fresh.webContents.getURL();
        if (pending) resolve(pending);
      }, 5);
    }));
    await page.evaluate(() => (window as unknown as { bulwarkDesktop: { windows: { sessionReady: () => void } } }).bulwarkDesktop.windows.sessionReady());
    const opened = await opening;
    // A message window, on the login the link names, marked as coming from a link.
    expect(opened).toContain('/popout/message/abc1');
    expect(opened).toContain(`account=${encodeURIComponent(login)}`);
    expect(opened).toContain('via=link');
    await expect.poll(types).toEqual(['main', 'message']);

    // The same message: that window, no second one.
    await secondLaunch(`bulwark://message/${login}/abc1`);
    await page.waitForTimeout(300);
    expect(await types()).toEqual(['main', 'message']);

    // A folder: the page's router, no load of the window.
    await page.evaluate(() => {
      const w = window as unknown as { __links: string[]; bulwarkDesktop: { menu: { onCommand: (l: (id: string) => void) => void } } };
      w.__links = [];
      w.bulwarkDesktop.menu.onCommand((id) => w.__links.push(id));
    });
    await secondLaunch('bulwark://folder/sent');
    await expect.poll(() => page.evaluate(() => (window as unknown as { __links: string[] }).__links)).toEqual(['link.folder:sent']);
    await secondLaunch('bulwark://mailbox/b7');
    await expect.poll(() => page.evaluate(() => (window as unknown as { __links: string[] }).__links.at(-1))).toBe('link.folder:b7');

    // Something else from outside goes nowhere.
    await secondLaunch('bulwark://evil/../../x');
    await page.waitForTimeout(200);
    expect((await urls()).some((u) => u.includes('evil'))).toBe(false);

    // A page firing links in a loop: five in ten seconds, counting those above.
    for (let i = 0; i < 8; i += 1) await secondLaunch(`bulwark://message/${login}/flood${i}`);
    await page.waitForTimeout(800);
    expect((await types()).filter((type) => type === 'message').length).toBeLessThan(3);
  } finally {
    await app.close();
    removeProfile(profile);
  }
});

test('zoom is back at the next start', async () => {
  const profile = tempProfile('zoom');
  let { app, page } = await launchStandalone(profile);
  await waitForLogin(page);
  await clickMenuItem(app, 'view.zoomIn');
  await clickMenuItem(app, 'view.zoomIn');
  await app.close();
  ({ app, page } = await launchStandalone(profile));
  try {
    await waitForLogin(page);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomLevel())).toBe(1);
    // A native menu's place depends on it: page coordinates scale by this.
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor())).toBeCloseTo(1.2, 1);
  } finally {
    await app.close();
    removeProfile(profile);
  }
});

test('the tray\'s hook: a last window closing leaves the app running, hidden', async () => {
  const profile = tempProfile('tray');
  const { app, page } = await launchStandalone(profile, '--bulwark-test-close-to-background');
  try {
    await waitForLogin(page);
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].close();
    });
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.isVisible()))).toEqual([false]);
    // Quit still means quit.
    const gone = new Promise<void>((resolve) => app.process().once('exit', () => resolve()));
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await gone;
  } finally {
    await app.close().catch(() => {});
    removeProfile(profile);
  }
});

test.describe('spellcheck makes no silent call to Google', () => {
  test('the address goes nowhere before anything else happens on the session', () => {
    const calls: string[] = [];
    closeDictionaryDownloads({
      setSpellCheckerDictionaryDownloadURL: (url: string) => calls.push(`url ${url}`),
      on: () => {
        calls.push('listen');
        return undefined;
      },
    });
    expect(calls[0]).toBe(`url ${DEAD_DICTIONARY_URL}`);
    expect(new URL(DEAD_DICTIONARY_URL).hostname.endsWith('.invalid')).toBe(true);
  });

  test('in the app: a language with no dictionary fails instead of fetching one, and says so', async () => {
    test.skip(process.platform === 'darwin', 'macOS has its own checker');
    const profile = tempProfile('spell');
    const { app, page } = await launchStandalone(profile);
    try {
      await waitForLogin(page);
      const outcome = await app.evaluate(({ BrowserWindow }) => new Promise<string>((resolve) => {
        const { session } = BrowserWindow.getAllWindows()[0].webContents;
        const language = session.availableSpellCheckerLanguages.find((l) => l.startsWith('pt')) ?? 'fr-FR';
        session.once('spellcheck-dictionary-download-success', () => resolve('downloaded'));
        session.once('spellcheck-dictionary-download-failure', () => resolve('refused'));
        setTimeout(() => resolve('nothing'), 25_000);
        session.setSpellCheckerLanguages([language]);
      }));
      expect(outcome).not.toBe('downloaded');
      if (outcome === 'refused') {
        const missing = await page.evaluate(() => (window as unknown as { bulwarkDesktop: { spellcheck: { missing: () => Promise<string[]> } } }).bulwarkDesktop.spellcheck.missing());
        // Windows: its own checker or none, never a dictionary question (test/spelling.spec.ts).
        if (process.platform === 'win32') expect(missing).toEqual([]);
        else expect(missing.length).toBeGreaterThan(0);
      }
    } finally {
      await app.close();
      removeProfile(profile);
    }
  });
});

test.describe('coming back after a crash', () => {
  function seedSession(profile: string, extra: Record<string, unknown> = {}): void {
    writeFileSync(path.join(profile, 'shell-state.json'), JSON.stringify({
      mode: 'standalone',
      session: [{ type: 'message', url: `${APP_ORIGIN}/popout/message/back1`, key: 'bulwark-message-back1' }],
      ...extra,
    }));
  }
  const readState = (profile: string) => JSON.parse(readFileSync(path.join(profile, 'shell-state.json'), 'utf8')) as { restoreAttempts?: number; session?: unknown[]; restoreWindows?: boolean };
  const sessionReady = (page: Page) => page.evaluate(() => (window as unknown as { bulwarkDesktop: { windows: { sessionReady: () => void } } }).bulwarkDesktop.windows.sessionReady());
  const windowCount = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);

  test('two starts that die while restoring: the third goes without, and the app stays up', async () => {
    const profile = tempProfile('loop');
    // A clean first run: its keys are only safe once Chromium has written its own
    // state, some seconds in. A kill before that is another matter (see the decisions).
    const first = await launchStandalone(profile);
    await waitForLogin(first.page);
    await first.app.close();
    seedSession(profile);
    // The dead app's other processes hold the profile for a moment, and a launch then
    // takes itself for a second copy and leaves.
    const launchWhenFree = async (): Promise<{ app: ElectronApplication; page: Page }> => {
      for (let tries = 0; ; tries += 1) {
        let started: ElectronApplication;
        try {
          started = await launch(profile, '--standalone');
        } catch (error) {
          if (tries > 8) throw error;
          await new Promise((resolve) => setTimeout(resolve, 3000));
          continue;
        }
        return { app: started, page: await shownPage(started) };
      }
    };
    for (const expected of [1, 2]) {
      const { app, page } = await launchWhenFree();
      await waitForLogin(page);
      await sessionReady(page);
      // Written before the first window opens: a crash leaves no time after.
      await expect.poll(() => readState(profile).restoreAttempts).toBe(expected);
      // The real main process: what Playwright started is only a launcher on Windows.
      const pid = await app.evaluate(() => process.pid);
      process.kill(pid, 'SIGKILL');
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
    const { app, page } = await launchWhenFree();
    try {
      await waitForLogin(page);
      await sessionReady(page);
      await page.waitForTimeout(1000);
      expect(await windowCount(app)).toBe(1);
      await expect.poll(() => readState(profile).restoreAttempts).toBeUndefined();
    } finally {
      await app.close();
      removeProfile(profile);
    }
  });

  test('a quit before anyone signed in keeps what was to come back', async () => {
    const profile = tempProfile('early');
    seedSession(profile);
    const { app, page } = await launchStandalone(profile);
    await waitForLogin(page);
    await app.close();
    expect(readState(profile).session).toHaveLength(1);
    removeProfile(profile);
  });

  test('with the setting off the list is gone and nothing is written', async () => {
    const profile = tempProfile('off');
    seedSession(profile, { restoreWindows: false });
    const { app, page } = await launchStandalone(profile);
    await waitForLogin(page);
    // The page holds the setting. The shell has its copy of it.
    await page.evaluate(() => {
      localStorage.setItem('bulwark-desktop-window-prefs', JSON.stringify({ restoreWindows: false }));
      window.dispatchEvent(new StorageEvent('storage', { key: 'bulwark-desktop-window-prefs' }));
    });
    await expect.poll(() => readState(profile).restoreWindows, { timeout: 10_000 }).toBe(false);
    await page.evaluate(() => (window as unknown as { bulwarkDesktop: { windows: { openMessage: (t: object) => void } } }).bulwarkDesktop.windows.openMessage({ url: '/popout/message/x1', emailId: 'x1' }));
    await expect.poll(() => windowCount(app)).toBe(2);
    await app.close();
    expect(readState(profile).session).toBeUndefined();
    removeProfile(profile);
  });

  test('windows wait for a main window started hidden', async () => {
    const profile = tempProfile('hidden');
    seedSession(profile);
    const { app, page } = await launchStandalone(profile);
    try {
      await waitForLogin(page);
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
      await sessionReady(page);
      await page.waitForTimeout(600);
      expect(await windowCount(app)).toBe(1);
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
      await expect.poll(() => windowCount(app), { timeout: 10_000 }).toBe(2);
    } finally {
      await app.close();
      removeProfile(profile);
    }
  });
});

test.describe('a line of the page\'s own menu bar runs only on a click or key main saw', () => {
  // An instance whose page runs lines of the bar itself (test/support/hostile-instance-2.ts).
  // Recent files from a folder of shortcuts this test makes, never the user's own.
  test.skip(process.platform !== 'win32', 'Windows shortcuts');
  let hostile: HostileInstance;
  let root = '';
  let recent = '';

  test.beforeAll(async () => {
    hostile = await startHostileInstance(3840);
    root = mkdtempSync(path.join(tmpdir(), 'bw-menu-recent-'));
    recent = path.join(root, 'Recent');
    mkdirSync(recent);
    mkdirSync(path.join(root, 'Documents'));
    writeFileSync(path.join(root, 'Documents', 'salary-2026.xlsx'), 'FAKE-SECRET salary table');
  });
  test.afterAll(() => {
    hostile?.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  });

  const lootOf = (kind: string) => hostile.loot.filter((entry) => entry.kind === kind).map((entry) => entry.body);
  const zoomLevel = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.isVisible())!.webContents.getZoomLevel());

  /** The instance's page with a recent file to find, no lock and every native question answered no. Then `mode` runs. */
  async function openHostile(profile: string, mode: HostileInstance['mode']): Promise<{ app: ElectronApplication; page: Page }> {
    hostile.loot.length = 0;
    hostile.mode = 'idle';
    const app = await launch(profile, `--instance=${hostile.origin}/`, '--ignore-certificate-errors', '--bulwark-test-no-native', `--bulwark-test-recent-dir=${recent}`);
    const page = await shownPage(app);
    await app.evaluate(({ app: electronApp, shell }) => {
      electronApp.relaunch = () => undefined;
      shell.openExternal = async () => undefined;
      shell.openPath = async () => '';
      shell.showItemInFolder = () => undefined;
    });
    await fakeOsIntegration(app, 1);
    const made = await app.evaluate(({ shell }, [lnk, target]) => shell.writeShortcutLink(lnk, 'create', { target }), [path.join(recent, 'salary-2026.xlsx.lnk'), path.join(root, 'Documents', 'salary-2026.xlsx')]);
    expect(made).toBe(true);
    await expect.poll(() => lootOf('bridge').length).toBeGreaterThan(0);
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { hub: { locked: boolean } } }).__bulwarkOs.hub.locked), { timeout: 30_000 }).toBe(false);
    hostile.loot.length = 0;
    hostile.mode = mode;
    await page.reload();
    return { app, page };
  }

  test('no mouse, no key: lines the page runs give it no recent files, no user activation and no drive', async () => {
    const profile = tempProfile('menu-run');
    const { app } = await openHostile(profile, 'menu');
    try {
      await expect.poll(() => lootOf('menu-done').length, { timeout: 60_000 }).toBe(1);
      expect.soft(lootOf('recent-list'), 'recent files handed to the page').toEqual([]);
      expect.soft(lootOf('recent-file'), 'file contents handed to the page').toEqual([]);
      expect.soft(lootOf('activation-after')[0] ?? false, 'navigator.userActivation.isActive after the page ran a menu line').toBe(false);
      expect.soft((lootOf('drive-by-menu')[0] as { ok?: boolean } | undefined)?.ok ?? false, 'the Files drive turned on').toBe(false);
    } finally {
      await app.close().catch(() => {});
      removeProfile(profile);
    }
  });

  test('a line run on load, or 6 seconds after a click, doesn\'t run; one run right on a click does', async () => {
    const profile = tempProfile('menu-late');
    const { app, page } = await openHostile(profile, 'menu-late');
    try {
      const before = await zoomLevel(app);
      await expect.poll(() => lootOf('menu-ready').length, { timeout: 30_000 }).toBe(1);
      expect(lootOf('ran-on-load')).toHaveLength(1);
      expect(await zoomLevel(app), 'zoomed by a line run on load').toBe(before);
      await page.mouse.click(400, 500);
      await expect.poll(() => lootOf('ran-late').length, { timeout: 20_000 }).toBe(1);
      expect(await zoomLevel(app), 'zoomed by a line run 6 s after a click').toBe(before);
      expect(lootOf('ran-late')[0], 'recent files 6 s after a click').toEqual({ ok: false, reason: 'gesture' });
      await page.mouse.click(400, 500);
      await expect.poll(() => lootOf('ran-on-click').length, { timeout: 20_000 }).toBe(1);
      await expect.poll(() => zoomLevel(app), { timeout: 5_000 }).toBeGreaterThan(before);
    } finally {
      await app.close().catch(() => {});
      removeProfile(profile);
    }
  });

  test('two lines run on one click: one gesture for what follows, not one per line', async () => {
    const profile = tempProfile('menu-twice');
    const { app, page } = await openHostile(profile, 'menu-twice');
    try {
      // The user lets this server see recent files when asked: what's left to stop the second list is the click.
      await fakeOsIntegration(app, 0);
      await expect.poll(() => lootOf('menu-ready').length, { timeout: 30_000 }).toBe(1);
      await page.mouse.click(400, 500);
      await expect.poll(() => lootOf('twice').length, { timeout: 20_000 }).toBe(1);
      const { first, second } = lootOf('twice')[0] as { first: { ok: boolean }; second: unknown };
      expect(first.ok, 'the click itself still counts').toBe(true);
      expect(second, 'a second line on the same click').toEqual({ ok: false, reason: 'gesture' });
    } finally {
      await app.close().catch(() => {});
      removeProfile(profile);
    }
  });

  test('Save as and Import, reported enabled by the page and run with no input, give it no user activation', async () => {
    const profile = tempProfile('menu-activation');
    const { app } = await openHostile(profile, 'menu-activation');
    try {
      await expect.poll(() => lootOf('menu-done').length, { timeout: 30_000 }).toBe(1);
      expect(lootOf('activation')[0]).toEqual({ 'file.saveAs': false, 'file.import': false });
    } finally {
      await app.close().catch(() => {});
      removeProfile(profile);
    }
  });
});

test.describe('the in-window menu bar and the user\'s real input', () => {
  // An instance whose page runs lines of the bar on input (test/support/input-instance.ts).
  test.skip(process.platform !== 'win32', 'the page draws the bar on Windows and Linux; Windows here');
  let instance: InputInstance;
  test.beforeAll(async () => {
    instance = await startInputInstance(3845);
  });
  test.afterAll(() => instance?.close());

  const lootOf = (kind: string) => instance.loot.filter((entry) => entry.kind === kind).map((entry) => entry.body);
  const zoomLevel = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.isVisible())!.webContents.getZoomLevel());

  /** The instance's page in `mode`, every outside program stood in for, every question answered with `answer`. */
  async function openInstance(profile: string, mode: InputInstance['mode'], answer = 1): Promise<{ app: ElectronApplication; page: Page }> {
    instance.loot.length = 0;
    instance.mode = 'idle';
    const app = await launch(profile, `--instance=${instance.origin}/`, '--ignore-certificate-errors', '--bulwark-test-no-native');
    const page = await shownPage(app);
    await app.evaluate(({ app: electronApp, shell, BrowserWindow }) => {
      electronApp.relaunch = () => undefined;
      shell.openPath = async () => '';
      shell.showItemInFolder = () => undefined;
      const g = globalThis as unknown as { __pastes: number };
      g.__pastes = 0;
      // Paste is stood in for: nothing here reads the clipboard.
      for (const window of BrowserWindow.getAllWindows()) {
        const count = () => {
          g.__pastes += 1;
        };
        window.webContents.paste = count;
        (Object.getPrototypeOf(window.webContents) as { paste: () => void }).paste = count;
      }
    });
    await fakeOsIntegration(app, answer);
    await expect.poll(() => lootOf('bridge').length).toBeGreaterThan(0);
    await expect.poll(() => app.evaluate(() => (globalThis as unknown as { __bulwarkOs: { hub: { locked: boolean } } }).__bulwarkOs.hub.locked), { timeout: 30_000 }).toBe(false);
    instance.loot.length = 0;
    instance.mode = mode;
    await page.reload();
    return { app, page };
  }

  /** A key as the OS sends it through the browser's input path: a raw key down, its character, the key up. */
  async function pressKey(page: Page, key: string, code: string, vk: number, text: string): Promise<void> {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    if (text) await cdp.send('Input.dispatchKeyEvent', { type: 'char', key, code, text, unmodifiedText: text, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await cdp.detach();
  }

  test('from the keyboard: Enter and Space run the line, a letter and an arrow do not', async () => {
    const profile = tempProfile('menu-keys');
    const { app, page } = await openInstance(profile, 'key-pick');
    try {
      await expect.poll(() => lootOf('ready').length, { timeout: 30_000 }).toBe(1);
      const levels: number[] = [await zoomLevel(app)];
      // Each key runs Zoom in on the page's side. Playwright's own key press sends Enter and
      // Space as another kind of key down than the OS does, so the keys go in as the OS sends them.
      for (const [key, code, vk, text] of [['p', 'KeyP', 80, 'p'], ['Enter', 'Enter', 13, '\r'], [' ', 'Space', 32, ' '], ['ArrowDown', 'ArrowDown', 40, '']] as const) {
        // Past the second a pick lasts, so each key stands alone.
        await page.waitForTimeout(1_300);
        await pressKey(page, key, code, vk, text);
        await expect.poll(() => lootOf('key-ran').length, { timeout: 10_000 }).toBe(levels.length);
        levels.push(await zoomLevel(app));
      }
      expect(levels[1], 'a letter').toBe(levels[0]);
      expect(levels[2], 'Enter').toBeGreaterThan(levels[1]);
      expect(levels[3], 'Space').toBeGreaterThan(levels[2]);
      expect(levels[4], 'an arrow').toBe(levels[3]);
    } finally {
      await app.close().catch(() => {});
      removeProfile(profile);
    }
  });
});
