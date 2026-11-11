/**
 * The app menu. Commands the page has to run go to it by id over the bridge
 * (`menu.onCommand`), where the webmail's own actions run them: nothing here knows
 * how to reply or move a message. What the page reports with `menu.setState` decides
 * what's enabled, per window, applied when that window has the focus.
 *
 * Shortcuts and the webmail's own: single keys (r, f, Delete) belong to the page,
 * which knows when you're typing or a dialog is open. They're shown here without being
 * registered, on Windows and Linux. macOS has no such option, so they're left off there
 * and the keys still work. When the user turned single keys off, none are shown.
 * Chords such as Ctrl+N are real accelerators. A key press reaches the page first,
 * and only one the page didn't take reaches the menu, so the two can't both fire.
 *
 * In a window with an integrated title bar on Windows and Linux there's no native bar:
 * the page draws these same menus as a row at the top when Alt is pressed, or always
 * with "Always show the menu bar" (`barMenus`, `runBarItem`). Its controls shrink to
 * that row while it's there, as in a native window with a menu bar.
 */

import { app, BrowserWindow, Menu, shell, type MenuItem, type MenuItemConstructorOptions } from 'electron';
import { CHANNEL, type MenuBarEntry, type MenuBarEvent, type MenuBarItem, type MenuBarMenu, type MenuBarReport, type MenuState } from '../shared/bridge';
import { assignMnemonics, barItemsOf, enabledWhileLocked, findBarItem, tidySeparators, windowMenuNames, type BarSourceItem } from './menu-text';
import { strings } from './strings';
import { lineRectFits, noteUserGesture, pickHitsLine, takePick, type ReportedLine } from './user-gesture';
import type { WindowManager } from './windows';

export interface MenuHooks {
  /** Left out while a policy forces the connection. Asks first (natively), then restarts. */
  switchMode?: () => void;
  /** The same without the question: the page asked already. */
  switchModeNow?: () => void;
  devTools: boolean;
  newWindow: () => void;
  zoom: (step: 1 | -1 | 0) => void;
  print: (window: BrowserWindow) => void;
  saveAsPdf: (window: BrowserWindow) => void;
  back: (window: BrowserWindow, direction: 1 | -1) => void;
  /** File > Open…: the OS's open dialog, then what "Open with" does with the files. Set by the os feature. */
  open?: (window: BrowserWindow) => void;
}

/** Features add their own lines, such as "Restart to update". */
/** `new` sits right under New message in File, with no line of its own. */
export type MenuSection = 'new' | 'file' | 'view' | 'help' | 'app';
type Extension = () => MenuItemConstructorOptions[];

/** Commands that go to the main window, wherever the focus is. */
function runsInMain(id: string): boolean {
  return id.startsWith('go.') || id.startsWith('view.layout.') || id === 'view.refresh' || id === 'help.shortcuts' || MAIN_WINDOW_COMMANDS.has(id);
}

/** New items of the other apps, importing and settings: what the main window shows. */
const MAIN_WINDOW_COMMANDS = new Set(['file.newEvent', 'file.newContact', 'file.newTask', 'file.import', 'file.importCalendar', 'file.importContacts', 'file.addAccount', 'file.switchMode']);

/** The hidden line that takes Ctrl+F off a Mac. */
const FIND_KEY_ID = 'edit.forwardOrSearch';

/**
 * Lines that hand the page what's on the clipboard. Picked in the page's own bar, one runs only
 * on a click inside it (`runBarItem`). Every other line either hands the page nothing or only
 * what the user then picks in a dialog the OS draws (Open…, Import, Attach, Upload files).
 */
const HANDS_DATA_ROLES = new Set(['paste', 'pasteandmatchstyle']);
/** More lines than any menu has: the rest of a report is left out. */
const MAX_REPORTED_LINES = 100;

/** Commands whose page action opens a file picker, which needs a user gesture in the page. */
// Save as… asks main for its dialog (os-save-open.ts), which wants a gesture of main's own as well.
const GESTURE_COMMANDS = new Set(['compose.attach', 'file.import', 'file.uploadFiles', 'file.saveAs']);

/** The part of the app the window shows, as its page reports it. Mail when it says nothing. */
export type AppSection = 'mail' | 'calendar' | 'contacts' | 'files' | 'settings';

export function sectionOf(state: MenuState | undefined): AppSection {
  for (const section of ['calendar', 'contacts', 'files', 'settings'] as const) {
    if (state?.[`section.${section}`] === true) return section;
  }
  return 'mail';
}

/** What decides which menus and lines there are, so a change means a new menu. */
export function menuShapeOf(state: MenuState | undefined): string {
  return `${sectionOf(state)}|${state?.['compose.send'] !== undefined}|${state?.['shortcuts.singleKeys'] === false}|${starredNow(state)}`;
}

/** The message (or every one selected) is starred: Message > Star says "Remove star" (desktop-p3-14). */
function starredNow(state: MenuState | undefined): boolean {
  const entry = state?.['message.star'];
  return typeof entry === 'object' && entry.checked === true;
}

