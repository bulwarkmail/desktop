/**
 * What the OS features share: the settings, the pause, the lock, the page's summary and
 * the way to the main window's page. Commands wait here until that page listens, so a
 * file double-clicked before the app is up isn't lost.
 */

import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { CHANNEL, type OsCommand, type OsSettings, type OsStatus, type OsSummary, type QuickComposeStatus } from '../../shared/bridge';
import { LinkRateLimit } from '../deep-link';
import type { FeatureContext } from './index';
import { cleanSettingsPatch, currentOsSettings, defaultSettings, onlyMessageFiles, toastCopyText } from './os-rules';

const EMPTY_SUMMARY: OsSummary = { unread: [], recent: [], nextEvent: null };

export class OsHub extends EventEmitter<{
  settings: [OsSettings, Partial<OsSettings>];
  status: [OsStatus];
  summary: [OsSummary];
  badge: [number];
  locked: [boolean];
  /** Sign-out, a wipe or a quit: nothing of this account stays on the OS's surfaces. */
  cleared: [];
}> {
  private readonly defaults = defaultSettings(process.platform, process.env);
  private readonly pending: OsCommand[] = [];
  private receiver: WebContents | null = null;
  /** The receiving page opens an .eml in a message window of its own (an older page shows it in the main window). */
  private receiverOpensMessageFiles = false;
  /**
   * Fails closed. `unknown` until the main window's page has said, and again after it
   * navigates: no content on any surface, and no toast's button acts. `main` is a lock
   * main decided on (the app lock's call): no page can lift that.
   */
  private lockState: 'unknown' | 'open' | 'page' | 'main' = 'unknown';
  private summaryNow: OsSummary = EMPTY_SUMMARY;
  private badgeNow = 0;
  shortcutActive = false;
  /**
   * This start came from the login entry made for "Open again after a restart" alone: the
   * user hasn't asked to start at login, so their "Start in the tray" doesn't apply.
   */
  startedForRestart = false;
  /** Opens the quick composer: os-quick-compose.ts. */
  quickCompose: (() => void) | null = null;
  quickComposeStatus: QuickComposeStatus | undefined;
  /** Writes to the clipboard, for a toast's copy button: os-toasts.ts. */
  copyText: ((text: string) => void) | null = null;
  /**
   * Puts the main window in front when Windows wouldn't, for a toast's click: os-toasts.ts.
   * The click starts a second process, and Windows gives neither it nor this one the
   * foreground, so a plain focus only flashes the taskbar button.
   */
  toFront: (() => void) | null = null;
  /** Any web page can fire `bulwark://new` in a loop, and each would take the focus. */
  private readonly newMessageLimit = new LinkRateLimit();

  constructor(readonly ctx: FeatureContext) {
    super();
    this.setMaxListeners(20);
    ctx.windows.on('created', (managed) => {
      if (managed.type !== 'main') return;
      const { webContents } = managed.window;
      // A new page listens anew. A route change in the page isn't a navigation here.
      webContents.on('did-navigate', () => {
        if (this.receiver === webContents) this.receiver = null;
        if (this.lockState === 'open') this.setLockState('unknown');
      });
    });
    ctx.windows.on('closed', (managed) => {
      if (managed.type === 'main') this.receiver = null;
    });
  }

  settings(): OsSettings {
    return currentOsSettings({ ...this.defaults, ...this.ctx.state.data.os }, process.platform);
  }

  status(): OsStatus {
    return { settings: this.settings(), pausedUntil: this.pausedUntil(), shortcutActive: this.shortcutActive, quickCompose: this.quickComposeStatus };
  }

  update(patch: unknown): OsStatus {
    const clean = cleanSettingsPatch(patch);
    if (Object.keys(clean).length > 0) {
      this.ctx.state.data.os = { ...this.ctx.state.data.os, ...clean };
      this.ctx.state.touch();
      this.emit('settings', this.settings(), clean);
    }
    this.announce();
    return this.status();
  }

  announce(): void {
    const status = this.status();
    this.ctx.windows.broadcast(CHANNEL.osStatusChanged, status);
    this.emit('status', status);
  }

  /** A pause that has run out reads as none. */
  pausedUntil(): number | null {
    const until = this.ctx.state.data.osPausedUntil;
    return typeof until === 'number' && until > Date.now() ? until : null;
  }

  setPaused(until: number | null): void {
    this.ctx.state.data.osPausedUntil = until;
    this.ctx.state.touch();
    this.announce();
  }

  /** Anything but a known open state counts as locked. */
  get locked(): boolean {
    return this.lockState !== 'open';
  }

  /** Really locked, as opposed to not having heard yet: what's already delivered goes. */
  get lockIsReal(): boolean {
    return this.lockState === 'page' || this.lockState === 'main';
  }

  private setLockState(next: 'unknown' | 'open' | 'page' | 'main'): void {
    const before = this.locked;
    this.lockState = next;
    if (this.lockIsReal) {
      this.summaryNow = EMPTY_SUMMARY;
      // What waits for the page and names a message must not run after the unlock either.
      const kept = this.pending.filter((command) => command.type !== 'notification' && command.type !== 'open-message');
      this.pending.length = 0;
      this.pending.push(...kept);
    }
    if (before !== this.locked || this.lockIsReal) this.emit('locked', this.locked);
  }

  /**
   * From the bridge. Any window may lock. Only the main window's page may say it's open,
   * and not if main locked it. A privileged plugin in that page can reach this call too,
   * which is why the app lock's own state is kept with setLockedByMain.
   */
  setLockedByPage(locked: boolean, contents: WebContents): void {
    if (locked) {
      if (this.lockState !== 'main') this.setLockState('page');
      return;
    }
    if (this.lockState === 'main' || this.ctx.windows.mainWindow()?.webContents !== contents) return;
    this.setLockState('open');
  }

  /** For the app lock in main: its verdict stands over anything a page says. */
  setLockedByMain(locked: boolean): void {
    this.setLockState(locked ? 'main' : 'open');
  }

  get summary(): OsSummary {
    return this.locked ? EMPTY_SUMMARY : this.summaryNow;
  }

  /** Sign-out, wipe, quit. */
  clearSurfaces(): void {
    this.summaryNow = EMPTY_SUMMARY;
    this.badgeNow = 0;
    this.emit('summary', this.summary);
    this.emit('badge', 0);
    this.emit('cleared');
  }

  setSummary(summary: OsSummary): void {
    this.summaryNow = summary;
    this.emit('summary', this.summary);
  }

  get badge(): number {
    return this.badgeNow;
  }

  setBadge(count: number): void {
    if (count === this.badgeNow) return;
    this.badgeNow = count;
    this.emit('badge', count);
  }

  /** Signs what a toast's buttons hand back: toastUrl in os-rules.ts. */
  toastSecret(): string {
    const { state } = this.ctx;
    if (!state.data.osToastSecret) {
      state.data.osToastSecret = randomBytes(32).toString('base64url');
      state.save();
    }
    return state.data.osToastSecret;
  }

  /** A button shouldn't throw a window in the user's face; the page opens the message if it can't. */
  toastAction(action: string, context: string, reply?: string): void {
    // An old toast's Delete must not act behind the lock. The lock screen is what opens.
    if (this.locked) {
      // Starting, main hasn't heard from a page yet. A button leaves the window to the start, in
      // the tray or not: asking for it would win over a start in the tray. A click, or a lock
      // that's real, brings it up.
      const starting = !this.lockIsReal && !this.ctx.windows.mainWindow();
      if (!starting || action === 'open' || action === 'reply') this.showForClick();
      return;
    }
    if (action.startsWith('copy:')) {
      const text = toastCopyText(action);
      if (text !== null) this.copyText?.(text);
      return;
    }
    if (action === 'open' || action === 'reply') {
      this.dispatch({ type: 'notification', action, context, reply });
      this.toFront?.();
    } else this.dispatch({ type: 'notification', action, context }, { show: false });
  }

  private showForClick(): void {
    this.ctx.showMain();
    this.toFront?.();
  }

  /** The main window's page says it listens. Only that page: pop-outs don't act on these. */
  subscribe(contents: WebContents, options?: unknown): void {
    const main = this.ctx.windows.mainWindow();
    if (!main || main.webContents !== contents) return;
    this.receiver = contents;
    this.receiverOpensMessageFiles = !!options && typeof options === 'object' && (options as { messageFileWindows?: unknown }).messageFileWindows === true;
    this.flush();
  }

  /** The main window's page, listening now, opens an .eml in a window of its own. */
  get messageFileWindows(): boolean {
    return !!this.receiver && !this.receiver.isDestroyed() && this.receiverOpensMessageFiles;
  }

  private flush(): void {
    const receiver = this.receiver;
    if (!receiver || receiver.isDestroyed()) return;
    for (const command of this.pending.splice(0)) receiver.send(CHANNEL.osCommand, command);
  }

  /** `show` brings the main window up. Without it, there still has to be a page to do the work. */
  dispatch(command: OsCommand, options: { show: boolean } = { show: true }): void {
    // A new message from outside the app is its own small window. One with parameters for
    // a plugin goes to the page, which hands them over once its composer is open.
    if (command.type === 'new-message' && this.quickCompose && !command.params) {
      if (this.newMessageLimit.allow(Date.now())) this.quickCompose();
      return;
    }
    this.pending.push(command);
    this.flush();
    const { windows } = this.ctx;
    // A mail link, and files for a new message (Send to, Open with), open a compose window of
    // their own (the page's mail-app.tsx) and the main window stays where it is, as with Outlook.
    // The page brings it up when it has to ask something or the composer opens there after all.
    // So does a saved message (.eml) for a page that opens it in a message window of its own;
    // signed out or offline, that page brings the main window up itself. Locked, the lock
    // screen shows.
    const forNewMessage = command.type === 'mailto' || (command.type === 'files' && command.reason === 'attach' && !command.ask);
    const messageFiles = command.type === 'files' && command.reason === 'open' && onlyMessageFiles(command) && this.messageFileWindows;
    const ownWindow = (forNewMessage || messageFiles) && !this.locked && !!windows.mainWindow();
    if (options.show && !ownWindow) {
      this.ctx.showMain();
    } else if (!windows.mainWindow()) {
      // Not a wish to see it: while the app starts, that would win over a start in the tray.
      this.ctx.showMain({ hidden: true });
    }
  }
}
