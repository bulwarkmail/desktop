/**
 * Deleting what the app keeps on this device, by main. A page only sees its own partition, and
 * a same-origin plugin could say it was done without doing it, so no renderer takes part and
 * none decides.
 *
 * Whose things go (wipe-scope.ts):
 * - A wipe a server's page asks for (its settings, or its admin's remote wipe) takes that
 *   server's things and nothing of another server's: its partition, and the shell's records
 *   keyed to its origin. Nobody is asked: the page asked its own question, and a remote wipe has
 *   nobody to ask. The servers this device approved and the CORS origins are the standalone
 *   page's, and go with its wipe only.
 * - "Change connection…" offers the same for the server being left (index.ts).
 * - Only the WipeOfflineData policy takes everything: every partition of the profile, and every
 *   origin's records. That's `runLocalWipe`.
 *
 * What a feature keeps goes with `addWipeStep`: each step hears whose things go. A remote wipe
 * and a wipe from settings run in the page, which holds the account list and the instance's
 * answer. At their end they call `wipeForPage`, handed to the page through `claim`, so not to a
 * frame. That runs the steps and answers what failed, because a remote wipe mustn't be reported
 * as done with a step undone. Then `finishWipeForPage` restarts, once the page has told the
 * instance. One account of several: only what's that account's, and no restart.
 *
 * A wipe with windows open ends in a restart, so whoever's there lands on a clean first
 * screen. A wipe at the start, before any window, goes on into that same start: there's
 * nothing to leave behind, and a step that failed mustn't restart the app for ever. It
 * runs again at the next start.
 *
 * What a wipe covers goes completely. The clear calls leave files in the partition's folder:
 * Chromium's network state lists every server it talked to, and caches remain. A session's own
 * files can't be deleted while it runs, so a wiped partition's folder goes at the next start,
 * before any session opens it (`removeWipedPartitions`). The note of it is in the state file, so
 * a crash before the restart doesn't lose it, and it goes once the folder has. A folder nothing
 * has opened in this run, as at a policy's wipe at the start, goes at once.
 */

import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { BrowserWindow, session as electronSession, type Session } from 'electron';
import { APP_ORIGIN } from '../../server/protocol';
import { APP_PARTITION, instancePartition } from '../app-session';
import type { StateFile } from '../state';
import { partitionFolder, settlePendingRemovals, urlOfOrigin, wipeCovers, type WipeReason, type WipeScope } from '../wipe-scope';

export type { WipeReason, WipeScope } from '../wipe-scope';

export type WipeStep = (scope: WipeScope) => Promise<void>;

const steps = new Set<WipeStep>();
/** The steps that also go for one account of several: what can't be told apart, and costs little. */
const accountSteps = new Set<WipeStep>();

/** How long a page gets to go. A hung one is destroyed with the rest at the restart. */
const LEAVE_MS = 5_000;

let restartApp: (() => void) | null = null;
let wiping = false;

/** The app's own restart: src/main/index.ts. */
export function restartAfterWipe(restart: () => void): void {
  restartApp = restart;
}

/** A page's "leave this site?" has nobody to ask and nothing to keep: windows.ts goes by this. */
export function wipeUnderWay(): boolean {
  return wiping;
}

export function addWipeStep(step: WipeStep, { perAccount = false } = {}): () => void {
  steps.add(step);
  if (perAccount) accountSteps.add(step);
  return () => {
    steps.delete(step);
    accountSteps.delete(step);
  };
}

/**
 * What the app noted as it opened each partition. The folder on disk can't stand in for
 * that: Electron lowercases its name, and opening a session under the lowercase name while
 * another has the same folder open hangs both.
 */
export function knownPartitions(state: StateFile): string[] {
  return [...(state.data.partitions ?? [])];
}