/** A line that stands for another command: a hidden second key, or the macOS app menu's Settings. */
function commandOf(id: string): string {
  if (id === 'app.settings') return 'file.settings';
  return id.endsWith('Alt') ? id.slice(0, -'Alt'.length) : id;
}

/** Enabled unless a state says otherwise, and available in a page with no state. */
const SHELL_COMMANDS = new Set(['file.settings', 'file.newWindow', 'file.print', 'file.savePdf', 'view.zoomIn', 'view.zoomOut', 'view.zoomReset', 'go.back', 'go.forward']);

const SHELL_STATE_COMMANDS = ['file.print', 'file.savePdf'];

/** Letters the keys of `File`, `Edit` … open with Alt. Strings mark them with &. */
function mnemonicOf(label: string): string | undefined {
  const at = label.indexOf('&');
  return at >= 0 ? label[at + 1]?.toLowerCase() : undefined;
}

function withoutMnemonic(label: string): string {
  return label.replace(/&(.)/g, '$1');
}

function greyWhileLocked(items: MenuItemConstructorOptions[]): void {
  for (const item of items) {
    if (Array.isArray(item.submenu)) {
      greyWhileLocked(item.submenu);
      // A submenu with nothing left to pick is greyed itself (File > Import), not opened onto
      // greyed lines (desktop-p3-16). Only the top-level menus come in here, so they stay openable.
      item.enabled = item.submenu.some((line) => line.type !== 'separator' && line.visible !== false && line.enabled !== false);
    } else if (item.type !== 'separator' && !enabledWhileLocked(item)) item.enabled = false;
  }
}

export class MenuController {
  private readonly stateByWindow = new WeakMap<BrowserWindow, MenuState>();
  private readonly extensions = new Map<MenuSection, Extension[]>();
  private windows: WindowManager | null = null;
  private timer: NodeJS.Timeout | null = null;
  /** The app lock is on: only what shows no mail stays enabled (`enabledWhileLocked`). */
  private locked = false;

  constructor(private readonly hooks: MenuHooks) {}

  /** What the start decided, once it has: nothing is offered before that. */
  allowSwitchingMode(switchMode: (() => void) | undefined, switchModeNow?: () => void): void {
    this.hooks.switchMode = switchMode;
    this.hooks.switchModeNow = switchMode ? switchModeNow : undefined;
    this.rebuild();
  }

  /** File > Open…, once the os feature can take the files. */
  allowOpening(open: (window: BrowserWindow) => void): void {
    this.hooks.open = open;
    this.scheduleRebuild();
  }

  /** The page asked and the answer was Change. False where switching isn't allowed. */
  changeConnection(): boolean {
    const now = this.hooks.switchModeNow;
    if (!now) return false;
    now();
    return true;
  }

  /**
   * File > Change connection…: the page asks in the app's own question window and calls
   * back (changeConnection). A page that doesn't say it can (an older webmail, an error
   * page) gets the OS's question here instead. Never a restart without asking.
   */
  private switchModeClicked(): void {
    if (this.stateOf('file.switchMode').enabled) this.dispatch('file.switchMode');
    else this.hooks.switchMode?.();
  }

  /** Once a mode has started: the first-run page has a menu without any windows behind it. */
  attach(windows: WindowManager): void {
    this.windows = windows;
    // A page's report is for that page: the next one starts over.
    windows.on('navigated', (window) => {
      this.stateByWindow.delete(window);
      this.barReporting.delete(window);
      this.barShown.delete(window);
      this.reportedLines.delete(window);
      this.applyState();
    });
    windows.on('changed', (list) => {
      // Windows came or went, or a title changed: the Window menu has other lines now.
      // Only the focus moving is a matter of ticks and greyed items.
      const signature = list.map((w) => `${w.id}:${w.title}:${w.menuName ?? ''}`).join('\n');
      if (signature !== this.windowSignature) {
        this.windowSignature = signature;
        this.scheduleRebuild();
      } else {
        this.applyState();
      }
    });
    this.rebuild();
  }

  /** The window lines the menu was last built with. */
  private windowSignature = '';

  extend(section: MenuSection, extension: Extension): void {
    this.extensions.set(section, [...(this.extensions.get(section) ?? []), extension]);
    this.scheduleRebuild();
  }

  private extras(section: MenuSection): MenuItemConstructorOptions[] {
    const items = (this.extensions.get(section) ?? []).flatMap((extension) => extension());
    return items.length ? [{ type: 'separator' }, ...items] : [];
  }

