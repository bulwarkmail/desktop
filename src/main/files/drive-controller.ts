/**
 * The Files drive on Windows: one Cloud Files sync root per account the user turned it on for,
 * in Explorer's navigation pane like OneDrive. The page's sync engine decides what's in it
 * (`place`, `update`, `markInSync`) and supplies a file's bytes when someone opens it
 * (drive-fetch.ts). This keeps the sync roots, their folders, the pins and the letter.
 *
 * - Turned on (`enable`): the first time for a server and account it needs a real click and
 *   the user's yes to main's own question, which names the server and the folder (`consent`).
 *   After that the wish is kept, and the page turns it on again after each sign-in without
 *   either. A no holds for a while. Never before a sign-in: at a start nothing registers or
 *   connects until the page asks. Turned off by the user, it asks again the next time.
 * - Turned off (`disable`): the sync root goes, with its folder. What was written here and isn't
 *   in Files yet is copied to `Documents\Bulwark – not uploaded\<date>` first (drive-rescue.ts);
 *   only a wipe deletes without that. `signed-out` keeps the wish and the pins, so the next
 *   sign-in brings both back. `suspended` (a sign-out nobody chose: the session ran out, the
 *   login was refused) only disconnects: the folder, its edits and its pins stay, and the next
 *   sign-in connects it again.
 * - `FilesDriveEnabled` off: the page gets a moment to upload what waits, then every sync root
 *   goes (rescued as above), and none comes back while it's off. The wishes stay.
 * - A wipe: every sync root of this profile, their folders, the letter and the wishes.
 * - "Always keep on this device" and "Free up space": the shell sets the pin attribute. A
 *   watcher sees it change, and this fetches the file or drops its content.
 *
 * Whatever runs, it only ever looks at sync roots this profile registered (`rootKey`): another
 * profile of the app (a second install, a test build, a development run) has its own, and they
 * stay as they are. A drive letter another profile's drive is on keeps its name too.
 *
 * No Electron here: features/files-drive.ts wires it to IPC, the policies and the wipe, and
 * plain Node tests drive it with the real helper.
 */

import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, watch, type BigIntStats, type FSWatcher } from 'node:fs';
import path from 'node:path';
import type {
  FilesDriveLetterState,
  FilesDriveState,
  FilesDriveStatus,
  FilesError,
  FilesExpect,
  FilesFetchRequest,
  FilesLocalEntry,
  FilesPlaceholder,
  FilesPlaceholderState,
  FilesResult,
  FilesRoot,
} from '../../shared/bridge';
import { filesErrorCode, type NativeFilesModule, type NativeSyncRoot } from '../native-loader';
import { FetchRelay, type FetchFailure } from './drive-fetch';
import { pinnedPaths, rescueFiles, unsyncedFiles, type PlaceholderInfo, type Rescued } from './drive-rescue';
import { settleLetter, type LetterSystem } from './drive-letter';
import { claimLetterLabel, releaseLetterLabel, type LetterLabelSystem } from './drive-letter-label';
import {
  accountKey,
  displayNameFor,
  entryFor,
  expectMatches,
  filesErrorOf,
  folderNameFor,
  freeLetters,
  inside,
  keyOfRoot,
  letterTarget,
  nativeStatusOf,
  profileKey,
  rootKey,
  trayLineOf,
  resolveUnder,
  statusClassId,
  syncRootPrefix,
  wantedLetter,
} from './drive-places';
import { splitRelative } from './paths';
import type { RegisteredRoot } from './registry';

export type DisableReason = 'user' | 'signed-out' | 'suspended' | 'wipe' | 'refused';
const REASONS: readonly string[] = ['user', 'signed-out', 'suspended', 'wipe', 'refused'];

/** What `disable` did with what wasn't uploaded. */
export interface DisableResult {
  rescued: Rescued | null;
}

export interface StoredDriveAccount {
  label: string;
  /** The folder's name under the drive's base folder. */
  folder: string;
  rootId: string;
  createdAt: number;
  /** The account part of its sync root's id. Absent: the account's key alone, as older versions registered it. */
  key?: string;
  /** Signed out: no sync root now, and the next sign-in brings it back. */
  signedOut?: boolean;
  /** Signed out without asking for it: registered, folder kept, not connected until the next sign-in. */
  suspended?: boolean;
  /** "Always keep on this device" from before a sign-out, put back as the page places these paths. */
  pins?: string[];
}

export interface StoredDrive {
  accounts?: Record<string, StoredDriveAccount>;
  /** The user's letter, kept while a policy overrides it. */
  letter?: string | null;
}

export interface DrivePolicy {
  /** `FilesDriveEnabled` is off (or unreadable, which counts as off). */
  forcedOff: boolean;
  /** `FilesDriveLetter`: null when not set, `none`, or a letter. */
  letter: string | null;
}

export interface DriveDeps {
  native: NativeFilesModule | null;
  /** Windows 10 1809 or later. */
  supported: boolean;
  provider: string;
  /** The folder the accounts' folders go in. */
  base: string;
  /** Tells profiles apart in the sync roots' ids. */
  profile: string;
  icon: string;
  version: string;
  store: { read(): StoredDrive; write(next: StoredDrive): void };
  policy: () => DrivePolicy;
  page: {
    /** True when the page was asked; else why it can't be. */
    fetch(request: FilesFetchRequest): FetchFailure | true;
    fetchCancelled(fetchId: string): void;
    stateChanged(state: FilesDriveState): void;
    /** Upload what waits in these accounts' drives, before the policy removes them. Resolves when done or given up. */
    flush?(accounts: string[]): Promise<void>;
  };
  registry: { add(entry: RegisteredRoot): void; remove(id: string): void };
  /** The page's record of a root whose folder went: a new folder must not look like everything was deleted. */
  forgetState?: (rootId: string) => Promise<void>;
  letters: LetterSystem | null;
  /** The letter's name and icon in "This PC" (drive-letter-label.ts). None: Windows names it. */
  letterLabels?: LetterLabelSystem | null;
  now?: () => number;
  warn?: (message: string) => void;
  /** Pin changes come through a watcher on each root. Off in tests that don't want it. */
  watchPins?: boolean;
  /**
   * Explorer's status for the drive (Windows 11): sync state and storage, from the page. Absent,
   * or a Windows without it: no status, the drive works the same.
   */
  status?: {
    /** A file: URL of the icon Explorer shows next to the state. Null: none could be made. */
    icon(): Promise<string | null>;
    /** The status line in Explorer was clicked. */
    opened(account: string): void;
  };
  /** What the tray shows of the drives changed (one on or off, a new status line). */
  summaryChanged?: () => void;
  /** How long a fetch waits for the page: drive-fetch.ts has the defaults. */
  fetchFirstAnswerMs?: number;
  fetchIdleMs?: number;
  /** Where files that weren't uploaded go (`Documents`). Absent: nowhere, and nothing is copied. */
  documents?: string;
  /** Files were copied there. `reason`: why the folder went (`policy` for FilesDriveEnabled). */
  rescued?: (rescued: Rescued, reason: DisableReason | 'policy' | 'start') => void;
  /** The pin attribute, as the shell sets it: the native helper's (NativeHelper.system.setPin). None: pins fail. */
  setPin?: (absolute: string, pin: 'pinned' | 'unpinned' | 'unspecified') => Promise<boolean>;
  /**
   * The user's yes to a drive for this server and an account, kept in the shell's state and
   * asked for in main's own question window (features/files-drive.ts). Absent: nobody is asked.
   */
  consent?: DriveConsent;
}

