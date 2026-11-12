/**
 * "Edit" on an attachment: a copy in a private folder, opened in its default program and
 * watched, so a save there can go back into mail. What the page should do with a saved
 * file (update the attachment, attach it to a reply, save a copy) is the page's. Here is
 * what has to hold whatever the page does.
 *
 * Nothing the user saved goes because a program, a window or the app closed. Each session
 * has a record on disk, so a change is noticed and offered again after a restart. A
 * changed file goes when the user decides, at a sign-out they agreed to, at a wipe, or after
 * 30 days and one last offer. An unchanged one stays a day: at start-up nothing says the
 * program holding it has closed. A file a program holds can't be deleted: its session stays
 * and stays watched, so a save in that program is still offered. Only a wipe or the
 * organisation's no means nothing it writes is offered again.
 *
 * Whatever new file appears in the folder is the user's too, as Save As in that program can
 * only start there, under the same list of what may be opened.
 *
 * The bridge can reach this from a same-origin plugin frame (see ipc.ts), and a call here
 * starts a program. So only listed file types go, here and not only in the page
 * (shared/edit-rules.ts), and a session takes a real click, spent as it's used
 * (user-gesture.ts). One click is one ticket, bound to its key, and a newer one ends it. The
 * ticket exists because the attachment's bytes can take longer to fetch than a click lasts.
 * Deleting a changed file on a page's word asks natively. What can't ask is `wipe` and
 * `forceDiscard`, for a wipe and the organisation's no, which must happen with nobody
 * there; a plugin that calls them deletes copies of mail, with no way to read them.
 *
 * Whether the organisation allows this is per account and only the page knows. The page
 * asks before each step and discards the session when the answer turns to no.
 *
 * The lock: no file opens and nothing is read or listed while locked, but a program that
 * already has a file open can't be closed from here, and a file it's editing can't be
 * deleted without losing the edit. So those stay, as plain files only this user can read,
 * and what was saved meanwhile is offered after the unlock.
 *
 * What a program does on its own can't be reached from here: its recovery files and its list
 * of recent files, which can name this folder. The strings and the README say so.
 */

import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, mkdirSync, readdirSync, readFileSync, rmSync, watch, type FSWatcher } from 'node:fs';
import { mkdir, open as openFile, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { app, shell, type WebContents } from 'electron';
import { CHANNEL, type EditBeginResult, type EditClearResult, type EditFile, type EditOpenResult, type EditReadResult, type EditSession } from '../../shared/bridge';
import { allowEditExtensionForTest, EDIT_CHANGED_KEEP_MS, EDIT_CHANGED_MAX_MS, EDIT_LAST_CALL_MS, EDIT_TAIL_BYTES, EDIT_UNCHANGED_KEEP_MS, editFileLooksWhole, editFileName, editNeedsMark, isEditTempName } from '../../shared/edit-rules';
import { strings } from '../strings';
import { native } from '../native';
import { makeFolderPrivate } from '../private-folder';
import { takeUserGesture, watchUserGestures } from '../user-gesture';
import { addWipeStep } from './local-wipe';
import type { OsHub } from './os-hub';
import { isInstalledBuild } from '../installed';
import { showMessageBox } from '../message-box';

declare const __BULWARK_TEST_BUILD__: boolean;

const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const MAX_SESSIONS = 50;
const MAX_SOURCE_LENGTH = 8192;
/** Long enough to fetch a large attachment. A newer click ends it sooner. */
const TICKET_LIFE_MS = 3 * 60_000;
/** Long enough for several writes of one save to count as one. */
const DEBOUNCE_MS = 800;
/** A file that's still growing isn't saved yet. */
const STABLE_MS = 1000;
/** A program with the file open against writers may be writing, or may just have it open, as Word does. */
const HELD_STABLE_MS = 3000;
/** For what a watcher missed or couldn't see, a file held when it changed, and one that's free now. */
const POLL_MS = 15_000;
const EXPIRY_CHECK_MS = 60 * 60_000;
/** A program saving replaces the file: gone for a moment isn't gone. */
const MISSING_LIMIT_MS = 60_000;
/** A yes to the question before a sign-out covers the deleting that follows it. */
const CLEAR_ALLOWANCE_MS = 2 * 60_000;
const FILE_FOLDER = 'f';
const PRIMARY_RECORD = 'session.json';
const RECORD_NAME = /^session(-[0-9a-f]+)?\.json$/;

interface SessionRecord {
  id: string;
  key: string;
  name: string;
  type: string;
  account: string;
  source: string;
  origin: string;
  createdAt: number;
  /** Opened, saved or taken. What the age limits count from. */
  touchedAt: number;
  /** What the page last took or started from. */
  baseHash: string;
  currentHash: string;
  version: number;
  /** Set for a file the user saved under a new name. The folder belongs to the session it came from. */
  folder?: string;
  /**
   * Wanted gone, and a program holds it. `release`: a save offers it again. `forced`: a wipe or
   * the organisation's no, so nothing it writes is offered.
   */
  closing?: 'release' | 'forced';
  /** When the last offer before deleting it was seen. */
  lastCallAt?: number;
}

interface LiveSession {
  record: SessionRecord;
  watcher: FSWatcher | null;
  timer: ReturnType<typeof setTimeout> | null;
  checking: boolean;
  checkAgain: boolean;
  seenSize: number;
  seenMtime: number;
  missingSince: number | null;
  /** The state of a file a program has open against writers, and since when. */
  heldStat: { size: number; mtime: number; at: number } | null;
}

/**
 * Local, not the roaming profile a packaged Windows app's userData is in: a copy of a mail
 * attachment shouldn't travel to a file server at logoff. The same choice as os-files.ts.
 */
function editRoot(): string {
  const local = process.env.LOCALAPPDATA;
  if (process.platform === 'win32' && isInstalledBuild() && local) return path.join(local, 'Bulwark', 'edit-files');
  return path.join(app.getPath('userData'), 'edit-files');
}

/**
 * Only this user, whatever the folder above allows (private-folder.ts). Without the native
 * helper it holds only where the OS's own defaults for a home folder apply.
 */
export function makeRootPrivate(root: string): Promise<boolean> {
  return makeFolderPrivate(root, { platform: process.platform, makePrivate: native().system.makeFolderPrivate, home: app.getPath('home') });
}

function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject);
  });
}

