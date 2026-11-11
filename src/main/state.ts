/**
 * The shell's own small JSON state under userData. Plain, not secret: mode,
 * approved servers, window sizes, last theme. Written atomically, read once.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Mode, OsSettings, ThemeColours, UpdateChannel, WindowType } from '../shared/bridge';
import type { StoredDrive } from './files/drive-controller';
import type { PrintMemory } from './print-rules';
import type { ResumeMark } from './resume-rules';

export interface StoredBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized?: boolean;
}

export interface ApprovedServer {
  origin: string;
  approvedAt: number;
}

export interface StoredImportJob {
  id: string;
  origin: string;
  touchedAt: number;
  /** Thunderbird profile folders, to tell whether it's running. */
  profiles: string[];
  files: { path: string; root: string; kind: 'mbox' | 'maildir' | 'pst'; name: string; folder: string[] }[];
}

/** A window to bring back at the next start. */
export interface SessionWindow {
  type: WindowType;
  url: string;
  key?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  maximized?: boolean;
}

/** Telemetry and crash report consent. Absent means nobody said yes: off. See features/privacy.ts. */
export interface PrivacyChoices {
  /** The first run asked, or the user answered in settings. */
  asked?: boolean;
  telemetry?: boolean;
  crashReports?: boolean;
  crashUploadUrl?: string;
  /** The shell's own id for its heartbeat. Instance mode only. */
  id?: string;
  lastPingAt?: number;
}

export interface ShellState {
  mode?: Mode;
  instanceUrl?: string;
  /** Mail servers the user approved: LAN or plain http. */
  approvedServers: ApprovedServer[];
  /** Every server origin an account uses, for the CORS headers. */
  corsOrigins: string[];
  /** Per window type. A quick composer keeps its own: it's small, and other composers aren't. */
  windowBounds: Partial<Record<WindowType | 'quickComposer', StoredBounds>>;
  theme?: ThemeColours;
  /** Whether a page draws its own title bar row, per origin (windows.ts). */
  overlayByOrigin: Record<string, boolean>;
  /** What the user changed of the OS settings; the rest are defaults (features/os-rules.ts). */
  os?: Partial<OsSettings>;
  /** Pause notifications, from the tray. */
  osPausedUntil?: number | null;
  /** The first close to the tray said so. */
  osCloseNoticeShown?: boolean;
  /** Signs what a toast's buttons hand back. Only a page reading this file could forge one. */
  osToastSecret?: string;
  /** The user's own channel. A policy goes first (update-rules.ts). */
  updateChannel?: UpdateChannel;
  /** The channel this copy started on, until someone chooses (updater.ts). */
  updateChannelInitial?: UpdateChannel;
  /** The last version a notification was shown for. */
  updateNotified?: string;
  /** What was open at quit. Off by the setting in the webmail. */
  session?: SessionWindow[];
  restoreWindows?: boolean;
  /** Starts in a row that began restoring and didn't get far. */
  restoreAttempts?: number;
  /** The main window's page when the computer restarted, with "Open again after a restart" on. */
  resumeAfterRestart?: ResumeMark;
  /** When a pop-out last opened: whether a warm spare is worth its memory. */
  lastPopoutAt?: number;
  /** Chromium's zoom level: 0 is 100%. */
  zoomLevel?: number;
  /** "Always show the menu bar" (Windows and Linux), and how tall the pages draw it, in CSS pixels. */
  menuBarPinned?: boolean;
  menuBarHeight?: number;
  privacy?: PrivacyChoices;
  /** Developer tools on Ctrl+Shift+I and F12: the user turned them on (features/dev-tools.ts). */
  devTools?: boolean;
  /** "Change Connection" was chosen: ask once, also over a recommended server. */
  askConnection?: boolean;
  /** WipeOfflineData values already acted on, so each deletes once, across restarts. */
  policyWipes?: string[];
  /** Every partition this profile has used: a wipe covers them all. */
  partitions?: string[];
  /** A hash of the key DPAPI stopped opening, once the user was told their sign-ins went with it. */
  keyLossTold?: string;
  /** Instances the user said may use the OS keystore. Revocable in the webmail's settings. */
  keystoreOrigins?: string[];
  /** The browser sign-in page's port per mail server, so what a password manager saved keeps matching. */
  signInPorts?: Record<string, number>;
  /**
   * The client certificate remembered for a `host:port`, by fingerprint, and a hash of the account
   * it was chosen in. Gone at that account's sign-out, and all of them at the last one.
   */
  certificateChoices?: Record<string, { fingerprint: string; account?: string }>;
  /** Where File > Save as… and File > Open… last were: the next dialog starts there. */
  saveAsFolder?: string;
  openFolder?: string;
  /** Local imports under way: paths the user confirmed, so one can go on after a restart. */
  importJobs?: StoredImportJob[];
  /** The Files drive: the accounts the user turned it on for, and the letter they chose. */
  filesDrive?: StoredDrive;
  /** The print preview's last destination and the choices per destination (print-rules.ts). */
  print?: PrintMemory;
}

const EMPTY: ShellState = { approvedServers: [], corsOrigins: [], windowBounds: {}, overlayByOrigin: {} };

export class StateFile {
  private timer: NodeJS.Timeout | null = null;
  readonly data: ShellState;

  constructor(private readonly file: string) {
    let loaded: Partial<ShellState> = {};
    try {
      loaded = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      // First run, or a damaged file: start clean. None of this is precious.
    }
    this.data = { ...EMPTY, ...loaded };
  }

  /** Saves soon. Window moves fire many times a second. */
  touch(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.save(), 400);
    this.timer.unref?.();
  }

  save(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(this.data, null, 2));
    renameSync(temp, this.file);
  }
}
