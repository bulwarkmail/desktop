/**
 * Where the Files drive lives on disk, and the small rules around it. No Electron here.
 *
 * Each account's sync root is a folder under `%USERPROFILE%\Bulwark Files`, named by the
 * address, so a second account doesn't move the first. Explorer shows "Bulwark Files" for
 * one account and "Bulwark Files - <address>" for each of several.
 */

import { createHash } from 'node:crypto';
import { lstatSync, type BigIntStats } from 'node:fs';
import path from 'node:path';
import type { FilesDriveStatus, FilesError, FilesLocalEntry, FilesPlaceholderState } from '../../shared/bridge';
import type { NativeDriveStatus } from '../native-loader';

export const DRIVE_PROVIDER = 'Bulwark';
/** A test build's own, as it has an AppUserModelID of its own: its sync roots are never the installed app's. */
export const DRIVE_TEST_PROVIDER = 'Bulwark Test';
export const DRIVE_FOLDER = 'Bulwark Files';
export const DRIVE_NAME = 'Bulwark Files';

/** The provider part of the sync roots' ids: a test's own when it names one, else the build's. */
export function driveProvider(o: { chosen: string | null | undefined; testBuild: boolean }): string {
  if (o.chosen) return o.chosen;
  return o.testBuild ? DRIVE_TEST_PROVIDER : DRIVE_PROVIDER;
}

/**
 * The folder the accounts' sync roots go in. A test build keeps it in its own profile: in the
 * user's `Bulwark Files` it would take over the installed app's folders, and its drive letter
 * with them, which a test run then removes.
 */
export function driveBase(o: { chosen: string | null | undefined; testBuild: boolean; profile: string; home: string }): string {
  if (o.chosen) return o.chosen;
  return path.join(o.testBuild ? o.profile : o.home, DRIVE_FOLDER);
}

/** An account's own key: never the address, and different per profile. */
export function accountKey(profile: string, account: string): string {
  return createHash('sha256').update(`${profile}\0${account}`).digest('hex').slice(0, 24);
}

/** The first part of the account part of every sync root id this profile registers. */
export function profileKey(profile: string): string {
  return createHash('sha256').update(`Bulwark Files profile\0${profile}`).digest('hex').slice(0, 16);
}

/**
 * The account part of a sync root's id (`<provider>!<user SID>!<this>`): the profile's key, a
 * dash, the account's key. A root whose id starts with another profile's key is that profile's,
 * and nothing here touches it. An id with the account's key alone is the form older versions
 * registered: it counts as this profile's only while this profile's stored accounts name it.
 */
export function rootKey(profile: string, account: string): string {
  return `${profileKey(profile)}-${accountKey(profile, account)}`;
}

/** The account part of a sync root's id. */
export function keyOfRoot(id: string): string {
  return id.split('!').at(-1) ?? '';
}

/**
 * The CLSID Explorer creates for the drive's status, one per profile: a test build, a dev run
 * and the installed app each serve their own, and none answers for another's sync roots. Never
 * written to the registry as a class, only into the sync root's own key.
 */
export function statusClassId(profile: string): string {
  const hex = createHash('sha256').update(`Bulwark Files status\0${profile}`).digest('hex');
  // Version 5 and the RFC 4122 variant, so it reads as a name-based GUID.
  const version = `5${hex.slice(13, 16)}`;
  const variant = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16) + hex.slice(17, 20);
  return `{${hex.slice(0, 8)}-${hex.slice(8, 12)}-${version}-${variant}-${hex.slice(20, 32)}}`.toUpperCase();
}

const STATUS_STATES = new Set(['synced', 'syncing', 'paused', 'offline', 'error']);
const MAX_STATUS_LABEL = 200;
const MAX_STATUS_TEXT = 500;

function plainText(value: unknown, min: number, max: number): value is string {
  return typeof value === 'string' && value.length >= min && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

/** The tray's line from the page's status: one line of plain text, or null. */
export function trayLineOf(value: unknown): string | null {
  const tray = (value as FilesDriveStatus | null)?.tray;
  return plainText(tray, 1, MAX_STATUS_LABEL * 2) ? tray : null;
}

/** The page's status for Explorer, in the helper's shape; null when it isn't one. */
export function nativeStatusOf(value: unknown): NativeDriveStatus | null {
  const status = value as FilesDriveStatus | null;
  if (!status || typeof status !== 'object' || !STATUS_STATES.has(status.state)) return null;
  if (!plainText(status.label, 1, MAX_STATUS_LABEL) || !plainText(status.detail, 0, MAX_STATUS_TEXT)) return null;
  const out: NativeDriveStatus = { state: status.state, label: status.label, detail: status.detail };
  if (status.quota !== null && status.quota !== undefined) {
    const { used, total, label } = status.quota;
    if (!Number.isSafeInteger(used) || used < 0 || !plainText(label, 1, MAX_STATUS_LABEL)) return null;
    if (total !== null && (!Number.isSafeInteger(total) || total <= 0)) return null;
    out.quota = total === null ? { used, label } : { used, total, label };
  }
  if (status.notice !== null && status.notice !== undefined) {
    if (!plainText(status.notice, 0, MAX_STATUS_TEXT)) return null;
    if (status.notice) out.notice = status.notice;
  }
  return out;
}

export function syncRootPrefix(provider: string): string {
  return `${provider}!`;
}

export function displayNameFor(label: string, accounts: number): string {
  return accounts > 1 ? `${DRIVE_NAME} - ${label}` : DRIVE_NAME;
}

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** A folder name for an address that Windows can hold, unlike any in `taken` (case aside). */
export function folderNameFor(label: string, taken: readonly string[]): string {
  let name = label.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').trim().slice(0, 120);
  if (!name || RESERVED.test(name)) name = `_${name || 'account'}`;
  const lower = new Set(taken.map((entry) => entry.toLowerCase()));
  if (!lower.has(name.toLowerCase())) return name;
  for (let number = 2; ; number++) {
    const next = `${name} (${number})`;
    if (!lower.has(next.toLowerCase())) return next;
  }
}

/** Is `inner` the same as or below `outer`? Windows paths, any case. */
export function inside(outer: string, inner: string): boolean {
  const relative = path.win32.relative(outer.toLowerCase(), inner.toLowerCase());
  return relative === '' || (!relative.startsWith('..') && !path.win32.isAbsolute(relative));
}

/** The parts of a path the page sends: relative, `/` between parts, nothing that leaves. */
export function relativeParts(relative: unknown): string[] | null {
  if (typeof relative !== 'string' || !relative || relative.length > 4096) return null;
  const parts = relative.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /[\\:\u0000]/.test(part))) return null;
  return parts;
}

