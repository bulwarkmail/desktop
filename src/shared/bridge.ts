/**
 * The bridge contract: the shell's copy of lib/desktop/types.ts in the webmail.
 * Add a member in both places together. A breaking change bumps
 * BRIDGE_VERSION; adding a member doesn't.
 */

import type { PolicySnapshot } from './policy-schema';

export const BRIDGE_VERSION = 1;

export type WindowType = 'main' | 'message' | 'composer' | 'settings';

export interface WindowInfo {
  id: number;
  type: WindowType;
  title: string;
  /** What the page calls the window in the Window menu (`windows.setMenuName`), if it said. */
  menuName?: string;
  focused: boolean;
  /** False for a main window hidden while pop-outs are open. */
  visible?: boolean;
}

export type Mode = 'standalone' | 'instance';

export type ServerPrepareResult =
  | { ok: true; approved: boolean }
  | { ok: false; reason: 'declined' | 'invalid' | 'policy' };

/** Standalone: a mail server's own OAuth. Instance: the instance's own login page. */
export type BrowserSignInRequest = { kind: 'oauth'; serverUrl: string } | { kind: 'instance' };

export type BrowserSignInBegin =
  | { ok: true; flowId: string; redirectUri: string; state: string }
  | { ok: false; error: string };

export type BrowserSignInResult =
  | { ok: true; code: string; state: string; iss?: string }
  | { ok: false; error: string };

/** The server has no OAuth: a page main serves. See src/main/browser-sign-in.ts. */
export type PasswordSignInStart = { ok: true; host: string } | { ok: false; error: string };

export type PasswordSignInAttempt =
  | { ok: true; username: string; password: string; totp?: string }
  | { ok: false; error: string };

export type PasswordSignInAnswer =
  | { ok: true }
  | { ok: false; error: 'invalid_credentials' | 'totp_required' | 'other' };

/**
 * What `auth.claim()` hands out, once per document, in the page's first render: a
 * same-origin frame can reach the parent's bridge, and main can't tell its calls apart.
 */
export interface BrowserSignInControls {
  begin: (request: BrowserSignInRequest) => Promise<BrowserSignInBegin>;
  complete: (flowId: string, url: string) => Promise<BrowserSignInResult>;
  useScheme: (flowId: string) => Promise<string | null>;
  cancel: (flowId: string) => void;
  beginPassword: (flowId: string) => Promise<PasswordSignInStart>;
  nextPassword: (flowId: string) => Promise<PasswordSignInAttempt>;
  answerPassword: (flowId: string, answer: PasswordSignInAnswer) => void;
  outcome: (flowId: string) => Promise<BrowserSignInResult>;
  /**
   * Instance mode: a plugin's OAuth request whose redirect_uri is the instance's plugin
   * callback, in a window on the app's session. Only from a click. False when it isn't one
   * (the page opens it as a link then).
   */
  pluginSignIn: (url: string) => Promise<boolean>;
}

export type PluginInstallResult =
  | { ok: true; id: string; version: string }
  | { ok: false; error: string; code?: string };

export interface ThemeColours {
  dark: boolean;
  background: string;
  foreground?: string;
}

export interface SystemTheme {
  dark: boolean;
  highContrast: boolean;
  /** The OS accent colour as #rrggbb, where the OS has one and tells. */
  accent?: string;
}

export type UpdateChannel = 'stable' | 'beta';

/** `install`: replaces itself. `notify`: an MSI, deb, rpm or unsigned macOS, says a version exists. `none`: a development run. */
export type UpdateAbility = 'install' | 'notify' | 'none';

export interface UpdateState {
  /** The running version. */
  version: string;
  channel: UpdateChannel;
  /** Set by the `UpdateChannel` policy. */
  channelLocked: boolean;
  /** False when the `AutoUpdate` policy turned updates off. */
  allowed: boolean;
  ability: UpdateAbility;
  /** Windows, and not the per-user installer: an MSI, whose updates come the way it did. */
  perMachine: boolean;
  /**
   * `available`: a newer version, for `notify` installs. `older-available`: on stable, with
   * a beta running, and the newest stable is older than it. `off`: the policy.
   */
  status: 'idle' | 'checking' | 'up-to-date' | 'downloading' | 'ready' | 'available' | 'older-available' | 'error' | 'off';
  /** The version the status is about. */
  target?: string;
  percent?: number;
}

export interface PolicyBridge {
  /** What's in force now. Synchronous: a page can read it in its first render. */
  get: () => PolicySnapshot;
  onChange: (listener: (snapshot: PolicySnapshot) => void) => () => void;
}

export type MenuState = Record<string, boolean | { enabled?: boolean; checked?: boolean }>;

export type OsUnlockKind = 'hello' | 'touchid';

export interface AppLockStatus {
  locked: boolean;
  enrolled: boolean;
  /**
   * The yes-or-no unlock in front of a key in the OS's storage: Touch ID on macOS. Windows Hello
   * isn't this any more but `hello` below, so it's never 'hello' from this shell.
   */
  os: OsUnlockKind | null;
  osEnrolled: boolean;
  /** The OS has a real key store, so `wrap` and `unwrap` work. False: secrets on this machine are only obfuscated. */
  wrap: boolean;
  /**
   * Windows Hello's key credential, a second way to the lock key (`helloEnroll`, `helloSign`).
   * `available`: Windows can show the prompt here. `allowed`: the AppLockHelloAllowed policy.
   * `enrolled`: this profile has a key credential. Absent off Windows and on an older shell.
   */
  hello?: { available: boolean; allowed: boolean; enrolled: boolean };
}

/** A signature from the lock's Hello key credential, or why there's none. */
export type HelloAnswer =
  | { ok: true; signature: Uint8Array }
  | { ok: false; reason: 'cancelled' | 'busy' | 'unavailable' | 'missing' | 'unsupported' | 'policy' | 'not-locked' | 'failed' };

/** What a page's wipe asks of main. `account` null: everything on this device. */
export interface LocalWipeRequest {
  reason: 'remote' | 'settings';
  account: string | null;
}

/** A PIN guess through main. Blocked: too many wrong ones. No secret: this profile lost it, or the OS won't open it. */
export type PinStepAnswer = { ok: true; bytes: Uint8Array } | { ok: false; blockedUntil?: number };

