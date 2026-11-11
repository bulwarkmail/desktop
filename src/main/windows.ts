/**
 * The window manager. All app windows go through here: main, message, composer
 * and settings. One window per message, per-type remembered bounds, cascading,
 * monitor-safe placement, and no white flash (hidden until first paint, with the
 * theme's background).
 *
 * Closing: the last main window hides while a pop-out is open, because a pop-out
 * borrows its session from it. When the last window on screen goes, a hidden main
 * goes too and the app quits, unless `setCloseToBackground` says to stay.
 *
 * Pop-outs open from a warm spare: a hidden window that has the pop-out code
 * loaded, so one comes up at once. See `activateSpare`.
 *
 * Step 6 features listen to the events (`created`, `changed`) and use `list`,
 * `focus` and `broadcast`. They don't create windows themselves.
 */

import { wipeUnderWay } from './features/local-wipe';
import { EventEmitter } from 'node:events';
import { app, BrowserWindow, screen, type BrowserWindowConstructorOptions, type Session, type WebContents, type WebPreferences } from 'electron';
import { CHANNEL, PRELOAD_ARG, type FlushAnswer, type Mode, type WindowInfo, type WindowType } from '../shared/bridge';
import type { SessionWindow, StateFile } from './state';
import { keystoreOffByPolicy } from './keystore-policy';
import { native } from './native';
import { showMessageBox } from './message-box';
import { strings, unsentDetail } from './strings';
import type { ChromeColours, ThemeController } from './theme';
import { fitInto, isOnSomeDisplay, placeWindow, type Rect } from './window-placement';
import { MainStart, nextInCycle, sumAnswers } from './window-logic';

/** The app's toolbar row (h-14), so the window's buttons line up with what's next to them. */
export const TITLE_BAR_HEIGHT = 56;

/** Pages whose renderer the app lock is ending on purpose: that isn't a crash to count or recover from. */
export const replacingRenderer = new WeakSet<WebContents>();
/** Whatever's under the buttons shows through: the app draws to the top of the window. */
const OVERLAY_COLOUR = '#00000000';

/** Tiling window managers draw no frame and move windows themselves: a native frame is what they expect. */
function desktopForcesNativeFrame(): boolean {
  if (process.platform !== 'linux') return false;
  const desktop = `${process.env.XDG_CURRENT_DESKTOP ?? ''}:${process.env.XDG_SESSION_DESKTOP ?? ''}`.toLowerCase();
  return /\b(i3|sway|bspwm|awesome|dwm|hyprland|qtile|xmonad|river|niri)\b/.test(desktop);
}

const DEFAULT_SIZE: Record<WindowType, { width: number; height: number }> = {
  main: { width: 1280, height: 860 },
  message: { width: 960, height: 820 },
  composer: { width: 760, height: 780 },
  settings: { width: 1040, height: 760 },
};

const QUICK_COMPOSER_SIZE = { width: 680, height: 560 };

const MIN_SIZE: Record<WindowType, { minWidth: number; minHeight: number }> = {
  main: { minWidth: 640, minHeight: 480 },
  message: { minWidth: 420, minHeight: 360 },
  composer: { minWidth: 480, minHeight: 420 },
  settings: { minWidth: 560, minHeight: 480 },
};

/** Past this, a slow page shows anyway rather than leave the user with nothing. */
const SHOW_FALLBACK_MS = 6000;
/** How long a closing window waits for its page to save. The page's own limit is shorter. */
const FLUSH_TIMEOUT_MS = 4000;
/** After the main window paints, for someone who used pop-outs lately: nothing at start-up competes with it. */
const SPARE_FIRST_DELAY_MS = 8000;
const SPARE_NEXT_DELAY_MS = 1500;
/** A spare costs a renderer: only for someone who used a pop-out in this long. */
const SPARE_RECENT_USE_MS = 7 * 24 * 3600_000;
/** And it goes when it sat unused this long. The next pop-out loads, and brings it back. */
const SPARE_IDLE_LIMIT_MS = 30 * 60_000;
/** A page that doesn't know about spares (an older instance) never says it's ready. */
const SPARE_READY_LIMIT_MS = 30_000;
/** A spare that didn't answer shows the pop-out by loading it. */
const SPARE_TAKEN_LIMIT_MS = 1500;
/** Windows from last time open only this long after the start: a sign-in later is a new day. */
const RESTORE_LIMIT_MS = 60_000;
/** One window at a time, so a dozen don't fight the main window for the server. */
const RESTORE_STAGGER_MS = 250;
/** Still running this long after restoring: those windows didn't take the app down. */
const RESTORE_STABLE_MS = 30_000;
/** Two starts in a row that didn't get that far: the third goes without them. */
const RESTORE_MAX_ATTEMPTS = 2;
/** A page that keeps dying isn't reloaded forever. */
const CRASH_WINDOW_MS = 60_000;
const MAX_CRASH_RELOADS = 2;

/** The window type a same-origin URL belongs in. Locale prefix optional. */
export function windowTypeOf(pathname: string): WindowType {
  const path = pathname.replace(/^\/[a-zA-Z]{2}(?:-[a-zA-Z]{2,4})?(?=\/)/, '');
  if (/^\/popout\/message(\/|$)/.test(path)) return 'message';
  if (/^\/popout\/compose(\/|$)/.test(path)) return 'composer';
  if (/^\/settings(\/|$)/.test(path)) return 'settings';
  return 'main';
}

export interface OpenOptions {
  type: WindowType;
  url: string;
  /** Identity: opening the same key again focuses that window. */
  key?: string;
  size?: { width: number; height: number };
  /** Its own place, for a window coming back from last time. */
  place?: Rect;
  /** Load the page rather than take the spare. */
  noSpare?: boolean;
  /** Come up behind the window in use: one coming back from last time. */
  inactive?: boolean;
  maximized?: boolean;
  /** Remembers its size apart from others of its type, and opens on the monitor the pointer is on. */
  boundsKey?: 'quickComposer';
}