export interface DriveConsent {
  /** A yes for this account; with none, a yes for any account of this server. */
  has(account?: string): boolean;
  add(account: string): void;
  remove(account: string): void;
  clear(): void;
  /** True for yes. `folder` is where the account's folder is, or will be. */
  ask(account: string, label: string, folder: string): Promise<boolean>;
}

/** How long a no to the question holds for an account: the page can't ask again before. */
export const DRIVE_NO_HOLD_MS = 10 * 60_000;

/** Without the helper's call there's nothing that sets the attribute. */
const noPin = async (): Promise<boolean> => false;

interface Live {
  account: string;
  root: FilesRoot;
  dir: string;
  syncRootId: string;
  /** The account part of `syncRootId`. */
  key: string;
  connection: string;
  watcher: FSWatcher | null;
  /** Pins from before a sign-out still to put back, by path in the root. */
  pins: Set<string>;
}

const MAX_ACCOUNT = 200;
const MAX_LABEL = 320;
const MAX_PLACE = 20_000;
const NATIVE_BATCH = 1000;
const PIN_SETTLE_MS = 300;
const MAX_PIN_WALK = 50_000;

const ok = <T>(value: T): FilesResult<T> => ({ ok: true, value });
const fail = <T = never>(error: FilesError): FilesResult<T> => ({ ok: false, error });

function lstatOrNull(file: string): BigIntStats | null {
  try {
    return lstatSync(file, { bigint: true });
  } catch {
    return null;
  }
}

function validText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value);
}

export class DriveController {
  private readonly live = new Map<string, Live>();
  private readonly relay: FetchRelay;
  private queue: Promise<unknown> = Promise.resolve();
  private letterNow: string | null = null;
  private hydrating: Promise<void> = Promise.resolve();
  private readonly hydrateWanted = new Set<string>();
  private readonly pinTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly warn: (message: string) => void;
  private readonly now: () => number;
  /** What the page last said for Explorer, per account. */
  private readonly statuses = new Map<string, FilesDriveStatus>();
  /** Serving Explorer's status: null until tried, false where Windows has none or it failed. */
  private statusServed: boolean | null = null;
  /** Per account, until when a no to the question holds. */
  private readonly refusedUntil = new Map<string, number>();

  constructor(private readonly deps: DriveDeps) {
    this.warn = deps.warn ?? console.warn;
    this.now = deps.now ?? Date.now;
    this.relay = new FetchRelay({
      native: {
        filesDriveTransfer: (...args) => this.native().filesDriveTransfer(...args),
        filesDriveTransferFailed: (...args) => this.native().filesDriveTransferFailed(...args),
      },
      locate: (connection, absolutePath) => this.locate(connection, absolutePath),
      ask: (request) => deps.page.fetch(request),
      cancelled: (fetchId) => deps.page.fetchCancelled(fetchId),
      warn: this.warn,
      ...(deps.fetchFirstAnswerMs ? { firstAnswerMs: deps.fetchFirstAnswerMs } : {}),
      ...(deps.fetchIdleMs ? { idleMs: deps.fetchIdleMs } : {}),
    });
  }

  get available(): boolean {
    return this.deps.supported && this.deps.native !== null;
  }

  /** Some account's drive is connected now. */
  get running(): boolean {
    return this.live.size > 0;
  }

  // ─── State ───────────────────────────────────────────────────

  state(): FilesDriveState {
    const stored = this.deps.store.read();
    const policy = this.deps.policy();
    return {
      supported: this.available,
      forcedOff: policy.forcedOff,
      wanted: Object.keys(stored.accounts ?? {}),
      letter: this.letterState(),
    };
  }

  private letterState(): FilesDriveLetterState {
    const policy = this.deps.policy();
    const chosen = this.deps.store.read().letter ?? null;
    let available: string[] = [];
    if (this.deps.letters) {
      try {
        available = freeLetters(this.deps.letters.usedMask(), this.letterNow);
      } catch {
        available = [];
      }
    }
    return { letter: this.letterNow, chosen, locked: policy.letter !== null, available };
  }

  private emit(): void {
    try {
      this.deps.page.stateChanged(this.state());
    } catch (error) {
      this.warn(`Telling the page about the drive failed: ${(error as Error).message}`);
    }
    this.deps.summaryChanged?.();
  }

  /**
   * What the tray shows: per connected drive its state line in the page's words (when the page
   * sent one), and the folder "Open Bulwark Files" opens: the account's, or with several the
   * folder that holds them.
   */
  traySummary(): { lines: string[]; folder: string | null; paused: boolean } {
    const live = [...this.live.values()];
    // Every drive the page says is paused: the tray offers to resume.
    const paused = live.length > 0 && live.every((entry) => this.statuses.get(entry.account)?.state === 'paused');
    const lines = live.flatMap((entry) => {
      const line = trayLineOf(this.statuses.get(entry.account));
      if (!line) return [];
      return [live.length > 1 ? `${entry.root.remoteLabel}: ${line}` : line];
    });
    const folder = live.length === 1 ? live[0].dir : live.length > 1 ? this.base() : null;
    return { lines, folder, paused };
  }