export type OsUnlockAnswer =
  | { ok: true; key: Uint8Array }
  | { ok: false; reason: 'unavailable' | 'denied' | 'failed' | 'not-locked' };

/** A native menu built by the page: an HTML menu read back, so the two can't drift. */
export interface NativeMenuItem {
  /** Handed back when this item is chosen. Left out of separators and submenus. */
  id?: string;
  label?: string;
  type?: 'normal' | 'separator' | 'checkbox' | 'radio';
  enabled?: boolean;
  checked?: boolean;
  /** The key the page answers for this item ("D", "Shift+I", "Ctrl+X"). Only shown, never registered. */
  accelerator?: string;
  submenu?: NativeMenuItem[];
}

/** One name in the strip that stands in for a menu bar in a window with no native frame. */
export interface MenuBarEntry {
  id: string;
  label: string;
  /** The letter that opens it with Alt, lower case. */
  mnemonic?: string;
}

export interface MenuBarEvent {
  /** The bar has the keys: Alt was pressed. With `pinned` it shows either way. */
  visible: boolean;
  /** Open this menu right away: Alt plus its letter. */
  open?: string;
  /** "Always show the menu bar". */
  pinned?: boolean;
}

/** One line of a menu the page draws as the menu bar's. */
export interface MenuBarItem {
  /** Its place in the app menu: handed back with its text when it's picked. */
  key: string;
  /** The line's command id (`message.reply`), or `role.<role>`: the page draws its icon by it. */
  id?: string;
  label: string;
  type: 'normal' | 'checkbox' | 'radio' | 'separator' | 'submenu';
  enabled: boolean;
  checked?: boolean;
  /** As Electron writes it: `CmdOrCtrl+N`. */
  accelerator?: string;
  /** Where in `label` the letter for it is. */
  mnemonic?: number;
  items?: MenuBarItem[];
}

export interface MenuBarMenu extends MenuBarEntry {
  items: MenuBarItem[];
}

/** What the page's bar takes now: its height in CSS pixels (0 when gone), and whether it has the keys. */
export interface MenuBarReport {
  height: number;
  active: boolean;
}

/** What a page says when asked to save before a window goes. */
export interface FlushAnswer {
  /** Drafts it couldn't save. */
  failed?: number;
  timedOut?: boolean;
  /** Mail waiting to be sent. It goes out at the next start. */
  unsent?: number;
}

export interface ConfirmOptions {
  message: string;
  detail?: string;
  /** Button labels, the safe choice last. */
  buttons: string[];
  /** The button Enter takes. */
  defaultId?: number;
  type?: 'none' | 'info' | 'warning' | 'question';
}

/**
 * A short question drawn by the shell in a window of its own, looking like the app's
 * in-page dialog. Everything in it is plain text: the dialog page sets textContent only.
 */
export interface DialogWindowRequest {
  /** The page's own name for it, for `dialogs.cancel`. */
  id: string;
  title: string;
  /** The text under the title, in runs; `bold` runs are drawn bold. */
  message?: { text: string; bold?: boolean }[];
  /** "From the plugin …": who is asking, when it isn't the app. Drawn under the title. */
  source?: string;
  /** A warning sign beside the title, as the page's destructive confirm has. */
  icon?: 'warning' | 'error';
  /** In the order they stand, start to end. `link`: a row of a choice (the shell's own questions only). */
  buttons: { label: string; variant?: 'primary' | 'secondary' | 'destructive' | 'link' }[];
  /** A checkbox on the footer's start; the answer says whether it was ticked (the shell's own questions only). */
  checkbox?: { label: string; checked?: boolean };
  /** The button Enter takes and the focus starts on. */
  defaultIndex?: number;
  /** The ⋮ menu at the top end: a plugin's options. */
  menu?: { label: string; items: { id: string; label: string; destructive?: boolean }[] };
  theme?: DialogWindowTheme;
  lang?: string;
  dir?: 'ltr' | 'rtl';
}

/** The page's look, read from its CSS: colours as #rrggbb[aa] or rgb(a)(). */
export interface DialogWindowTheme {
  dark?: boolean;
  colours?: Partial<Record<DialogWindowColour, string>>;
  font?: string;
  /** px. */
  fontSize?: number;
  /** px, the card's corners; buttons get radiusSmall. */
  radius?: number;
  radiusSmall?: number;
}

export type DialogWindowColour =
  | 'background'
  | 'foreground'
  | 'muted'
  | 'mutedForeground'
  | 'border'
  | 'input'
  | 'primary'
  | 'primaryForeground'
  | 'destructive'
  | 'destructiveForeground'
  | 'accent'
  | 'accentForeground'
  | 'ring';

/** A button by its index, a menu item by its id. Null: closed without an answer (Escape, Alt+F4, the page went). */
export type DialogWindowAnswer = { button: number; checked?: boolean } | { menu: string } | null;

/**
 * What to show in the shell's print preview (src/main/print-preview.ts): this page as its
 * print CSS lays it out, a print window this page opened as `window.open('', name)` with a
 * name `bulwark-print-…` (main keeps it hidden), or a PDF's bytes.
 */
export type PrintPreviewRequest = (
  | { source: 'page' }
  | { source: 'window'; name: string }
  | { source: 'pdf'; data: Uint8Array }
) & {
  /** For the file name of Save as PDF and the header line. */
  title?: string;
  /** The page's look, as for dialogs.show. */
  theme?: DialogWindowTheme;
};

/** `refused`: printing is off, or there was nothing to show. `busy`: a preview is open over that window. */
export type PrintPreviewOutcome = 'printed' | 'saved' | 'system' | 'cancelled' | 'refused' | 'busy' | 'failed';

export interface LanguagesUpdate {
  /** The interface language. The shell's menus follow it too. */
  ui: string;
  /** What the composer's text is in, if it says. */
  composer?: string[];
  /** The shell's menu and dialog text in that language, by the keys of `src/main/strings.ts`. */
  labels?: Record<string, string>;
}
export type KeystoreHash = 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512';