export interface ManagedWindow {
  window: BrowserWindow;
  type: WindowType;
  key: string | null;
  url: string;
  boundsKey?: 'quickComposer';
  /** What the OS made of the place it was given. Until it changes, nothing is stored. */
  initialBounds?: Electron.Rectangle;
  /** The page has something to save before it closes (lib/desktop/types.ts `lifecycle`). */
  flushable?: boolean;
  /** Saved: the next close goes straight through. */
  flushed?: boolean;
  /** The Window menu's name for it, from its page: the view and account, a subject. */
  menuName?: string;
  /** Asked and not answered yet. */
  flushWaits?: Set<(answers: FlushAnswer[]) => void>;
  /**
   * On its way out. Showing a window now takes the whole app down with it (exit code
   * 0xffff7003), which happens when its page finishes loading just as it's closed.
   */
  closing?: boolean;
  /** The user said Leave to the page's unsaved-changes question: the next unload goes through. */
  leaveConfirmed?: boolean;
  /** The unsaved-changes question is on screen: another unload meanwhile only changes what Leave does. */
  askingToLeave?: boolean;
  /** The history entry the unload was a step to, if it was one: where a Leave goes. */
  leaveToIndex?: number;
  /** The history entry the page is on, as last committed. */
  historyIndex?: number;
  /** What this window's open drafts come back as next time. */
  restoreUrls?: string[];
  /** When its page died lately. */
  crashes?: number[];
}

export interface FlushSummary {
  /** A window had something to save. */
  asked: boolean;
  /** Drafts that didn't get saved, counting windows that ran out of time. */
  failed: number;
  /** Mail waiting to go out. */
  unsent: number;
}

export interface WindowManagerOptions {
  state: StateFile;
  theme: ThemeController;
  session: Session;
  origin: string;
  mode: Mode;
  preloadPath: string;
  /** Asked at each new window: the DeveloperToolsAvailability policy can change while the app runs. */
  devTools: () => boolean;
  /** Keep a warm spare. Off in tests that count windows. */
  spare?: boolean;
  /** How long an unused spare stays. For a test: the real wait is half an hour. */
  spareIdleMs?: number;
  /** Navigation and window-open guards, applied to every window including pop-ups. */
  attachGuards: (window: BrowserWindow) => void;
}

interface Spare {
  window: BrowserWindow;
  ready: boolean;
  limit: NodeJS.Timeout;
  idle?: NodeJS.Timeout;
}