  /** One change at a time: two enables of one account mustn't both register. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }

  private native(): NativeFilesModule {
    if (!this.deps.native) throw new Error('files:unsupported');
    return this.deps.native;
  }

  private writeAccounts(change: (accounts: Record<string, StoredDriveAccount>) => void): void {
    const stored = this.deps.store.read();
    const accounts = { ...(stored.accounts ?? {}) };
    change(accounts);
    this.deps.store.write({ ...stored, accounts });
  }

  // ─── Turning it on and off ───────────────────────────────────

  enable(account: unknown, label: unknown, gesture: () => boolean): Promise<FilesResult<FilesRoot>> {
    return this.serial(async () => {
      if (!this.available) return fail('unsupported');
      if (this.deps.policy().forcedOff) return fail('policy');
      if (!validText(account, MAX_ACCOUNT) || !validText(label, MAX_LABEL)) return fail('failed');
      const stored = this.deps.store.read().accounts?.[account];
      const { consent } = this.deps;
      // The first time takes a click, and the user's yes for this server. After that the wish
      // stands, and a sign-in brings it back.
      if (!stored || (consent && !consent.has(account))) {
        if (!gesture()) return fail('gesture');
        if (consent && !consent.has(account)) {
          if ((this.refusedUntil.get(account) ?? 0) > this.now()) return fail('cancelled');
          const folder = path.win32.join(this.base(), this.folderNameOf(account, label, stored));
          const yes = await consent.ask(account, label, folder).then((answer) => answer === true, () => false);
          if (!yes) {
            this.refusedUntil.set(account, this.now() + DRIVE_NO_HOLD_MS);
            return fail('cancelled');
          }
          consent.add(account);
          this.refusedUntil.delete(account);
          // Turned off while it asked.
          if (this.deps.policy().forcedOff) return fail('policy');
        }
      }
      const running = this.live.get(account);
      if (running) return ok(running.root);
      const result = await this.start(account, label, stored);
      if (result.ok) {
        await this.relabel();
        await this.applyLetter();
      }
      this.emit();
      return result;
    });
  }

  /** The name of an account's folder under the base: the one it has, or a new one for its label. */
  private folderNameOf(account: string, label: string, stored: StoredDriveAccount | undefined): string {
    const others = Object.entries(this.deps.store.read().accounts ?? {})
      .filter(([other]) => other !== account)
      .map(([, entry]) => entry.folder);
    return stored?.folder ?? folderNameFor(label, others);
  }

  private async start(account: string, label: string, stored: StoredDriveAccount | undefined): Promise<FilesResult<FilesRoot>> {
    const native = this.native();
    const { base } = this.deps;
    const folder = this.folderNameOf(account, label, stored);
    const dir = path.win32.join(base, folder);
    let real: string;
    try {
      mkdirSync(dir, { recursive: true });
      // A link here would put the drive somewhere else, and its deletion with it.
      if (lstatSync(base).isSymbolicLink() || lstatSync(dir).isSymbolicLink()) return fail('outside');
      real = realpathSync.native(dir);
      if (!inside(realpathSync.native(base), real)) return fail('outside');
    } catch (error) {
      this.warn(`The drive's folder couldn't be made: ${(error as Error).message}`);
      return fail('failed');
    }
    const key = this.keyOf(account, stored);
    const count = [...this.live.keys()].filter((other) => other !== account).length + 1;
    let syncRootId: string;
    try {
      syncRootId = await native.filesDriveRegister({
        provider: this.deps.provider,
        account: key,
        path: real,
        displayName: displayNameFor(label, count),
        icon: this.deps.icon,
        version: this.deps.version,
      });
    } catch (error) {
      this.warn(`Registering the drive failed: ${(error as Error).message}`);
      return fail(filesErrorOf(filesErrorCode(error)));
    }
    let connection: string;
    try {
      connection = native.filesDriveConnect(real, (event) => this.relay.onNative(event));
    } catch (error) {
      this.warn(`Connecting the drive failed: ${(error as Error).message}`);
      await native.filesDriveUnregister(syncRootId).catch(() => {});
      return fail(filesErrorOf(filesErrorCode(error)));
    }
    const root: FilesRoot = {
      id: stored?.rootId ?? randomBytes(16).toString('hex'),
      kind: 'drive',
      account,
      path: real,
      remoteId: null,
      remoteLabel: label,
      paused: false,
      createdAt: stored?.createdAt ?? this.now(),
    };
    const live: Live = { account, root, dir: real, syncRootId, key, connection, watcher: null, pins: new Set(stored?.pins ?? []) };
    this.live.set(account, live);
    this.deps.registry.add({
      root,
      dir: real,
      placeholderState: (absolute) => this.placeholderState(absolute),
      contentAbsent: (absolute) => this.contentAbsent(absolute),
    });
    this.writeAccounts((accounts) => {
      // Pins wait until the page has placed their paths again.
      accounts[account] = { label, folder, rootId: root.id, createdAt: root.createdAt, key, ...(live.pins.size > 0 ? { pins: [...live.pins] } : {}) };
    });
    if (this.deps.watchPins !== false) live.watcher = this.watchPins(live);
    return ok(root);
  }

  disable(account: unknown, reason: unknown): Promise<DisableResult> {
    return this.serial(async () => {
      if (typeof account !== 'string' || !REASONS.includes(reason as string)) return { rescued: null };
      const why = reason as DisableReason;
      if (why === 'suspended') {
        this.suspend(account);
        this.writeAccounts((accounts) => {
          const entry = accounts[account];
          if (entry) accounts[account] = { ...entry, suspended: true };
        });
        await this.applyLetter();
        this.emit();
        return { rescued: null };
      }
      // A wipe and a refusal delete: that's what they are for. Everything else keeps what wasn't uploaded.
      const keep = why === 'user' || why === 'signed-out';
      const pins = why === 'signed-out' ? this.pinsOf(account) : [];
      const rescued = await this.stop(account, true, keep ? why : null);
      this.writeAccounts((accounts) => {
        const entry = accounts[account];
        if (!entry) return;
        if (why === 'signed-out') {
          const { suspended: _suspended, ...rest } = entry;
          accounts[account] = { ...rest, signedOut: true, ...(pins.length > 0 ? { pins } : {}) };
        } else delete accounts[account];
      });
      // Gone for good: turning it on again asks again. A sign-out keeps the yes with the wish.
      if (why !== 'signed-out') this.deps.consent?.remove(account);
      await this.relabel();
      await this.applyLetter();
      this.emit();
      return { rescued };
    });
  }

  private placeholderInfo(): PlaceholderInfo {
    return (absolute) => {
      try {
        return this.native().filesDriveInfo(absolute);
      } catch {
        return null;
      }
    };
  }

  /** The folder an account's drive is in now, connected or not. */
  private folderOf(account: string): string | null {
    const live = this.live.get(account);
    if (live) return live.dir;
    const stored = this.deps.store.read().accounts?.[account];
    return stored ? path.win32.join(this.base(), stored.folder) : null;
  }