export interface KeystoreCertificate {
  /** Opaque: the only ids sign, decrypt and agree accept. */
  id: string;
  /** The leaf, DER. */
  certificate: Uint8Array;
  /** Intermediates, DER, without leaf and root. May be empty. */
  chain: Uint8Array[];
  subject: string;
  issuer: string;
  /** Hex. */
  serial: string;
  /** Milliseconds since 1970. */
  notBefore: number;
  notAfter: number;
  /** keyUsage names. Empty without the extension. */
  usages: string[];
  /** extendedKeyUsage OIDs. Empty without the extension. */
  extendedUsages: string[];
  /** The key's algorithm OID. */
  algorithm: string;
  keyType: 'rsa' | 'ec';
  curve?: 'P-256' | 'P-384' | 'P-521';
  keyBits: number;
  /** A hint for the UI. */
  source: 'software' | 'smartcard' | 'keychain' | 'unknown';
  signSchemes: string[];
  decryptSchemes: string[];
  canAgree: boolean;
  /** The key can also sign the user in somewhere: the user is asked per use. */
  askEachUse: boolean;
}

/** Whether this origin may use the keystore at all. `app` is standalone. */
export type KeystoreAccessState = 'app' | 'policy' | 'stored' | 'off';

export type KeystoreSignScheme =
  | { scheme: 'rsa-pkcs1'; hash: KeystoreHash }
  /** MGF1 on the same hash, salt as long as the hash. */
  | { scheme: 'rsa-pss'; hash: KeystoreHash }
  /** `hash` names the digest's length. */
  | { scheme: 'ecdsa'; hash: KeystoreHash };

export type KeystoreDecryptScheme =
  | { scheme: 'rsa-pkcs1' }
  /** MGF1 on the same hash. */
  | { scheme: 'rsa-oaep'; hash: KeystoreHash; label?: Uint8Array };

/** `quiet`: answer from what's already allowed, with keystore:ask-first in place of a dialog. */
export interface KeystoreUseOptions {
  quiet?: boolean;
}

/** How main answers a keystore call. The preload turns a failure into `new Error(code)`. */
export type KeystoreResult<T> = { ok: true; value: T } | { ok: false; code: string };

export interface SessionUrls {
  apiUrl?: string;
  downloadUrl?: string;
  uploadUrl?: string;
  eventSourceUrl?: string;
}

export type LocalImportKind = 'mbox' | 'maildir' | 'pst';

/** Something a scan found. The handle is all the page can ask for it by. */
export interface LocalImportCandidate {
  handle: string;
  app: 'thunderbird' | 'outlook';
  kind: LocalImportKind;
  /** The Thunderbird profile's name, or "Outlook". */
  group: string;
  account?: string;
  /** Where the mail goes: `Archives.sbd/2020` is ["Archives", "2020"]. Empty for a PST, which has its own. */
  folder: string[];
  name: string;
  size: number;
  lastModified: number;
  /** Maildir only. */
  messages?: number;
}

export interface LocalImportBook {
  handle: string;
  group: string;
  name: string;
  contacts: number;
}

export type LocalImportScanResult =
  | {
      ok: true;
      candidates: LocalImportCandidate[];
      books: LocalImportBook[];
      /** Seen and not offered. */
      refused: { name: string; reason: 'ost' | 'in-use' }[];
      /** Thunderbird calendars seen, which aren't read. */
      calendars: number;
      thunderbirdRunning: boolean;
      /** The search took too long and was stopped: this is what it found until then. */
      incomplete?: boolean;
    }
  | { ok: false; reason: 'declined' | 'busy' | 'failed' };

/** A file the user confirmed. `url` takes Range requests; a Maildir's messages are at `url/<position>`. */
export interface LocalImportFile {
  url: string;
  name: string;
  kind: LocalImportKind;
  folder: string[];
  size: number;
  lastModified: number;
  entrySizes?: number[];
}

export type LocalImportGrantResult =
  | {
      ok: true;
      jobId: string;
      files: LocalImportFile[];
      /** Contacts of the confirmed address books, as vCard text. */
      contacts: string[];
      /** Names that couldn't be read after all. */
      refused: string[];
      thunderbirdRunning: boolean;
    }
  | { ok: false; reason: 'declined' | 'busy' | 'invalid'; refused?: string[] };

export type LocalImportResumeResult =
  | Extract<LocalImportGrantResult, { ok: true }>
  /** `in-use`: none can be read right now, which may pass, so the job stays. `invalid`: they're gone, and so is the job. */
  | { ok: false; reason: 'later' | 'stopped' | 'busy' | 'invalid' | 'in-use' | 'unknown'; refused?: string[] };

export interface OsSettings {
  /** Closing the main window leaves the app running in the tray. */
  closeToTray: boolean;
  startAtLogin: boolean;
  /** At login: no window, only the tray. */
  startMinimized: boolean;
  /** Taskbar flash or dock bounce on new mail. */
  attentionOnNewMail: boolean;
  quietHoursEnabled: boolean;
  /** HH:MM, local time. */
  quietHoursStart: string;
  quietHoursEnd: string;
  /** "Show Bulwark", an Electron accelerator. Null: off. */
  showShortcut: string | null;
  /** Quick compose, an Electron accelerator. Null: off. Unset: nobody chose, so the policy's or the built-in one. */
  quickComposeShortcut?: string | null;
}

export interface QuickComposeStatus {
  /** What's in force after policy and the user's choice. Null: off. */
  shortcut: string | null;
  /** Really held. False with a shortcut: another app has it. */
  active: boolean;
  /** Set by the `QuickComposeShortcut` policy. */
  locked: boolean;
  /** What turning it on again gives. */
  builtIn: string | null;
}

export interface OsStatus {
  settings: OsSettings;
  pausedUntil: number | null;
  /** The shortcut in settings is really held. Another app can have it. */
  shortcutActive: boolean;
  quickCompose?: QuickComposeStatus;
}

export interface OsFile {
  name: string;
  data: Uint8Array;
}

/** What the OS asks the app to do: a tray item, a jump list entry, a toast, a double-clicked file. */
export type OsCommand =
  /** `params`: a bulwark://new link's parameters for a plugin of the page (main/deep-link.ts). */
  | { type: 'new-message'; params?: Record<string, string> }
  /** `settings/files_sync`: Settings > Files on this computer, from the drive's status in Explorer. */
  | { type: 'navigate'; target: 'inbox' | 'calendar' | 'contacts' | 'settings/files_sync' }
  | { type: 'open-message'; emailId: string; accountId?: string; context?: string }
  | { type: 'open-mailbox'; mailboxId: string }
  | { type: 'mailto'; url: string }
  | { type: 'webcal'; url: string }
  /** `ask`: opened with the app, so the user picks between a new message and Files. Without it, attach. */
  | { type: 'files'; reason: 'open' | 'attach'; files: OsFile[]; failed: string[]; ask?: boolean }
  | { type: 'notification'; action: string; context: string; reply?: string }
  /** The tray's "Pause syncing" and "Resume syncing": every drive and synced folder. Older pages ignore it. */
  | { type: 'files-sync'; action: 'pause-all' | 'resume-all' };

