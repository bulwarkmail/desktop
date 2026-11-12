/**
 * What a wipe covers, with no Electron in it, so the unit specs and the drive's controller can
 * load it. The wipe itself is features/local-wipe.ts.
 *
 * A wipe a server's page asks for, and the remote wipe its admin sends through that page, take
 * that server's things on this device and nothing of another server's. Only the WipeOfflineData
 * policy, which the machine's administrator sets, takes the whole profile.
 */

import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { APP_ORIGIN } from '../server/protocol';
import { isLinkPath, removeOwn } from './remove-tree';

export type WipeReason = 'policy-nonce' | 'remote' | 'settings' | 'connection';

export interface WipeScope {
  reason: WipeReason;
  /** The page whose server's things go. Null: everything in this profile, which only the policy asks for. */
  origin: string | null;
  /** One account of that origin, or null for all of it. */
  account: string | null;
}

/**
 * Whether a wipe for `origin` takes a record made for `owner`. A record from before records
 * named their origin is the standalone page's: that is what a profile was until its
 * connection was changed.
 */
export function wipeCovers(origin: string | null, owner: string | undefined): boolean {
  return origin === null || (owner ?? APP_ORIGIN) === origin;
}

/** Whether `url` is a page of `origin`. A wipe for null covers every page. */
export function urlOfOrigin(url: string, origin: string | null): boolean {
  if (origin === null) return true;
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/**
 * A wiped partition whose folder goes at the next start, before any session has it open: what
 * the clear calls leave (Chromium's network state names every server it talked to, and the
 * caches) can't be deleted while a session holds the files. `keepLocalStorage`: the page asked
 * to keep its local storage, which says whom to tell about the wipe; all else of the folder goes.
 */
export interface PendingRemoval {
  partition: string;
  keepLocalStorage?: boolean;
}

/**
 * The folder Electron keeps a `persist:` partition in: its name, lowercased. Null for any other
 * name, so nothing outside the profile's `Partitions` folder can be named.
 */
export function partitionFolder(userData: string, partition: string): string | null {
  const name = /^persist:([A-Za-z0-9_-]{1,200})$/.exec(partition)?.[1];
  return name ? path.join(userData, 'Partitions', name.toLowerCase()) : null;
}

/** A wiped partition's folder moved aside is called this: no session opens it, as no partition name has a `~`. */
const ASIDE = /^wiped~[0-9a-f]{16}$/;

export function isAsideName(name: string): boolean {
  return ASIDE.test(name);
}

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export type Rename = (from: string, to: string) => void;

/**
 * The removals a wipe left for this start, each in two steps. First the folder is moved aside,
 * in the same folder, under a name no session opens, so the next session of that server always
 * gets a fresh folder, and nothing it keeps can be taken by a removal that only succeeds later.
 * With `keepLocalStorage` the local storage moves back into a fresh folder. Tries for `waitMs`
 * while the folder is held (the run before may still be ending).
 *
 * `left`: still in place (held), to try again; a session must not open these. `gone`: the
 * partitions whose whole folder moved aside, or had none. `aside`: the names moved aside, which
 * `removeAsideFolders` takes whenever their files are free. An entry that names no partition
 * folder is dropped and touches nothing.
 */
export function settlePendingRemovals(userData: string, pending: unknown, options: { waitMs?: number; rename?: Rename } = {}): { left: PendingRemoval[]; gone: string[]; aside: string[] } {
  const rename = options.rename ?? renameSync;
  const left: PendingRemoval[] = [];
  const gone: string[] = [];
  const aside: string[] = [];
  for (const entry of Array.isArray(pending) ? pending : []) {
    const partition = (entry as PendingRemoval | null)?.partition;
    const folder = typeof partition === 'string' ? partitionFolder(userData, partition) : null;
    if (!folder) continue;
    const keepLocalStorage = (entry as PendingRemoval).keepLocalStorage === true;
    try {
      lstatSync(folder);
    } catch {
      if (!keepLocalStorage) gone.push(partition!);
      continue;
    }
    const name = `wiped~${randomBytes(8).toString('hex')}`;
    const moved = path.join(path.dirname(folder), name);
    const until = Date.now() + (options.waitMs ?? 0);
    let done = false;
    for (;;) {
      try {
        rename(folder, moved);
        done = true;
        break;
      } catch (error) {
        if (Date.now() >= until) {
          console.warn(`A wiped partition's folder is still in use, nothing opens it until it can be set aside (${folder}): ${(error as Error).message}`);
          break;
        }
        pause(250);
      }
    }
    if (!done) {
      left.push({ partition: partition!, ...(keepLocalStorage ? { keepLocalStorage } : {}) });
      continue;
    }
    aside.push(name);
    if (!keepLocalStorage) {
      gone.push(partition!);
      continue;
    }
    // Only out of a real folder: what stands behind a link isn't the app's to move.
    if (isLinkPath(moved)) continue;
    try {
      lstatSync(path.join(moved, 'Local Storage'));
      mkdirSync(folder);
      rename(path.join(moved, 'Local Storage'), path.join(folder, 'Local Storage'));
    } catch {
      // None, or it can't move back: what said whom to tell goes with the rest.
    }
  }
  return { left, gone, aside };
}

/**
 * Removes folders moved aside: the ones noted, and any left by a crash between the move and its
 * note. At most `limit` per call, so a folder that stays held costs little at each start and
 * never holds one up. Never through a link (remove-tree.ts). Answers the names still there.
 */
export function removeAsideFolders(userData: string, noted: unknown, limit = 5, remove: (folder: string) => void = (folder) => removeOwn(folder, { tries: 1 })): string[] {
  const root = path.join(userData, 'Partitions');
  let onDisk: string[] = [];
  try {
    onDisk = readdirSync(root).filter(isAsideName);
  } catch {
    // No partitions yet.
  }
  const named = (Array.isArray(noted) ? noted : []).filter((name): name is string => typeof name === 'string' && isAsideName(name));
  const present = new Set(onDisk.map((name) => name.toLowerCase()));
  const names = [...new Set([...named, ...onDisk])].filter((name) => present.has(name.toLowerCase()));
  const left: string[] = [];
  let tried = 0;
  for (const name of names) {
    if (tried >= limit) {
      left.push(name);
      continue;
    }
    tried += 1;
    try {
      remove(path.join(root, name));
    } catch {
      left.push(name);
    }
  }
  return left;
}
