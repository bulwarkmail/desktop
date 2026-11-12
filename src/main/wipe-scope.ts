/**
 * What a wipe covers, with no Electron in it, so the unit specs and the drive's controller can
 * load it. The wipe itself is features/local-wipe.ts.
 *
 * A wipe a server's page asks for, and the remote wipe its admin sends through that page, take
 * that server's things on this device and nothing of another server's. Only the WipeOfflineData
 * policy, which the machine's administrator sets, takes the whole profile.
 */

import { readdirSync } from 'node:fs';
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

/** What of a wiped partition's folder goes: all of it, or all but the local storage the page keeps. */
export function partitionLeftovers(entries: readonly string[], keepLocalStorage: boolean): string[] {
  return keepLocalStorage ? entries.filter((name) => name.toLowerCase() !== 'local storage') : [...entries];
}

/**
 * True when nothing that should go is left. A file still held (in use, by another program) leaves
 * it for the next try. Never through a link (remove-tree.ts): a folder that is itself a link goes
 * as the link, and what it points at stays.
 */
export function removePartitionFolder(folder: string, keepLocalStorage: boolean): boolean {
  try {
    if (!keepLocalStorage || isLinkPath(folder)) {
      removeOwn(folder);
      return true;
    }
    let names: string[];
    try {
      names = readdirSync(folder);
    } catch {
      return true;
    }
    for (const name of partitionLeftovers(names, true)) removeOwn(path.join(folder, name), { root: folder });
    return true;
  } catch (error) {
    console.warn(`A wiped partition's folder could not be removed yet, the next start tries again (${folder}): ${(error as Error).message}`);
    return false;
  }
}

/**
 * The removals a wipe left for this start. `left`: what goes on waiting for the next start.
 * `gone`: the partitions whose folder went as a whole. An entry that names no partition folder
 * is dropped and touches nothing.
 */
export function settlePendingRemovals(userData: string, pending: unknown, remove = removePartitionFolder): { left: PendingRemoval[]; gone: string[] } {
  const left: PendingRemoval[] = [];
  const gone: string[] = [];
  for (const entry of Array.isArray(pending) ? pending : []) {
    const partition = (entry as PendingRemoval | null)?.partition;
    const folder = typeof partition === 'string' ? partitionFolder(userData, partition) : null;
    if (!folder) continue;
    const keepLocalStorage = (entry as PendingRemoval).keepLocalStorage === true;
    if (!remove(folder, keepLocalStorage)) left.push({ partition: partition!, ...(keepLocalStorage ? { keepLocalStorage } : {}) });
    else if (!keepLocalStorage) gone.push(partition!);
  }
  return { left, gone };
}