  /** What the user pinned, to put back after the next sign-in; with pins not placed again yet. */
  private pinsOf(account: string): string[] {
    const dir = this.folderOf(account);
    const now = dir ? pinnedPaths(dir, this.placeholderInfo()) : [];
    const waiting = this.live.get(account)?.pins ?? new Set(this.deps.store.read().accounts?.[account]?.pins ?? []);
    return [...new Set([...now, ...waiting])].slice(0, 5000);
  }

  /**
   * Files written here that aren't in Files, copied out of a folder that's about to go. Only a
   * process connected to the sync root sees placeholders as such (to any other, Windows shows
   * plain files), so a folder without a live drive is connected for this, with nobody to fetch.
   * Can't connect: `failed`, and the caller keeps the folder.
   */
  private async rescue(dir: string, reason: DisableReason | 'policy' | 'start'): Promise<Rescued | null> {
    if (!this.deps.documents || !this.deps.native) return null;
    const live = [...this.live.values()].some((entry) => entry.dir.toLowerCase() === dir.toLowerCase());
    let connection: string | null = null;
    if (!live) {
      const native = this.native();
      try {
        connection = native.filesDriveConnect(dir, (event) => {
          if (event.kind === 'fetch') native.filesDriveTransferFailed(event.connection, event.transferKey, event.requestKey, event.offset, event.length, 'not-running');
        });
      } catch (error) {
        this.warn(`Reading what wasn't uploaded failed: ${(error as Error).message}`);
        return { folder: '', count: 0, failed: 1 };
      }
    }
    let rescued: Rescued | null = null;
    try {
      rescued = await rescueFiles(dir, unsyncedFiles(dir, this.placeholderInfo()), this.deps.documents, new Date(this.now()));
    } catch (error) {
      this.warn(`Keeping the files that weren't uploaded failed: ${(error as Error).message}`);
      return { folder: '', count: 0, failed: 1 };
    } finally {
      if (connection) {
        try {
          this.native().filesDriveDisconnect(connection);
        } catch {
          // Going anyway.
        }
      }
    }
    if (rescued && rescued.count > 0) {
      try {
        this.deps.rescued?.(rescued, reason);
      } catch {
        // Telling about it is extra.
      }
    }
    return rescued;
  }

  /** A sign-out nobody chose: disconnected, still registered, the folder and its edits stay. */
  private suspend(account: string): void {
    const live = this.live.get(account);
    if (!live) return;
    this.live.delete(account);
    live.watcher?.close();
    this.relay.dropRoot(live.root.id);
    this.deps.registry.remove(live.root.id);
    this.statuses.delete(account);
    try {
      this.native().filesDriveStatusSet?.(live.syncRootId, undefined);
    } catch {
      // Not served: nothing to forget.
    }
    try {
      this.native().filesDriveDisconnect(live.connection);
    } catch (error) {
      this.warn(`Disconnecting the drive failed: ${(error as Error).message}`);
    }
    this.stopStatusWhenIdle();
  }

  /**
   * Disconnects, deletes the folder and unregisters. The wish is the caller's. `keep`: copy what
   * wasn't uploaded out first, and keep the folder if any of it couldn't be copied.
   */
  private async stop(account: string, removeFolder: boolean, keep: DisableReason | 'policy' | null = null): Promise<Rescued | null> {
    const live = this.live.get(account);
    const stored = this.deps.store.read().accounts?.[account];
    const key = live?.key ?? this.keyOf(account, stored);
    let dir: string | null = null;
    let rescued: Rescued | null = null;
    if (live) {
      // Read while connected: only then are placeholders told apart from files made here.
      if (removeFolder && keep) rescued = await this.rescue(live.dir, keep);
      this.live.delete(account);
      live.watcher?.close();
      this.relay.dropRoot(live.root.id);
      this.deps.registry.remove(live.root.id);
      try {
        this.native().filesDriveStatusSet?.(live.syncRootId, undefined);
      } catch {
        // Not served: nothing to forget.
      }
      try {
        this.native().filesDriveDisconnect(live.connection);
      } catch (error) {
        this.warn(`Disconnecting the drive failed: ${(error as Error).message}`);
      }
      dir = live.dir;
    } else if (stored) {
      dir = path.win32.join(this.base(), stored.folder);
      if (removeFolder && keep && lstatOrNull(dir)) rescued = await this.rescue(dir, keep);
    }
    // Something couldn't be copied: the folder stays, with it.
    if (rescued && rescued.failed > 0) removeFolder = false;
    // While still registered: Windows lets a placeholder go then without asking anyone.
    if (removeFolder && dir) this.removeFolder(dir);
    const rootId = live?.root.id ?? stored?.rootId;
    if (removeFolder && rootId) await this.deps.forgetState?.(rootId).catch(() => {});
    this.statuses.delete(account);
    // Unregistering takes the status class's value with the sync root's key.
    for (const root of await this.ourRoots()) {
      if (keyOfRoot(root.id) === key) await this.unregister(root);
    }
    if (removeFolder && dir) this.removeFolder(dir);
    this.stopStatusWhenIdle();
    return rescued;
  }

  /** The base folder as the disk names it: the roots' paths are resolved, so this must be too. */
  private base(): string {
    try {
      return realpathSync.native(this.deps.base);
    } catch {
      return this.deps.base;
    }
  }

  private removeFolder(dir: string): void {
    const base = this.base();
    if (!inside(base, dir) || path.win32.relative(base.toLowerCase(), dir.toLowerCase()) === '') return;
    const facts = lstatOrNull(dir);
    if (!facts) return;
    try {
      // A link is removed, never what it points to.
      rmSync(dir, { recursive: !facts.isSymbolicLink(), force: true, maxRetries: 3, retryDelay: 200 });
    } catch (error) {
      this.warn(`The drive's folder couldn't be removed: ${(error as Error).message}`);
    }
  }

  /**
   * The account part of an account's sync root id: the one it was stored with, the account's
   * key alone for an account stored before ids had the profile in them, and `rootKey` for one
   * that has none yet.
   */
  private keyOf(account: string, stored: StoredDriveAccount | undefined): string {
    if (!stored) return rootKey(this.deps.profile, account);
    return stored.key ?? accountKey(this.deps.profile, account);
  }

  /**
   * This user's sync roots that this profile registered: this provider's, with this profile's
   * key in the id, or with a key one of this profile's stored accounts has. Any other root,
   * another profile's or one nobody stored names, is never connected to, rescued or removed.
   */
  private async ourRoots(): Promise<NativeSyncRoot[]> {
    if (!this.deps.native) return [];
    try {
      const prefix = syncRootPrefix(this.deps.provider);
      const own = `${profileKey(this.deps.profile)}-`;
      const stored = new Set(Object.entries(this.deps.store.read().accounts ?? {}).map(([account, entry]) => this.keyOf(account, entry)));
      return (await this.deps.native.filesDriveRoots()).filter((root) => {
        if (!root.id.startsWith(prefix)) return false;
        const key = keyOfRoot(root.id);
        return key.startsWith(own) || stored.has(key);
      });
    } catch (error) {
      this.warn(`Listing the sync roots failed: ${(error as Error).message}`);
      return [];
    }
  }