export class WindowManager extends EventEmitter<{
  created: [ManagedWindow];
  closed: [ManagedWindow];
  changed: [WindowInfo[]];
  /** The user chose to stay on a page, so whatever was closing it is off. */
  stayed: [];
  /** The main window closed to the tray. */
  hiddenToBackground: [ManagedWindow];
  /** A main window is signed in, with a session to lend. */
  sessionReady: [];
  /** Nobody is signed in any more: a pop-out would find no session. */
  sessionEnded: [];
  /** A window went to another document: what its old page said no longer holds. */
  navigated: [BrowserWindow];
  /** Windows is ending the session: a restart, a shutdown or a sign-out. Once. */
  sessionEnding: [];
}> {
  private readonly windows = new Map<number, ManagedWindow>();
  private lastFocused: number | null = null;
  private nextFlushId = 1;
  private readonly flushWaits = new Map<number, (answers: FlushAnswer[]) => void>();
  private quitting = false;
  private closeToBackground: () => boolean = () => false;
  private spare: Spare | null = null;
  private spareTimer: NodeJS.Timeout | null = null;
  /** No more tries this run: the page has no spare route. */
  private spareUnsupported = false;
  private savedSession: SessionWindow[];
  private restoring = false;
  private restoreDeferred = false;
  private readonly startedAt = Date.now();
  private readonly mainStart = new MainStart();

  constructor(private readonly options: WindowManagerOptions) {
    super();
    options.theme.onChange((colours) => this.applyChrome(colours));
    options.theme.onSystemChange((system) => this.broadcast(CHANNEL.themeSystem, system));
    this.on('changed', (windows) => {
      this.broadcast(CHANNEL.windowsChanged, windows);
      this.storeSession();
    });
    const { state } = options;
    this.savedSession = state.data.restoreWindows === false ? [] : (state.data.session ?? []);
    if (state.data.restoreWindows === false && state.data.session) {
      delete state.data.session;
      state.touch();
    }
  }

  /** What every window with the bridge runs on. Also used for window.open pop-ups. */
  webPreferences(): WebPreferences {
    const { session, preloadPath, origin, mode, devTools } = this.options;
    return {
      session,
      preload: preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: true,
      devTools: devTools(),
      additionalArguments: [
        `${PRELOAD_ARG.allowedOrigin}${origin}`,
        `${PRELOAD_ARG.mode}${mode}`,
        `${PRELOAD_ARG.keystore}${native().keystore.available && !keystoreOffByPolicy() ? '1' : '0'}`,
      ],
    };
  }

  /**
   * Does the page draw its own title bar row? Only then can the native frame go:
   * without the row nothing can drag the window, and the controls would cover
   * the page. Unknown means yes; `checkOverlay` corrects it and remembers.
   */
  wantsOverlay(): boolean {
    if (desktopForcesNativeFrame()) return false;
    return this.options.state.data.overlayByOrigin[this.options.origin] !== false;
  }

  private chromeOptions(colours: ChromeColours): BrowserWindowConstructorOptions {
    // A native bar hides behind Alt, unless the user wants it always.
    if (!this.wantsOverlay()) return { autoHideMenuBar: !this.menuBarPinned() };
    if (process.platform === 'darwin') {
      // At the top of the rail, centred on the toolbar row.
      return { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 21 }, titleBarOverlay: { height: TITLE_BAR_HEIGHT } };
    }
    return {
      autoHideMenuBar: true,
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: OVERLAY_COLOUR, symbolColor: colours.symbol, height: this.overlayHeight() },
    };
  }

  /** The menu bar rows pages draw, in CSS pixels, per window: the controls sit in that row while it's there. */
  private readonly barHeights = new WeakMap<BrowserWindow, number>();

  /**
   * The row grows with the page's zoom, and the buttons with it. While the page shows
   * its menu bar, the controls are as tall as that, as in a native window with a menu
   * bar, and everything else moves down under both. A new window starts the height an
   * always-shown bar has, so its controls don't jump once it loads.
   */
  private overlayHeight(window?: BrowserWindow): number {
    const stored = this.options.state.data.menuBarHeight;
    const pinnedHeight = this.menuBarPinned() && typeof stored === 'number' && stored > 0 && stored <= TITLE_BAR_HEIGHT ? stored : undefined;
    // Until a page says, what an always-shown bar takes.
    const bar = window && this.barHeights.has(window) ? this.barHeights.get(window) : pinnedHeight;
    return Math.round((bar || TITLE_BAR_HEIGHT) * 1.2 ** (this.options.state.data.zoomLevel ?? 0));
  }

  menuBarPinned(): boolean {
    return this.options.state.data.menuBarPinned === true && process.platform !== 'darwin';
  }

  /** "Always show the menu bar": a native bar stops hiding, and the pages draw theirs (menu.ts). */
  setMenuBarPinned(pinned: boolean): void {
    const { state } = this.options;
    if ((state.data.menuBarPinned === true) === pinned) return;
    state.data.menuBarPinned = pinned;
    state.touch();
    if (this.wantsOverlay()) return;
    for (const { window } of this.windows.values()) {
      if (window.isDestroyed()) continue;
      window.setAutoHideMenuBar(!pinned);
      window.setMenuBarVisibility(pinned);
    }
  }

  /** A page drew its menu bar this tall, or took it away (0). */
  setMenuBarHeight(window: BrowserWindow, height: number): void {
    if (process.platform === 'darwin' || !this.wantsOverlay() || window.isDestroyed()) return;
    const next = Number.isFinite(height) && height > 0 ? Math.min(Math.round(height), TITLE_BAR_HEIGHT) : 0;
    if (this.barHeights.get(window) === next) return;
    this.barHeights.set(window, next);
    if (next && this.menuBarPinned() && this.options.state.data.menuBarHeight !== next) {
      this.options.state.data.menuBarHeight = next;
      this.options.state.touch();
    }
    try {
      window.setTitleBarOverlay({ color: OVERLAY_COLOUR, symbolColor: this.options.theme.colours().symbol, height: this.overlayHeight(window) });
    } catch {
      // A window that was made with a native frame has no overlay.
    }
  }

  /** The controls' height now, in window pixels: for the checks. */
  overlayHeightOf(window: BrowserWindow): number {
    return this.overlayHeight(window);
  }

  /** Zoom changed. */
  refreshChrome(): void {
    this.applyChrome(this.options.theme.colours());
  }

  /** The options of a new window apart from its place: for us, and for window.open. */
  windowOptions(type: WindowType): BrowserWindowConstructorOptions {
    const colours = this.options.theme.colours();
    return {
      show: false,
      backgroundColor: colours.background,
      title: 'Bulwark',
      ...MIN_SIZE[type],
      ...this.chromeOptions(colours),
      webPreferences: this.webPreferences(),
    };
  }

  /** Remembered, cascaded, on the current monitor. */
  placeFor(type: WindowType, size?: { width: number; height: number }, boundsKey?: 'quickComposer'): Rect {
    if (boundsKey === 'quickComposer') {
      // It opens from any app, so where the user is, not where this app last was.
      const current = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      return placeWindow({ size: size ?? QUICK_COMPOSER_SIZE, stored: this.options.state.data.windowBounds.quickComposer, displays: [current], current });
    }
    // Not a main window hidden behind its pop-outs. One still painting does count: a second window opened right after it must not land on top.
    const others = [...this.windows.values()].filter((w) => !w.window.isDestroyed() && (w.type !== 'main' || w.window.isVisible()));
    const sameType = others.filter((w) => w.type === type).at(-1)?.window.getNormalBounds();
    const focused = this.focusedManaged()?.window;
    const anchor = (focused && others.some((w) => w.window === focused) ? focused.getNormalBounds() : undefined) ?? others.at(-1)?.window.getNormalBounds();
    const current = anchor ? screen.getDisplayMatching(anchor) : screen.getPrimaryDisplay();
    return placeWindow({
      size: size ?? DEFAULT_SIZE[type],
      stored: this.options.state.data.windowBounds[type],
      sameType,
      anchor,
      displays: screen.getAllDisplays(),
      current,
    });
  }

  open(options: OpenOptions): BrowserWindow {
    const key = options.key ?? (options.type === 'main' ? 'main' : null);
    if (key !== null) {
      const existing = this.findByKey(key);
      if (existing) {
        this.focusWindow(existing.window);
        return existing.window;
      }
    }
    if (options.type === 'message' || options.type === 'composer') this.notePopoutUse();
    if (!options.noSpare) {
      const warm = this.activateSpare(options, key);
      if (warm) return warm;
    }
    const place = options.place ?? this.placeFor(options.type, options.size, options.boundsKey);
    const window = new BrowserWindow({ ...this.windowOptions(options.type), ...place });
    // The constructor is further off than setBounds on a scaled display.
    window.setBounds(place);
    const managed = this.adopt(window, options.type, key, options.url, false, options.inactive);
    managed.boundsKey = options.boundsKey;
    managed.initialBounds = window.getNormalBounds();
    if (options.maximized || (options.type === 'main' && this.options.state.data.windowBounds.main?.maximized)) window.maximize();
    void window.loadURL(options.url).catch(() => {
      // A failed load shows Chromium's error page; the guards and ready-to-show still apply.
    });
    return window;
  }

  /** Takes in a window made by window.open as well as our own. */
  adopt(window: BrowserWindow, type: WindowType, key: string | null, url: string, warm = false, inactive = false): ManagedWindow {
    const managed: ManagedWindow = { window, type, key, url };
    this.windows.set(window.id, managed);
    if (!warm) {
      this.options.attachGuards(window);
      this.showWhenPainted(managed, inactive);
    }

    const { webContents } = window;
    if (!warm) webContents.on('did-change-theme-color', (_event, colour) => this.options.theme.setFromPageColour(colour));
    // After the event: the window takes the new title once its listeners have run.
    webContents.on('page-title-updated', () => setTimeout(() => this.emitChanged(), 0));
    window.on('focus', () => {
      this.lastFocused = window.id;
      this.emitChanged();
    });
    window.on('hide', () => {
      this.emitChanged();
      // Everything is in the tray: nobody is about to open a pop-out.
      if (this.noneVisible()) this.destroySpare();
    });
    window.on('show', () => this.emitChanged());
    for (const event of ['resize', 'move', 'maximize', 'unmaximize'] as const) {
      window.on(event as 'resize', () => {
        this.rememberBounds(managed);
        this.storeSession();
      });
    }
    window.on('close', (event) => {
      this.rememberBounds(managed);
      if (this.shouldHide(managed)) {
        event.preventDefault();
        window.hide();
        // Hidden only because pop-outs borrow its session: the app isn't staying in the tray.
        if (this.closeToBackground()) this.emit('hiddenToBackground', managed);
        return;
      }
      // Quitting has saved. A page that said it had something since must not stop the
      // quit: preventing a close while quitting calls the whole quit off.
      if (!managed.flushable || managed.flushed || this.quitting) {
        managed.closing = true;
        return;
      }
      event.preventDefault();
      void this.flushWindow(managed).then(async (answers) => {
        if (window.isDestroyed()) return;
        const { failed, unsent } = sumAnswers(answers);
        if (!(await this.confirmLeaving(window, failed, this.isLastOnScreen(managed) ? unsent : 0))) return;
        if (window.isDestroyed()) return;
        managed.flushed = true;
        window.close();
      });
    });
    // The page's own window.close() goes straight through, with no 'close' on the window.
    webContents.once('close' as never, () => {
      managed.closing = true;
    });
    // The page that said it has something to save is gone, and the next says so itself. Nothing
    // can answer now, and nothing may wait for it or ask about it: a question with no page
    // behind it holds up a close for good.
    // A crashed page gets here too: it's reloaded.
    webContents.on('did-navigate', () => this.noPageLeft(managed));
    // The OS is ending the session: there's no time for questions, only for saving.
    window.on('session-end', () => this.saveForSessionEnd());
    webContents.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      // The next page names the window itself.
      managed.menuName = undefined;
      // A Leave is for the unload it was asked about, which is past now (or never came).
      managed.leaveConfirmed = false;
      this.emit('navigated', window);
    });
    const committed = () => {
      managed.historyIndex = webContents.navigationHistory.getActiveIndex();
    };
    webContents.on('did-navigate', committed);
    webContents.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
      if (isMainFrame) committed();
    });
    if (type !== 'main') webContents.on('render-process-gone', (_event, details) => this.onPageGone(managed, details.reason));
    // Unanswered, this cancels the close silently, and a quit with it.
    // The question is a window of the app's own, which can't answer Chromium while it
    // waits: the unload stops here, and a Leave starts it again. A close or a quit closes
    // or quits again; a step in the history goes to the entry it was for, which only main
    // knows; anything else is the page's to repeat (the preload knows where it was going,
    // and reloads when nothing was).
    webContents.on('will-prevent-unload', (event) => {
      if (wipeUnderWay() || managed.leaveConfirmed) {
        managed.leaveConfirmed = false;
        event.preventDefault();
        return;
      }
      // While a step is waiting, the history's active entry is the one it goes to.
      const pending = webContents.navigationHistory.getActiveIndex();
      managed.leaveToIndex = managed.historyIndex !== undefined && pending !== managed.historyIndex ? pending : undefined;
      // One question at a time: a close or a quit meanwhile is what its Leave does then.
      if (managed.askingToLeave) return;
      managed.askingToLeave = true;
      const text = strings();
      if (window.isMinimized()) window.restore();
      if (!window.isVisible()) window.show();
      void showMessageBox(window, {
        type: 'question',
        title: 'Bulwark',
        message: text.leaveTitle,
        detail: text.leaveDetail,
        buttons: [text.leave, text.stay],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      }).then(({ response }) => {
        managed.askingToLeave = false;
        if (window.isDestroyed()) return;
        if (response === 0) {
          managed.leaveConfirmed = true;
          const index = managed.leaveToIndex;
          if (this.quitting) app.quit();
          else if (managed.closing) window.close();
          else if (index !== undefined && index < webContents.navigationHistory.length()) webContents.navigationHistory.goToIndex(index);
          else webContents.send(CHANNEL.windowsLeave);
          return;
        }
        for (const other of this.windows.values()) {
          other.flushed = false;
          other.closing = false;
        }
        this.quitting = false;
        this.emit('stayed');
      });
    });
    window.once('closed', () => {
      this.windows.delete(window.id);
      if (this.lastFocused === window.id) this.lastFocused = null;
      this.emit('closed', managed);
      this.emitChanged();
      this.afterClosed();
    });

    this.emit('created', managed);
    this.emitChanged();
    return managed;
  }

  /** True if the window may go. A prompt only when something would be lost. */
  private async confirmLeaving(window: BrowserWindow, failed: number, unsent: number): Promise<boolean> {
    if (failed === 0 && unsent === 0) return true;
    // A hidden main window asking would leave Stay with nothing on screen.
    if (window.isMinimized()) window.restore();
    if (!window.isVisible()) window.show();
    const text = strings();
    const { response: choice } = await showMessageBox(window, {
      type: 'warning',
      title: 'Bulwark',
      message: failed > 0 ? text.unsavedTitle : text.unsentTitle,
      detail: failed > 0 ? text.unsavedDetail : unsentDetail(text, unsent),
      buttons: [failed > 0 ? text.closeAnyway : text.closeNow, text.stay],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (choice === 0) return true;
    this.emit('stayed');
    return false;
  }

  /**
   * The last main window with pop-outs open only hides: they borrow its session.
   * The same when the app is to stay in the background (tray, macOS).
   */
  private shouldHide(managed: ManagedWindow): boolean {
    if (this.quitting || managed.type !== 'main') return false;
    const others = [...this.windows.values()].filter((w) => w !== managed && !w.window.isDestroyed());
    if (others.some((w) => w.type === 'main')) return false;
    return others.length > 0 || this.staysInBackground();
  }

  private staysInBackground(): boolean {
    return process.platform === 'darwin' || this.closeToBackground();
  }

  private isLastOnScreen(managed: ManagedWindow): boolean {
    if (this.staysInBackground()) return false;
    return ![...this.windows.values()].some((w) => w !== managed && !w.window.isDestroyed() && this.onScreen(w));
  }

  /**
   * A pop-out still painting counts: only a main window can be hidden on purpose. So does
   * one that's minimised, which is on the taskbar, though isVisible() says no on Windows.
   */
  private onScreen(managed: ManagedWindow): boolean {
    return managed.type !== 'main' || managed.window.isVisible() || managed.window.isMinimized();
  }

  /** A pop-out's page died. It comes back from its address, unless it keeps doing that. */
  private noPageLeft(managed: ManagedWindow): void {
    managed.flushable = false;
    for (const finish of [...(managed.flushWaits ?? [])]) finish([]);
  }

  private onPageGone(managed: ManagedWindow, reason: string): void {
    const { window } = managed;
    if (reason === 'clean-exit' || window.isDestroyed() || replacingRenderer.has(window.webContents)) return;
    const now = Date.now();
    managed.crashes = [...(managed.crashes ?? []).filter((at) => now - at < CRASH_WINDOW_MS), now];
    if (managed.crashes.length > MAX_CRASH_RELOADS) {
      managed.flushable = false;
      window.close();
      return;
    }
    window.webContents.reload();
  }

  private savingForSessionEnd = false;

  /** Whichever window hears first saves them all. The list of windows stays as it is. */
  private saveForSessionEnd(): void {
    if (this.savingForSessionEnd) return;
    this.savingForSessionEnd = true;
    this.quitting = true;
    this.emit('sessionEnding');
    this.options.state.save();
    void this.flushAll();
  }

  /** A pop-out closed. If only a hidden main is left and nothing keeps the app running, it goes too. */
  private afterClosed(): void {
    if (this.windows.size === 0) {
      this.destroySpare();
      return;
    }
    if (this.quitting || this.staysInBackground()) return;
    const left = [...this.windows.values()].filter((w) => !w.window.isDestroyed());
    if (left.some((w) => this.onScreen(w))) return;
    for (const { window } of left) window.close();
  }

  /**
   * Whether closing the last window leaves the app running. The tray feature calls
   * this with its `closeToTray` setting. macOS stays regardless, as apps do there.
   */
  setCloseToBackground(check: () => boolean): void {
    this.closeToBackground = check;
  }

  /** From here on closing a window closes it. Undone by choosing Stay in a prompt. */
  beginQuit(): void {
    const { state } = this.options;
    // Quit before anyone signed in, or halfway through: what was to come back still is.
    if (this.restoring) this.storeSession();
    // A clean quit is no crash, however soon after the start.
    delete state.data.restoreAttempts;
    this.quitting = true;
    this.destroySpare();
    this.options.state.save();
  }

  /** Windows are going. Choosing Stay in a prompt ends that. */
  isQuitting(): boolean {
    return this.quitting;
  }

  /** A page's unsaved-changes question is on screen. */
  askingToLeave(): boolean {
    for (const managed of this.windows.values()) if (managed.askingToLeave) return true;
    return false;
  }

  /** The next main window loads but isn't shown: a start at login, or a toast's button. */
  startMainHidden(): void {
    this.mainStart.startHidden();
  }

  /** Asked for before the boot opens it: the main window shows when it does, start in the tray or not. */
  showMainWhenOpened(): void {
    this.mainStart.wantShown();
  }

  cancelQuit(): void {
    this.quitting = false;
    for (const managed of this.windows.values()) managed.flushed = false;
  }

  private showWhenPainted(managed: ManagedWindow, inactive = false): void {
    const { window } = managed;
    const hidden = managed.type === 'main' && this.mainStart.take();
    const show = () => {
      if (inactive) window.showInactive();
      else window.show();
    };
    const fallback = setTimeout(() => {
      if (!hidden && !window.isDestroyed() && !managed.closing && !window.isVisible()) show();
    }, SHOW_FALLBACK_MS);
    window.once('closed', () => clearTimeout(fallback));
    window.once('ready-to-show', () => {
      clearTimeout(fallback);
      if (window.isDestroyed() || managed.closing) return;
      // A window rebuilt with a native frame starts hidden just the same.
      if (hidden) this.mainStart.startHidden();
      void this.checkOverlay(managed).then((replaced) => {
        if (hidden && !replaced) this.mainStart.take();
        if (managed.closing) return;
        if (!hidden && !replaced && !window.isDestroyed() && !window.isVisible()) show();
        if (!replaced && managed.type === 'main' && this.popoutsUsedLately()) this.scheduleSpare(SPARE_FIRST_DELAY_MS);
      });
    });
  }

  /**
   * An older instance has no --titlebar-right-inset, so it can't take a frameless
   * window: rebuilt once with a native frame, still hidden, and remembered per
   * origin. The other way round only takes effect on the next window.
   * Returns true if the window was replaced.
   */
  private async checkOverlay(managed: ManagedWindow): Promise<boolean> {
    if (desktopForcesNativeFrame()) return false;
    const { window, type, key, url } = managed;
    let knowsInset: unknown;
    try {
      if (new URL(window.webContents.getURL()).origin !== this.options.origin) return false;
      knowsInset = await window.webContents.executeJavaScript(
        "getComputedStyle(document.documentElement).getPropertyValue('--titlebar-right-inset') !== ''",
        true,
      );
    } catch {
      return false;
    }
    if (window.isDestroyed() || typeof knowsInset !== 'boolean') return false;
    const had = this.wantsOverlay();
    const { state, origin } = this.options;
    state.data.overlayByOrigin[origin] = knowsInset;
    state.touch();
    if (!had || knowsInset) return false;
    // The new one first: with no windows left, the app would quit.
    this.windows.delete(window.id);
    window.removeAllListeners('closed');
    this.open({ type, key: key ?? undefined, url, noSpare: true });
    window.destroy();
    return true;
  }

  private rememberBounds(managed: ManagedWindow): void {
    const { window } = managed;
    const type = managed.boundsKey ?? managed.type;
    if (window.isDestroyed() || window.isFullScreen() || window.isMinimized()) return;
    const bounds = window.getNormalBounds();
    // On a scaled display a window comes out a few pixels off what was asked for.
    // Storing that would make a remembered size creep with every launch, so only
    // a change after that counts.
    const start = managed.initialBounds;
    const untouched = start && start.x === bounds.x && start.y === bounds.y && start.width === bounds.width && start.height === bounds.height;
    const maximized = window.isMaximized();
    const stored = this.options.state.data.windowBounds[type];
    if (untouched && stored && !!stored.maximized === maximized) return;
    this.options.state.data.windowBounds[type] = untouched && stored ? { ...stored, maximized } : { ...bounds, maximized };
    this.options.state.touch();
  }

  private applyChrome(colours: ChromeColours): void {
    const all = [...this.windows.values()].map((w) => w.window);
    if (this.spare) all.push(this.spare.window);
    for (const window of all) {
      if (window.isDestroyed()) continue;
      window.setBackgroundColor(colours.background);
      if (process.platform !== 'darwin' && this.wantsOverlay()) {
        try {
          window.setTitleBarOverlay({ color: OVERLAY_COLOUR, symbolColor: colours.symbol, height: this.overlayHeight(window) });
        } catch {
          // A window that was made with a native frame has no overlay to colour.
        }
      }
    }
  }

  // ─── The warm spare ─────────────────────────────────────────

  private popoutsUsedLately(): boolean {
    const last = this.options.state.data.lastPopoutAt;
    return typeof last === 'number' && Date.now() - last < SPARE_RECENT_USE_MS;
  }

  private notePopoutUse(): void {
    this.options.state.data.lastPopoutAt = Date.now();
    this.options.state.touch();
    this.scheduleSpare(SPARE_NEXT_DELAY_MS);
  }

  /** The page's language changed: a spare holds the old one, and its strings. */
  dropSpare(): void {
    this.destroySpare();
    if (this.popoutsUsedLately()) this.scheduleSpare(SPARE_NEXT_DELAY_MS);
  }

  private scheduleSpare(delay: number): void {
    if (this.options.spare === false || this.spareUnsupported || this.spare || this.spareTimer || this.quitting) return;
    this.spareTimer = setTimeout(() => {
      this.spareTimer = null;
      this.createSpare();
    }, delay);
    this.spareTimer.unref?.();
  }

  private createSpare(): void {
    if (this.spare || this.quitting || this.windows.size === 0) return;
    const window = new BrowserWindow({ ...this.windowOptions('composer'), ...DEFAULT_SIZE.composer });
    this.options.attachGuards(window);
    window.webContents.on('did-change-theme-color', (_event, colour) => this.options.theme.setFromPageColour(colour));
    const limit = setTimeout(() => {
      this.spareUnsupported = true;
      this.destroySpare();
    }, SPARE_READY_LIMIT_MS);
    this.spare = { window, ready: false, limit };
    window.once('closed', () => {
      clearTimeout(limit);
      if (this.spare?.window === window) this.spare = null;
    });
    void window.loadURL(`${this.options.origin}/popout/spare`).catch(() => {});
  }

  /** The spare page has loaded and waits. */
  spareReady(window: BrowserWindow): void {
    if (this.spare?.window !== window) return;
    clearTimeout(this.spare.limit);
    this.spare.ready = true;
    const held = this.spare;
    held.idle = setTimeout(() => {
      if (this.spare === held) this.destroySpare();
    }, this.options.spareIdleMs ?? SPARE_IDLE_LIMIT_MS);
    held.idle.unref?.();
  }

  private destroySpare(): void {
    if (this.spareTimer) clearTimeout(this.spareTimer);
    this.spareTimer = null;
    const spare = this.spare;
    this.spare = null;
    if (spare?.idle) clearTimeout(spare.idle);
    if (spare && !spare.window.isDestroyed()) spare.window.destroy();
  }

  /**
   * Makes the spare into the pop-out: its place and size, then the page swaps in
   * the route without a load and the window shows. Only `message` and `composer`,
   * which is all the spare page knows how to become.
   */
  private activateSpare(options: OpenOptions, key: string | null): BrowserWindow | null {
    if (options.type !== 'message' && options.type !== 'composer') return null;
    const spare = this.spare;
    if (!spare?.ready || spare.window.isDestroyed()) return null;
    this.spare = null;
    if (spare.idle) clearTimeout(spare.idle);
    const { window } = spare;
    const place = options.place ?? this.placeFor(options.type, options.size, options.boundsKey);
    const { minWidth, minHeight } = MIN_SIZE[options.type];
    window.setMinimumSize(minWidth, minHeight);
    window.setBounds(place);
    const managed = this.adopt(window, options.type, key, options.url, true);
    managed.boundsKey = options.boundsKey;
    managed.initialBounds = window.getNormalBounds();
    let taken = false;
    // The page says other things first (its theme, its menu state).
    const onMessage = (_event: unknown, channel: string) => {
      if (channel !== CHANNEL.windowsSpareTaken) return;
      taken = true;
      window.webContents.removeListener('ipc-message', onMessage);
    };
    window.webContents.on('ipc-message', onMessage);
    window.webContents.send(CHANNEL.windowsSpareActivate, options.url);
    window.show();
    setTimeout(() => {
      if (!taken && !window.isDestroyed()) void window.loadURL(options.url).catch(() => {});
    }, SPARE_TAKEN_LIMIT_MS).unref?.();
    this.scheduleSpare(SPARE_NEXT_DELAY_MS);
    return window;
  }

  // ─── Saving before a window goes ────────────────────────────

  /** The page's name for its window in the Window menu. One line, no control characters, not too long. */
  setMenuName(window: BrowserWindow, name: string): void {
    const managed = this.windows.get(window.id);
    if (!managed) return;
    // eslint-disable-next-line no-control-regex
    const clean = name.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) || undefined;
    if (clean === managed.menuName) return;
    managed.menuName = clean;
    this.emitChanged();
  }

  setFlushable(window: BrowserWindow, flushable: boolean): void {
    const managed = this.windows.get(window.id);
    if (managed) managed.flushable = flushable;
  }

  flushDone(id: number, answers: unknown): void {
    this.flushWaits.get(id)?.(Array.isArray(answers) ? (answers as FlushAnswer[]) : []);
  }

  /** Asks the page to save and waits, within limits: a hung page can't keep a window open. */
  private flushWindow(managed: ManagedWindow): Promise<FlushAnswer[]> {
    if (!managed.flushable || managed.window.isDestroyed()) return Promise.resolve([]);
    return new Promise((resolve) => {
      const id = this.nextFlushId++;
      const finish = (answers: FlushAnswer[]) => {
        clearTimeout(timer);
        this.flushWaits.delete(id);
        managed.flushWaits?.delete(finish);
        resolve(answers);
      };
      const timer = setTimeout(() => finish([{ timedOut: true }]), FLUSH_TIMEOUT_MS);
      this.flushWaits.set(id, finish);
      (managed.flushWaits ??= new Set()).add(finish);
      managed.window.webContents.send(CHANNEL.lifecycleFlush, id);
    });
  }

  /** Before a quit, every window at once. */
  async flushAll(): Promise<FlushSummary> {
    const pending = [...this.windows.values()].filter((w) => w.flushable && !w.flushed && !w.window.isDestroyed());
    const answers = await Promise.all(pending.map((w) => this.flushWindow(w)));
    for (const w of pending) w.flushed = true;
    // A composer saved for the first time just now said which draft while quitting. All the
    // windows are still here, and none of them has been closed by the quit yet.
    if (this.quitting) this.writeSession();
    const { failed, unsent } = sumAnswers(answers.flat());
    return { asked: pending.length > 0, failed, unsent };
  }

  /** The page decided: it has saved, or discarded, and asks to go. No second save. */
  closeSelf(window: BrowserWindow): void {
    const managed = this.windows.get(window.id);
    if (managed) managed.flushed = true;
    window.close();
  }

  // ─── Coming back next time ──────────────────────────────────

  setRestoreUrls(window: BrowserWindow, urls: string[]): void {
    const managed = this.windows.get(window.id);
    if (!managed) return;
    managed.restoreUrls = urls;
    this.storeSession();
  }

  private sessionWindows(): SessionWindow[] {
    const entries: SessionWindow[] = [];
    for (const managed of this.windows.values()) {
      const { window, type, key } = managed;
      if (window.isDestroyed()) continue;
      const bounds = window.getNormalBounds();
      // A composer comes back through its draft, or not at all. Settings is a page of the main
      // window, not a window to bring back.
      if (type === 'message') {
        let url = managed.url;
        try {
          const current = window.webContents.getURL();
          if (new URL(current).origin === this.options.origin && windowTypeOf(new URL(current).pathname) === type) url = current;
        } catch {
          // Still loading: what it was opened with.
        }
        entries.push({ type, url, key: key ?? undefined, bounds, maximized: window.isMaximized() });
      } else if (type === 'main' && key !== 'main') {
        entries.push({ type, url: managed.url, key: key ?? undefined, bounds, maximized: window.isMaximized() });
      }
      for (const url of managed.restoreUrls ?? []) {
        entries.push({ type: 'composer', url, key: `restored:${url}`, bounds: type === 'composer' ? bounds : undefined, maximized: type === 'composer' && window.isMaximized() });
      }
    }
    return entries;
  }

  /** Local data was wiped: what was to come back names drafts and messages that no longer are. */
  forgetSession(): void {
    const { state } = this.options;
    this.savedSession = [];
    delete state.data.session;
    delete state.data.restoreAttempts;
    delete state.data.resumeAfterRestart;
    state.save();
  }

  private storeSession(): void {
    // Quitting closes the windows one by one, which would forget them.
    if (!this.quitting) this.writeSession();
  }

  private writeSession(): void {
    // With the setting off nothing is written. Before the restore, the old list stands.
    const { state } = this.options;
    if (state.data.restoreWindows === false || (this.savedSession.length > 0 && !this.restoring)) return;
    state.data.session = [...this.sessionWindows(), ...this.savedSession];
    state.touch();
  }

  setRestoreEnabled(enabled: boolean): void {
    const { state } = this.options;
    state.data.restoreWindows = enabled;
    if (!enabled) {
      this.savedSession = [];
      delete state.data.session;
    }
    state.touch();
  }

  /**
   * The main window has a session to lend, so what was open last time can come back.
   * Once, and only near the start.
   */
  restoreSession(): void {
    if (this.savedSession.length === 0 || this.restoring) return;
    // Started hidden, for the tray: they come when the main window does.
    const main = this.mainWindow();
    if (main && !main.isVisible()) {
      if (!this.restoreDeferred) {
        this.restoreDeferred = true;
        main.once('show', () => this.restoreSession());
      }
      return;
    }
    const { state } = this.options;
    const saved = this.savedSession;
    if (!this.restoreDeferred && Date.now() - this.startedAt > RESTORE_LIMIT_MS) {
      this.savedSession = [];
      this.storeSession();
      return;
    }
    // Two starts that crashed doing this: not a third. Written before the first
    // window opens, since a crash leaves no time for it after.
    const attempts = state.data.restoreAttempts ?? 0;
    if (attempts >= RESTORE_MAX_ATTEMPTS) {
      this.savedSession = [];
      delete state.data.restoreAttempts;
      this.storeSession();
      state.save();
      return;
    }
    state.data.restoreAttempts = attempts + 1;
    state.save();
    setTimeout(() => {
      delete state.data.restoreAttempts;
      state.touch();
    }, RESTORE_STABLE_MS).unref?.();

    this.restoring = true;
    const valid = saved.filter((entry) => this.validSessionEntry(entry));
    const openNext = (index: number) => {
      if (this.quitting) return;
      if (index >= valid.length) {
        this.restoring = false;
        this.savedSession = [];
        this.storeSession();
        return;
      }
      const entry = valid[index];
      this.savedSession = valid.slice(index + 1);
      const bounds = entry.bounds && isOnSomeDisplay(entry.bounds, screen.getAllDisplays()) ? fitInto(entry.bounds, screen.getDisplayMatching(entry.bounds).workArea) : undefined;
      this.open({ type: entry.type, url: entry.url, key: entry.key, place: bounds, noSpare: true, inactive: true, maximized: entry.maximized });
      setTimeout(() => openNext(index + 1), RESTORE_STAGGER_MS);
    };
    openNext(0);
  }

  private validSessionEntry(entry: SessionWindow): boolean {
    // Saved by an older version, which opened Settings as a window.
    if (entry.type === 'settings') return false;
    try {
      const url = new URL(entry.url);
      return url.protocol === 'https:' && url.origin === this.options.origin && windowTypeOf(url.pathname) === entry.type;
    } catch {
      return false;
    }
  }

  // ─── Finding and focusing ───────────────────────────────────

  findByKey(key: string): ManagedWindow | undefined {
    return [...this.windows.values()].find((w) => w.key === key && !w.closing && !w.window.isDestroyed());
  }

  managedFor(window: BrowserWindow): ManagedWindow | undefined {
    return this.windows.get(window.id);
  }

  all(): ManagedWindow[] {
    return [...this.windows.values()].filter((w) => !w.window.isDestroyed());
  }

  mainWindow(): BrowserWindow | undefined {
    return [...this.windows.values()].find((w) => w.type === 'main' && !w.window.isDestroyed())?.window;
  }

  focusedManaged(): ManagedWindow | undefined {
    const focused = BrowserWindow.getFocusedWindow();
    if (focused && this.windows.has(focused.id)) return this.windows.get(focused.id);
    return this.lastFocused !== null ? this.windows.get(this.lastFocused) : undefined;
  }

  focusWindow(window: BrowserWindow): void {
    if (window.isDestroyed() || this.windows.get(window.id)?.closing) return;
    if (window.isMinimized()) window.restore();
    if (!window.isVisible()) window.show();
    window.focus();
  }

  /** With an id, that window. With none, the main one. */
  focus(id?: number): void {
    const window = typeof id === 'number' ? this.windows.get(id)?.window : this.mainWindow();
    if (window) this.focusWindow(window);
  }

  /** Ctrl+`: the next window on screen, in the order they opened. */
  cycle(direction: 1 | -1 = 1): void {
    const shown = this.all().filter((w) => w.window.isVisible());
    const next = nextInCycle(shown.map((w) => w.window.id), this.focusedManaged()?.window.id, direction);
    if (next !== null) this.focus(next);
  }

  list(): WindowInfo[] {
    const focused = BrowserWindow.getFocusedWindow()?.id;
    return [...this.windows.values()]
      .filter((w) => !w.window.isDestroyed())
      .map(({ window, type, menuName }) => ({ id: window.id, type, title: window.getTitle(), ...(menuName ? { menuName } : {}), focused: window.id === focused, visible: window.isVisible() }));
  }

  broadcast(channel: string, payload: unknown): void {
    for (const { window } of this.windows.values()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload);
    }
    if (this.spare && !this.spare.window.isDestroyed()) this.spare.window.webContents.send(channel, payload);
  }

  private emitChanged(): void {
    this.emit('changed', this.list());
  }

  isEmpty(): boolean {
    return this.windows.size === 0;
  }

  /** Nothing on screen: another launch or a dock click brings the main window back. */
  noneVisible(): boolean {
    return !this.all().some((w) => w.window.isVisible());
  }

  originUrl(): string {
    return this.options.origin;
  }
}