/**
 * File > Save as… and the message's own "Save as…": the page names the files, main asks
 * where (the OS's Save dialog for one, a folder for several, starting in the folder used
 * last), and the page then hands over each file's bytes. Only messages so far: each is
 * written as an .eml, whatever the name says.
 */
export interface SaveAsRequest {
  kind: 'message';
  /** One per file, in the order the bytes come. A name only: main makes it safe. */
  names: string[];
}

/** `id` for `write` and `end`. Refused: no click or menu pick just before, the organisation's policy, the app lock. */
export type SaveAsBegin = { id: string } | { cancelled: true } | { refused: 'gesture' | 'policy' | 'locked' | 'invalid' };

export interface SaveAsResult {
  saved: number;
  failed: number;
}

/** The page's `os.onCommand` options. `messageFileWindows`: it opens an .eml in a window of its own. */
export interface OsCommandOptions {
  messageFileWindows?: boolean;
}

export interface OsNotification {
  /** Tag of the toast. Showing an id again within a few minutes does nothing. */
  id: string;
  group?: string;
  title: string;
  body: string;
  /** Handed back with the action. Keep it short: Windows keeps it in the toast. */
  context: string;
  actions?: { id: string; label: string }[];
  reply?: { label: string; placeholder: string };
  /** The user wants a sound with this. */
  sound?: boolean;
  /** New mail: flash the taskbar or bounce the dock if that's on. */
  attention?: boolean;
  /**
   * What a locked app says instead: new mail unless this says otherwise. `undo`: the answer
   * to the user's own click (a discarded draft's Undo), shown past pause, quiet hours and focus.
   */
  kind?: 'mail' | 'reminder' | 'undo';
}

export interface OsNotifyResult {
  shown: boolean;
  reason?: 'duplicate' | 'paused' | 'quiet-hours' | 'focused' | 'unsupported' | 'invalid' | 'failed';
  /** The page should play the sound the user picked. */
  playSound: boolean;
}

export interface OsTrayMessage {
  emailId: string;
  accountId: string;
  sender: string;
  subject: string;
  context?: string;
}

export interface OsSummary {
  unread: OsTrayMessage[];
  /** Newest conversations, whether read or not, for the jump list. */
  recent: OsTrayMessage[];
  nextEvent: { title: string; when: string } | null;
  /** The account `unread` is from, when more than one is signed in. */
  account?: string;
}

export type OsPowerEvent = 'suspend' | 'resume' | 'lock-screen' | 'unlock-screen';

export interface OsDefaultAppStatus {
  /** Offered to the OS as a mail app. */
  registered: boolean;
  mailto: boolean;
  webcal: boolean;
}

export interface PrivacyState {
  telemetry: { on: boolean; forcedOff: boolean };
  crashReports: { on: boolean; forcedOff: boolean; uploadUrl: string };
}

export interface CrashFileInfo {
  id: string;
  createdAt: number;
  bytes: number;
}

export type CrashSendResult =
  | { ok: true }
  | { ok: false; reason: 'no-consent' | 'no-url' | 'not-found' | 'cancelled' | 'failed' };

/** `forcedOff`: the DeveloperToolsAvailability policy says no. `locked`: the app lock is on, so nothing changes. */
export interface DevToolsState {
  on: boolean;
  forcedOff: boolean;
  locked: boolean;
}

/** One of the user's recently used files, as the Attach menu shows it. Nothing more of it reaches the page. */
export interface RecentFile {
  /** Opaque. `attach` takes it, from the window that listed it, until that window lists again. */
  id: string;
  name: string;
  /** The folder it's in, for display. */
  folder: string;
  /** The whole path, for a tooltip. */
  path: string;
  /** When it was last used, in milliseconds since 1970. */
  usedAt: number;
  /** Its size in bytes, so the page can grey out one larger than the server takes. */
  size?: number;
  /** A small icon as a data: URL, when the OS gave one in time. */
  icon?: string;
}

/** `gesture`: no click or key press just now. `policy`: RecentFilesInAttach is off. */
export type RecentFilesResult =
  | { ok: true; files: RecentFile[] }
  | { ok: false; reason: 'policy' | 'locked' | 'gesture' };

export type RecentFileAttachResult =
  | { ok: true; file: OsFile }
  | { ok: false; reason: 'policy' | 'locked' | 'gesture' | 'unknown' | 'missing' | 'too-large' | 'failed' };

/** An attachment copied to a private folder and open in its default program. */
export interface EditSession {
  id: string;
  name: string;
  type: string;
  /** The local account it belongs to. */
  account: string;
  /** What the page said it came from. Main only keeps it. */
  source: string;
  /** Saved differently from what the page last took. */
  changed: boolean;
  /** Goes up with each save. */
  version: number;
  /** What the file holds now: a chip holding this version has nothing to update. */
  hash: string;
  /** A composer has it and offers the update itself. */
  claimed: boolean;
  /** Wanted gone, and another program has it open. */
  held: boolean;
  /** Saved under a new name in that program. */
  savedAs: boolean;
  /** Not used for 30 days: this offer is the last. */
  lastChance: boolean;
}

/** What couldn't be deleted because another program has it open, by file name. `refused`: nothing happened. */
export interface EditClearResult {
  held: string[];
  refused?: boolean;
}

export interface EditFile {
  /** One session per key: Edit on the same attachment opens the same file. */
  key: string;
  name: string;
  type: string;
  data: Uint8Array;
  account: string;
  source: string;
}

export type EditBeginResult =
  /** One click, one ticket, for that key. A session for it exists: reopen this one. */
  | { ok: true; ticket: string; open?: string }
  | { ok: false; reason: 'locked' | 'gesture' };

export type EditOpenResult =
  | { ok: true; id: string }
  | { ok: false; reason: 'locked' | 'ticket' | 'type' | 'too-large' | 'full' | 'no-app' | 'failed' };

export type EditReadResult =
  | { ok: true; name: string; type: string; data: Uint8Array; hash: string }
  | { ok: false; reason: 'locked' | 'missing' | 'busy' | 'too-large' };

