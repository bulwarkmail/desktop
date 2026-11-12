/**
 * What a wipe covers, with no Electron in it, so the unit specs and the drive's controller can
 * load it. The wipe itself is features/local-wipe.ts.
 *
 * A wipe a server's page asks for, and the remote wipe its admin sends through that page, take
 * that server's things on this device and nothing of another server's. Only the WipeOfflineData
 * policy, which the machine's administrator sets, takes the whole profile.
 */

import { APP_ORIGIN } from '../server/protocol';

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
