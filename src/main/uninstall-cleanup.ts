/**
 * `Bulwark.exe --uninstall-cleanup`: what the app wrote into the user's Windows at its starts,
 * taken away again, so Default apps, Open with and Send to don't keep pointing at a deleted exe.
 * The MSI runs it as the user who uninstalls, before it removes the files
 * (scripts/msi-project.cjs). The NSIS uninstaller runs it too, and takes the registry entries and
 * folders away by itself as well (build/installer.nsh customUnInstall): keep the two alike. The
 * Files drive only goes through here. No Electron here, so a test can run it on a key and
 * folders of its own.
 */

import { readdirSync, rmdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { DriveController, type StoredDrive } from './files/drive-controller';
import { DRIVE_NAME } from './files/drive-places';
import { DRIVES_KEY, registryLetterLabels } from './files/drive-letter-label';
import { SEND_TO_NAME, windowsRegistrationKeys } from './features/os-rules';
import type { NativeFilesModule, Registry } from './native-loader';
import { readKey, stringOf, valueOf } from './registry-values';
import { removeOwn } from './remove-tree';

export const UNINSTALL_CLEANUP_SWITCH = '--uninstall-cleanup';

/** Only before a bare `--`: after it come links and files, and a file may have any name. */
export function asksForUninstallCleanup(argv: readonly string[]): boolean {
  const end = argv.indexOf('--');
  return argv.slice(1, end === -1 ? argv.length : end).includes(UNINSTALL_CLEANUP_SWITCH);
}

export interface CleanupPlaces {
  /** `HKCU`, or in a test the key that stands in for it. */
  root: string;
  /** The exe being uninstalled. Only what names it, or what only it could have written, goes. */
  exe: string;
  /** The user's SendTo folder, or a test's own. */
  sendTo: string | null;
  /** `%LOCALAPPDATA%`, or a test's own. */
  local: string | null;
}

const RUN_KEYS = ['Software\\Microsoft\\Windows\\CurrentVersion\\Run', 'Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run'];
/** The login item's name for an installed app (os-login.ts). */
const LOGIN_ITEM_NAME = 'Bulwark';

const unquote = (text: string) => text.trim().replace(/^"(.*)"$/, '$1');
const sameFile = (a: string, b: string) => unquote(a).toLowerCase() === unquote(b).toLowerCase();

/** The COM servers Electron registered for this exe's toasts: any CLSID whose LocalServer32 names it. */
function toastServers(registry: Registry, root: string, exe: string): string[] {
  const classes = `${root}\\Software\\Classes\\CLSID`;
  const ids: string[] = [];
  for (const id of readKey(registry, classes)?.subkeys ?? []) {
    if (!/^\{[0-9A-F-]+\}$/i.test(id)) continue;
    const server = readKey(registry, `${classes}\\${id}\\LocalServer32`);
    if (server?.values.some((value) => stringOf(value) !== null && sameFile(stringOf(value)!, exe))) ids.push(id);
  }
  return ids;
}

/** The drive letters whose name and icon in "This PC" are this install's: the same test as the NSIS uninstaller. */
async function ourDriveLetters(registry: Registry, root: string, exe: string): Promise<string[]> {
  const icon = `${path.win32.join(path.win32.dirname(exe), 'resources', 'os-icons', 'bulwark.ico')},0`;
  const labels = registryLetterLabels(root, registry, null);
  const letters: string[] = [];
  for (const letter of readKey(registry, `${root}\\${DRIVES_KEY}`)?.subkeys ?? []) {
    if (!/^[A-Z]$/i.test(letter)) continue;
    const found = await labels.read(letter);
    if (found.icon !== null && found.icon.toLowerCase() === icon.toLowerCase() && (found.label === null || found.label === '' || found.label === DRIVE_NAME)) letters.push(letter);
  }
  return letters;
}

function removeIfEmpty(folder: string): void {
  try {
    if (readdirSync(folder).length === 0) rmdirSync(folder);
  } catch {
    // Not there, or not ours to take.
  }
}

/**
 * The app's own folders under %LOCALAPPDATA%. Copies of files on their way to a drop go: they
 * were only ever ours. The edit and sync folders only when empty: a copy of an attachment someone
 * still edits, or what the sync knows, stays with the user, as the profile does.
 */
export function removeLocalFolders(local: string): void {
  const own = path.join(local, 'Bulwark');
  // Never through a link a user or program put there (remove-tree.ts).
  removeOwn(path.join(own, 'os-files'), { root: local });
  removeIfEmpty(path.join(own, 'edit-files'));
  removeIfEmpty(path.join(own, 'files-sync', 'state'));
  removeIfEmpty(path.join(own, 'files-sync'));
  removeIfEmpty(own);
  removeOwn(path.join(local, 'bulwark-desktop-updater'), { root: local });
}

/** The Files drive of the profile being left behind, as features/files-drive.ts names it. */
export interface DrivePlaces {
  /** The profile folder: its key is in its sync roots' ids. */
  profile: string;
  provider: string;
  /** The folder the accounts' folders are in, `%USERPROFILE%\Bulwark Files` for the installed app. */
  base: string;
  /** Where files that weren't uploaded are copied to, as when the policy turns the drive off. */
  documents: string;
  /** What the profile kept about the drive: shell-state.json's `filesDrive`. */
  stored: StoredDrive;
  /** Windows 10 1809 or later. */
  supported: boolean;
  version: string;
}

/**
 * The Files drive at an uninstall, done the way the FilesDriveEnabled policy turns it off: what
 * wasn't uploaded is copied to `Documents\Bulwark – not uploaded\<date>`, every sync root this
 * profile registered is unregistered (so "Bulwark Files" leaves Explorer's navigation pane), and
 * their folders go. Another profile's roots, and another user's, stay. With no helper there is
 * nothing to do. The base folder goes when it's left empty.
 */
export async function removeFilesDrive(helper: NativeFilesModule | null, places: DrivePlaces): Promise<void> {
  if (!helper) return;
  let stored = places.stored;
  const drive = new DriveController({
    native: helper,
    supported: places.supported,
    provider: places.provider,
    base: places.base,
    profile: places.profile,
    icon: '',
    version: places.version,
    store: { read: () => stored, write: (next) => (stored = next) },
    policy: () => ({ forcedOff: true, letter: null }),
    page: { fetch: () => 'not-running', fetchCancelled: () => {}, stateChanged: () => {} },
    registry: { add: () => {}, remove: () => {} },
    letters: null,
    documents: places.documents,
    watchPins: false,
    warn: (message) => console.warn(message),
  });
  await drive.startUp();
  removeIfEmpty(places.base);
}

/**
 * `registry` is the native helper's. Without it nothing in the registry goes, as when reg.exe
 * failed; the folders still do. `drive`: the Files drive's helper and places; a failure there
 * stops none of the rest.
 */
export async function uninstallCleanup(places: CleanupPlaces, registry: Registry | null, drive: { helper: NativeFilesModule | null; places: DrivePlaces } | null = null): Promise<void> {
  if (registry) await cleanRegistry(registry, places.root, places.exe);
  if (places.sendTo) rmSync(path.join(places.sendTo, `${SEND_TO_NAME}.lnk`), { force: true });
  if (drive) await removeFilesDrive(drive.helper, drive.places).catch((error) => console.warn('Removing the Files drive failed:', error));
  if (places.local) removeLocalFolders(places.local);
}

async function cleanRegistry(registry: Registry, root: string, exe: string): Promise<void> {
  const del = (key: string, name?: string) => (name === undefined ? registry.deleteKey(`${root}\\${key}`) : registry.deleteValue(`${root}\\${key}`, name));

  // Default apps, the mail and calendar links, .eml/.ics/.vcf, Open with and "Choose another app".
  const { keys, values } = windowsRegistrationKeys(path.win32.basename(exe));
  for (const key of keys) del(key);
  for (const value of values) del(value.key, value.name);

  // Electron's toast activator: any CLSID whose server is this exe.
  for (const id of toastServers(registry, root, exe)) del(`Software\\Classes\\CLSID\\${id}`);

  // Start at login, when the entry is this exe's, or there is none (StartupApproved may still have one).
  const entry = valueOf(readKey(registry, `${root}\\${RUN_KEYS[0]}`) ?? undefined, LOGIN_ITEM_NAME);
  const command = stringOf(entry)?.trim();
  if (!entry || (command && command.toLowerCase().includes(exe.toLowerCase()))) {
    for (const key of RUN_KEYS) del(key, LOGIN_ITEM_NAME);
  }

  // The Files drive letter's name and icon, where they are this install's.
  const labels = registryLetterLabels(root, registry, null);
  for (const letter of await ourDriveLetters(registry, root, exe)) await labels.remove(letter);
}
