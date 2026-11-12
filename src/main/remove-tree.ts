/**
 * Removing a folder the app made, when a user or another program could have put a link into it:
 * a junction, a directory or file symlink, or any other entry that resolves somewhere else. Such
 * an entry goes as the link itself; nothing behind it is ever touched. Node's own recursive
 * removal can't be relied on for this: the Node in Electron 45 goes into directory junctions on
 * Windows and empties what they point at.
 *
 * `removeTree` walks with `lstat`, recurses only into real directories (one whose real path is
 * where the walk expects it), removes files and links one by one, then the directories, and
 * refuses to start at a path that is itself a link. `removeOwn` is for a name only the app uses
 * (a partition's folder, a copy's folder): a link there goes as the link, anything else as a
 * tree. No Electron here, so the unit specs run it under the test runner's Node and Electron's.
 */

import { lstatSync, readdirSync, realpathSync, rmdirSync, unlinkSync, type Stats } from 'node:fs';
import path from 'node:path';

export interface RemoveOptions {
  /**
   * A folder the target must really be inside: a link anywhere between it and the target's
   * folder refuses the removal, so nothing reached through such a link goes.
   */
  root?: string;
  /** Tries per entry for a file or folder held for a moment (EBUSY, EPERM, ENOTEMPTY). */
  tries?: number;
  delayMs?: number;
}

const BUSY = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EMFILE', 'ENFILE', 'EACCES']);

function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function retried(run: () => void, tries: number, delayMs: number): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      run();
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      if (attempt >= tries || !BUSY.has(code ?? '')) throw error;
      pause(delayMs * attempt);
    }
  }
}

const samePath = (a: string, b: string) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

function refused(target: string, why: string): Error {
  return Object.assign(new Error(`${target}: ${why}, not removed`), { code: 'ELINK' });
}

/** A directory that resolves somewhere other than where it stands is a link of some kind. */
function redirects(target: string, realParent: string): boolean {
  try {
    return !samePath(realpathSync.native(target), path.join(realParent, path.basename(target)));
  } catch {
    return true;
  }
}

/** Whether `target` is itself a link, or a directory that resolves elsewhere. False when it isn't there. */
export function isLinkPath(target: string): boolean {
  let facts: Stats;
  try {
    facts = lstatSync(target);
  } catch {
    return false;
  }
  if (facts.isSymbolicLink()) return true;
  if (!facts.isDirectory()) return false;
  try {
    return redirects(target, realpathSync.native(path.dirname(target)));
  } catch {
    return true;
  }
}

/** Throws when a link stands anywhere between `root` and `folder`. */
function checkRoot(root: string, folder: string): void {
  const relative = path.relative(root, folder);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw refused(folder, `not inside ${root}`);
  let realFolder: string;
  try {
    realFolder = realpathSync.native(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!samePath(realFolder, path.join(realpathSync.native(root), relative))) throw refused(folder, `a link stands between it and ${root}`);
}

/** Removes `target` as a link: the link goes, never what it points at. Refuses anything that isn't a link. */
export function removeLink(target: string, options: RemoveOptions = {}): void {
  if (!isLinkPath(target)) {
    if (!lstatExists(target)) return;
    throw refused(target, 'not a link');
  }
  retried(() => {
    try {
      unlinkSync(target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EISDIR') throw error;
      // A directory link on Windows.
      rmdirSync(target);
    }
  }, options.tries ?? 4, options.delayMs ?? 100);
}

function lstatExists(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

function removeEntry(target: string, facts: Stats, realParent: string, tries: number, delayMs: number): void {
  if (facts.isSymbolicLink() || (facts.isDirectory() && redirects(target, realParent))) {
    removeLink(target, { tries, delayMs });
    return;
  }
  if (!facts.isDirectory()) {
    retried(() => unlinkSync(target), tries, delayMs);
    return;
  }
  const real = path.join(realParent, path.basename(target));
  let names: string[] = [];
  try {
    names = readdirSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return;
  }
  for (const name of names) {
    const child = path.join(target, name);
    let childFacts: Stats;
    try {
      childFacts = lstatSync(child);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    removeEntry(child, childFacts, real, tries, delayMs);
  }
  retried(() => rmdirSync(target), tries, delayMs);
}

/**
 * Removes `target` and everything in it, never through a link: one met on the way goes as the
 * link. Refuses a target that is itself a link, or one reached through a link below `root`. Not
 * there: nothing to do. Throws when something can't go (held by a program); what could go is
 * gone by then.
 */
export function removeTree(target: string, options: RemoveOptions = {}): void {
  const tries = options.tries ?? 4;
  const delayMs = options.delayMs ?? 100;
  let facts: Stats;
  try {
    facts = lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (options.root) checkRoot(options.root, path.dirname(target));
  if (isLinkPath(target)) throw refused(target, 'a link');
  removeEntry(target, facts, realpathSync.native(path.dirname(target)), tries, delayMs);
}

/**
 * A name only the app uses (a partition's folder, a copy's folder, its own temp folder): a link
 * standing there goes as the link, anything else as `removeTree` takes it.
 */
export function removeOwn(target: string, options: RemoveOptions = {}): void {
  if (options.root) checkRoot(options.root, path.dirname(target));
  if (isLinkPath(target)) removeLink(target, options);
  else removeTree(target, options);
}