  private async unregister(root: NativeSyncRoot): Promise<void> {
    try {
      await this.native().filesDriveUnregister(root.id);
    } catch (error) {
      this.warn(`Unregistering a sync root failed: ${(error as Error).message}`);
    }
  }

  /** "Bulwark Files" for one, "Bulwark Files - <address>" for each of several. Registering again renames. */
  private async relabel(): Promise<void> {
    const count = this.live.size;
    for (const live of this.live.values()) {
      try {
        await this.native().filesDriveRegister({
          provider: this.deps.provider,
          account: live.key,
          path: live.dir,
          displayName: displayNameFor(live.root.remoteLabel, count),
          icon: this.deps.icon,
          version: this.deps.version,
        });
      } catch (error) {
        this.warn(`Renaming the drive failed: ${(error as Error).message}`);
        continue;
      }
      // Registering writes the key anew: the status class goes back in each time.
      await this.attachStatus(live);
    }
  }

  /**
   * At a start, before any sign-in: sync roots of ours nobody wants any more go (a crash
   * between a sign-out and its cleanup, an account removed elsewhere), and so does all of it
   * when the policy says off. Wanted ones stay registered, unconnected, until the page asks,
   * and take this version's icon if they have another.
   */
  startUp(): Promise<void> {
    return this.serial(async () => {
      if (!this.available) return;
      await this.settleWithPolicy();
      await this.refreshIcons();
      await this.applyLetter();
      this.emit();
    });
  }

  /**
   * A root registered with another icon (the exe's, before the app had its own .ico, or an
   * install somewhere else) is registered again with this one. Registering updates it in
   * place, so the user's drive switches without being turned off and on.
   */
  private async refreshIcons(): Promise<void> {
    if (this.deps.policy().forcedOff) return;
    const labels = new Map<string, string>();
    for (const [account, entry] of Object.entries(this.deps.store.read().accounts ?? {})) {
      if (!entry.signedOut) labels.set(this.keyOf(account, entry), entry.label);
    }
    for (const root of await this.ourRoots()) {
      const key = keyOfRoot(root.id);
      const label = labels.get(key);
      // An older helper lists no icon: nothing to compare, so nothing changes.
      if (label === undefined || !root.path || typeof root.icon !== 'string') continue;
      if (root.icon.toLowerCase() === this.deps.icon.toLowerCase()) continue;
      try {
        await this.native().filesDriveRegister({
          provider: this.deps.provider,
          account: key,
          path: root.path,
          displayName: root.displayName || displayNameFor(label, labels.size),
          icon: this.deps.icon,
          version: this.deps.version,
        });
      } catch (error) {
        this.warn(`Updating the drive's icon failed: ${(error as Error).message}`);
      }
    }
  }

  /** `FilesDriveEnabled` or `FilesDriveLetter` changed. */
  policyChanged(): Promise<void> {
    return this.serial(async () => {
      if (!this.available) return;
      // Turned off: the page uploads what waits first, as far as it can in a short while.
      if (this.deps.policy().forcedOff && this.live.size > 0) await this.deps.page.flush?.([...this.live.keys()]).catch(() => {});
      await this.settleWithPolicy();
      await this.applyLetter();
      this.emit();
    });
  }

  private async settleWithPolicy(): Promise<void> {
    const forcedOff = this.deps.policy().forcedOff;
    const accounts = this.deps.store.read().accounts ?? {};
    const wanted = new Set(Object.entries(accounts).filter(([, entry]) => !forcedOff && !entry.signedOut).map(([account, entry]) => this.keyOf(account, entry)));
    if (forcedOff) {
      for (const account of [...this.live.keys()]) await this.stop(account, true, 'policy');
      for (const entry of Object.values(accounts)) await this.rescueAndRemove(path.win32.join(this.base(), entry.folder), 'policy');
    }
    for (const root of await this.ourRoots()) {
      const key = keyOfRoot(root.id);
      if (wanted.has(key)) continue;
      // Ours by id, but only a folder inside the drive's own is ever deleted.
      if (root.path) await this.rescueAndRemove(root.path, 'start');
      await this.unregister(root);
    }
    // Signed out: its folder went at the sign-out. One left behind by a crash goes now.
    for (const entry of Object.values(accounts)) if (entry.signedOut) await this.rescueAndRemove(path.win32.join(this.base(), entry.folder), 'start');
  }

  /** A folder that goes without a live drive: what wasn't uploaded is copied out first. */
  private async rescueAndRemove(dir: string, reason: 'policy' | 'start'): Promise<void> {
    if (!lstatOrNull(dir)) return;
    const rescued = await this.rescue(dir, reason);
    if (rescued && rescued.failed > 0) return;
    this.removeFolder(dir);
  }

  /** The wipe: every sync root of this profile's, their folders, the letter and every wish. */
  wipe(): Promise<void> {
    return this.serial(async () => {
      for (const account of [...this.live.keys()]) await this.stop(account, true);
      for (const entry of Object.values(this.deps.store.read().accounts ?? {})) this.removeFolder(path.win32.join(this.base(), entry.folder));
      for (const root of await this.ourRoots()) {
        if (root.path) this.removeFolder(root.path);
        await this.unregister(root);
      }
      this.deps.store.write({});
      this.deps.consent?.clear();
      this.refusedUntil.clear();
      await this.applyLetter();
      this.emit();
    });
  }

  /** The app quits: connections end, registrations and folders stay for the next start. */
  shutdown(): void {
    if (this.statusServed) this.deps.native?.filesDriveStatusStop?.();
    this.statusServed = null;
    for (const live of this.live.values()) {
      live.watcher?.close();
      this.relay.dropRoot(live.root.id);
      try {
        this.native().filesDriveDisconnect(live.connection);
      } catch {
        // Going anyway.
      }
    }
    this.live.clear();
  }

  // ─── Explorer's status ───────────────────────────────────────

  /** The CLSID Explorer creates for this profile's drives. */
  get statusClassId(): string {
    return statusClassId(this.deps.profile);
  }