/** Partition folders nobody noted, from a profile older than the notes. Absolute paths. */
export function unnotedPartitionFolders(userData: string, state: StateFile): string[] {
  const noted = new Set(knownPartitions(state).map((partition) => partition.replace(/^persist:/, '').toLowerCase()));
  const root = path.join(userData, 'Partitions');
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !noted.has(entry.name.toLowerCase()))
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

/** The partitions a session was opened for in this run: their files are held until the process ends. */
const opened = new Set<string>();

export function notePartition(state: StateFile, partition: string): void {
  opened.add(partition);
  const known = state.data.partitions ?? [];
  if (known.includes(partition)) return;
  state.data.partitions = [...known, partition];
  state.save();
}

function sessionOf(partition: string): Session {
  opened.add(partition);
  return electronSession.fromPartition(partition);
}

/** The partition a page of `origin` stands on (index.ts opens it). */
function partitionOf(origin: string): string {
  return origin === APP_ORIGIN ? APP_PARTITION : instancePartition(origin);
}

/** That partition's folder goes at the next start, all of it or all but the local storage. Written at once. */
function removeAtNextStart(state: StateFile, partition: string, keepLocalStorage: boolean): void {
  const others = (state.data.partitionsToRemove ?? []).filter((entry) => entry.partition !== partition);
  state.data.partitionsToRemove = [...others, { partition, ...(keepLocalStorage ? { keepLocalStorage } : {}) }];
  state.save();
}

/**
 * At the start, before any session: the folders the last wipe left to go. What can't go yet (a
 * file still held) stays noted for the next start, and the log says so; the start goes on. A
 * partition whose whole folder went is no longer one this profile has.
 */
export function removeWipedPartitions(userData: string, state: StateFile): void {
  const pending = state.data.partitionsToRemove;
  if (pending === undefined) return;
  const { left, gone } = settlePendingRemovals(userData, pending);
  if (gone.length > 0) state.data.partitions = (state.data.partitions ?? []).filter((partition) => !gone.includes(partition));
  if (left.length > 0) state.data.partitionsToRemove = left;
  else delete state.data.partitionsToRemove;
  state.save();
}

async function leaveWindows(): Promise<boolean> {
  const windows = BrowserWindow.getAllWindows();
  await Promise.all(
    windows.map(async (window) => {
      if (window.isDestroyed()) return;
      // A page holds its database open, and an open file can't be deleted.
      await Promise.race([
        window.webContents.loadURL('about:blank').catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, LEAVE_MS)),
      ]);
    }),
  );
  return windows.length > 0;
}

/**
 * After the caller has written down what's done: its `await` goes first. Destroyed, not
 * closed: a close would ask pages that are gone, and there's nothing left to save.
 */
function restartSoon(): void {
  setImmediate(() => {
    for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.destroy();
    restartApp?.();
  });
}

export interface WipeResult {
  partitions: string[];
  failed: string[];
}

/**
 * The shell's own records of whose things go: `origin`'s, or everyone's for null. The windows
 * to bring back name drafts and messages. The servers approved on this device, the CORS
 * origins and the browser sign-in's ports are the standalone page's: only its wipe takes them.
 */
function forgetShellRecords(state: StateFile, origin: string | null): void {
  const { data } = state;
  // A wipe at the start comes before any window manager.
  const sessionLeft = (data.session ?? []).filter((entry) => !urlOfOrigin(entry.url, origin));
  if (sessionLeft.length > 0) data.session = sessionLeft;
  else delete data.session;
  delete data.restoreAttempts;
  if (data.resumeAfterRestart && wipeCovers(origin, data.resumeAfterRestart.origin)) delete data.resumeAfterRestart;
  if (origin === null || origin === APP_ORIGIN) {
    // Which servers this device signed in to through the browser.
    delete data.signInPorts;
    data.corsOrigins = [];
    data.approvedServers = [];
  }
  data.overlayByOrigin = origin === null ? {} : Object.fromEntries(Object.entries(data.overlayByOrigin ?? {}).filter(([owner]) => owner !== origin));
  if (data.keystoreOrigins) data.keystoreOrigins = data.keystoreOrigins.filter((owner) => !wipeCovers(origin, owner));
  if (data.recentFilesOrigins) data.recentFilesOrigins = data.recentFilesOrigins.filter((owner) => !wipeCovers(origin, owner));
  if (data.importJobs) data.importJobs = data.importJobs.filter((job) => !wipeCovers(origin, job.origin));
  if (data.filesDriveConsent) data.filesDriveConsent = data.filesDriveConsent.filter((entry) => !wipeCovers(origin, entry.origin));
  state.save();
}

