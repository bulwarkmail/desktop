/**
 * The decisions of the OS integration with nothing of Electron in them, so they
 * can be tested as they are: what a command line asks for, whether it's quiet now,
 * what a toast says, what goes in the registry.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDeepLink, type WindowLink } from '../deep-link';
import type { OsCommand, OsSettings } from '../../shared/bridge';

/**
 * "Show Bulwark" from anywhere: Ctrl+Alt+B (⌥⌘B). Not on Windows, where Ctrl+Alt is AltGr
 * and B types on 44 of its layouts (see quickComposeBuiltIn): a function key types nothing.
 * Never one of the app's own keys: a global one never reaches the app (`APP_KEYS`).
 */
export function showShortcutBuiltIn(platform: string): string {
  return platform === 'win32' ? 'CommandOrControl+Alt+F11' : 'CommandOrControl+Alt+B';
}

/** What switching it on gave before: the composer's Bcc key. */
const OLD_SHOW_SHORTCUT = 'CommandOrControl+Shift+B';

/** Stored settings as they apply now: the old built-in key, which nobody picked, becomes the new one. */
export function currentOsSettings<T extends { showShortcut?: string | null }>(stored: T, platform: string): T {
  return stored.showShortcut === OLD_SHOW_SHORTCUT ? { ...stored, showShortcut: showShortcutBuiltIn(platform) } : stored;
}
/** Same as HANDOFF_MAX_BYTES in the webmail: it wouldn't take more. */
export const MAX_LAUNCH_FILE_BYTES = 100 * 1024 * 1024;
const MAX_URL_LENGTH = 8192;