/*
 * Files on this computer: folders kept the same as a Files folder, and on Windows the
 * Files drive (Cloud Files API placeholders). The sync engine is the page's
 * (lib/files-sync in the webmail): it holds the JMAP session and decides. Main only does
 * what the page can't: the disk, the folder picker, the OS's sync root, and the
 * callbacks Windows makes when someone opens a file that isn't on the disk yet.
 *
 * Paths here are always relative to a root, with `/` between parts, never `..`, never
 * absolute. Main resolves them inside the root and refuses anything that leaves it,
 * through a link or otherwise.
 */

/** A place on this computer kept the same as Files: a folder the user picked, or the drive. */
export interface FilesRoot {
  /** Main's id for it. Random, never a path. */
  id: string;
  kind: 'folder' | 'drive';
  /** The page's local account id it belongs to. */
  account: string;
  /** Where it is on disk, to show and nothing else. */
  path: string;
  /** A folder: the Files folder it pairs with (null: the top of Files). The drive: null. */
  remoteId: string | null;
  /** What the page called the Files side when it was added, to show. */
  remoteLabel: string;
  paused: boolean;
  createdAt: number;
}

/** One file or folder under a root, as it is on disk now. */
export interface FilesLocalEntry {
  /** Relative to the root, `/` between parts. */
  path: string;
  kind: 'file' | 'directory';
  size: number;
  mtimeMs: number;
  /** The same across a rename on the same volume (file id, inode), to tell a move from a delete and a create. */
  fileId: string;
  /** The drive only: what the placeholder says. */
  placeholder?: FilesPlaceholderState;
}

export interface FilesPlaceholderState {
  /** The FileNode id written into it. Null for something made in Explorer that isn't a placeholder yet. */
  identity: string | null;
  /** Main or the page marked it in sync and nobody changed it since. */
  inSync: boolean;
  /** The content is on this disk. */
  hydrated: boolean;
  pin: 'pinned' | 'unpinned' | 'unspecified';
}

/** What the page expects a path to be, so main refuses to act on something that changed meanwhile. */
export interface FilesExpect {
  fileId: string;
  size: number;
  mtimeMs: number;
}

export type FilesError =
  /** Not there. */
  | 'missing'
  /** Something is already at the target. */
  | 'exists'
  /** It changed since the page looked (`expect` didn't match). */
  | 'changed'
  /** Another program has it open. */
  | 'busy'
  | 'denied'
  /** The path leaves the root, or goes through a link. */
  | 'outside'
  /** A name this file system can't hold. */
  | 'name'
  /** The disk is full. */
  | 'full'
  /** The organisation's policy says no. */
  | 'policy'
  /** No real click came with a call that needs one. */
  | 'gesture'
  /** The user closed the picker. */
  | 'cancelled'
  /** The folder is inside another root, holds one, or is a system folder. */
  | 'overlap'
  /** The root is paused, gone, or the app is locked. */
  | 'inactive'
  | 'unsupported'
  | 'failed';

export type FilesResult<T> = { ok: true; value: T } | { ok: false; error: FilesError };

/** Something on disk under a root changed. `paths: null`: too much at once, scan it all. */
export interface FilesChangeEvent {
  rootId: string;
  paths: string[] | null;
}

/** Windows wants bytes of a file that isn't on the disk yet: someone opened it. */
export interface FilesFetchRequest {
  fetchId: string;
  rootId: string;
  /** The FileNode id in the placeholder. */
  identity: string;
  path: string;
  /** What Windows asked for. Supplying from 0 to the end is always fine. */
  offset: number;
  length: number;
  /** The size in the placeholder. */
  total: number;
}

/** A remote file or folder the drive should show, before any content is fetched. */
export interface FilesPlaceholder {
  path: string;
  kind: 'file' | 'directory';
  size: number;
  mtimeMs: number;
  identity: string;
}

export interface FilesDriveLetterState {
  /** In use now. */
  letter: string | null;
  /** The user's own choice, kept even while a policy overrides it. */
  chosen: string | null;
  /** `FilesDriveLetter` forces it (a letter, or `none`). */
  locked: boolean;
  /** Letters free now, D to Z. */
  available: string[];
}

export interface FilesDriveState {
  /** Windows 10 1809 or later with the helper loaded. */
  supported: boolean;
  /** `FilesDriveEnabled` is off. */
  forcedOff: boolean;
  /** Accounts the user turned the drive on for, whether or not it's registered right now. */
  wanted: string[];
  letter: FilesDriveLetterState;
}

/**
 * What Explorer shows for the drive on Windows 11, where OneDrive shows its own: the sync
 * state and the storage used. The page's engine knows both, and says them in its language.
 */
export interface FilesDriveStatus {
  state: 'synced' | 'syncing' | 'paused' | 'offline' | 'error';
  /** Short, next to the state: "Up to date", "Syncing". */
  label: string;
  /** The line under it: "Syncing: 3 done, 5 to go", "Stopped: The disk is full". */
  detail: string;
  /** From the server's Quota/get. `total` null: no limit, only what's used. Null: nothing known. */
  quota: { used: number; total: number | null; label: string } | null;
  /** Storage nearly full or full, in words. */
  notice: string | null;
  /** The tray menu's line: "Bulwark Files: Up to date", "Bulwark Files: Offline. Waiting: 3". Absent from older pages. */
  tray?: string;
}

/**
 * What the main page takes once, in its first render (`files.claim()`), like `auth.claim`:
 * a same-origin frame reaches the bridge through `parent`, and main can't tell its calls
 * apart. Main also takes these calls only from the main window.
 */