  /** What the page says Explorer should show for an account's drive. Kept for when it's on. */
  setStatus(account: unknown, status: unknown): void {
    if (!validText(account, MAX_ACCOUNT)) return;
    const shown = nativeStatusOf(status);
    if (!shown) return;
    const old = this.statuses.get(account);
    this.statuses.set(account, status as FilesDriveStatus);
    if (trayLineOf(status) !== trayLineOf(old) || old?.state !== (status as FilesDriveStatus).state) this.deps.summaryChanged?.();
    // At most as many as there are accounts: a page can't grow this by inventing them.
    if (this.statuses.size > 64) this.statuses.delete(this.statuses.keys().next().value!);
    const live = this.live.get(account);
    if (live && this.statusServed) this.pushStatus(live);
  }

  private async serveStatus(): Promise<boolean> {
    if (this.statusServed !== null) return this.statusServed;
    const native = this.deps.native;
    if (!this.deps.status || !native?.filesDriveStatusServe || !native.filesDriveStatusAttach || !native.filesDriveStatusSet) {
      this.statusServed = false;
      return false;
    }
    try {
      const icon = await this.deps.status.icon();
      this.statusServed = !!icon && native.filesDriveStatusServe(this.statusClassId, icon, (syncRootId) => this.statusOpened(syncRootId));
    } catch (error) {
      // Explorer shows no status then; the drive works the same.
      this.warn(`Serving the drive's status failed: ${(error as Error).message}`);
      this.statusServed = false;
    }
    return this.statusServed;
  }

  private async attachStatus(live: Live): Promise<void> {
    if (!(await this.serveStatus())) return;
    if (this.live.get(live.account) !== live) return;
    try {
      this.native().filesDriveStatusAttach!(live.syncRootId, this.statusClassId);
    } catch (error) {
      this.warn(`Showing the drive's status in Explorer failed: ${(error as Error).message}`);
      return;
    }
    this.pushStatus(live);
  }

  private pushStatus(live: Live): void {
    const status = nativeStatusOf(this.statuses.get(live.account));
    if (!status) return;
    try {
      this.native().filesDriveStatusSet?.(live.syncRootId, status);
    } catch (error) {
      this.warn(`Updating the drive's status failed: ${(error as Error).message}`);
    }
  }

  private statusOpened(syncRootId: string): void {
    for (const live of this.live.values()) {
      if (live.syncRootId === syncRootId) {
        this.deps.status?.opened(live.account);
        return;
      }
    }
  }

  /** No drive left: nobody to answer Explorer for. */
  private stopStatusWhenIdle(): void {
    if (this.live.size > 0 || !this.statusServed) return;
    try {
      this.deps.native?.filesDriveStatusStop?.();
    } catch {
      // Gone anyway.
    }
    this.statusServed = null;
  }

  /** For the folders feature: where no folder pair may go. */
  parentFolders(): string[] {
    return [this.deps.base];
  }

  /** `removeRoot` on a drive root. */
  async removeRoot(root: FilesRoot): Promise<void> {
    await this.disable(root.account, 'user');
  }

  // ─── The letter ──────────────────────────────────────────────

  setLetter(letter: unknown, gesture: () => boolean): Promise<FilesResult<FilesDriveLetterState>> {
    return this.serial(async () => {
      if (!this.available || !this.deps.letters) return fail('unsupported');
      if (this.deps.policy().letter !== null) return fail('policy');
      if (letter !== null && (typeof letter !== 'string' || !/^[D-Z]$/.test(letter))) return fail('failed');
      if (letter !== null) {
        if (!gesture()) return fail('gesture');
        // A letter for a drive the user said yes to for this server, and none before that.
        if (this.deps.consent && !this.deps.consent.has()) return fail('gesture');
        if (!this.letterState().available.includes(letter)) return fail('exists');
      }
      const stored = this.deps.store.read();
      this.deps.store.write({ ...stored, letter });
      await this.applyLetter();
      this.emit();
      if (letter !== null && this.letterNow !== letter && this.targets().length > 0) return fail('failed');
      return ok(this.letterState());
    });
  }

  /** The accounts' folders that should be there now. */
  private targets(): string[] {
    if (this.deps.policy().forcedOff) return [];
    const accounts = this.deps.store.read().accounts ?? {};
    return Object.entries(accounts)
      .filter(([, entry]) => !entry.signedOut)
      .map(([account, entry]) => this.live.get(account)?.dir ?? path.win32.join(this.base(), entry.folder))
      .filter((dir) => lstatOrNull(dir)?.isDirectory());
  }

  private async applyLetter(): Promise<void> {
    if (!this.deps.letters) return;
    const targets = this.targets();
    const policyLetter = this.deps.policy().letter;
    const chosen = this.deps.store.read().letter ?? null;
    const letter = wantedLetter(policyLetter, chosen, targets.length > 0);
    const before = this.letterNow;
    const labels = this.deps.letterLabels ?? null;
    let named: string | null = null;
    try {
      // Named before it comes, so Explorer never shows it as the disk under it. Not a letter
      // something else holds: that one keeps its own name, and this gets no letter.
      const free = letter !== null && (this.deps.letters.usedMask() & (1 << (letter.charCodeAt(0) - 65))) === 0;
      if (labels && letter && (free || letter === before) && (await claimLetterLabel(labels, letter, this.deps.icon, this.warn))) named = letter;
      this.letterNow = await settleLetter(this.deps.letters, this.base(), letter, letterTarget(this.base(), targets), this.warn);
      // Ours from before this start: the letter outlives the app within a sign-in.
      if (labels && this.letterNow && this.letterNow !== named) await claimLetterLabel(labels, this.letterNow, this.deps.icon, this.warn);
    } catch (error) {
      this.warn(`Setting the drive letter failed: ${(error as Error).message}`);
    }
    if (!labels) return;
    // A letter mapped to a folder outside this profile's drive folder is another drive's, such
    // as another profile's, whose name has the app's icon as well: that name stays.
    const elsewhere = new Set<string>();
    try {
      for (const [mapped, to] of await this.deps.letters.list()) if (!inside(this.base(), to)) elsewhere.add(mapped);
    } catch (error) {
      this.warn(`Reading the drive letters failed: ${(error as Error).message}`);
      return;
    }
    // Every letter this may have named: the one before, the one it wanted and didn't get, and
    // the stored and the policy's, for a name a crash left behind.
    const others = new Set([before, letter, chosen, policyLetter].filter((other): other is string => !!other && /^[D-Z]$/.test(other) && other !== this.letterNow && !elsewhere.has(other)));
    for (const other of others) {
      try {
        await releaseLetterLabel(labels, other, this.deps.icon);
      } catch (error) {
        this.warn(`Removing the drive letter's name failed: ${(error as Error).message}`);
      }
    }
  }