export function defaultSettings(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): OsSettings {
  // Plain GNOME has no tray at all: closing into nothing would look like a quit that isn't one.
  const desktop = (env.XDG_CURRENT_DESKTOP ?? '').toLowerCase();
  const noTray = platform === 'linux' && desktop.includes('gnome') && !desktop.includes('ubuntu');
  return {
    closeToTray: !noTray,
    startAtLogin: false,
    startMinimized: false,
    reopenAfterRestart: false,
    attentionOnNewMail: true,
    quietHoursEnabled: false,
    quietHoursStart: '22:00',
    quietHoursEnd: '07:00',
    showShortcut: null,
  };
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Ctrl+Alt+N, Cmd+Opt+N. */
export const QUICK_COMPOSE_SHORTCUT = 'CommandOrControl+Alt+N';

/**
 * Windows reads AltGr as Ctrl+Alt, so a global Ctrl+Alt+N would take away whatever AltGr+N
 * types: `}` on Czech, Hungarian and Romanian keyboards, ń on Polish. On the layouts Windows
 * ships, every letter and digit types something on at least 18 of them, with or without Shift
 * (test/fixtures/keyboard-layouts.json). Enter types on none, so this needs no look at the
 * keyboard, which neither Electron nor the native helper can tell us about anyway.
 */
export function quickComposeBuiltIn(platform: string): string {
  return platform === 'win32' ? 'CommandOrControl+Alt+Enter' : QUICK_COMPOSE_SHORTCUT;
}

/**
 * The shortcut in force, or null for none. A forced policy decides. Otherwise the user's
 * choice, where off counts as a choice, then a recommendation, then what's built in.
 */
export function quickComposeShortcut(policy: { value: string | null; locked: boolean }, choice: string | null | undefined, builtIn: string | null = QUICK_COMPOSE_SHORTCUT): string | null {
  const chosen = policy.locked ? policy.value : choice === undefined ? (policy.value ?? builtIn) : choice;
  return !chosen || chosen.toLowerCase() === 'off' ? null : chosen;
}

const SHORTCUT_KEY = /^(?:[A-Za-z0-9]|F(?:[1-9]|1\d|2[0-4])|Enter)$/;
/** One name per modifier. AltGr types characters, and the OS keeps the Windows or Super key. */
const SHORTCUT_MODIFIERS: Record<string, string> = {
  commandorcontrol: 'cmd',
  cmdorctrl: 'cmd',
  command: 'cmd',
  cmd: 'cmd',
  control: 'ctrl',
  ctrl: 'ctrl',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
};
/** What a system or every app already uses, past the rule of two modifiers. `cmd` is Cmd on a Mac and Ctrl elsewhere. */
const RESERVED_SHORTCUTS = new Set(['cmd+shift+A', 'cmd+shift+C', 'cmd+shift+V', 'cmd+shift+X', 'cmd+shift+Z']);
/**
 * The app's own keys with two modifiers: the composer's (Cc, Bcc, schedule send) and the
 * menus' (new message, new window, Save as PDF, reply all, forward). A global key is taken
 * before any window sees it, so one of these would stop working in Bulwark itself.
 * Same list as APP_KEYS in the webmail's lib/desktop/shortcut-keys.ts.
 */
const APP_KEYS = new Set(['cmd+shift+B', 'cmd+shift+C', 'cmd+shift+ENTER', 'cmd+shift+M', 'cmd+shift+N', 'cmd+shift+S', 'cmd+shift+R', 'cmd+shift+F']);
const RESERVED_ON_MAC = new Set([
  'cmd+shift+3', 'cmd+shift+4', 'cmd+shift+5', 'cmd+shift+Q',
  'cmd+ctrl+Q', 'cmd+ctrl+F',
  'alt+cmd+D', 'alt+cmd+H', 'alt+cmd+M',
]);

/**
 * What a page may hold for every app on this computer, and a same-origin plugin can reach
 * that call: Ctrl+V or Alt+F4 would stop working everywhere. Ctrl or Cmd with at least one
 * more modifier, on a letter, digit, function key or Enter. A policy isn't held to this.
 * It also keeps a page from storing what Electron's register throws on at every start.
 */
export function isAccelerator(value: unknown, platform: string = process.platform): value is string {
  if (typeof value !== 'string' || value.length > 64) return false;
  const parts = value.split('+');
  const key = parts.pop() ?? '';
  if (!SHORTCUT_KEY.test(key)) return false;
  const mac = platform === 'darwin';
  const modifiers: string[] = [];
  for (const part of parts) {
    const name = SHORTCUT_MODIFIERS[part.toLowerCase()];
    if (!name) return false;
    // Off a Mac, Ctrl and CommandOrControl are one key.
    modifiers.push(name === 'ctrl' && !mac ? 'cmd' : name);
  }
  const distinct = new Set(modifiers);
  if (distinct.size !== modifiers.length || distinct.size < 2 || !(distinct.has('cmd') || distinct.has('ctrl'))) return false;
  const named = `${[...distinct].sort().join('+')}+${key.toUpperCase()}`;
  return !RESERVED_SHORTCUTS.has(named) && !APP_KEYS.has(named) && !(mac && RESERVED_ON_MAC.has(named));
}

/** What a page may change: known keys of the right type, nothing else. */
export function cleanSettingsPatch(patch: unknown): Partial<OsSettings> {
  const input = (patch && typeof patch === 'object' ? patch : {}) as Record<string, unknown>;
  const out: Partial<OsSettings> = {};
  for (const key of ['closeToTray', 'startAtLogin', 'startMinimized', 'reopenAfterRestart', 'attentionOnNewMail', 'quietHoursEnabled'] as const) {
    if (typeof input[key] === 'boolean') out[key] = input[key];
  }
  for (const key of ['quietHoursStart', 'quietHoursEnd'] as const) {
    const value = input[key];
    if (typeof value === 'string' && TIME.test(value)) out[key] = value;
  }
  if (input.showShortcut === null) out.showShortcut = null;
  else if (isAccelerator(input.showShortcut)) out.showShortcut = input.showShortcut;
  if (input.quickComposeShortcut === null) out.quickComposeShortcut = null;
  else if (isAccelerator(input.quickComposeShortcut)) out.quickComposeShortcut = input.quickComposeShortcut;
  return out;
}

/** These start the app with the OS, which outlasts this run and the page that asked. */
const STARTS_WITH_OS = ['startAtLogin', 'reopenAfterRestart'] as const;

/**
 * Starting with the OS is persistence: it outlasts this run and the page that asked. A same-origin
 * plugin frame can make this call, so turning it on takes a real click. Turning it off doesn't.
 */
export function settingsAllowedWithoutClick(patch: unknown, clicked: boolean): unknown {
  if (clicked || !patch || typeof patch !== 'object') return patch;
  const input = patch as Record<string, unknown>;
  if (!STARTS_WITH_OS.some((key) => input[key] === true)) return patch;
  const rest = { ...input };
  for (const key of STARTS_WITH_OS) if (rest[key] === true) delete rest[key];
  return rest;
}

/**
 * Whether closing the last window leaves the app in the tray. The Files drive needs the app
 * running, as OneDrive does (opening a file that isn't on the disk asks it), so while a drive is
 * on the app stays even with "close to the tray" off. With no tray to come back from it would be
 * hiding into nothing; the Dock stays on a Mac.
 */
export function closesToBackground(options: { closeToTray: boolean; hasTray: boolean; platform: string; driveOn: boolean }): boolean {
  return (options.closeToTray || options.driveOn) && (options.hasTray || options.platform === 'darwin');
}

/** Longest a page may pause notifications. The tray's own choices don't go through here. */
export const MAX_PAGE_PAUSE_MS = 24 * 60 * 60 * 1000;

export function pageSetPause(until: unknown, now: number): number | null {
  return typeof until === 'number' && Number.isFinite(until) ? Math.min(until, now + MAX_PAGE_PAUSE_MS) : null;
}

/** The tray's "Until I turn them back on": the furthest a Date goes. Only the tray sets it. */
export const PAUSE_UNTIL_TURNED_ON = 8.64e15;

/** "Paused until 14:35", with the day when it isn't today, or until turned back on. */
export function pausedText(
  until: number,
  now: number,
  text: { trayPausedUntil: (time: string) => string; trayPausedForever: string },
  locale?: string,
): string {
  if (until >= PAUSE_UNTIL_TURNED_ON) return text.trayPausedForever;
  const at = new Date(until);
  const sameDay = at.toDateString() === new Date(now).toDateString();
  let time: string;
  try {
    time = new Intl.DateTimeFormat(locale || undefined, sameDay ? { hour: '2-digit', minute: '2-digit' } : { weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(at);
  } catch {
    time = at.toLocaleTimeString();
  }
  return text.trayPausedUntil(time);
}

function minutesOf(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

/** Start and end in local time. Across midnight works; equal times mean no quiet hours. */
export function inQuietHours(settings: Pick<OsSettings, 'quietHoursEnabled' | 'quietHoursStart' | 'quietHoursEnd'>, now: Date): boolean {
  if (!settings.quietHoursEnabled) return false;
  const start = minutesOf(settings.quietHoursStart);
  const end = minutesOf(settings.quietHoursEnd);
  const current = now.getHours() * 60 + now.getMinutes();
  if (start === end) return false;
  return start < end ? current >= start && current < end : current >= start || current < end;
}

export type FocusAssist = 'off' | 'priority' | 'alarms' | 'fullscreen';

/**
 * The state of Windows' Do Not Disturb, from the native helper's notificationQuietState
 * (os-toasts.ts). WNF profile 1 is priority only, 2 alarms only.
 * SHQueryUserNotificationState: 2 busy (full screen), 3 Direct3D full screen, 4
 * presentation, 6 quiet time. No answer counts as off: Windows still holds the toast
 * itself, and only our own sound depends on this.
 */
export function focusAssistFrom(state: { profile: number; notificationState: number } | null): FocusAssist {
  if (!state) return 'off';
  const { profile, notificationState: quns } = state;
  if (profile === 2) return 'alarms';
  if (profile === 1) return 'priority';
  if (quns === 2 || quns === 3 || quns === 4 || quns === 6) return 'fullscreen';
  return 'off';
}

/** The check, with a limit: off when the helper isn't there, fails, or takes longer than `timeoutMs`. */
export function focusAssistCheck(quietState: () => Promise<{ profile: number; notificationState: number } | null>, timeoutMs: number): Promise<FocusAssist> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('off'), timeoutMs);
    const settle = (value: FocusAssist) => {
      clearTimeout(timer);
      resolve(value);
    };
    try {
      quietState().then((state) => settle(focusAssistFrom(state)), () => settle('off'));
    } catch {
      settle('off');
    }
  });
}