export interface FilesControls {
  roots: () => Promise<FilesRoot[]>;
  /**
   * Shows the OS folder picker. Needs a real click, unless `chosen` names a folder the user
   * already picked with `chooseFolder`: then it's added without another picker.
   */
  addFolder: (request: { account: string; remoteId: string | null; remoteLabel: string; chosen?: string }) => Promise<FilesResult<FilesRoot>>;
  /**
   * The folder on this computer first, as OneDrive asks (settings-p3-4): shows the OS picker
   * (needs a real click) and answers a token for `addFolder` and the folder's name, to offer a
   * Files folder of the same name. Absent in older shells.
   */
  chooseFolder?: () => Promise<FilesResult<{ token: string; name: string }>>;
  /** A folder: forgotten, its files stay. The drive: as `drive.disable(account, 'user')`. */
  removeRoot: (rootId: string) => Promise<void>;
  setPaused: (rootId: string, paused: boolean) => Promise<void>;
  /** Everything under `under` (default: the whole root). Skips links and main's own temporary files. */
  scan: (rootId: string, under?: string) => Promise<FilesResult<FilesLocalEntry[]>>;
  stat: (rootId: string, path: string) => Promise<FilesResult<FilesLocalEntry | null>>;
  /** A URL the page fetches once for the file's bytes (Range works). Refused for a drive file that isn't on the disk. */
  openRead: (rootId: string, path: string) => Promise<FilesResult<{ url: string; entry: FilesLocalEntry }>>;
  /**
   * Writing a file: chunks go to a temporary file next to it, `commitWrite` puts it in place
   * if what's there is still `expect` (null: nothing may be there), and sets `mtimeMs`.
   */
  beginWrite: (rootId: string, path: string, options: { expect: FilesExpect | null; mtimeMs: number; size: number }) => Promise<FilesResult<string>>;
  writeChunk: (writeId: string, data: Uint8Array) => Promise<FilesResult<null>>;
  commitWrite: (writeId: string) => Promise<FilesResult<FilesLocalEntry>>;
  abortWrite: (writeId: string) => Promise<void>;
  mkdir: (rootId: string, path: string) => Promise<FilesResult<FilesLocalEntry>>;
  /** Never overwrites. A case-only rename works on a case-insensitive disk. */
  move: (rootId: string, from: string, to: string, expect: FilesExpect | null) => Promise<FilesResult<FilesLocalEntry>>;
  /** A folder: to the OS's trash where it has one. Refused when it changed since `expect`. */
  remove: (rootId: string, path: string, expect: FilesExpect | null) => Promise<FilesResult<'trash' | 'deleted'>>;
  onChange: (listener: (event: FilesChangeEvent) => void) => () => void;
  /** The engine's own record of a root (what both sides looked like at the last sync). */
  loadState: (rootId: string) => Promise<string | null>;
  saveState: (rootId: string, state: string) => Promise<void>;
  /** Opens Explorer, Finder or the file manager on it. */
  showInFolder: (rootId: string, path: string) => Promise<boolean>;
  /** Windows only. Absent elsewhere. */
  drive?: FilesDriveControls;
}

export interface FilesDriveControls {
  state: () => Promise<FilesDriveState>;
  onStateChange: (listener: (state: FilesDriveState) => void) => () => void;
  /**
   * Registers and connects the account's sync root. Needs a real click unless the user
   * turned it on before (a sign-in brings it back). `label` is the address, shown when
   * there are several accounts.
   */
  enable: (account: string, label: string) => Promise<FilesResult<FilesRoot>>;
  /**
   * `user`: turned off. `signed-out`: the account signed out, and comes back at the next
   * sign-in, pins included. Both unregister the sync root and delete its folder, after
   * copying what wasn't uploaded to `Documents\Bulwark – not uploaded\<date>` (`rescued`).
   * `suspended`: a sign-out nobody chose; only disconnects, the folder stays. `wipe` and
   * `refused` delete everything, nothing is copied.
   */
  disable: (account: string, reason: 'user' | 'signed-out' | 'suspended' | 'wipe' | 'refused') => Promise<FilesDriveDisableResult | void>;
  /**
   * Main is about to remove the drives of these accounts (the policy): say `working` at once,
   * upload what waits, then `flushed` without a phase. A page that says nothing within a few
   * seconds isn't waited for.
   */
  onFlush?: (listener: (request: { requestId: string; accounts: string[] }) => void) => () => void;
  flushed?: (requestId: string, phase?: 'working') => void;
  /** Opens the folder files that weren't uploaded went to last. False when there's none. */
  openRescue?: () => Promise<boolean>;
  /**
   * "Always keep on this device" (`pinned`) and "Free up space" (`unpinned`) from the app, as
   * Explorer's own menu sets them: the content comes or goes the same way. Absent in older shells.
   */
  setPin?: (rootId: string, path: string, pin: 'pinned' | 'unpinned') => Promise<FilesResult<null>>;
  /** New placeholders, parents first. One answer per entry. */
  place: (rootId: string, entries: FilesPlaceholder[]) => Promise<FilesResult<{ path: string; error?: FilesError }[]>>;
  /**
   * New metadata from the server for a placeholder that is in sync. `dehydrate`: the
   * content changed, drop the copy on disk (a pinned one is fetched again). Refused
   * with `changed` when someone edited it here meanwhile.
   */
  update: (rootId: string, path: string, meta: { size: number; mtimeMs: number; identity: string; dehydrate: boolean }, expect: FilesExpect | null) => Promise<FilesResult<FilesLocalEntry>>;
  /** After an upload: makes it a placeholder with this identity if it isn't one, and marks it in sync. */
  markInSync: (rootId: string, path: string, identity: string, expect: FilesExpect) => Promise<FilesResult<FilesLocalEntry>>;
  onFetch: (listener: (request: FilesFetchRequest) => void) => () => void;
  onFetchCancel: (listener: (fetchId: string) => void) => () => void;
  /** Bytes for a fetch, in order from `offset`. False when Windows no longer wants them. */
  supply: (fetchId: string, offset: number, data: Uint8Array) => Promise<boolean>;
  fail: (fetchId: string, error: 'offline' | 'missing' | 'failed') => void;
  setLetter: (letter: string | null) => Promise<FilesResult<FilesDriveLetterState>>;
  /** What Explorer shows for the account's drive. Absent in shells before it. */
  status?: (account: string, status: FilesDriveStatus) => void;
}

export interface FilesBridge {
  claim: () => FilesControls | null;
}

/** What turning the drive off did with the files that weren't uploaded. */
export interface FilesDriveDisableResult {
  rescued: { folder: string; count: number; failed: number } | null;
}