  private scheduleRebuild(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.rebuild();
    }, 50);
    this.timer.unref?.();
  }

  /** Greys and ticks, in place, with no new menu. */
  private applyState(): void {
    const menu = Menu.getApplicationMenu();
    if (!menu) return;
    const walk = (items: MenuItem[], nested: boolean) => {
      for (const item of items) {
        if (item.submenu) {
          walk(item.submenu.items, true);
          // Locked: a submenu with nothing left to pick is greyed itself (File > Import),
          // not opened onto greyed lines (desktop-p3-16). Top-level menus stay openable.
          if (this.locked && nested) item.enabled = item.submenu.items.some((line) => line.type !== 'separator' && line.visible && line.enabled);
        }
        if (this.locked && !item.submenu && item.type !== 'separator' && !enabledWhileLocked(item)) {
          item.enabled = false;
          continue;
        }
        const id = item.id;
        if (!id) continue;
        if (id === FIND_KEY_ID) {
          item.enabled = this.ctrlFTarget() !== null;
          continue;
        }
        if (id.startsWith('window.focus.')) {
          item.checked = this.windows?.focusedManaged()?.window.id === Number(id.slice('window.focus.'.length));
          continue;
        }
        const command = commandOf(id);
        if (!/^(file|edit|view|message|compose|go|help)\./.test(command) || !this.knownCommands.has(command)) continue;
        const state = this.stateOf(command);
        item.enabled = state.enabled;
        if (item.type === 'checkbox' && state.checked !== undefined) item.checked = state.checked;
        // Setting a radio item at all ticks it, whatever the value: Electron's group does that.
        if (item.type === 'radio' && state.checked) item.checked = true;
      }
    };
    walk(menu.items, false);
  }

  /**
   * Ctrl+F on Windows and Linux: Forward while a message is selected in Mail, as in Outlook
   * beside Ctrl+R, and the view's search everywhere else. Null when neither can run.
   */
  private ctrlFTarget(): 'message.forward' | 'edit.search' | null {
    if (this.stateOf('message.forward').enabled) return 'message.forward';
    if (this.stateOf('edit.search').enabled) return 'edit.search';
    return null;
  }

  /** Items whose state comes from the page or the policy. */
  private readonly knownCommands = new Set<string>(SHELL_STATE_COMMANDS);

  /** The app lock closed or opened: a new menu, greyed or not. */
  setLocked(locked: boolean): void {
    if (this.locked === locked) return;
    this.locked = locked;
    this.rebuild();
  }

  /** The language changed: a new menu. */
  refresh(): void {
    this.scheduleRebuild();
  }

  /** The window a command is for: the focused one, or the one last used. */
  private target(id: string): BrowserWindow | undefined {
    const windows = this.windows;
    if (!windows) return undefined;
    const focused = windows.focusedManaged();
    // A second main window's Go menu goes in that window.
    if (runsInMain(id)) return focused?.type === 'main' ? focused.window : windows.mainWindow();
    return focused?.window ?? windows.mainWindow();
  }

  /** Sends a command to the page that can run it. */
  dispatch(id: string): void {
    const window = this.target(id);
    if (!window || window.isDestroyed()) return;
    if (runsInMain(id)) this.windows?.focusWindow(window);
    if (!GESTURE_COMMANDS.has(id)) {
      window.webContents.send(CHANNEL.menuCommand, id);
      return;
    }
    // A file picker opens only on a user action, and a native menu's pick isn't one the page
    // sees. A line of the page's own bar runs only right after a click or key main saw in the
    // window (runBarItem), and that input noted its gesture already: nothing more is noted.
    if (!this.runningBarPick) noteUserGesture(window.webContents);
    void window.webContents.executeJavaScript('0', true).catch(() => {}).finally(() => {
      if (!window.isDestroyed()) window.webContents.send(CHANNEL.menuCommand, id);
    });
  }

  /** The focused window's part of the app, and whether a composer is in it. */
  private shape(): { section: AppSection; composing: boolean } {
    const window = this.target('message.reply');
    const state = window ? this.stateByWindow.get(window) : undefined;
    return { section: sectionOf(state), composing: state?.['compose.send'] !== undefined };
  }

  private stateOf(id: string): { enabled: boolean; checked?: boolean } {
    const window = this.target(id);
    const state = window ? this.stateByWindow.get(window) : undefined;
    if (SHELL_COMMANDS.has(id)) {
      const entry = state?.[id];
      return { enabled: typeof entry === 'boolean' ? entry : (entry?.enabled ?? true) };
    }
    const entry = state?.[id];
    if (entry === undefined) return { enabled: false };
    if (typeof entry === 'boolean') return { enabled: entry };
    return { enabled: entry.enabled ?? true, checked: entry.checked };
  }

  private singleKeysOff(): boolean {
    const window = this.target('message.reply');
    const state = window ? this.stateByWindow.get(window) : undefined;
    return state?.['shortcuts.singleKeys'] === false;
  }

  /** A shortcut the page handles itself: only ever shown, never registered. */
  private pageKey(accelerator: string, single = true): Pick<MenuItemConstructorOptions, 'accelerator' | 'registerAccelerator'> {
    if (process.platform === 'darwin') return {};
    if (single && this.singleKeysOff()) return {};
    return { accelerator, registerAccelerator: false };
  }

  private command(id: string, label: string, extra: MenuItemConstructorOptions = {}): MenuItemConstructorOptions {
    this.knownCommands.add(id);
    const state = this.stateOf(id);
    return {
      id,
      label,
      enabled: state.enabled,
      ...(extra.type === 'checkbox' || extra.type === 'radio' ? { checked: state.checked ?? false } : {}),
      click: () => this.dispatch(id),
      ...extra,
    };
  }

  private windowEntries(): MenuItemConstructorOptions[] {
    const windows = this.windows;
    if (!windows) return [];
    const text = strings();
    const list = windows.list();
    if (list.length === 0) return [];
    const names = windowMenuNames(list, text.windowNames, this.locked);
    return [
      { type: 'separator' },
      ...list.map((info, index): MenuItemConstructorOptions => ({
        id: `window.focus.${info.id}`,
        label: names[index].replace(/&/g, '&&'),
        type: 'checkbox',
        checked: info.focused,
        click: () => windows.focus(info.id),
      })),
    ];
  }

  buildTemplate(): MenuItemConstructorOptions[] {
    const text = strings();
    const { hooks, windows } = this;
    const mac = process.platform === 'darwin';
    const win = process.platform === 'win32';
    const { section, composing } = this.shape();
    const mail = section === 'mail';
    const files = section === 'files';
    // A bare window counts: a preview's Ctrl+P prints the preview, not what's behind it.
    const focused = () => BrowserWindow.getFocusedWindow() ?? windows?.focusedManaged()?.window;
    const onFocused = (run: (window: BrowserWindow) => void) => () => {
      const window = focused();
      if (window) run(window);
    };

    const fileMenu: MenuItemConstructorOptions = {
      id: 'file',
      label: text.menuFile,
      submenu: [
        this.command('file.newMessage', text.menuNewMessage, { accelerator: 'CmdOrCtrl+N' }),
        // Outlook's key for a new message, as well. Hidden, so only one shows.
        ...(mac ? [] : [this.command('file.newMessage', text.menuNewMessage, { id: 'file.newMessageAlt', accelerator: 'Ctrl+Shift+M', visible: false, acceleratorWorksWhenHidden: true })]),
        this.command('file.newEvent', text.menuNewEvent),
        this.command('file.newTask', text.menuNewTask),
        this.command('file.newContact', text.menuNewContact),
        // Files' own: a folder where you are, and files into it.
        ...(files ? [
          this.command('file.newFolder', text.menuNewFolder),
          this.command('file.uploadFiles', text.menuUploadFiles),
        ] : []),
        ...(this.extensions.get('new') ?? []).flatMap((extension) => extension()),
        { id: 'file.newWindow', label: text.menuNewWindow, accelerator: 'CmdOrCtrl+Shift+N', enabled: !!windows, click: hooks.newWindow },
        { type: 'separator' },
        // Thunderbird's File menu: a saved message (or an event or contact file) opens as
        // "Open with" opens it from Explorer, and the message on screen saves as an .eml.
        {
          id: 'file.open',
          label: text.menuOpen,
          accelerator: 'CmdOrCtrl+O',
          enabled: !!windows && !!hooks.open,
          click: () => {
            const window = focused() ?? windows?.mainWindow();
            if (window) hooks.open?.(window);
          },
        },
        // Ctrl+S is the composer's Save draft while one is open, so Save as has no key then.
        ...(mail ? [this.command('file.saveAs', text.menuSaveAs, composing ? {} : { accelerator: 'CmdOrCtrl+S' })] : []),
        { type: 'separator' },
        // Files has nothing to print: a list of names would be all.
        {
          id: 'file.print',
          label: text.menuPrint,
          accelerator: 'CmdOrCtrl+P',
          visible: !files,
          enabled: !files && !!windows && this.stateOf('file.print').enabled,
          click: onFocused(hooks.print),
        },
        {
          id: 'file.savePdf',
          label: text.menuSavePdf,
          accelerator: 'CmdOrCtrl+Shift+S',
          visible: !files,
          enabled: !files && !!windows && this.stateOf('file.savePdf').enabled,
          click: onFocused(hooks.saveAsPdf),
        },
        { type: 'separator' },
        // Each app's own import: mail, calendar and contacts.
        {
          id: 'file.importMenu',
          label: text.menuImportMenu,
          submenu: [
            this.command('file.import', text.menuImportMail),
            this.command('file.importCalendar', text.menuImportCalendar),
            this.command('file.importContacts', text.menuImportContacts),
          ],
        },
        // Outlook's File > Add account: the sign-in form for another account.
        this.command('file.addAccount', text.menuAddAccount),
        // Settings where Windows and Linux mail apps keep them, next to how the app connects.
        // A page of the main window, as the rail's gear opens it (the page's go.settings).
        ...(mac ? [] : [this.command('file.settings', text.menuSettings, { accelerator: 'Ctrl+,', click: () => this.dispatch('go.settings') })]),
        // Left out while a policy forces the connection.
        ...(hooks.switchMode ? [{ id: 'file.switchMode', label: text.menuSwitchMode, click: () => this.switchModeClicked() } as MenuItemConstructorOptions] : []),
        ...this.extras('file'),
        { type: 'separator' },
        { id: 'file.close', label: text.menuClose, accelerator: 'CmdOrCtrl+W', role: 'close' },
        // Windows calls it Exit.
        // Windows calls it Exit and leaves it to Alt+F4: Ctrl+Q marks as read there, as in Outlook.
        ...(mac ? [] : [{ id: 'file.quit', label: win ? text.menuExit : text.menuQuit, role: 'quit', ...(win ? {} : { accelerator: 'Ctrl+Q' }) } as MenuItemConstructorOptions]),
      ],
    };

    const searchLabels: Record<AppSection, string> = {
      mail: text.menuSearch,
      settings: text.menuSearchSettings,
      calendar: text.menuSearchEvents,
      contacts: text.menuSearchContacts,
      files: text.menuSearchFiles,
    };
    const editMenu: MenuItemConstructorOptions = {
      id: 'edit',
      label: text.menuEdit,
      submenu: [
        { role: 'undo', label: text.menuUndo },
        { role: 'redo', label: text.menuRedo },
        { type: 'separator' },
        { role: 'cut', label: text.menuCut },
        { role: 'copy', label: text.menuCopy },
        { role: 'paste', label: text.menuPaste },
        ...(mac ? [{ role: 'pasteAndMatchStyle' } as MenuItemConstructorOptions] : []),
        { role: 'selectAll', label: text.menuSelectAll },
        { type: 'separator' },
        // What the screen searches: Settings searches its own pages.
        this.command('edit.search', searchLabels[section], mac ? {} : { accelerator: 'Ctrl+E' }),
        // Ctrl+F: Forward or search, whichever the window can do (ctrlFTarget). Hidden: Forward shows the key.
        ...(mac ? [] : [{
          id: FIND_KEY_ID,
          label: text.menuForward,
          accelerator: 'Ctrl+F',
          visible: false,
          acceleratorWorksWhenHidden: true,
          enabled: this.ctrlFTarget() !== null,
          click: () => {
            const target = this.ctrlFTarget();
            if (target) this.dispatch(target);
          },
        } as MenuItemConstructorOptions]),
      ],
    };

    const refreshLabel = mail ? text.menuRefresh : text.menuRefreshView;
    const viewMenu: MenuItemConstructorOptions = {
      id: 'view',
      label: text.menuView,
      submenu: [
        // Mail checks for new mail; Calendar, Contacts and Files read what they show again.
        this.command('view.refresh', refreshLabel, { accelerator: mac ? 'F5' : 'F9' }),
        // The page takes F5 itself. Shown where it's the only one.
        ...(mac ? [] : [this.command('view.refresh', refreshLabel, { id: 'view.refreshAlt', accelerator: 'F5', visible: false, acceleratorWorksWhenHidden: true })]),
        { type: 'separator' },
        ...(section === 'calendar' ? [
          this.command('view.calendar.day', text.menuDay, { type: 'radio', ...this.pageKey('D') }),
          this.command('view.calendar.week', text.menuWeek, { type: 'radio', ...this.pageKey('W') }),
          this.command('view.calendar.month', text.menuMonth, { type: 'radio', ...this.pageKey('M') }),
          this.command('view.calendar.agenda', text.menuAgenda, { type: 'radio', ...this.pageKey('A') }),
        ] : []),
        {
          id: 'view.readingPane',
          visible: mail,
          label: text.menuReadingPane,
          submenu: [
            this.command('view.layout.split', text.menuPaneRight, { type: 'radio' }),
            this.command('view.layout.horizontal', text.menuPaneBelow, { type: 'radio' }),
            this.command('view.layout.focus', text.menuPaneOff, { type: 'radio' }),
          ],
        },
        { type: 'separator' },
        { id: 'view.zoomIn', label: text.menuZoomIn, accelerator: 'CmdOrCtrl+Plus', click: () => hooks.zoom(1) },
        // The = key without Shift. Hidden, as browsers do it, so only one shows.
        { id: 'view.zoomInAlt', label: text.menuZoomIn, accelerator: 'CmdOrCtrl+=', visible: false, acceleratorWorksWhenHidden: true, click: () => hooks.zoom(1) },
        { id: 'view.zoomOut', label: text.menuZoomOut, accelerator: 'CmdOrCtrl+-', click: () => hooks.zoom(-1) },
        { id: 'view.zoomReset', label: text.menuZoomReset, accelerator: 'CmdOrCtrl+0', click: () => hooks.zoom(0) },
        { type: 'separator' },
        { role: 'togglefullscreen', label: text.menuFullScreen },
        ...(mac || !windows ? [] : [{
          id: 'view.menuBar',
          label: text.menuShowMenuBar,
          type: 'checkbox',
          checked: windows.menuBarPinned(),
          click: (item: MenuItem) => this.setBarPinned(item.checked),
        } as MenuItemConstructorOptions]),
        ...this.extras('view'),
      ],
    };

    const messageMenu: MenuItemConstructorOptions = {
      id: 'message',
      label: text.menuMessage,
      submenu: [
        ...(composing ? [
          this.command('compose.send', text.menuSend, this.pageKey('CmdOrCtrl+Enter', false)),
          this.command('compose.saveDraft', text.menuSaveDraft, { accelerator: 'CmdOrCtrl+S' }),
          this.command('compose.attach', text.menuAttach),
          { type: 'separator' } as MenuItemConstructorOptions,
        ] : []),
        // Outlook's and Apple Mail's keys; the single ones still work beside them.
        this.command('message.reply', text.menuReply, { accelerator: 'CmdOrCtrl+R' }),
        this.command('message.replyAll', text.menuReplyAll, { accelerator: 'CmdOrCtrl+Shift+R' }),
        // Ctrl+F as in Outlook (the hidden FIND_KEY_ID runs it); Ctrl+Shift+F still works. A Mac keeps Apple Mail's.
        ...(mac ? [this.command('message.forward', text.menuForward, { accelerator: 'CmdOrCtrl+Shift+F' })] : [
          this.command('message.forward', text.menuForward, { accelerator: 'Ctrl+F', registerAccelerator: false }),
          this.command('message.forward', text.menuForward, { id: 'message.forwardAlt', accelerator: 'Ctrl+Shift+F', visible: false, acceleratorWorksWhenHidden: true }),
        ]),
        { type: 'separator' },
        this.command('message.markRead', text.menuMarkRead, win ? { accelerator: 'Ctrl+Q' } : this.pageKey('Shift+I')),
        this.command('message.markUnread', text.menuMarkUnread, mac ? {} : { accelerator: 'Ctrl+U' }),
        this.command('message.star', this.stateOf('message.star').checked ? text.menuUnstar : text.menuStar, this.pageKey('S')),
        { type: 'separator' },
        this.command('message.move', text.menuMove),
        this.command('message.archive', text.menuArchive, this.pageKey('E')),
        this.command('message.spam', text.menuSpam, this.pageKey('!')),
        this.command('message.delete', text.menuDelete, this.pageKey('Delete', false)),
        { type: 'separator' },
        this.command('message.openWindow', text.menuOpenInWindow),
      ],
    };

    const goMenu: MenuItemConstructorOptions = {
      id: 'go',
      label: text.menuGo,
      submenu: [
        // Mail's folders and messages only in Mail, as the Message menu; Calendar moves through time.
        ...(mail ? [
          this.command('go.inbox', text.menuGoInbox),
          this.command('go.sent', text.menuGoSent),
          this.command('go.drafts', text.menuGoDrafts),
          { type: 'separator' } as MenuItemConstructorOptions,
          this.command('go.nextMessage', text.menuGoNext, this.pageKey('J')),
          this.command('go.previousMessage', text.menuGoPrevious, this.pageKey('K')),
          this.command('go.nextUnread', text.menuGoNextUnread, this.pageKey('N')),
        ] : []),
        ...(section === 'calendar' ? [
          this.command('go.today', text.menuGoToday, this.pageKey('T')),
          this.command('go.nextPeriod', text.menuGoNextPeriod, this.pageKey('Right', false)),
          this.command('go.previousPeriod', text.menuGoPreviousPeriod, this.pageKey('Left', false)),
        ] : []),
        { type: 'separator' },
        this.command('go.mail', text.menuGoMail, mac ? {} : { accelerator: 'Ctrl+1' }),
        this.command('go.calendar', text.menuGoCalendar, mac ? {} : { accelerator: 'Ctrl+2' }),
        this.command('go.contacts', text.menuGoContacts, mac ? {} : { accelerator: 'Ctrl+3' }),
        this.command('go.files', text.menuGoFiles, mac ? {} : { accelerator: 'Ctrl+4' }),
        { type: 'separator' },
        {
          id: 'go.back',
          label: text.menuGoBack,
          accelerator: mac ? 'Cmd+[' : 'Alt+Left',
          click: () => {
            const window = focused();
            if (window) hooks.back(window, -1);
          },
        },
        {
          id: 'go.forward',
          label: text.menuGoForward,
          accelerator: mac ? 'Cmd+]' : 'Alt+Right',
          click: () => {
            const window = focused();
            if (window) hooks.back(window, 1);
          },
        },
      ],
    };

    const windowMenu: MenuItemConstructorOptions = {
      id: 'window',
      label: text.menuWindow,
      submenu: [
        // Windows and Linux apps don't minimise on Ctrl+M (Outlook checks for mail there):
        // the role brings that key along, so only a Mac gets the role.
        mac ? { role: 'minimize', label: text.menuMinimize } : { id: 'window.minimize', label: text.menuMinimize, click: onFocused((window) => window.minimize()) },
        ...(mac ? [{ role: 'zoom' } as MenuItemConstructorOptions] : []),
        {
          id: 'window.cycle',
          label: text.menuCycle,
          // macOS has its own for this in the system; Ctrl+` is for the rest.
          accelerator: mac ? 'Cmd+`' : 'Ctrl+`',
          click: () => windows?.cycle(1),
        },
        ...(mac ? [{ type: 'separator' } as MenuItemConstructorOptions, { role: 'front' } as MenuItemConstructorOptions] : []),
        ...this.windowEntries(),
      ],
    };

    const helpMenu: MenuItemConstructorOptions = {
      id: 'help',
      label: text.menuHelp,
      ...(mac ? { role: 'help' } : {}),
      submenu: [
        this.command('help.shortcuts', text.menuShortcuts, this.pageKey('?')),
        { id: 'help.docs', label: text.menuDocs, click: () => void shell.openExternal('https://bulwarkmail.org/docs').catch(() => {}) },
        ...this.extras('help'),
        ...(mac ? [] : [{ type: 'separator' } as MenuItemConstructorOptions, { role: 'about', label: text.menuAbout } as MenuItemConstructorOptions]),
      ],
    };

    const appMenu: MenuItemConstructorOptions = {
      id: 'app',
      label: app.name,
      submenu: [
        { role: 'about', label: text.menuAbout },
        { type: 'separator' },
        this.command('file.settings', text.menuSettings, { id: 'app.settings', accelerator: 'Cmd+,', click: () => this.dispatch('go.settings') }),
        ...this.extras('app'),
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    };

    // Only Mail, or a composer, has a Message menu. Left out rather than hidden: a native
    // bar may still draw a hidden top-level menu, and it would keep its Alt letter.
    const bar = [fileMenu, editMenu, viewMenu, ...(mail || composing ? [messageMenu] : []), goMenu, windowMenu, helpMenu];
    // A hidden line (Reading pane outside Mail) leaves its lines around it: one is enough.
    for (const menu of [appMenu, ...bar]) menu.submenu = tidySeparators(menu.submenu as MenuItemConstructorOptions[]);
    if (this.locked) for (const menu of [appMenu, ...bar]) greyWhileLocked(menu.submenu as MenuItemConstructorOptions[]);
    assignMnemonics(bar.map((item) => item.label as string)).forEach((label, index) => {
      bar[index].label = label;
    });
    return [
      ...(mac ? [appMenu] : []),
      ...bar,
      ...(hooks.devTools ? [{ label: 'Develop', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }] } as MenuItemConstructorOptions] : []),
    ];
  }

  rebuild(): void {
    const template = this.buildTemplate();
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    this.refreshNames(template);
  }

  // ─── The state a page reports ───────────────────────────────

  setCommandState(window: BrowserWindow, state: MenuState): void {
    const before = menuShapeOf(this.stateByWindow.get(this.target('message.reply') ?? window));
    this.stateByWindow.set(window, state);
    // Accelerators, and which menus and lines there are, only change in a new menu.
    if (menuShapeOf(this.stateByWindow.get(this.target('message.reply') ?? window)) !== before) this.scheduleRebuild();
    else this.applyState();
  }

  /** A bare preview reports nothing, so what the organisation allows comes from the main window. */
  commandState(window: BrowserWindow): MenuState | undefined {
    return this.stateByWindow.get(window) ?? (this.windows?.managedFor(window) ? undefined : (() => {
      const main = this.windows?.mainWindow();
      return main ? this.stateByWindow.get(main) : undefined;
    })());
  }

  // ─── The strip for a window with no native bar ──────────────

  private barItems: { entry: MenuBarEntry; item: MenuItem }[] = [];

  private refreshNames(template: MenuItemConstructorOptions[]): void {
    const menu = Menu.getApplicationMenu();
    this.barItems = (menu?.items ?? []).flatMap((item, index) => {
      const source = template[index];
      const label = typeof source?.label === 'string' ? source.label : item.label;
      if (!item.submenu || !source?.id || source.visible === false) return [];
      return [{ entry: { id: source.id, label: withoutMnemonic(label), mnemonic: mnemonicOf(label) }, item }];
    });
  }

  barEntries(): MenuBarEntry[] {
    return this.barItems.map(({ entry }) => entry);
  }

  popupBarMenu(window: BrowserWindow, id: string, x: number, y: number): void {
    const found = this.barItems.find(({ entry }) => entry.id === id);
    if (!found?.item.submenu) return;
    const scale = window.webContents.getZoomFactor();
    found.item.submenu.popup({
      window,
      x: Math.round(x * scale),
      y: Math.round(y * scale),
      // A bar that hides behind Alt goes when its menu does.
      callback: () => {
        if (!window.isDestroyed()) this.showBar(window, { visible: false });
      },
    });
  }

  /** Windows whose bar has the keys: Alt was pressed there. */
  private readonly barShown = new WeakSet<BrowserWindow>();
  /** Windows whose page draws the whole bar and says when it goes (`barReport`). */
  private readonly barReporting = new WeakSet<BrowserWindow>();

  isBarShown(window: BrowserWindow): boolean {
    return this.barShown.has(window);
  }

  /** The page closes its own menus with Escape, and only then the bar. An older page can't. */
  barHandlesEscape(window: BrowserWindow): boolean {
    return this.barReporting.has(window);
  }

  showBar(window: BrowserWindow, event: MenuBarEvent): void {
    if (event.visible) this.barShown.add(window);
    else this.barShown.delete(window);
    window.webContents.send(CHANNEL.menuBarEvent, { ...event, pinned: this.barPinned() });
  }

  barPinned(): boolean {
    return this.windows?.menuBarPinned() ?? false;
  }

  /** "Always show the menu bar", from the View menu or the settings page: every window, at once. */
  setBarPinned(pinned: boolean): void {
    const windows = this.windows;
    if (!windows || process.platform === 'darwin') return;
    windows.setMenuBarPinned(pinned);
    for (const { window } of windows.all()) {
      if (!window.isDestroyed()) window.webContents.send(CHANNEL.menuBarEvent, { visible: this.barShown.has(window), pinned } satisfies MenuBarEvent);
    }
    this.scheduleRebuild();
  }

  /** What the page's bar holds: every menu, with what's enabled and ticked in that window now. */
  barMenus(window: BrowserWindow): MenuBarMenu[] {
    // The state of the window asking, not the last one that had the focus.
    if (BrowserWindow.getFocusedWindow() === window) this.applyState();
    return this.barItems.map(({ entry, item }) => ({
      ...entry,
      items: barItemsOf((item.submenu?.items ?? []) as unknown as BarSourceItem[], String(this.topIndex(item))),
    }));
  }

  private topIndex(item: MenuItem): number {
    return Menu.getApplicationMenu()?.items.indexOf(item) ?? -1;
  }

  /** Set while a line of the page's bar runs, for `dispatch`. */
  private runningBarPick = false;

  /**
   * A line of the page's bar was picked: the same item the native menu has, clicked in that
   * window. Which line is the page's word, so main holds it to the click or key that reached
   * the window a moment ago, as main saw it, and notes no gesture of its own. One click or key
   * runs one line. A letter runs only the line it's the underlined letter of. A line that hands
   * the page what's on the clipboard runs only on a click inside that line, where the page said
   * the line was before the click (`barReport`), never from the keyboard.
   */
  runBarItem(window: BrowserWindow, key: unknown, label: unknown): void {
    const menu = Menu.getApplicationMenu();
    if (!menu || typeof key !== 'string' || typeof label !== 'string' || window.isDestroyed()) return;
    const item = findBarItem(menu.items as unknown as (BarSourceItem & MenuItem)[], key, label);
    if (!item || !item.enabled) return;
    const pick = takePick(window.webContents);
    if (!pick) return;
    if (HANDS_DATA_ROLES.has(String(item.role ?? '').toLowerCase())) {
      const line = this.reportedLines.get(window)?.get(key);
      if (!line || line.label !== label || !pickHitsLine(pick, line)) return;
    } else if (pick.kind === 'letter' && this.barLetterOf(key) !== pick.letter) {
      return;
    }
    this.runningBarPick = true;
    try {
      item.click(undefined, window, window.webContents);
    } finally {
      this.runningBarPick = false;
    }
  }

  /** The underlined letter of a line of the page's bar, lower case, as `barMenus` gives it. */
  private barLetterOf(key: string): string | null {
    const find = (lines: MenuBarItem[]): MenuBarItem | null => {
      for (const line of lines) {
        if (line.key === key) return line;
        const inner = line.items ? find(line.items) : null;
        if (inner) return inner;
      }
      return null;
    };
    for (const { item } of this.barItems) {
      const line = find(barItemsOf((item.submenu?.items ?? []) as unknown as BarSourceItem[], String(this.topIndex(item))));
      if (line) return line.mnemonic === undefined ? null : (line.label[line.mnemonic] ?? '').toLowerCase() || null;
    }
    return null;
  }

  /** Where the page said the lines of its open menu are, per window, by key: see `barReport`. */
  private readonly reportedLines = new WeakMap<BrowserWindow, Map<string, ReportedLine & { label: string }>>();

  /**
   * The page's bar took this much room, or none, and has the keys or not. With a menu open, the
   * page may say where its lines are (`lines`: key, label and rectangle in CSS pixels): what a
   * click on a line that hands over the clipboard is held to. A rectangle that isn't a line's
   * (too large, outside the window, in the bar's own row) is left out, and one that's the same
   * as before keeps the time it was first reported.
   */
  barReport(window: BrowserWindow, report: unknown): void {
    const { height, active, lines } = (report ?? {}) as Partial<MenuBarReport> & { lines?: unknown };
    if (typeof height !== 'number' || typeof active !== 'boolean') return;
    // Its first word: it's listening now, and may have to show the bar from the start.
    const first = !this.barReporting.has(window);
    this.barReporting.add(window);
    if (first && this.barPinned()) window.webContents.send(CHANNEL.menuBarEvent, { visible: active, pinned: true } satisfies MenuBarEvent);
    if (active) this.barShown.add(window);
    else this.barShown.delete(window);
    this.windows?.setMenuBarHeight(window, height);
    if (!active || !Array.isArray(lines)) {
      this.reportedLines.delete(window);
      return;
    }
    const scale = window.webContents.getZoomFactor();
    const { width, height: viewHeight } = window.getContentBounds();
    const before = this.reportedLines.get(window);
    const kept = new Map<string, ReportedLine & { label: string }>();
    const now = Date.now();
    for (const raw of lines.slice(0, MAX_REPORTED_LINES)) {
      const line = (raw ?? {}) as { key?: unknown; label?: unknown; x?: unknown; y?: unknown; width?: unknown; height?: unknown };
      if (typeof line.key !== 'string' || typeof line.label !== 'string') continue;
      const rect = { x: Number(line.x) * scale, y: Number(line.y) * scale, width: Number(line.width) * scale, height: Number(line.height) * scale };
      if (!lineRectFits(rect, { width, height: viewHeight, barHeight: height * scale, scale })) continue;
      const old = before?.get(line.key);
      const same = old && old.label === line.label && old.x === rect.x && old.y === rect.y && old.width === rect.width && old.height === rect.height;
      kept.set(line.key, { ...rect, label: line.label, at: same ? old.at : now });
    }
    this.reportedLines.set(window, kept);
  }
}