/** A mailto: or webcal: link. bulwark: links have their one parser, src/main/deep-link.ts. */
export function commandFromUrl(raw: string): OsCommand | null {
  if (raw.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol === 'mailto:') return { type: 'mailto', url: raw };
  if (url.protocol === 'webcal:' || url.protocol === 'webcals:') return { type: 'webcal', url: raw };
  return null;
}

/**
 * What a URL handed to the app means. Anyone can put a bulwark: link on a page, so
 * these only ever show something: nothing here changes mail.
 */
export function requestFromUrl(raw: string): { commands: OsCommand[]; links: WindowLink[] } {
  const link = parseDeepLink(raw);
  if (!link) {
    const command = commandFromUrl(raw);
    return { commands: command ? [command] : [], links: [] };
  }
  if (link.kind === 'new') return { commands: [{ type: 'new-message', ...(link.params ? { params: link.params } : {}) }], links: [] };
  if (link.kind === 'view') return { commands: [{ type: 'navigate', target: link.view }], links: [] };
  // Not a request of any kind: see os-launch.ts, which gives it to the flow that's waiting.
  if (link.kind === 'sign-in') return { commands: [], links: [] };
  return { commands: [], links: [link] };
}

export interface LaunchRequest {
  commands: OsCommand[];
  /** bulwark: links main opens itself. */
  links: WindowLink[];
  /** Files named on the command line, absolute. Whether they exist is checked when read. */
  files: string[];
  /** The login item's flag. */
  fromLogin: boolean;
  /** A toast's button or click, as handed to us. Checked before anything is done with it. */
  toastUrls: string[];
  /** Explorer's "Send to": every file goes on a new message, with no question. */
  sendTo: boolean;
}

const OPENABLE = new Set(['.eml', '.ics', '.vcf']);

export function fileReason(file: string): 'open' | 'attach' {
  return OPENABLE.has(path.extname(file).toLowerCase()) ? 'open' : 'attach';
}

/**
 * What becomes of the files of one launch. Send to attaches whatever it is; "Open with" attaches
 * a document and opens an .eml, .ics or .vcf. Neither asks: a compose window with the files
 * opens, as for a mail link, and the main window stays where it is.
 */