/** Each step, whatever another did. Answers what failed, by the step's own words. */
async function runSteps(scope: WipeScope): Promise<string[]> {
  const failed: string[] = [];
  for (const step of steps) {
    try {
      await step(scope);
    } catch (error) {
      console.error('A wipe step failed:', error);
      failed.push((error as Error)?.message || 'step');
    }
  }
  return failed;
}

/** How long a page gets after main's steps, to tell the instance. It may have gone by then. */
const FINISH_WAIT_MS = 20_000;
let finishWaiting: ReturnType<typeof setTimeout> | null = null;
/** The partition and state of the page's wipe that waits for its finish. */
let finishing: { partition: string; state: StateFile } | null = null;

/**
 * What the page can't do, for its own server only: `origin` is the page's, `sender` its
 * partition's session, which goes in `finishWipeForPage`. Answers what failed.
 */
export async function wipeForPage({ reason, account }: { reason: 'remote' | 'settings'; account: string | null }, sender: Session, origin: string, state: StateFile): Promise<string[]> {
  const failed: string[] = [];
  if (account !== null) {
    try {
      await sender.clearCache();
      for (const step of accountSteps) await step({ reason, origin, account });
    } catch (error) {
      console.error('Wiping an account failed:', error);
      failed.push('account');
    }
    return failed;
  }
  wiping = true;
  failed.push(...(await wipeServer(reason, sender, origin, state)));
  if (failed.length > 0) {
    wiping = false;
    return failed;
  }
  // Until the page says otherwise, its local storage stays: a crash before the finish keeps what
  // says whom to tell, as the finish without the page's word does.
  finishing = { partition: partitionOf(origin), state };
  removeAtNextStart(state, finishing.partition, true);
  // A page that goes before it gets to finish: the next start would stop here anyway.
  finishWaiting = setTimeout(() => void finishWipeForPage(sender, true), FINISH_WAIT_MS);
  return failed;
}

/**
 * One server's things: its partition's cache and sign-ins, every step's part, and its records.
 * The records last: the drive's step tells an older account's page by the yes kept there. The
 * storage is the caller's.
 */
async function wipeServer(reason: WipeReason, session: Session, origin: string, state: StateFile): Promise<string[]> {
  const failed: string[] = [];
  try {
    await session.clearCache();
    await session.clearAuthCache();
  } catch (error) {
    console.error('Clearing the cache failed:', error);
    failed.push('cache');
  }
  failed.push(...(await runSteps({ reason, origin, account: null })));
  forgetShellRecords(state, origin);
  return failed;
}

/**
 * The partition the page stood on, and the restart. Only after a `wipeForPage` that went through.
 * `keepLocalStorage`: the instance hasn't heard yet, and all that says who to tell is there. The
 * page took the rest of it out already.
 */
export async function finishWipeForPage(sender: Session, keepLocalStorage: boolean): Promise<void> {
  if (!finishWaiting) return;
  clearTimeout(finishWaiting);
  finishWaiting = null;
  if (finishing) removeAtNextStart(finishing.state, finishing.partition, keepLocalStorage);
  finishing = null;
  await leaveWindows();
  try {
    await sender.clearStorageData(keepLocalStorage
      ? { storages: ['cookies', 'filesystem', 'indexdb', 'shadercache', 'serviceworkers', 'cachestorage'] }
      : undefined);
  } catch (error) {
    console.error('Clearing the page\'s storage failed:', error);
  }
  restartSoon();
}