export type Resolved = { ok: true; absolute: string; parts: string[] } | { ok: false; error: FilesError };

/**
 * A path under a root, as an absolute path. Refused when it leaves the root, or when a folder
 * on the way is a link or a junction: something on the other end isn't the drive's.
 */
export function resolveUnder(rootDir: string, relative: unknown, lstat: (file: string) => { isSymbolicLink(): boolean } | null = lstatOrNull): Resolved {
  const parts = relativeParts(relative);
  if (!parts) return { ok: false, error: 'outside' };
  let at = rootDir;
  for (const part of parts) {
    at = path.win32.join(at, part);
    const facts = lstat(at);
    if (facts?.isSymbolicLink()) return { ok: false, error: 'outside' };
  }
  if (!inside(rootDir, at)) return { ok: false, error: 'outside' };
  return { ok: true, absolute: at, parts };
}

function lstatOrNull(file: string): BigIntStats | null {
  try {
    return lstatSync(file, { bigint: true });
  } catch {
    return null;
  }
}

/** The same as the folders side reads them (files/disk.ts), so `expect` works across both. */
export function fileIdOf(stats: BigIntStats): string {
  return `${stats.dev}:${stats.ino}`;
}

export function mtimeMsOf(stats: BigIntStats): number {
  return Number(stats.mtimeNs / 1000n) / 1000;
}

export function entryFor(relative: string, stats: BigIntStats, placeholder?: FilesPlaceholderState): FilesLocalEntry {
  const directory = stats.isDirectory();
  return {
    path: relative,
    kind: directory ? 'directory' : 'file',
    size: directory ? 0 : Number(stats.size),
    mtimeMs: mtimeMsOf(stats),
    fileId: fileIdOf(stats),
    ...(placeholder ? { placeholder } : {}),
  };
}

export function expectMatches(stats: BigIntStats, expect: { fileId: string; size: number; mtimeMs: number }): boolean {
  return fileIdOf(stats) === expect.fileId && (stats.isDirectory() ? 0 : Number(stats.size)) === expect.size && mtimeMsOf(stats) === expect.mtimeMs;
}

/** What the helper's error code means to the page. */
export function filesErrorOf(code: string): FilesError {
  switch (code) {
    case 'missing':
    case 'exists':
    case 'busy':
    case 'denied':
    case 'name':
    case 'full':
    case 'changed':
    case 'outside':
    case 'unsupported':
      return code;
    // Edited here since: the save replaced the placeholder with a plain file.
    case 'not-placeholder':
      return 'changed';
    case 'pinned':
      return 'busy';
    default:
      return 'failed';
  }
}

// ─── The drive letter ────────────────────────────────────────

export const LETTERS = 'DEFGHIJKLMNOPQRSTUVWXYZ'.split('');

/** The letters D to Z that nothing uses, from GetLogicalDrives' mask, plus our own. */
export function freeLetters(usedMask: number, ours: string | null): string[] {
  return LETTERS.filter((letter) => letter === ours || (usedMask & (1 << (letter.charCodeAt(0) - 65))) === 0);
}

/**
 * The letter that should be in use: the policy's (`none` for none), else the user's. Only
 * while a drive is there.
 */
export function wantedLetter(policy: string | null, chosen: string | null, anyRoot: boolean): string | null {
  if (!anyRoot) return null;
  if (policy === 'none') return null;
  if (policy && /^[D-Z]$/.test(policy)) return policy;
  return chosen && /^[D-Z]$/.test(chosen) ? chosen : null;
}

/** One account: its folder. Several: the folder that holds them all. */
export function letterTarget(base: string, rootDirs: readonly string[]): string | null {
  if (rootDirs.length === 0) return null;
  return rootDirs.length === 1 ? rootDirs[0] : base;
}