  // ─── What the page does in it ────────────────────────────────

  private liveByRoot(rootId: unknown): Live | null {
    if (typeof rootId !== 'string') return null;
    for (const live of this.live.values()) if (live.root.id === rootId) return live;
    return null;
  }

  private locate(connection: string, absolutePath: string): { rootId: string; path: string } | null {
    for (const live of this.live.values()) {
      if (live.connection !== connection) continue;
      if (!inside(live.dir, absolutePath)) return null;
      const relative = path.win32.relative(live.dir, absolutePath).split('\\').join('/');
      return relative ? { rootId: live.root.id, path: relative } : null;
    }
    return null;
  }

  async place(rootId: unknown, entries: unknown): Promise<FilesResult<{ path: string; error?: FilesError }[]>> {
    const live = this.liveByRoot(rootId);
    if (!live) return fail('inactive');
    if (!Array.isArray(entries) || entries.length > MAX_PLACE) return fail('failed');
    const answers: { path: string; error?: FilesError }[] = entries.map((entry) => ({ path: typeof (entry as FilesPlaceholder)?.path === 'string' ? (entry as FilesPlaceholder).path : '' }));
    // By parent, in the order the parents first come: parents come before their children.
    const groups = new Map<string, { index: number; name: string; entry: FilesPlaceholder }[]>();
    entries.forEach((raw, index) => {
      const entry = raw as FilesPlaceholder;
      // The same check as every other files path: no reserved device name, no trailing dot or space.
      const checked = splitRelative(entry?.path, 'win32');
      const parts = checked.ok ? checked.parts : null;
      const valid =
        parts &&
        (entry.kind === 'file' || entry.kind === 'directory') &&
        Number.isSafeInteger(entry.size) &&
        entry.size >= 0 &&
        Number.isFinite(entry.mtimeMs) &&
        typeof entry.identity === 'string' &&
        entry.identity.length > 0 &&
        Buffer.byteLength(entry.identity) <= 4096;
      if (!valid) {
        answers[index].error = checked.ok ? 'failed' : checked.error;
        return;
      }
      const parent = parts.slice(0, -1).join('/');
      const group = groups.get(parent) ?? [];
      group.push({ index, name: parts[parts.length - 1], entry });
      groups.set(parent, group);
    });
    for (const [parent, group] of groups) {
      let parentDir = live.dir;
      if (parent) {
        const resolved = resolveUnder(live.dir, parent);
        if (!resolved.ok) {
          for (const item of group) answers[item.index].error = resolved.error;
          continue;
        }
        parentDir = resolved.absolute;
      }
      const facts = lstatOrNull(parentDir);
      if (!facts?.isDirectory()) {
        for (const item of group) answers[item.index].error = 'missing';
        continue;
      }
      for (let at = 0; at < group.length; at += NATIVE_BATCH) {
        const batch = group.slice(at, at + NATIVE_BATCH);
        let codes: string[];
        try {
          codes = this.native().filesDrivePlace(
            parentDir,
            batch.map(({ name, entry }) => ({ name, directory: entry.kind === 'directory', size: entry.kind === 'directory' ? 0 : entry.size, mtimeMs: entry.mtimeMs, identity: entry.identity })),
          );
        } catch (error) {
          const code = filesErrorOf(filesErrorCode(error));
          codes = batch.map(() => code);
        }
        batch.forEach((item, position) => {
          const code = codes[position] ?? 'failed';
          if (code) answers[item.index].error = filesErrorOf(code);
        });
      }
    }
    if (live.pins.size > 0) this.restorePins(live, entries as FilesPlaceholder[], answers);
    return ok(answers);
  }

  /** Pins from before the sign-out, on paths placed again just now. The watcher fetches the content. */
  private restorePins(live: Live, entries: FilesPlaceholder[], answers: { path: string; error?: FilesError }[]): void {
    const setPin = this.deps.setPin ?? noPin;
    entries.forEach((entry, index) => {
      if (answers[index].error || !live.pins.has(entry.path)) return;
      live.pins.delete(entry.path);
      const resolved = resolveUnder(live.dir, entry.path);
      if (!resolved.ok) return;
      void setPin(resolved.absolute, 'pinned').then(() => {
        if (this.live.get(live.account) === live) this.checkPin(resolved.absolute, null);
      });
    });
    this.writeAccounts((accounts) => {
      const entry = accounts[live.account];
      if (!entry) return;
      const { pins: _pins, ...rest } = entry;
      accounts[live.account] = live.pins.size > 0 ? { ...rest, pins: [...live.pins] } : rest;
    });
  }

  private resolveFile(live: Live, relative: unknown): { absolute: string; relative: string; stats: BigIntStats } | FilesError {
    const resolved = resolveUnder(live.dir, relative);
    if (!resolved.ok) return resolved.error;
    const stats = lstatOrNull(resolved.absolute);
    if (!stats) return 'missing';
    if (stats.isSymbolicLink()) return 'outside';
    return { absolute: resolved.absolute, relative: resolved.parts.join('/'), stats };
  }

  private entryNow(absolute: string, relative: string): FilesResult<FilesLocalEntry> {
    const stats = lstatOrNull(absolute);
    if (!stats) return fail('missing');
    return ok(entryFor(relative, stats, this.placeholderState(absolute) ?? undefined));
  }

  async update(rootId: unknown, relative: unknown, meta: unknown, expect: unknown): Promise<FilesResult<FilesLocalEntry>> {
    const live = this.liveByRoot(rootId);
    if (!live) return fail('inactive');
    const change = meta as { size: number; mtimeMs: number; identity: string; dehydrate: boolean } | null;
    if (
      !change ||
      !Number.isSafeInteger(change.size) ||
      change.size < 0 ||
      !Number.isFinite(change.mtimeMs) ||
      typeof change.identity !== 'string' ||
      !change.identity ||
      Buffer.byteLength(change.identity) > 4096 ||
      typeof change.dehydrate !== 'boolean'
    ) {
      return fail('failed');
    }
    if (expect !== null && !validExpect(expect)) return fail('failed');
    const found = this.resolveFile(live, relative);
    if (typeof found === 'string') return fail(found);
    if (expect && !expectMatches(found.stats, expect)) return fail('changed');
    let pinned = false;
    try {
      pinned = this.native().filesDriveInfo(found.absolute).pin === 'pinned';
      this.native().filesDriveUpdate(found.absolute, {
        size: change.size,
        mtimeMs: change.mtimeMs,
        identity: change.identity,
        markInSync: true,
        dehydrate: change.dehydrate,
        verifyInSync: true,
      });
    } catch (error) {
      return fail(filesErrorOf(filesErrorCode(error)));
    }
    // A pinned file stays on the device: its new content comes now.
    if (change.dehydrate && pinned) this.queueHydrate(found.absolute);
    return this.entryNow(found.absolute, found.relative);
  }