export function launchFileCommand(reason: 'open' | 'attach', sendTo: boolean): { reason: 'open' | 'attach'; ask?: boolean } {
  if (sendTo) return { reason: 'attach' };
  return { reason };
}

function isMessageFile(name: string): boolean {
  return path.extname(name).toLowerCase() === '.eml';
}

/** Files to open that are all saved messages (.eml), every one read: a message window each. */
export function onlyMessageFiles(command: { files: readonly { name: string }[]; failed: readonly string[] }): boolean {
  return command.files.length > 0 && command.failed.length === 0 && command.files.every((file) => isMessageFile(file.name));
}

/**
 * A second launch that brings up a window of its own and leaves the main window be: a link, a
 * new message, a mail link, files for a new message (Send to, Open with on a document), or,
 * for a page that opens them in a message window (`messageFileWindows`), saved messages.
 */
export function launchOpensOwnWindow(request: Pick<LaunchRequest, 'links' | 'commands' | 'files' | 'sendTo'>, messageFileWindows = false): boolean {
  if (request.links.length > 0) return true;
  if (request.commands.length === 0 && request.files.length === 0) return false;
  return request.commands.every((command) => command.type === 'new-message' || command.type === 'mailto')
    && request.files.every((file) => launchFileCommand(fileReason(file), request.sendTo).reason === 'attach'
      || (messageFileWindows && isMessageFile(file)));
}

/** At most this many files go on one message from the OS, and this much together. The rest are named as not opened. */
export const MAX_LAUNCH_FILES = 100;
export const MAX_LAUNCH_TOTAL_BYTES = 500 * 1024 * 1024;

/**
 * Files that arrive one launch at a time but were picked together: "Open with" on several files
 * in Explorer starts the app once per file, and macOS sends `open-file` once per file. Within a
 * short quiet time they make one message. Each new file waits a little longer, up to a cap, so
 * a slow Explorer can't hold the first file for ever.
 */
export class LaunchFileBatch<T extends { files: unknown[]; failed: string[] }> {
  private held: T | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private startedAt = 0;

  constructor(
    private readonly deliver: (batch: T) => void,
    private readonly quietMs = 600,
    private readonly maxWaitMs = 3000,
    private readonly now: () => number = Date.now,
  ) {}

  add(batch: T): void {
    if (this.held) {
      this.held = { ...this.held, files: [...this.held.files, ...batch.files], failed: [...this.held.failed, ...batch.failed] };
    } else {
      this.held = batch;
      this.startedAt = this.now();
    }
    if (this.timer) clearTimeout(this.timer);
    const left = Math.max(0, this.maxWaitMs - (this.now() - this.startedAt));
    this.timer = setTimeout(() => this.flush(), Math.min(this.quietMs, left));
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const batch = this.held;
    this.held = null;
    if (batch) this.deliver(batch);
  }
}

/** Only a development run has its script on the command line. There, argv[1] may be a user's file. */
export function launchSkipPaths(defaultApp: boolean, appPath: string, argv1: string | undefined): string[] {
  return defaultApp ? [appPath, argv1 ?? ''].filter(Boolean) : [];
}

/**
 * What a command line asks for. Chromium's and our own switches, the program and its
 * script are not requests. Past a bare `--` nothing is a switch, which is how the
 * registered handlers pass a URL.
 *
 * A URL stands alone. A handler gets one, so anything next to it came from a link broken
 * up on its spaces, and must not attach a local file. File managers on Linux hand over
 * file: URLs, which are files.
 */
export function parseArgv(
  argv: readonly string[],
  options: { cwd: string; skip: readonly string[]; platform?: NodeJS.Platform },
): LaunchRequest {
  const request: LaunchRequest = { commands: [], links: [], files: [], fromLogin: false, toastUrls: [], sendTo: false };
  const skipped = new Set(options.skip.map((entry) => path.resolve(options.cwd, entry).toLowerCase()));
  const platform = options.platform ?? process.platform;
  let positional = false;
  let urlFound = false;
  const files: string[] = [];
  for (const arg of argv.slice(1)) {
    if (!positional && arg === '--') {
      positional = true;
      continue;
    }
    if (!positional && arg === LOGIN_FLAG) {
      request.fromLogin = true;
      continue;
    }
    if (!positional && arg === SEND_TO_FLAG) {
      request.sendTo = true;
      continue;
    }
    if (!positional && arg.startsWith('-')) continue;
    if (!arg) continue;
    if (platform === 'linux' && /^file:\/\//i.test(arg)) {
      try {
        const file = fileURLToPath(arg, { windows: false });
        if (!skipped.has(file.toLowerCase())) files.push(file);
      } catch {
        // A file: URL naming another host: no local file.
      }
      continue;
    }
    if (/^[a-z][a-z0-9+.-]+:/i.test(arg) && !/^[a-z]:[\\/]/i.test(arg)) {
      if (urlFound) continue;
      urlFound = true;
      if (arg.toLowerCase().startsWith(TOAST_URL_PREFIX)) {
        request.toastUrls.push(arg);
        continue;
      }
      const asked = requestFromUrl(arg);
      request.commands.push(...asked.commands);
      request.links.push(...asked.links);
      continue;
    }
    const resolved = path.resolve(options.cwd, arg);
    if (!skipped.has(resolved.toLowerCase())) files.push(resolved);
  }
  if (!urlFound) request.files = files;
  return request;
}

