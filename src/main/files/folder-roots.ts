/**
 * The folders the user picked, as roots: kept in the store between runs, listed in the
 * registry while they sync, and taken away by the user, the policy or a wipe. Taking one away
 * stops its writes and reads, and forgets it with the engine's record of it; the files in the
 * folder stay, they were the user's. No Electron here, so tests can drive it
 * (features/files-folders.ts wires it up).
 */

import { randomBytes } from 'node:crypto';
import type { FilesRoot } from '../../shared/bridge';
import type { FilesDisk } from './disk';
import type { FilesReadGrants } from './read-grants';
import type { filesRegistry } from './registry';
import { validRootId, type FolderRootStore, type StoredFolderRoot } from './store';

export interface FolderRootsOptions {
  store: FolderRootStore;
  registry: typeof filesRegistry;
  disk: FilesDisk;
  grants: FilesReadGrants;
  origin: string;
  /** `FilesFolderSyncEnabled` now. */
  allowed: () => boolean;
}

export function toRoot(stored: StoredFolderRoot): FilesRoot {
  return {
    id: stored.id,
    kind: 'folder',
    account: stored.account,
    path: stored.dir,
    remoteId: stored.remoteId,
    remoteLabel: stored.remoteLabel,
    paused: stored.paused,
    createdAt: stored.createdAt,
  };
}

export class FolderRoots {
  constructor(private readonly options: FolderRootsOptions) {}

  /** Those of this origin, back in the registry. With the policy off, none, and the list goes. */
  async load(): Promise<void> {
    if (!this.options.allowed()) {
      await this.applyPolicy();
      return;
    }
    const { registry, origin } = this.options;
    for (const stored of await this.options.store.list()) {
      if (stored.origin !== origin || registry.get(stored.id)) continue;
      registry.add({ root: toRoot(stored), dir: stored.dir });
    }
  }

  /** `dir` resolved and checked by the caller. Kept before it's listed, so a crash can't lose the choice. */
  async add(dir: string, request: { account: string; remoteId: string | null; remoteLabel: string }, now = Date.now()): Promise<FilesRoot> {
    const stored: StoredFolderRoot = {
      id: randomBytes(12).toString('base64url'),
      account: request.account,
      origin: this.options.origin,
      dir,
      remoteId: request.remoteId,
      remoteLabel: request.remoteLabel,
      paused: false,
      createdAt: now,
    };
    await this.options.store.add(stored);
    const root = toRoot(stored);
    this.options.registry.add({ root, dir });
    return root;
  }

  ids(match: (root: FilesRoot) => boolean = () => true): string[] {
    return this.options.registry.list().filter((entry) => entry.root.kind === 'folder' && match(entry.root)).map((entry) => entry.root.id);
  }

  /** Forgotten, with their writes, reads and the engine's record. Their files stay. */
  async remove(ids: readonly string[]): Promise<void> {
    const { registry, grants, disk, store } = this.options;
    for (const id of ids) {
      grants.revokeRoot(id);
      registry.remove(id);
    }
    await disk.abortWrites((rootId) => ids.includes(rootId));
    await store.removeWhere((stored) => ids.includes(stored.id));
    for (const id of ids) if (validRootId(id)) await store.removeState(id);
  }

  async setPaused(id: string, paused: boolean): Promise<void> {
    const { registry, grants, disk, store } = this.options;
    const entry = registry.get(id);
    if (!entry || entry.root.paused === paused) return;
    if (entry.root.kind === 'folder') await store.update(id, { paused });
    if (paused) {
      grants.revokeRoot(id);
      await disk.abortWrites((rootId) => rootId === id);
    }
    registry.update(id, { paused });
  }

  /** The policy forced off: every folder root goes, every origin's. */
  async applyPolicy(): Promise<void> {
    if (this.options.allowed()) return;
    await this.remove(this.ids());
    await this.options.store.removeWhere(() => true);
  }

  /**
   * A wipe. One account: its folder roots and the engine's records of its roots, the drive's
   * too (the drive takes its own folder). Every account of `owner`: that page's folder roots
   * and their records, and what this run has going if it's this page. Owner null: all of it,
   * every origin's.
   */
  async wipe(account: string | null, owner: string | null): Promise<void> {
    const { registry, grants, disk, store, origin } = this.options;
    if (account === null && owner === null) {
      grants.revokeAll();
      for (const id of this.ids()) registry.remove(id);
      await disk.abortWrites();
      await store.removeAll();
      return;
    }
    if (account === null) {
      if (owner === origin) {
        grants.revokeAll();
        for (const id of this.ids()) registry.remove(id);
        await disk.abortWrites();
      }
      await store.removeWhere((stored) => stored.origin === owner);
      return;
    }
    const ofAccount = registry.list().filter((entry) => entry.root.account === account).map((entry) => entry.root.id);
    await this.remove(this.ids((root) => root.account === account));
    await store.removeWhere((stored) => stored.origin === origin && stored.account === account);
    for (const id of ofAccount) if (validRootId(id)) await store.removeState(id);
  }
}