  async markInSync(rootId: unknown, relative: unknown, identity: unknown, expect: unknown): Promise<FilesResult<FilesLocalEntry>> {
    const live = this.liveByRoot(rootId);
    if (!live) return fail('inactive');
    if (typeof identity !== 'string' || !identity || Buffer.byteLength(identity) > 4096 || !validExpect(expect)) return fail('failed');
    const found = this.resolveFile(live, relative);
    if (typeof found === 'string') return fail(found);
    if (!expectMatches(found.stats, expect)) return fail('changed');
    try {
      this.native().filesDriveConvert(found.absolute, identity);
    } catch (error) {
      return fail(filesErrorOf(filesErrorCode(error)));
    }
    return this.entryNow(found.absolute, found.relative);
  }

  supply(fetchId: unknown, offset: unknown, data: unknown): Promise<boolean> {
    return this.relay.supply(fetchId, offset, data);
  }

  failFetch(fetchId: unknown, error: unknown): void {
    this.relay.fail(fetchId, error);
  }

  activeFetches(): FilesFetchRequest[] {
    return this.relay.active();
  }

  // ─── Placeholder state, for scan and stat ────────────────────

  placeholderState(absolute: string): FilesPlaceholderState | null {
    try {
      const info = this.native().filesDriveInfo(absolute);
      return { identity: info.placeholder ? info.identity ?? null : null, inSync: info.placeholder && info.inSync, hydrated: info.hydrated, pin: info.pin };
    } catch {
      return null;
    }
  }

  /** Reading it would make Windows ask the page for it: main's own reads must not. */
  contentAbsent(absolute: string): boolean {
    try {
      const info = this.native().filesDriveInfo(absolute);
      return info.placeholder && !info.directory && !info.hydrated;
    } catch (error) {
      return filesErrorCode(error) !== 'missing';
    }
  }

  // ─── Pins ────────────────────────────────────────────────────

  private watchPins(live: Live): FSWatcher | null {
    try {
      const watcher = watch(live.dir, { recursive: true }, (_event, name) => {
        if (!name) return;
        const absolute = path.win32.join(live.dir, name.toString());
        const waiting = this.pinTimers.get(absolute);
        if (waiting) clearTimeout(waiting);
        this.pinTimers.set(
          absolute,
          setTimeout(() => {
            this.pinTimers.delete(absolute);
            if (this.live.get(live.account) === live) this.checkPin(absolute, null);
          }, PIN_SETTLE_MS),
        );
      });
      watcher.on('error', (error) => this.warn(`Watching the drive failed: ${error.message}`));
      return watcher;
    } catch (error) {
      this.warn(`Watching the drive failed: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * "Always keep on this device" pins, "Free up space" unpins: the shell sets the attribute and
   * leaves the rest to the provider. A folder's pin goes to what's in it that has none of its own.
   */
  checkPin(absolute: string, inherited: 'pinned' | 'unpinned' | null, budget = { left: MAX_PIN_WALK }): void {
    if (budget.left-- <= 0) return;
    let info;
    try {
      info = this.native().filesDriveInfo(absolute);
    } catch {
      return;
    }
    // A file that just came, in a pinned folder: the folder's pin is its.
    const pin = info.pin === 'unspecified' ? inherited ?? this.ancestorPin(absolute) : info.pin;
    if (info.directory) {
      if (!pin) return;
      let names: string[] = [];
      try {
        names = readdirSync(absolute);
      } catch {
        return;
      }
      for (const name of names) this.checkPin(path.win32.join(absolute, name), pin, budget);
      return;
    }
    if (!info.placeholder) return;
    if (pin === 'pinned' && !info.hydrated) this.queueHydrate(absolute);
    else if (pin === 'unpinned' && info.onDisk > 0 && info.inSync) {
      try {
        this.native().filesDriveDehydrate(absolute);
      } catch (error) {
        // Open somewhere, or changed here and not uploaded yet: it stays.
        this.warn(`Freeing up a file failed: ${(error as Error).message}`);
      }
    }
  }

  /** The nearest pin set on a folder above, inside the drive. */
  private ancestorPin(absolute: string): 'pinned' | 'unpinned' | null {
    const live = [...this.live.values()].find((entry) => inside(entry.dir, absolute));
    if (!live) return null;
    for (let dir = path.win32.dirname(absolute); dir.length >= live.dir.length && inside(live.dir, dir); dir = path.win32.dirname(dir)) {
      try {
        const pin = this.native().filesDriveInfo(dir).pin;
        if (pin !== 'unspecified') return pin;
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * One at a time: a hydrate holds a libuv thread until the page has sent every byte, and the
   * transfers need threads of their own.
   */
  private queueHydrate(absolute: string): void {
    if (this.hydrateWanted.has(absolute)) return;
    this.hydrateWanted.add(absolute);
    this.hydrating = this.hydrating.then(async () => {
      this.hydrateWanted.delete(absolute);
      try {
        const info = this.native().filesDriveInfo(absolute);
        if (info.hydrated) return;
        await this.native().filesDriveHydrate(absolute);
      } catch (error) {
        this.warn(`Keeping a file on this device failed: ${(error as Error).message}`);
      }
    });
  }

  /**
   * "Always keep on this device" or "Free up space" from the page (the Files screen's menu), set
   * the way Explorer sets it: the attribute, then the content comes or goes as for Explorer's.
   */
  async setPin(rootId: unknown, relative: unknown, pin: unknown): Promise<FilesResult<null>> {
    const live = this.liveByRoot(rootId);
    if (!live) return fail('inactive');
    if (pin !== 'pinned' && pin !== 'unpinned') return fail('failed');
    const found = this.resolveFile(live, relative);
    if (typeof found === 'string') return fail(found);
    const setPin = this.deps.setPin ?? noPin;
    if (!(await setPin(found.absolute, pin))) return fail('failed');
    if (this.live.get(live.account) === live) this.checkPin(found.absolute, null);
    return ok(null);
  }

  /** Waits for the pinned files queued so far. For tests. */
  hydrated(): Promise<void> {
    return this.hydrating;
  }
}

function validExpect(value: unknown): value is FilesExpect {
  const expect = value as FilesExpect;
  return !!expect && typeof expect === 'object' && typeof expect.fileId === 'string' && Number.isFinite(expect.size) && Number.isFinite(expect.mtimeMs);
}