/**
 * "Change connection…" with the user's yes to removing the server being left: the same as that
 * server's own wipe, with nobody left to tell. The windows go blank first, as a page holds its
 * database open; the switch's restart follows. Answers what failed.
 */
export async function wipeForConnectionChange(session: Session, origin: string, state: StateFile): Promise<string[]> {
  wiping = true;
  await leaveWindows();
  const failed = await wipeServer('connection', session, origin, state);
  try {
    await session.clearStorageData();
  } catch (error) {
    console.error('Clearing the storage failed:', error);
    failed.push('storage');
  }
  removeAtNextStart(state, partitionOf(origin), false);
  return failed;
}

/**
 * Everything, the HTTP cache too: it held whatever the mail server sent before a page asked
 * for `no-store`, attachments and whole messages among it. Sign-ins go too: the keys and the
 * account list do, and a cookie with no account would only confuse the start-up. So do the
 * mail servers this profile has used: a device told to remove everything doesn't keep their
 * names. Done means every partition finished: on any failure the caller asks again next time.
 * Only the WipeOfflineData policy asks for this.
 */
export async function runLocalWipe(reason: WipeReason, userData: string, state: StateFile): Promise<WipeResult> {
  wiping = true;
  const hadWindows = await leaveWindows();
  const partitions = knownPartitions(state);
  const failed: string[] = [];
  // No session has these open, and none may: see knownPartitions.
  for (const folder of unnotedPartitionFolders(userData, state)) {
    try {
      rmSync(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch (error) {
      console.error(`Wiping ${folder} failed:`, error);
      failed.push(folder);
    }
  }
  const removed: string[] = [];
  for (const partition of partitions) {
    // Nothing has its files open yet in this run: the folder goes now, the network state with it.
    const folder = partitionFolder(userData, partition);
    if (folder && !opened.has(partition)) {
      try {
        rmSync(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
        removed.push(partition);
        continue;
      } catch (error) {
        console.warn(`Removing ${folder} failed, it is cleared now and goes at the next start:`, error);
      }
    }
    try {
      const session = sessionOf(partition);
      await session.clearStorageData();
      await session.clearCache();
      await session.clearAuthCache();
    } catch (error) {
      console.error(`Wiping ${partition} failed:`, error);
      failed.push(partition);
    }
    if (folder) removeAtNextStart(state, partition, false);
  }
  if (removed.length > 0) state.data.partitions = (state.data.partitions ?? []).filter((partition) => !removed.includes(partition));
  failed.push(...(await runSteps({ reason, origin: null, account: null })));
  forgetShellRecords(state, null);
  if (hadWindows) restartSoon();
  else wiping = false;
  return { partitions, failed };
}

/**
 * OfflineEnabled forced off, for the partitions no page is using: each page clears its
 * own account by account, and the others would otherwise keep their mail until someone
 * opens them. The store's files only: S/MIME keys and plugin data have nothing to do
 * with it, and a store key with no file is already understood as gone.
 */
export async function clearStoreFiles(userData: string, state: StateFile, except: readonly Session[] = []): Promise<string[]> {
  const failed: string[] = [];
  for (const folder of unnotedPartitionFolders(userData, state)) {
    try {
      rmSync(path.join(folder, 'File System'), { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch (error) {
      console.error(`Clearing ${folder} failed:`, error);
      failed.push(folder);
    }
  }
  for (const partition of knownPartitions(state)) {
    try {
      const session = sessionOf(partition);
      if (except.includes(session)) continue;
      await session.clearStorageData({ storages: ['filesystem'] });
    } catch (error) {
      console.error(`Clearing ${partition} failed:`, error);
      failed.push(partition);
    }
  }
  return failed;
}