/** IPC channels, all checked against the sender's origin in main (ipc.ts). */
export const CHANNEL = {
  windowsOpen: 'bulwark:windows.open',
  windowsOpenMessage: 'bulwark:windows.openMessage',
  windowsOpenComposer: 'bulwark:windows.openComposer',
  windowsFocus: 'bulwark:windows.focus',
  windowsList: 'bulwark:windows.list',
  windowsChanged: 'bulwark:windows.changed',
  themeSet: 'bulwark:theme.set',
  themeSystem: 'bulwark:theme.system',
  themeGetSystem: 'bulwark:theme.getSystem',
  windowsCloseSelf: 'bulwark:windows.closeSelf',
  windowsSetRestore: 'bulwark:windows.setRestore',
  windowsSetRestoreEnabled: 'bulwark:windows.setRestoreEnabled',
  windowsSetMenuName: 'bulwark:windows.setMenuName',
  windowsSessionReady: 'bulwark:windows.sessionReady',
  windowsSessionEnded: 'bulwark:windows.sessionEnded',
  windowsSpareReady: 'bulwark:windows.spareReady',
  windowsSpareActivate: 'bulwark:windows.spareActivate',
  windowsSpareTaken: 'bulwark:windows.spareTaken',
  /** Main to the preload: the user chose Leave, go where the page was going (windows.ts). */
  windowsLeave: 'bulwark:windows.leave',
  menuSetState: 'bulwark:menu.setState',
  menuCommand: 'bulwark:menu.command',
  menuPopup: 'bulwark:menu.popup',
  menuBarEntries: 'bulwark:menu.barEntries',
  menuBarOpen: 'bulwark:menu.barOpen',
  menuBarEvent: 'bulwark:menu.barEvent',
  menuBarMenus: 'bulwark:menu.barMenus',
  menuBarRun: 'bulwark:menu.barRun',
  menuBarReport: 'bulwark:menu.barReport',
  menuBarSetPinned: 'bulwark:menu.barSetPinned',
  menuChangeConnection: 'bulwark:menu.changeConnection',
  shellOpenExternal: 'bulwark:shell.openExternal',
  shellSetLanguages: 'bulwark:shell.setLanguages',
  dialogsConfirm: 'bulwark:dialogs.confirm',
  dialogsShow: 'bulwark:dialogs.show',
  dialogsCancel: 'bulwark:dialogs.cancel',
  dialogsShowWindow: 'bulwark:dialogs.showWindow',
  /** The dialog window's own page: what to draw, its size, the answer. */
  dialogWindowSpec: 'bulwark:dialog-window.spec',
  dialogWindowReady: 'bulwark:dialog-window.ready',
  dialogWindowAnswer: 'bulwark:dialog-window.answer',
  printPreview: 'bulwark:print.preview',
  printListen: 'bulwark:print.listen',
  printRequested: 'bulwark:print.requested',
  /** The print preview's own page: what to draw, a render, the user's choice. */
  printWindowSpec: 'bulwark:print-window.spec',
  printWindowChoices: 'bulwark:print-window.choices',
  printWindowRender: 'bulwark:print-window.render',
  printWindowReady: 'bulwark:print-window.ready',
  printWindowRun: 'bulwark:print-window.run',
  clipboardCopyFile: 'bulwark:clipboard.copyFile',
  clipboardClearFiles: 'bulwark:clipboard.clearFiles',
  spellMissing: 'bulwark:spell.missing',
  spellListMissing: 'bulwark:spell.listMissing',
  spellAllowDownload: 'bulwark:spell.allowDownload',
  serversPrepare: 'bulwark:servers.prepare',
  serversNoteSession: 'bulwark:servers.noteSession',
  serversForget: 'bulwark:servers.forget',
  lifecycleRegister: 'bulwark:lifecycle.register',
  lifecycleFlush: 'bulwark:lifecycle.flush',
  lifecycleFlushed: 'bulwark:lifecycle.flushed',
  authBegin: 'bulwark:auth.begin',
  authComplete: 'bulwark:auth.complete',
  authCancel: 'bulwark:auth.cancel',
  authUseScheme: 'bulwark:auth.useScheme',
  authPasswordBegin: 'bulwark:auth.password.begin',
  authPasswordNext: 'bulwark:auth.password.next',
  authPasswordAnswer: 'bulwark:auth.password.answer',
  authPasswordOutcome: 'bulwark:auth.password.outcome',
  authPluginSignIn: 'bulwark:auth.pluginSignIn',
  pluginsInstall: 'bulwark:plugins.install',
  osSubscribe: 'bulwark:os.subscribe',
  osCommand: 'bulwark:os.command',
  osGetStatus: 'bulwark:os.getStatus',
  osSetSettings: 'bulwark:os.setSettings',
  osSetPaused: 'bulwark:os.setPaused',
  osStatusChanged: 'bulwark:os.statusChanged',
  osSetBadge: 'bulwark:os.setBadge',
  osSetSummary: 'bulwark:os.setSummary',
  osSetProgress: 'bulwark:os.setProgress',
  osSetLocked: 'bulwark:os.setLocked',
  osClearSurfaces: 'bulwark:os.clearSurfaces',
  osNotify: 'bulwark:os.notify',
  osPower: 'bulwark:os.power',
  osStartDrag: 'bulwark:os.startDrag',
  osCopyFiles: 'bulwark:os.copyFiles',
  osDefaultAppStatus: 'bulwark:os.defaultAppStatus',
  osDefaultAppOpen: 'bulwark:os.defaultAppOpen',
  saveAsBegin: 'bulwark:saveAs.begin',
  saveAsWrite: 'bulwark:saveAs.write',
  saveAsEnd: 'bulwark:saveAs.end',
  editBegin: 'bulwark:edit.begin',
  editOpen: 'bulwark:edit.open',
  editReopen: 'bulwark:edit.reopen',
  editList: 'bulwark:edit.list',
  editSettle: 'bulwark:edit.settle',
  editRead: 'bulwark:edit.read',
  editTaken: 'bulwark:edit.taken',
  editRelease: 'bulwark:edit.release',
  editDiscard: 'bulwark:edit.discard',
  editForceDiscard: 'bulwark:edit.forceDiscard',
  editAskClear: 'bulwark:edit.askClear',
  editClear: 'bulwark:edit.clear',
  editWipe: 'bulwark:edit.wipe',
  editShown: 'bulwark:edit.shown',
  editSetSource: 'bulwark:edit.setSource',
  editClaim: 'bulwark:edit.claim',
  editChanged: 'bulwark:edit.changed',
  welcomeChoose: 'bulwark:welcome.choose',
  appLockStatus: 'bulwark:appLock.status',
  appLockLock: 'bulwark:appLock.lock',
  appLockEnroll: 'bulwark:appLock.enroll',
  appLockProve: 'bulwark:appLock.prove',
  appLockDisable: 'bulwark:appLock.disable',
  appLockForget: 'bulwark:appLock.forget',
  appLockClearOrphan: 'bulwark:appLock.clearOrphan',
  appLockOsEnroll: 'bulwark:appLock.osEnroll',
  appLockOsRemove: 'bulwark:appLock.osRemove',
  appLockOsUnlock: 'bulwark:appLock.osUnlock',
  appLockHelloEnroll: 'bulwark:appLock.helloEnroll',
  appLockHelloSign: 'bulwark:appLock.helloSign',
  appLockHelloCancel: 'bulwark:appLock.helloCancel',
  appLockHelloRemove: 'bulwark:appLock.helloRemove',
  appLockWrap: 'bulwark:appLock.wrap',
  appLockPinStep: 'bulwark:appLock.pinStep',
  appLockReplaceRenderer: 'bulwark:appLock.replaceRenderer',
  appLockScreenLock: 'bulwark:appLock.screenLock',
  httpCacheClear: 'bulwark:httpCache.clear',
  localWipeRun: 'bulwark:localWipe.run',
  localWipeFinish: 'bulwark:localWipe.finish',
  appLockUnwrap: 'bulwark:appLock.unwrap',
  appLockRequest: 'bulwark:appLock.request',
  updatesState: 'bulwark:updates.state',
  updatesCheck: 'bulwark:updates.check',
  updatesSetChannel: 'bulwark:updates.setChannel',
  updatesRestart: 'bulwark:updates.restart',
  updatesOpenDownload: 'bulwark:updates.openDownload',
  updatesInstallOlder: 'bulwark:updates.installOlder',
  updatesChanged: 'bulwark:updates.changed',
  policyGet: 'bulwark:policy.get',
  policyChanged: 'bulwark:policy.changed',
  privacyGet: 'bulwark:privacy.get',
  privacySetTelemetry: 'bulwark:privacy.setTelemetry',
  privacySetCrashReports: 'bulwark:privacy.setCrashReports',
  privacySetCrashUploadUrl: 'bulwark:privacy.setCrashUploadUrl',
  privacyListCrashes: 'bulwark:privacy.listCrashes',
  privacySendCrash: 'bulwark:privacy.sendCrash',
  privacyDeleteCrashes: 'bulwark:privacy.deleteCrashes',
  privacyChanged: 'bulwark:privacy.changed',
  welcomePrivacy: 'bulwark:welcome.privacy',
  welcomeOpenLink: 'bulwark:welcome.openLink',
  welcomeFit: 'bulwark:welcome.fit',
  keystoreList: 'bulwark:keystore.list',
  keystoreSign: 'bulwark:keystore.sign',
  keystoreDecrypt: 'bulwark:keystore.decrypt',
  keystoreAgree: 'bulwark:keystore.agree',
  keystoreAccess: 'bulwark:keystore.access',
  keystoreRevoke: 'bulwark:keystore.revoke',
  keystoreClearGrants: 'bulwark:keystore.clearGrants',
  certificatesClearChoices: 'bulwark:certificates.clearChoices',
  certificatesSetAccount: 'bulwark:certificates.setAccount',
  certificatesConnectionsReset: 'bulwark:certificates.connectionsReset',
  localImportScan: 'bulwark:localImport.scan',
  localImportGrant: 'bulwark:localImport.grant',
  localImportResume: 'bulwark:localImport.resume',
  localImportRelease: 'bulwark:localImport.release',
  localImportReleaseAll: 'bulwark:localImport.releaseAll',
  devToolsGet: 'bulwark:devTools.get',
  devToolsSet: 'bulwark:devTools.set',
  devToolsChanged: 'bulwark:devTools.changed',
  filesRoots: 'bulwark:files.roots',
  filesAddFolder: 'bulwark:files.addFolder',
  filesChooseFolder: 'bulwark:files.chooseFolder',
  filesRemoveRoot: 'bulwark:files.removeRoot',
  filesSetPaused: 'bulwark:files.setPaused',
  filesScan: 'bulwark:files.scan',
  filesStat: 'bulwark:files.stat',
  filesOpenRead: 'bulwark:files.openRead',
  filesBeginWrite: 'bulwark:files.beginWrite',
  filesWriteChunk: 'bulwark:files.writeChunk',
  filesCommitWrite: 'bulwark:files.commitWrite',
  filesAbortWrite: 'bulwark:files.abortWrite',
  filesMkdir: 'bulwark:files.mkdir',
  filesMove: 'bulwark:files.move',
  filesRemove: 'bulwark:files.remove',
  filesChanged: 'bulwark:files.changed',
  filesLoadState: 'bulwark:files.loadState',
  filesSaveState: 'bulwark:files.saveState',
  filesShowInFolder: 'bulwark:files.showInFolder',
  filesDriveState: 'bulwark:files.drive.state',
  filesDriveStateChanged: 'bulwark:files.drive.stateChanged',
  filesDriveEnable: 'bulwark:files.drive.enable',
  filesDriveDisable: 'bulwark:files.drive.disable',
  filesDrivePlace: 'bulwark:files.drive.place',
  filesDriveUpdate: 'bulwark:files.drive.update',
  filesDriveMarkInSync: 'bulwark:files.drive.markInSync',
  filesDriveFetch: 'bulwark:files.drive.fetch',
  filesDriveFetchCancel: 'bulwark:files.drive.fetchCancel',
  filesDriveSupply: 'bulwark:files.drive.supply',
  filesDriveFail: 'bulwark:files.drive.fail',
  filesDriveSetLetter: 'bulwark:files.drive.setLetter',
  filesDriveStatus: 'bulwark:files.drive.status',
  filesDriveFlush: 'bulwark:files.drive.flush',
  filesDriveFlushed: 'bulwark:files.drive.flushed',
  filesDriveOpenRescue: 'bulwark:files.drive.openRescue',
  filesDriveSetPin: 'bulwark:files.drive.setPin',
  recentFilesList: 'bulwark:recentFiles.list',
  recentFilesAttach: 'bulwark:recentFiles.attach',
} as const;

/** What main passes to the preload through additionalArguments. */
export const PRELOAD_ARG = {
  allowedOrigin: '--bulwark-origin=',
  mode: '--bulwark-mode=',
  keystore: '--bulwark-keystore=',
} as const;
