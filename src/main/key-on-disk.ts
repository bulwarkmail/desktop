/**
 * Windows only. safeStorage and Chromium's cookie store encrypt with one key, which Chromium
 * makes on a first start and keeps in `os_crypt.encrypted_key` of Local State, wrapped with
 * DPAPI. Local State reaches the disk only ten seconds later, or at a clean quit. A secret
 * written before that is lost in a crash along with the key, so nothing may be written under
 * the key until it's on disk.
 *
 * Chromium can also replace the key later: when DPAPI won't open it, or Local State is damaged,
 * it makes a new one and writes that over the old. So a copy of the wrapped key is kept next to
 * the secrets, written before the first of them, and put back before Chromium reads Local State.
 * The copy is as safe as the original: only DPAPI, for this user on this machine, opens it.
 *
 * A copy DPAPI won't open any more (a password reset, a profile copied to another user) must not
 * go back: Chromium would make yet another key at each start, and whatever is under the one in
 * use would go with it. Only DPAPI can say, and only Chromium asks it, so a run of the app tries
 * the copy in a folder of its own. That also means it goes back by itself if DPAPI opens it again.
 *
 * macOS keeps the key in the Keychain and Linux in the secret service, which write at once, so
 * none of this runs there. No Electron here, so tests can load it.
 */

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { removeOwn } from './remove-tree';

/** A run of the app that only gets the key onto the disk, by quitting cleanly. */
export const KEY_INIT_SWITCH = '--bulwark-init-key';
/** The same, in the folder below instead of the profile. Takes no path: it can't aim anywhere else. */
export const KEY_CHECK_SWITCH = `${KEY_INIT_SWITCH}=check`;
export const KEY_CHECK_FOLDER = 'key-check';

/** What such a run is started with: only what says which profile this is, and which run it is. */
export function keyInitArgs(argv: readonly string[], isPackaged: boolean, mainScript: string, run: string, devProfileSwitch?: string): string[] {
  const profile = argv.filter((arg) => (devProfileSwitch !== undefined && arg.startsWith(devProfileSwitch)) || arg.startsWith('--user-data-dir='));
  return [...(isPackaged ? [] : [mainScript]), ...profile, run];
}

export const KEYS_FOLDER = 'keys';
const SAVED_KEY = 'os-crypt-key.saved';
/** The app lock's records. Its store keys are wrapped with safeStorage as well. */
const APP_LOCK_FOLDER = 'app-lock';

/** A file that's complete on disk once this returns, even if the power goes right after. */
export function durableWrite(file: string, data: string | Buffer): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  const fd = openSync(temp, 'w', 0o600);
  try {
    writeFileSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, file);
}

function readLocalState(userData: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(readFileSync(path.join(userData, 'Local State'), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/** The wrapped key as it is on disk: what a crash right now would leave. */
export function keyOnDisk(userData: string): string | null {
  const key = (readLocalState(userData)?.os_crypt as { encrypted_key?: unknown } | undefined)?.encrypted_key;
  return typeof key === 'string' && key ? key : null;
}

export function savedKey(userData: string): string | null {
  try {
    return readFileSync(path.join(userData, KEYS_FOLDER, SAVED_KEY), 'utf8') || null;
  } catch {
    return null;
  }
}

/** Keeps what's on disk now. Call it only with the key's secrets known to be readable. */
export function saveKey(userData: string): void {
  const key = keyOnDisk(userData);
  if (key) durableWrite(path.join(userData, KEYS_FOLDER, SAVED_KEY), key);
}

function list(userData: string, folder: string): string[] {
  return existsSync(path.join(userData, folder)) ? readdirSync(path.join(userData, folder)) : [];
}

/** The app lock's keys sit in its records and in the page's database, so main can't try them. */
export function holdsAppLockRecords(userData: string): boolean {
  return list(userData, APP_LOCK_FOLDER).length > 0;
}

/** Anything encrypted with the key that a new key would make unreadable. */
export function holdsSecrets(userData: string): boolean {
  return list(userData, KEYS_FOLDER).some((name) => name.endsWith('.bin')) || holdsAppLockRecords(userData);
}

function putKeyBack(userData: string, key: string): void {
  const state = readLocalState(userData) ?? {};
  // audit_enabled set: without it Chromium wraps the key anew, which reads as another key here.
  const osCrypt = { ...(state.os_crypt as object | undefined), encrypted_key: key, audit_enabled: true };
  durableWrite(path.join(userData, 'Local State'), JSON.stringify({ ...state, os_crypt: osCrypt }));
}

/**
 * Whether DPAPI opens this key, by a run of the app on a copy: Chromium replaces a key it can't
 * open. If that can't be found out, the answer is yes, as putting the key back protects secrets.
 */
export function keyOpens(userData: string, key: string, runCheck: () => void): boolean {
  const folder = path.join(userData, KEY_CHECK_FOLDER);
  const clear = () => removeOwn(folder, { root: userData, tries: 6, delayMs: 200 });
  try {
    clear();
    durableWrite(path.join(folder, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: key, audit_enabled: true } }));
    runCheck();
    return keyOnDisk(folder) === key;
  } catch (error) {
    console.error(error);
    return true;
  } finally {
    try {
      clear();
    } catch {
      // A leftover file of that run. The next check clears the folder.
    }
  }
}

export interface KeySettling {
  /** A clean run on the profile. About 250 ms, against Chromium's ten seconds. */
  runKeyInit: () => void;
  keyOpens: (key: string) => boolean;
  /** This start may write the profile's first secrets. In instance mode it won't. */
  firstSecretsMayFollow: boolean;
}

/**
 * Before Chromium reads Local State, which it does once this module has finished loading. Puts
 * back a key that's gone or was replaced, if it still opens.
 *
 * Otherwise the clean run is for what can't wait: a first key, and, with no secrets yet, a key
 * this start hasn't seen proved. If DPAPI won't open that one, Chromium would use a new key from
 * memory while the old stays on disk for ten seconds, and secrets written in that time would look
 * safe and be under neither. After the clean run, what's on disk is the key in use. If the run
 * fails, waitForKeyOnDisk still holds back a first key.
 */
export function settleKeyBeforeChromium(userData: string, { runKeyInit, keyOpens: opens, firstSecretsMayFollow }: KeySettling): void {
  const saved = savedKey(userData);
  const secrets = holdsSecrets(userData);
  if (saved && saved !== keyOnDisk(userData) && (!keyOnDisk(userData) || secrets) && opens(saved)) {
    try {
      putKeyBack(userData, saved);
    } catch (error) {
      // The next start tries again. Until then the secrets can't be read, and the error page says so.
      console.error(error);
    }
  }
  const onDisk = keyOnDisk(userData);
  if (!onDisk || (!secrets && (saved !== onDisk || firstSecretsMayFollow))) runKeyInit();
}

/** Whether Local State holds the key. False after the wait means the disk isn't taking it. */
export async function waitForKeyOnDisk(userData: string, { timeoutMs = 30_000, intervalMs = 100 } = {}): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!keyOnDisk(userData)) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return true;
}