/** Whether a program has the file open so that nobody else may write: mid-save, or Word just having it open. */
async function writerHolds(file: string): Promise<boolean> {
  try {
    const handle = await openFile(file, 'r+');
    await handle.close();
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

async function looksWhole(file: string, name: string, size: number): Promise<boolean> {
  const handle = await openFile(file, 'r');
  try {
    const length = Math.min(size, EDIT_TAIL_BYTES);
    const tail = new Uint8Array(length);
    await handle.read(tail, 0, length, size - length);
    return editFileLooksWhole(name, size, tail);
  } finally {
    await handle.close();
  }
}

/** Marked as a browser's download is, so Windows and Office treat it with the same care. True once read back. */
async function markFromInternet(file: string): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  if (__BULWARK_TEST_BUILD__ && process.argv.includes('--bulwark-test-no-zone-mark')) return false;
  const stream = `${file}:Zone.Identifier`;
  try {
    await writeFile(stream, '[ZoneTransfer]\r\nZoneId=3\r\n');
    return (await readFile(stream, 'utf8')).includes('ZoneId=3');
  } catch {
    // Not NTFS: there's nowhere to put the mark.
    return false;
  }
}

function readRecords(folder: string): SessionRecord[] {
  let names: string[];
  try {
    names = readdirSync(folder);
  } catch {
    return [];
  }
  const records: SessionRecord[] = [];
  for (const name of names) {
    if (!RECORD_NAME.test(name)) continue;
    try {
      const record = JSON.parse(readFileSync(path.join(folder, name), 'utf8')) as Partial<SessionRecord>;
      const inFolder = (record.folder ?? record.id) === path.basename(folder);
      const valid = inFolder
        && typeof record.id === 'string'
        && typeof record.name === 'string' && editFileName(record.name) === record.name
        && typeof record.baseHash === 'string' && typeof record.currentHash === 'string'
        && typeof record.touchedAt === 'number' && typeof record.account === 'string' && typeof record.origin === 'string';
      if (valid) records.push({ key: '', type: '', source: '', createdAt: record.touchedAt!, version: 0, ...record } as SessionRecord);
    } catch {
      // Not one of ours, or cut off by a crash: as good as no record.
    }
  }
  return records;
}

/** Deletes a folder, and failing that at least what says what it was. */
function removeFolderNow(folder: string): boolean {
  try {
    rmSync(folder, { recursive: true, force: true });
    return true;
  } catch {
    try {
      for (const name of readdirSync(folder)) if (RECORD_NAME.test(name)) rmSync(path.join(folder, name), { force: true });
    } catch {
      // The next try.
    }
    return false;
  }
}

/** What's on the disk, for a wipe that comes before anything else in the app has started. */
function removeAllFolders(root: string, except: ReadonlySet<string> = new Set()): string[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  return names.filter((name) => !except.has(name)).map((name) => path.join(root, name)).filter((folder) => !removeFolderNow(folder));
}

export interface EditHandle {
  root: string;
  sessions: () => SessionRecord[];
  /** One round of what the timers do. For tests, with a clock of their own. */
  tick: () => Promise<void>;
}

let running: { wipeEverything: (origin: string | null) => string[] } | null = null;

/** The folders of one origin's copies, from their records, for a wipe before the feature started. */
function removeFoldersOf(root: string, origin: string): string[] {
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const left: string[] = [];
  for (const name of names) {
    const folder = path.join(root, name);
    const records = readRecords(folder);
    if (records.length === 0 || !records.every((record) => record.origin === origin)) continue;
    if (!removeFolderNow(folder)) left.push(name);
  }
  return left;
}

// At load, not in setup: a policy's wipe at the start of a launch comes before any feature. Throwing
// is how the wipe hears it isn't done: it asks again, and a program may have let go by then. Each
// copy's record names the page it was opened from: a server's wipe takes those of its page.
addWipeStep(async ({ origin }) => {
  const left = running
    ? running.wipeEverything(origin)
    : origin === null ? removeAllFolders(editRoot()).map((folder) => path.basename(folder)) : removeFoldersOf(editRoot(), origin);
  if (left.length > 0) throw new Error(`${left.length} edited files are held by another program`);
});

export function setupEdit(hub: OsHub): EditHandle {
  if (__BULWARK_TEST_BUILD__ && !app.isPackaged) {
    const extension = process.argv.find((arg) => arg.startsWith('--bulwark-test-edit-extension='))?.split('=')[1];
    if (extension) allowEditExtensionForTest(extension);
  }
  const { windows, origin } = hub.ctx;
  const root = editRoot();
  const sessions = new Map<string, LiveSession>();
  const tickets = new Map<number, { ticket: string; key: string; expires: number }>();
  const claims = new Map<string, Set<number>>();
  const heldFolders = new Set<string>();
  const watchedForClaims = new WeakSet<WebContents>();
  const candidates = new Map<string, { size: number; mtime: number; at: number }>();
  const scanning = new Set<string>();
  const clearAllowances = new Map<string, number>();
  let rootReady: Promise<boolean> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let lastExpiryCheck = 0;

  app.on('web-contents-created', (_event, contents) => watchUserGestures(contents));
  windows.on('created', ({ window }) => watchUserGestures(window.webContents));

  const folderIdOf = (record: SessionRecord) => record.folder ?? record.id;
  const folderOf = (record: SessionRecord) => path.join(root, folderIdOf(record));
  const filesOf = (record: SessionRecord) => path.join(folderOf(record), FILE_FOLDER);
  const fileOf = (record: SessionRecord) => path.join(filesOf(record), record.name);
  const recordFileOf = (record: SessionRecord) => path.join(folderOf(record), record.folder ? `session-${record.id}.json` : PRIMARY_RECORD);
  const claimedNow = (record: SessionRecord) => (claims.get(record.id)?.size ?? 0) > 0;
  const isChanged = (record: SessionRecord) => record.currentHash !== record.baseHash;

  const view = ({ record }: LiveSession): EditSession => ({
    id: record.id,
    name: record.name,
    type: record.type,
    account: record.account,
    source: record.source,
    changed: isChanged(record),
    version: record.version,
    hash: record.currentHash,
    claimed: claimedNow(record),
    held: !!record.closing,
    savedAs: !!record.folder,
    lastChance: isChanged(record) && Date.now() - record.touchedAt > EDIT_CHANGED_KEEP_MS,
  });

  const list = (): EditSession[] => (hub.locked ? [] : [...sessions.values()].filter(({ record }) => record.origin === origin).map(view));
  /** A window going away can leave a page that's already gone in the list for a moment. */
  const send = (sessionsNow: EditSession[]) => {
    try {
      windows.broadcast(CHANNEL.editChanged, sessionsNow);
    } catch {
      // Whoever is left hears at the next change, and asks for the list when it starts.
    }
  };
  const announce = () => {
    if (!hub.locked) send(list());
  };

  /** Temp and rename: a crash mid-write must not lose what the session is. */
  const persist = async ({ record }: LiveSession) => {
    const target = recordFileOf(record);
    const temp = `${target}.${randomBytes(4).toString('hex')}`;
    await writeFile(temp, JSON.stringify(record), { mode: 0o600 });
    await rename(temp, target);
  };

  const stopWatching = (session: LiveSession) => {
    session.watcher?.close();
    session.watcher = null;
    if (session.timer) clearTimeout(session.timer);
    session.timer = null;
  };

  /** A folder a program still holds: the poll tries it again. */
  const holdFolder = (folder: string) => {
    heldFolders.add(folder);
    startPoll();
  };

  const retryHeldFolders = () => {
    for (const folder of [...heldFolders]) if (removeFolderNow(folder)) heldFolders.delete(folder);
  };

  /**
   * True when it's gone. A program holds it otherwise, and the session stays, watched. For
   * `release` a save there is a save like any other, so what the user had asked to end comes back.
   */
  const removeSession = (session: LiveSession, mode: 'release' | 'forced' = 'release'): boolean => {
    const { record } = session;
    claims.delete(record.id);
    try {
      rmSync(fileOf(record), { force: true });
    } catch {
      if (record.closing !== 'forced') record.closing = mode;
      record.baseHash = record.currentHash;
      void persist(session).catch(() => {});
      return false;
    }
    stopWatching(session);
    sessions.delete(record.id);
    const folder = folderOf(record);
    const shared = [...sessions.values()].some((other) => folderIdOf(other.record) === folderIdOf(record));
    if (shared) rmSync(recordFileOf(record), { force: true });
    else if (!removeFolderNow(folder)) holdFolder(folder);
    return true;
  };

  const retryClosing = () => {
    let removed = false;
    for (const session of [...sessions.values()]) {
      if (session.record.closing && removeSession(session, session.record.closing)) removed = true;
    }
    retryHeldFolders();
    if (removed) announce();
  };

  const expire = () => {
    const now = Date.now();
    lastExpiryCheck = now;
    let changedAnything = false;
    for (const session of [...sessions.values()]) {
      const { record } = session;
      if (claimedNow(record) || record.closing) continue;
      const age = now - record.touchedAt;
      if (isChanged(record)) {
        if (age <= EDIT_CHANGED_KEEP_MS) continue;
        // Not gone without one last look, unless there's nobody left who could take it.
        changedAnything = true;
        const shownLongEnough = record.lastCallAt !== undefined && now - record.lastCallAt > EDIT_LAST_CALL_MS;
        if (shownLongEnough || age > EDIT_CHANGED_MAX_MS) removeSession(session);
      } else if (age > EDIT_UNCHANGED_KEEP_MS) {
        removeSession(session);
        changedAnything = true;
      }
    }
    if (changedAnything) announce();
  };

  const newLive = (record: SessionRecord): LiveSession => ({
    record,
    watcher: null,
    timer: null,
    checking: false,
    checkAgain: false,
    seenSize: -1,
    seenMtime: -1,
    missingSince: null,
    heldStat: null,
  });

  /** A file the user saved under another name, once it has settled and can be told to be whole. */
  const scanForSavedAs = async (session: LiveSession) => {
    const { record } = session;
    const folderId = folderIdOf(record);
    if (record.closing === 'forced' || scanning.has(folderId)) return;
    scanning.add(folderId);
    try {
      const dir = filesOf(record);
      const tracked = new Set([...sessions.values()].filter((other) => folderIdOf(other.record) === folderId).map((other) => other.record.name.toLowerCase()));
      for (const name of await readdir(dir)) {
        if (tracked.has(name.toLowerCase()) || isEditTempName(name) || editFileName(name) !== name) continue;
        const file = path.join(dir, name);
        const now = await stat(file).catch(() => null);
        if (!now || !now.isFile() || now.size === 0) continue;
        const seen = candidates.get(file);
        if (!seen || seen.size !== now.size || seen.mtime !== now.mtimeMs) {
          candidates.set(file, { size: now.size, mtime: now.mtimeMs, at: Date.now() });
          session.checkAgain = true;
          continue;
        }
        const wait = (await writerHolds(file)) ? HELD_STABLE_MS : STABLE_MS;
        if (Date.now() - seen.at < wait) {
          session.checkAgain = true;
          continue;
        }
        if (sessions.size >= MAX_SESSIONS || !(await looksWhole(file, name, now.size))) continue;
        const hash = await hashFile(file);
        candidates.delete(file);
        const when = Date.now();
        const added = newLive({
          id: randomBytes(8).toString('hex'),
          key: `${record.key}#${name}`,
          name,
          type: '',
          account: record.account,
          source: record.source,
          origin: record.origin,
          createdAt: when,
          touchedAt: when,
          baseHash: '',
          currentHash: hash,
          version: 1,
          folder: folderId,
        });
        added.seenSize = now.size;
        added.seenMtime = now.mtimeMs;
        sessions.set(added.record.id, added);
        startWatching(added);
        announce();
        await persist(added);
      }
    } catch {
      // The folder's going, or a file is held: the poll comes back to it.
    } finally {
      scanning.delete(folderId);
    }
  };

  const check = async (session: LiveSession): Promise<void> => {
    if (session.checking) {
      session.checkAgain = true;
      return;
    }
    session.checking = true;
    const { record } = session;
    const file = fileOf(record);
    try {
      await scanForSavedAs(session);
      const first = await stat(file).catch(() => null);
      if (!first) {
        session.missingSince ??= Date.now();
        if (Date.now() - session.missingSince > MISSING_LIMIT_MS && sessions.has(record.id)) {
          // The bytes are gone, so there's nothing to offer or keep.
          removeSession(session);
          announce();
        }
        return;
      }
      session.missingSince = null;
      if (first.size === session.seenSize && first.mtimeMs === session.seenMtime) return;
      await new Promise((resolve) => setTimeout(resolve, STABLE_MS));
      const second = await stat(file).catch(() => null);
      if (!second || second.size !== first.size || second.mtimeMs !== first.mtimeMs) {
        session.heldStat = null;
        session.checkAgain = true;
        return;
      }
      if (await writerHolds(file)) {
        // Word holds a file like this for as long as it's open, so this can't wait for it to let go.
        const held = session.heldStat;
        if (!held || held.size !== second.size || held.mtime !== second.mtimeMs) {
          session.heldStat = { size: second.size, mtime: second.mtimeMs, at: Date.now() };
          session.checkAgain = true;
          return;
        }
        if (Date.now() - held.at < HELD_STABLE_MS) {
          session.checkAgain = true;
          return;
        }
      }
      session.heldStat = null;
      // A program may hold it against reading while it writes. The seen values stay, so the next look reads again.
      const hash = await hashFile(file);
      if (hash === record.currentHash || !sessions.has(record.id)) {
        session.seenSize = second.size;
        session.seenMtime = second.mtimeMs;
        return;
      }
      // Empty or cut off: not offered, and the next look reads it again.
      if (!(await looksWhole(file, record.name, second.size))) return;
      session.seenSize = second.size;
      session.seenMtime = second.mtimeMs;
      if (record.closing === 'forced') {
        record.currentHash = hash;
        record.baseHash = hash;
        return;
      }
      delete record.closing;
      delete record.lastCallAt;
      record.currentHash = hash;
      record.version += 1;
      record.touchedAt = Date.now();
      // First: a full disk mustn't keep a save from being offered.
      announce();
      await persist(session);
    } catch {
      // Held or mid-write: the poll comes back to it.
    } finally {
      session.checking = false;
      if (session.checkAgain && sessions.has(record.id)) {
        session.checkAgain = false;
        schedule(session);
      }
    }
  };

  function schedule(session: LiveSession): void {
    if (session.timer) clearTimeout(session.timer);
    session.timer = setTimeout(() => {
      session.timer = null;
      void check(session);
    }, DEBOUNCE_MS);
    session.timer.unref?.();
  }

  // Only while there's something to look after: an idle app with no edited files doesn't wake
  // up for this. Whatever adds a session or a held folder starts it again.
  const startPoll = () => {
    pollTimer ??= setInterval(() => {
      for (const session of sessions.values()) void check(session);
      retryClosing();
      if (Date.now() - lastExpiryCheck > EXPIRY_CHECK_MS) expire();
      if (sessions.size === 0 && heldFolders.size === 0 && pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }, POLL_MS);
    pollTimer.unref?.();
  };

  /**
   * The folder, not the file: a save usually replaces the file, and a watch on the file would
   * stay on the old one. Any change looks, since it may be Save As. Office's `~$` and `~WRL`
   * files, LibreOffice's `.~lock` and an editor's swap files are never read as a save.
   */
  function startWatching(session: LiveSession): void {
    try {
      session.watcher = watch(filesOf(session.record), { persistent: false }, () => schedule(session));
      // The poll carries on without it.
      session.watcher.on('error', () => {
        session.watcher?.close();
        session.watcher = null;
      });
    } catch (error) {
      console.error('Could not watch an edited file:', error);
    }
    startPoll();
  }

  /** What the last run left: offered again if changed, gone if nobody can want it. */
  const loadSessions = async () => {
    mkdirSync(root, { recursive: true });
    for (const name of readdirSync(root)) {
      const folder = path.join(root, name);
      const records = readRecords(folder);
      if (records.length === 0) {
        if (!removeFolderNow(folder)) holdFolder(folder);
        continue;
      }
      for (const record of records) {
        const session = newLive(record);
        sessions.set(record.id, session);
        startWatching(session);
      }
    }
    startPoll();
    retryClosing();
    await Promise.all([...sessions.values()].map(check));
    expire();
    announce();
  };

  const takeTicket = (ticket: unknown, sender: WebContents, key: string | null): boolean => {
    const found = tickets.get(sender.id);
    if (typeof ticket !== 'string' || !found || found.ticket !== ticket) return false;
    tickets.delete(sender.id);
    return found.expires > Date.now() && (key === null || found.key === key);
  };

  const sessionForKey = (key: string): LiveSession | undefined => {
    for (const session of sessions.values()) {
      const { record } = session;
      if (record.origin === origin && record.closing !== 'forced' && (record.key === key || `session:${record.id}` === key)) return session;
    }
    return undefined;
  };

  const openInProgram = async (session: LiveSession): Promise<EditOpenResult> => {
    const { record } = session;
    const file = fileOf(record);
    // Each time, as a program can take the mark off when it saves.
    const marked = await markFromInternet(file);
    if (editNeedsMark(record.name) && !marked) return { ok: false, reason: 'type' };
    const problem = await shell.openPath(file).catch((error: unknown) => String(error));
    if (problem) {
      console.error('Could not open an edited file:', problem);
      return { ok: false, reason: 'no-app' };
    }
    return { ok: true, id: record.id };
  };

  const begin = (sender: WebContents, key: unknown): EditBeginResult => {
    if (hub.locked) return { ok: false, reason: 'locked' };
    if (typeof key !== 'string' || !key || key.length > 2048) return { ok: false, reason: 'gesture' };
    if (!takeUserGesture(sender)) return { ok: false, reason: 'gesture' };
    const ticket = randomBytes(16).toString('hex');
    tickets.set(sender.id, { ticket, key, expires: Date.now() + TICKET_LIFE_MS });
    const open = sessionForKey(key)?.record.id;
    return open ? { ok: true, ticket, open } : { ok: true, ticket };
  };

  const open = async (sender: WebContents, ticket: unknown, raw: unknown): Promise<EditOpenResult> => {
    if (hub.locked) return { ok: false, reason: 'locked' };
    const input = (raw ?? {}) as Partial<EditFile>;
    const { data, account, key, source, type } = input;
    if (typeof key !== 'string' || !takeTicket(ticket, sender, key)) return { ok: false, reason: 'ticket' };
    const name = editFileName(input.name);
    if (!name) return { ok: false, reason: 'type' };
    if (!(data instanceof Uint8Array) || typeof account !== 'string' || !account || account.length > 512) {
      return { ok: false, reason: 'failed' };
    }
    if (data.byteLength > MAX_FILE_BYTES) return { ok: false, reason: 'too-large' };
    if (typeof source !== 'string' || source.length > MAX_SOURCE_LENGTH) return { ok: false, reason: 'failed' };
    // A session that came to be while the bytes were on their way: its edits are the file.
    const existing = sessionForKey(key);
    if (existing) return openInProgram(existing);
    if (sessions.size >= MAX_SESSIONS) return { ok: false, reason: 'full' };

    rootReady ??= makeRootPrivate(root);
    if (!(await rootReady)) {
      rootReady = null;
      return { ok: false, reason: 'failed' };
    }
    // Short: Office stops at about 218 characters of path.
    const id = randomBytes(8).toString('hex');
    const hash = createHash('sha256').update(data).digest('hex');
    const now = Date.now();
    const record: SessionRecord = {
      id, key, name, account, source, origin,
      type: typeof type === 'string' ? type.slice(0, 200) : '',
      createdAt: now,
      touchedAt: now,
      baseHash: hash,
      currentHash: hash,
      version: 0,
    };
    const session = newLive(record);
    const file = fileOf(record);
    try {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await persist(session);
      await writeFile(file, data, { mode: 0o600 });
    } catch (error) {
      console.error('Could not write an edited file:', error);
      removeFolderNow(folderOf(record));
      return { ok: false, reason: 'failed' };
    }
    // Locked while it was being written: nothing opens now.
    if (hub.locked) {
      removeFolderNow(folderOf(record));
      return { ok: false, reason: 'locked' };
    }
    sessions.set(id, session);
    const result = await openInProgram(session);
    if (!result.ok) {
      removeSession(session);
      announce();
      return result;
    }
    const written = await stat(file).catch(() => null);
    session.seenSize = written?.size ?? -1;
    session.seenMtime = written?.mtimeMs ?? -1;
    startWatching(session);
    announce();
    return result;
  };

  const reopen = async (sender: WebContents, ticket: unknown, id: unknown): Promise<EditOpenResult> => {
    if (hub.locked) return { ok: false, reason: 'locked' };
    const session = typeof id === 'string' ? sessions.get(id) : undefined;
    if (!session || session.record.origin !== origin || session.record.closing === 'forced') return { ok: false, reason: 'failed' };
    const found = tickets.get(sender.id)?.key;
    const matches = found === session.record.key || found === `session:${session.record.id}`;
    if (!matches || !takeTicket(ticket, sender, null)) return { ok: false, reason: 'ticket' };
    session.record.touchedAt = Date.now();
    delete session.record.closing;
    await persist(session).catch(() => {});
    return openInProgram(session);
  };

  const read = async (id: unknown): Promise<EditReadResult> => {
    if (hub.locked) return { ok: false, reason: 'locked' };
    const session = typeof id === 'string' ? sessions.get(id) : undefined;
    if (!session || session.record.origin !== origin || session.record.closing === 'forced') return { ok: false, reason: 'missing' };
    const { record } = session;
    const file = fileOf(record);
    try {
      const before = await stat(file);
      if (before.size > MAX_FILE_BYTES) return { ok: false, reason: 'too-large' };
      const data = await readFile(file);
      const after = await stat(file);
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) return { ok: false, reason: 'busy' };
      const tail = new Uint8Array(data.buffer, data.byteOffset + Math.max(0, data.length - EDIT_TAIL_BYTES), Math.min(data.length, EDIT_TAIL_BYTES));
      if (!editFileLooksWhole(record.name, data.length, tail)) return { ok: false, reason: 'busy' };
      return { ok: true, name: record.name, type: record.type, data, hash: createHash('sha256').update(data).digest('hex') };
    } catch (error) {
      return { ok: false, reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'busy' };
    }
  };

  /** A save a moment ago, still in the watcher's wait. Only a changed file costs any time here. */
  const settle = async (only?: LiveSession): Promise<void> => {
    const those = only ? [only] : [...sessions.values()];
    const busy = () => those.some((session) => session.checking);
    const quiet = async () => {
      for (let tries = 0; busy() && tries < 160; tries += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    };
    await quiet();
    await Promise.all(those.map(check));
    await quiet();
  };

  const taken = async (id: unknown, hash: unknown) => {
    const session = typeof id === 'string' ? sessions.get(id) : undefined;
    if (!session || typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) return;
    // A save after this read stays a change.
    session.record.baseHash = hash;
    session.record.touchedAt = Date.now();
    delete session.record.lastCallAt;
    announce();
    await persist(session).catch(() => {});
  };

  const ask = async (message: string, detail: string, confirm: string): Promise<boolean> => {
    const options = { type: 'warning' as const, title: 'Bulwark', message, detail, buttons: [confirm, strings().editCancel], defaultId: 1, cancelId: 1, noLink: true };
    const parent = windows.mainWindow();
    const answer = parent && !parent.isDestroyed() ? await showMessageBox(parent, options) : await showMessageBox(options);
    return answer.response === 0;
  };

  const namesLine = (names: readonly string[]) => names.slice(0, 5).join(', ') + (names.length > 5 ? ', …' : '');
  const ofAccount = (account: string | null) => [...sessions.values()].filter(({ record }) => record.origin === origin && !record.closing && (account === null || record.account === account));

  const release = async (id: unknown, source: unknown) => {
    const session = typeof id === 'string' ? sessions.get(id) : undefined;
    if (!session || session.record.origin !== origin) return;
    // The page's flag can be a moment behind, and this decides whether a save survives.
    await settle(session);
    claims.delete(session.record.id);
    if (isChanged(session.record)) {
      if (typeof source === 'string' && source.length <= MAX_SOURCE_LENGTH) session.record.source = source;
      await persist(session).catch(() => {});
    } else {
      removeSession(session);
    }
    announce();
  };

  /** A page's word to delete: what's only a copy goes, and the user's edits take the user's yes. */
  const discard = async (id: unknown): Promise<EditClearResult> => {
    const session = typeof id === 'string' ? sessions.get(id) : undefined;
    if (hub.locked || !session || session.record.origin !== origin) return { held: [], refused: true };
    await settle(session);
    if (isChanged(session.record)) {
      const text = strings();
      const yes = await ask(text.editDiscardTitle.replaceAll('{name}', session.record.name), `${text.editDiscardDetail} ${text.editOutsideNote}`, text.editDiscardConfirm);
      if (!yes) return { held: [], refused: true };
    }
    const gone = removeSession(session);
    announce();
    return { held: gone ? [] : [session.record.name] };
  };

  const heldNamesOf = async (account: string | null): Promise<string[]> => {
    const held: string[] = [];
    for (const { record } of ofAccount(account)) if (await writerHolds(fileOf(record))) held.push(record.name);
    return held;
  };

  /** The question before a sign-out. A yes covers the deleting that follows. */
  const askClear = async (account: unknown): Promise<boolean> => {
    if (typeof account !== 'string') return true;
    await settle();
    const changed = ofAccount(account).filter(({ record }) => isChanged(record)).map(({ record }) => record.name);
    const held = await heldNamesOf(account);
    if (changed.length === 0 && held.length === 0) return true;
    const text = strings();
    const parts = [
      ...(changed.length ? [text.editSignOutChanged.replaceAll('{names}', namesLine(changed))] : []),
      ...(held.length ? [text.editSignOutHeld.replaceAll('{names}', namesLine(held))] : []),
      text.editOutsideNote,
    ];
    const yes = await ask(text.editSignOutTitle, parts.join(' '), text.editSignOutConfirm);
    if (yes) clearAllowances.set(account, Date.now() + CLEAR_ALLOWANCE_MS);
    return yes;
  };

  const clear = async (account: unknown): Promise<EditClearResult> => {
    if (hub.locked || (account !== null && typeof account !== 'string')) return { held: [], refused: true };
    const named = account as string | null;
    await settle();
    const allowed = named !== null && (clearAllowances.get(named) ?? 0) > Date.now();
    if (named !== null) clearAllowances.delete(named);
    const changed = ofAccount(named).filter(({ record }) => isChanged(record)).map(({ record }) => record.name);
    if (changed.length > 0 && !allowed) {
      const text = strings();
      const yes = await ask(text.editClearTitle, `${text.editSignOutChanged.replaceAll('{names}', namesLine(changed))} ${text.editOutsideNote}`, text.editClearConfirm);
      if (!yes) return { held: [], refused: true };
    }
    const held: string[] = [];
    for (const session of ofAccount(named)) if (!removeSession(session)) held.push(session.record.name);
    announce();
    return { held };
  };

  /** A wipe: asks nobody, and nothing that's written afterwards is offered. */
  const wipe = (account: unknown): EditClearResult => {
    if (account !== null && typeof account !== 'string') return { held: [], refused: true };
    const named = account as string | null;
    const held: string[] = [];
    for (const session of [...sessions.values()]) {
      const { record } = session;
      if (record.origin === origin && (named === null || record.account === named) && !removeSession(session, 'forced')) held.push(record.name);
    }
    announce();
    return { held };
  };

  /** The organisation said no. */
  const forceDiscard = (id: unknown): EditClearResult => {
    const session = typeof id === 'string' ? sessions.get(id) : undefined;
    if (!session || session.record.origin !== origin) return { held: [], refused: true };
    const gone = removeSession(session, 'forced');
    announce();
    return { held: gone ? [] : [session.record.name] };
  };

  /** `owner`: that page's copies only. Null: everyone's, and whatever else is in the folder. */
  const wipeEverything = (owner: string | null): string[] => {
    const left: string[] = [];
    for (const session of [...sessions.values()]) {
      if (owner !== null && session.record.origin !== owner) continue;
      if (!removeSession(session, 'forced')) left.push(session.record.name);
    }
    if (owner === null) {
      const stillThere = new Set([...sessions.values()].map(({ record }) => folderIdOf(record)));
      for (const folder of removeAllFolders(root, stillThere)) {
        holdFolder(folder);
        left.push(path.basename(folder));
      }
    }
    announce();
    return left;
  };
  running = { wipeEverything };

  const setClaim = (sender: WebContents, id: unknown, on: unknown) => {
    if (typeof id !== 'string' || !sessions.has(id)) return;
    const holders = claims.get(id) ?? new Set<number>();
    if (on === true) holders.add(sender.id);
    else holders.delete(sender.id);
    if (holders.size > 0) claims.set(id, holders);
    else claims.delete(id);
    if (!watchedForClaims.has(sender)) {
      watchedForClaims.add(sender);
      // A composer that went without saying so, with its window or by a reload.
      const senderId = sender.id;
      const dropAll = () => {
        for (const [claimed, set] of claims) {
          if (set.delete(senderId) && set.size === 0) claims.delete(claimed);
        }
        // Not from inside the event: its window may be half gone.
        setImmediate(announce);
      };
      sender.once('destroyed', dropAll);
      sender.on('did-navigate', dropAll);
    }
    announce();
  };

  // Nothing while it's locked. What changed meanwhile comes with the unlock.
  hub.on('locked', (locked) => send(locked ? [] : list()));

  const { ctx } = hub;
  ctx.handle(CHANNEL.editBegin, (event, _window, key) => begin(event.sender, key));
  ctx.handle(CHANNEL.editOpen, (event, _window, ticket, file) => open(event.sender, ticket, file));
  ctx.handle(CHANNEL.editReopen, (event, _window, ticket, id) => reopen(event.sender, ticket, id));
  ctx.handle(CHANNEL.editList, () => list());
  ctx.handle(CHANNEL.editSettle, async () => {
    await settle();
    return list();
  });
  ctx.handle(CHANNEL.editRead, (_event, _window, id) => read(id));
  ctx.handle(CHANNEL.editTaken, (_event, _window, id, hash) => taken(id, hash));
  ctx.handle(CHANNEL.editRelease, (_event, _window, id, source) => release(id, source));
  ctx.handle(CHANNEL.editDiscard, (_event, _window, id) => discard(id));
  ctx.handle(CHANNEL.editForceDiscard, (_event, _window, id) => forceDiscard(id));
  ctx.handle(CHANNEL.editAskClear, (_event, _window, account) => askClear(account));
  ctx.handle(CHANNEL.editClear, (_event, _window, account) => clear(account));
  ctx.handle(CHANNEL.editWipe, (_event, _window, account) => wipe(account));
  ctx.on(CHANNEL.editSetSource, (_event, _window, id, source) => {
    const session = typeof id === 'string' ? sessions.get(id) : undefined;
    if (!session || typeof source !== 'string' || source.length > MAX_SOURCE_LENGTH || session.record.source === source) return;
    session.record.source = source;
    void persist(session).catch(() => {});
    announce();
  });
  ctx.on(CHANNEL.editClaim, (event, _window, id, on) => setClaim(event.sender, id, on));
  ctx.on(CHANNEL.editShown, (_event, _window, id) => {
    const session = typeof id === 'string' ? sessions.get(id) : undefined;
    if (!session || session.record.lastCallAt !== undefined || !view(session).lastChance) return;
    session.record.lastCallAt = Date.now();
    void persist(session).catch(() => {});
  });

  app.on('will-quit', () => {
    // Everything stays for the next start. Only what watches it goes.
    for (const session of sessions.values()) stopWatching(session);
    if (pollTimer) clearInterval(pollTimer);
  });

  void loadSessions().catch((error: unknown) => console.error('Could not read the edited files:', error));

  return {
    root,
    sessions: () => [...sessions.values()].map(({ record }) => record),
    tick: async () => {
      await settle();
      retryClosing();
      expire();
    },
  };
}