export const LOGIN_FLAG = '--bulwark-from-login';
/** On the "Send to" shortcut's command line, ahead of the files Explorer adds. */
export const SEND_TO_FLAG = '--bulwark-send-to';

// Windows reserves these with any extension, and with spaces before it: "con .txt".
const RESERVED_NAME = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])\s*(\..*)?$/i;

/** A name that's safe to create on every OS. Never a path. */
export function safeFileName(name: unknown, fallback = 'file'): string {
  const raw = typeof name === 'string' ? name : '';
  // eslint-disable-next-line no-control-regex
  let clean = raw.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, '_').replace(/[‪-‮⁦-⁩]/g, '').trim();
  clean = clean.replace(/[. ]+$/, '').replace(/^\.+/, '');
  if (!clean) clean = fallback;
  if (RESERVED_NAME.test(clean)) clean = `_${clean}`;
  if (clean.length > 150) {
    const ext = path.extname(clean).slice(0, 16);
    clean = clean.slice(0, 150 - ext.length) + ext;
  }
  return clean;
}

/**
 * A file that runs something by being opened, and that Windows doesn't warn about the way it
 * does for an executable from the internet. Kept readable, not active.
 */
const RISKY_EXTENSIONS = new Set(['.lnk', '.url', '.scf', '.library-ms', '.search-ms', '.searchconnector-ms', '.appref-ms', '.website', '.desktop']);

export function safeDragFileName(name: unknown): string {
  const clean = safeFileName(name);
  return RISKY_EXTENSIONS.has(path.extname(clean).toLowerCase()) ? `${clean}.txt` : clean;
}

function xml(raw: string): string {
  // A lone surrogate from a cut-off subject would make the whole toast invalid XML.
  const text = (raw as string & { toWellFormed(): string }).toWellFormed();
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[&<>"']/g, (c: string) => `&#${c.charCodeAt(0)};`);
}

export const REPLY_INPUT = 'reply';
const TOAST_COPY_PREFIX = 'copy:';
const TOAST_COPY_TEXT = /^[\p{L}\p{N}\- ]{1,24}$/u;

/**
 * A button whose id is `copy:<text>` puts the text on the clipboard and nothing else, such as
 * the code from a sign-in mail. Main does it, so the window stays where it is.
 * Only short codes: letters, digits, dashes and spaces.
 */
export function toastCopyText(action: string): string | null {
  if (!action.startsWith(TOAST_COPY_PREFIX)) return null;
  const text = action.slice(TOAST_COPY_PREFIX.length);
  return TOAST_COPY_TEXT.test(text) ? text : null;
}

const TOAST_ARGS_PREFIX = 'bulwark:';
const TOAST_URL_PREFIX = 'bulwark://toast/';

function toastSignature(action: string, context: string, secret: string): string {
  return createHmac('sha256', secret).update(`${action}\n${context}`).digest('base64url');
}

/**
 * A toast's click or button as a URL Windows opens for us, app running or not. Unlike every
 * other bulwark: link this one does something to mail, and a web page can link to it too,
 * so it's signed with a key of this install that no page ever sees.
 */
export function toastUrl(action: string, context: string, secret: string): string {
  return `${TOAST_URL_PREFIX}${encodeURIComponent(action)}?c=${encodeURIComponent(context)}&s=${toastSignature(action, context, secret)}`;
}

export function parseToastUrl(raw: string, secret: string): { action: string; context: string } | null {
  if (raw.length > MAX_URL_LENGTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'bulwark:' || url.hostname !== 'toast') return null;
  let action: string;
  try {
    action = decodeURIComponent(url.pathname.slice(1));
  } catch {
    return null;
  }
  const context = url.searchParams.get('c') ?? '';
  const given = Buffer.from(url.searchParams.get('s') ?? '');
  const wanted = Buffer.from(toastSignature(action, context, secret));
  if (!action || given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null;
  return { action, context };
}

/** A typed reply: only Windows' activator can carry the text. Survives a restart, so it's all in here. */
export function toastArguments(action: string, context: string): string {
  return `${TOAST_ARGS_PREFIX}${encodeURIComponent(action)}:${encodeURIComponent(context)}`;
}

export function parseToastArguments(args: string): { action: string; context: string } | null {
  if (!args.startsWith(TOAST_ARGS_PREFIX)) return null;
  const rest = args.slice(TOAST_ARGS_PREFIX.length);
  const split = rest.indexOf(':');
  if (split < 1) return null;
  try {
    return { action: decodeURIComponent(rest.slice(0, split)), context: decodeURIComponent(rest.slice(split + 1)) };
  } catch {
    return null;
  }
}

export interface ToastContent {
  title: string;
  body: string;
  silent: boolean;
  context: string;
  actions: { id: string; label: string }[];
  reply?: { label: string; placeholder: string };
}

/**
 * The Windows toast. Electron's own `actions` only know a button's index, which is
 * nothing to go on after a restart.
 *
 * Buttons are protocol activations, because that also works when the app isn't running:
 * Electron's activator only answers once this process has shown a toast, and COM gave up on
 * a cold start here (decisions, OS integration).
 *
 * The click and typed text go through the activator when it's known to answer:
 * `activatorAnswers`, after this process has shown a toast. Windows lets only the activator
 * take the foreground from the notification shell; a process started for a protocol link
 * gets no such right, so a click by protocol leaves the window behind. Otherwise the click is
 * a protocol link and Reply a button that opens the composer, so nothing typed can be lost.
 */
export function buildToastXml(toast: ToastContent, secret: string, activatorAnswers: boolean): string {
  let reply = '';
  if (toast.reply && activatorAnswers) {
    reply = `<input id="${REPLY_INPUT}" type="text" placeHolderContent="${xml(toast.reply.placeholder)}"/><action content="${xml(toast.reply.label)}" hint-inputId="${REPLY_INPUT}" activationType="foreground" arguments="${xml(toastArguments('reply', toast.context))}"/>`;
  } else if (toast.reply) {
    reply = `<action content="${xml(toast.reply.label)}" activationType="protocol" arguments="${xml(toastUrl('reply', toast.context, secret))}"/>`;
  }
  const buttons = toast.actions
    .slice(0, toast.reply ? 4 : 5)
    .map((action) => `<action content="${xml(action.label)}" activationType="protocol" arguments="${xml(toastUrl(action.id, toast.context, secret))}"/>`)
    .join('');
  const actions = reply || buttons ? `<actions>${reply}${buttons}</actions>` : '';
  const audio = toast.silent ? '<audio silent="true"/>' : '';
  const body = toast.body ? `<text>${xml(toast.body)}</text>` : '';
  const launch = activatorAnswers
    ? `launch="${xml(toastArguments('open', toast.context))}" activationType="foreground"`
    : `launch="${xml(toastUrl('open', toast.context, secret))}" activationType="protocol"`;
  return `<toast ${launch}><visual><binding template="ToastGeneric"><text>${xml(toast.title)}</text>${body}</binding></visual>${actions}${audio}</toast>`;
}

export const WINDOWS_APP_NAME = 'Bulwark';
/** The installed app's, on its Start menu shortcut (electron-builder.yml appId). */
export const APP_USER_MODEL_ID = 'org.bulwarkmail.desktop';
/**
 * A test build's. Windows keeps one jump list, taskbar group and notification list per ID:
 * with the installed app's, a test run's jump list, pointing at its own electron.exe, would
 * replace the user's.
 */
export const TEST_APP_USER_MODEL_ID = 'org.bulwarkmail.desktop.test';

export function appUserModelId(testBuild: boolean): string {
  return testBuild ? TEST_APP_USER_MODEL_ID : APP_USER_MODEL_ID;
}

/** What put a Windows copy of the app where it is. A folder no installer made has neither mark. */
export type WindowsInstaller = 'nsis' | 'msi' | 'none';

/** The file the MSI puts next to the exe (scripts/msi-project.cjs). An NSIS install has its uninstaller there. */
export const MSI_MARKER_FILE = 'installed-by-msi.ini';

/** `exeName` without `.exe`: electron-builder names the NSIS uninstaller after the executable. */
export function windowsInstallerOf(exists: (name: string) => boolean, exeName: string): WindowsInstaller {
  if (exists(`Uninstall ${exeName}.exe`)) return 'nsis';
  if (exists(MSI_MARKER_FILE)) return 'msi';
  return 'none';
}

/**
 * Whether this copy may write itself into the user's OS: mail links, file types, Default apps,
 * Open with, Send to, start at login, the installed app's toast activator and jump list. Only a
 * production build an installer put there. A test build, a test pack (scripts/pack-test.mjs: a
 * test build, or one with its profile baked in) and a folder nobody installed (`electron-builder
 * --dir`'s win-unpacked, a copy of it) would point the user's registration at an exe that goes
 * away again. A development test run may still write to a stand-in key of its own
 * (os-default-app.ts).
 */
export function registersWithOs(facts: { platform: NodeJS.Platform; testBuild: boolean; bakedProfile: boolean; installer: WindowsInstaller }): boolean {
  if (facts.testBuild || facts.bakedProfile) return false;
  return facts.platform !== 'win32' || facts.installer !== 'none';
}

export const WINDOWS_CAPABILITIES = 'Software\\Bulwark\\Capabilities';

export interface RegistryValue {
  key: string;
  /** Absent: the key's default value. */
  name?: string;
  data: string;
}

const CLASSES = 'Software\\Classes';

/** `--` ends Chromium's switches, so nothing in a link or a file name can pass for one. */
function windowsOpenCommand(exe: string): string {
  return `"${exe}" -- "%1"`;
}

/**
 * Electron's own call writes `"exe" "%1"`, with no terminator. On Windows the registration in
 * os-default-app.ts writes the scheme, along with everything else it offers.
 */
export function electronRegistersScheme(platform: NodeJS.Platform, packaged: boolean): boolean {
  return packaged && platform !== 'win32';
}

/** A handled URL scheme or file type, in the class it's registered as. */
function progId(id: string, description: string, exe: string, url: boolean): RegistryValue[] {
  const key = `${CLASSES}\\${id}`;
  return [
    { key, data: description },
    ...(url ? [{ key, name: 'URL Protocol', data: '' }] : []),
    { key: `${key}\\DefaultIcon`, data: `${exe},0` },
    { key: `${key}\\shell\\open\\command`, data: windowsOpenCommand(exe) },
  ];
}

export const WINDOWS_URLS: Record<string, string> = { mailto: 'Bulwark.Url.mailto', webcal: 'Bulwark.Url.webcal', webcals: 'Bulwark.Url.webcal' };
export const WINDOWS_FILES: Record<string, string> = { '.eml': 'Bulwark.File.eml', '.ics': 'Bulwark.File.ics', '.vcf': 'Bulwark.File.vcf' };

/**
 * Under HKCU, so no elevation. This only offers Bulwark: which app is the default
 * stays the user's choice in Settings, which reads RegisteredApplications.
 */
export function windowsRegistration(exe: string): RegistryValue[] {
  const caps = WINDOWS_CAPABILITIES;
  return [
    { key: caps, name: 'ApplicationName', data: WINDOWS_APP_NAME },
    { key: caps, name: 'ApplicationDescription', data: 'Mail, calendar and contacts' },
    { key: caps, name: 'ApplicationIcon', data: `${exe},0` },
    ...Object.entries(WINDOWS_URLS).map(([scheme, id]) => ({ key: `${caps}\\UrlAssociations`, name: scheme, data: id })),
    ...Object.entries(WINDOWS_FILES).map(([ext, id]) => ({ key: `${caps}\\FileAssociations`, name: ext, data: id })),
    { key: 'Software\\RegisteredApplications', name: WINDOWS_APP_NAME, data: caps },
    ...progId(WINDOWS_URLS.mailto, 'URL:MailTo Protocol', exe, true),
    ...progId(WINDOWS_URLS.webcal, 'URL:Webcal Protocol', exe, true),
    ...progId('bulwark', 'URL:Bulwark Protocol', exe, true),
    ...progId(WINDOWS_FILES['.eml'], 'E-mail message', exe, false),
    ...progId(WINDOWS_FILES['.ics'], 'Calendar file', exe, false),
    ...progId(WINDOWS_FILES['.vcf'], 'Contact card', exe, false),
    // Lets "Open with" offer Bulwark before anyone sets a default.
    ...Object.entries(WINDOWS_FILES).map(([ext, id]) => ({ key: `${CLASSES}\\${ext}\\OpenWithProgids`, name: id, data: '' })),
  ];
}

/**
 * An uninstall takes the keys, and a reinstall to the same path must still put them back. Only the
 * exact command counts: the right exe with another command line is something else's registration,
 * and the rest of what the app offers may never have been written. `command` is the command key's
 * default value, null when there's none (or it isn't text).
 */
export function needsRegistration(command: string | null, exe: string): boolean {
  if (command === null) return true;
  return command.trim().toLowerCase() !== windowsOpenCommand(exe).toLowerCase();
}

/** How long a failed main window waits before it tries again. */
export function reloadDelayMs(attempt: number): number {
  return [2000, 5000, 15_000, 30_000, 60_000][Math.min(attempt, 4)];
}

/** Network errors: worth another try. -3 is a navigation that was replaced; -200 and on are certificates. */
export function isRetryableLoadError(code: number): boolean {
  return code !== -3 && code < 0 && code > -200;
}

/** Keys taken away again, deepest first. The `.eml` keys belong to everyone: only our value goes. */
export function windowsRegistrationKeys(exeName = 'Bulwark.exe'): { keys: string[]; values: { key: string; name: string }[] } {
  const openWith = windowsOpenWithKeys(exeName);
  return {
    keys: [...new Set(Object.values(WINDOWS_URLS)), ...Object.values(WINDOWS_FILES), 'bulwark'].map((id) => `${CLASSES}\\${id}`).concat('Software\\Bulwark', ...openWith.keys),
    values: [
      { key: 'Software\\RegisteredApplications', name: WINDOWS_APP_NAME },
      ...Object.entries(WINDOWS_FILES).map(([ext, id]) => ({ key: `${CLASSES}\\${ext}\\OpenWithProgids`, name: id })),
      ...openWith.values,
    ],
  };
}

/** The class "Open with" names for documents and pictures. Never anyone's default: only listed. */
export const WINDOWS_ATTACH_PROGID = 'Bulwark.File.attach';

/**
 * Where Bulwark shows up in Explorer's "Open with" by itself. Common documents and pictures:
 * what people send. Any other file reaches it through "Choose another app", by the
 * Applications key. build/installer.nsh lists the same extensions to remove them again.
 */
export const OPEN_WITH_EXTENSIONS = [
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp', '.rtf', '.txt', '.csv',
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.bmp', '.tif', '.tiff', '.svg', '.zip',
] as const;

/** The name the "Send to" entry has in Explorer, and of its shortcut in the SendTo folder. */
export const SEND_TO_NAME = 'Bulwark (as attachment)';

/**
 * "Open with" for documents and pictures, and Bulwark in "Choose another app" for any file.
 * Under HKCU, no elevation, and nothing here makes Bulwark the default for a type: a class in
 * OpenWithProgids is only offered. The OpenWithEnabled policy takes all of it away.
 */
export function windowsOpenWithRegistration(exe: string): RegistryValue[] {
  const exeName = path.win32.basename(exe);
  const app = `${CLASSES}\\Applications\\${exeName}`;
  return [
    ...progId(WINDOWS_ATTACH_PROGID, 'File to send with Bulwark', exe, false),
    { key: `${CLASSES}\\${WINDOWS_ATTACH_PROGID}`, name: 'FriendlyTypeName', data: 'File to send with Bulwark' },
    ...OPEN_WITH_EXTENSIONS.map((ext) => ({ key: `${CLASSES}\\${ext}\\OpenWithProgids`, name: WINDOWS_ATTACH_PROGID, data: '' })),
    { key: app, name: 'FriendlyAppName', data: WINDOWS_APP_NAME },
    { key: `${app}\\DefaultIcon`, data: `${exe},0` },
    { key: `${app}\\shell\\open\\command`, data: windowsOpenCommand(exe) },
  ];
}

export function windowsOpenWithKeys(exeName: string): { keys: string[]; values: { key: string; name: string }[] } {
  return {
    keys: [`${CLASSES}\\${WINDOWS_ATTACH_PROGID}`, `${CLASSES}\\Applications\\${exeName}`],
    values: OPEN_WITH_EXTENSIONS.map((ext) => ({ key: `${CLASSES}\\${ext}\\OpenWithProgids`, name: WINDOWS_ATTACH_PROGID })),
  };
}

/** Whether the Open with keys are this exe's, by the attach class's command. */
export function needsOpenWithRegistration(attachCommand: string | null, exe: string): boolean {
  return needsRegistration(attachCommand, exe);
}

/** The Send to shortcut: the app, then the marker, then `--`. Explorer adds the files after it. */
export function sendToShortcut(exe: string): { target: string; args: string; description: string; icon: string; iconIndex: number } {
  return { target: exe, args: `${SEND_TO_FLAG} --`, description: 'Attach to a new message in Bulwark', icon: exe, iconIndex: 0 };
}

/** A shortcut that's ours and points at this exe with these arguments needs no writing. */
export function sendToShortcutCurrent(found: { target?: string; args?: string } | null, exe: string): boolean {
  if (!found) return false;
  const wanted = sendToShortcut(exe);
  return (found.target ?? '').toLowerCase() === wanted.target.toLowerCase() && (found.args ?? '').trim() === wanted.args;
}

/**
 * Whether a shortcut of that name is ours, by the flag on its command line. Every copy of the app
 * and the installer write it (build/installer.nsh), and no other program has a use for it. One
 * of another program that happens to have the name isn't ours to change or take away.
 */
export function isOurSendToShortcut(found: { target?: string; args?: string } | null): boolean {
  return !!found && (found.args ?? '').trim().split(/\s+/).includes(SEND_TO_FLAG);
}

/**
 * What a start does with the Send to shortcut. Ours naming another exe, or one that's gone (a
 * test pack's, an older install's), is pointed at this one. A missing one comes back only with
 * the keys, when they were missing or named another exe: that was another copy's registration.
 * One the user deleted while the keys stayed stays deleted.
 */
export function sendToShortcutAction(found: { target?: string; args?: string } | null, exe: string, keysRewritten: boolean): 'none' | 'create' | 'replace' {
  if (!found) return keysRewritten ? 'create' : 'none';
  if (!isOurSendToShortcut(found) || sendToShortcutCurrent(found, exe)) return 'none';
  return 'replace';
}

/** The autostart entry where the OS has no login item API. */
export function linuxAutostartEntry(exec: string): string {
  return `[Desktop Entry]\nType=Application\nName=Bulwark\nExec=${exec} ${LOGIN_FLAG}\nIcon=bulwark\nX-GNOME-Autostart-enabled=true\nHidden=false\nNoDisplay=false\n`;
}
