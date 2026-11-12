/**
 * Whether the app is locked, decided here and nowhere else. The tray, the jump list,
 * the toasts and window titles all go by this.
 *
 * A page can always ask to lock. It can never just say "unlocked", because a pop-out or
 * a same-origin plugin frame could say the same: to lift the lock it shows a proof that
 * only the lock key's bytes give, and those exist only right after a real unlock. This
 * keeps the proof's hash, so nothing here can unlock anything. Windows Hello and Touch ID
 * run in main, and lift it themselves.
 *
 * Starts locked until it's known otherwise, so nothing shows mail in the first moments of
 * a start. An unreadable file counts as locked. No Electron in this file.
 *
 * It also counts PIN guesses (see `guess`): every guess needs main's secret, so this count
 * is the one a page, a frame or a copy of the page's records can't reset.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/** Wrong PINs that cost nothing, as on the page (the webmail's lib/app-lock/vault.ts). */
const FREE_GUESSES = 4;
const FIRST_WAIT_MS = 30_000;
const LONGEST_WAIT_MS = 60 * 60_000;
/** Locked again this soon after an unlock: something locks on its own, and the user may never get back in. */
const RELOCK_ERROR_MS = 1_000;

export function waitAfterGuesses(guesses: number): number {
  if (guesses <= FREE_GUESSES) return 0;
  return Math.min(FIRST_WAIT_MS * 2 ** (guesses - FREE_GUESSES - 1), LONGEST_WAIT_MS);
}

function digest(proof: Uint8Array): string {
  return createHash('sha256').update(proof).digest('hex');
}

/** The name an origin's files in the app-lock folder go by. */
export function appLockSite(origin: string): string {
  return createHash('sha256').update(origin).digest('hex').slice(0, 16);
}

/**
 * Whether a file in the app-lock folder is that site's: the gate's record and the Hello marker
 * (`<site>.json`, `<site>.hello.json`), and the keys main keeps for it (`<name>-<site>.bin`).
 */
export function isSiteFile(name: string, site: string): boolean {
  return name.startsWith(`${site}.`) || name.endsWith(`-${site}.bin`);
}

function recordFile(userData: string, origin: string): string {
  return path.join(userData, 'app-lock', `${appLockSite(origin)}.json`);
}

function isProof(proof: unknown): proof is Uint8Array {
  return proof instanceof Uint8Array && proof.length === 32;
}

export class AppLockGate extends EventEmitter<{ locked: [boolean]; enrolled: [boolean]; requested: [] }> {
  private file: string | null = null;
  private proofHash: string | null = null;
  private lockedNow = true;
  private guesses = 0;
  private blockedUntil = 0;
  private unlockedAt = 0;
  /** Whether the screen locking locks the app. Only an unlocked page can turn it off. */
  private screenLock = true;

  /** Features start in some order, and whichever asks first reads the profile. */
  initForProfile(userData: string, origin: string): void {
    const file = recordFile(userData, origin);
    if (this.file !== file) this.init(file);
  }

  /** Whether this run's lock is that origin's in that profile. */
  isFor(userData: string, origin: string): boolean {
    return this.file === recordFile(userData, origin);
  }

  /** Reads what's known about this profile. */
  init(file: string): void {
    this.file = file;
    let locked = false;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { proofHash?: unknown; guesses?: unknown; blockedUntil?: unknown; screenLock?: unknown };
      if (typeof parsed.proofHash === 'string') this.proofHash = parsed.proofHash;
      this.guesses = typeof parsed.guesses === 'number' ? parsed.guesses : 0;
      this.blockedUntil = typeof parsed.blockedUntil === 'number' ? parsed.blockedUntil : 0;
      // Only a clear "no" turns it off.
      this.screenLock = parsed.screenLock !== false;
      locked = true;
    } catch (error) {
      // No file: no lock here. Anything else: it can't be told, so locked.
      locked = (error as NodeJS.ErrnoException).code !== 'ENOENT';
    }
    this.set(locked);
  }

  get locked(): boolean {
    return this.lockedNow;
  }

  get enrolled(): boolean {
    return this.proofHash !== null;
  }

  get locksWithScreen(): boolean {
    return this.screenLock;
  }

  /**
   * The user's "Lock after" choice: off for "when I sign out or restart". Turning it off makes
   * the app less locked, so only while unlocked, which only the PIN or a passkey gets to.
   */
  setLocksWithScreen(on: unknown): boolean {
    if (typeof on !== 'boolean' || !this.enrolled || this.lockedNow) return false;
    if (on !== this.screenLock) {
      this.screenLock = on;
      this.write();
    }
    return true;
  }

  private set(locked: boolean): void {
    if (locked === this.lockedNow) return;
    const since = Date.now() - this.unlockedAt;
    if (locked && this.unlockedAt > 0 && since < RELOCK_ERROR_MS) console.error(`[app-lock] Locked again ${since} ms after an unlock`);
    if (!locked) this.unlockedAt = Date.now();
    this.lockedNow = locked;
    this.emit('locked', locked);
  }

  /** Only ever more locked, so anyone may ask. */
  lock(): void {
    this.set(true);
  }

  /** The screen locked, or "Lock now" in the menu or tray: the pages save and go to the lock screen. */
  requestLock(): void {
    if (!this.enrolled) return;
    this.set(true);
    this.emit('requested');
  }

  matches(proof: unknown): boolean {
    if (!isProof(proof) || !this.proofHash) return false;
    const given = Buffer.from(digest(proof), 'hex');
    const stored = Buffer.from(this.proofHash, 'hex');
    return given.length === stored.length && timingSafeEqual(given, stored);
  }

  /** Sets the lock up. Refused when there is one, or a page could replace it and then prove it. */
  enroll(proof: unknown): boolean {
    if (!isProof(proof) || this.enrolled || !this.file) return false;
    this.proofHash = digest(proof);
    this.guesses = 0;
    this.blockedUntil = 0;
    this.screenLock = true;
    this.write();
    this.set(false);
    this.emit('enrolled', true);
    return true;
  }

  /** Someone really unlocked, with the PIN or a passkey. */
  prove(proof: unknown): boolean {
    if (!this.matches(proof)) return false;
    if (this.guesses > 0 || this.blockedUntil > 0) {
      this.guesses = 0;
      this.blockedUntil = 0;
      this.write();
    }
    this.set(false);
    return true;
  }

  /**
   * One more PIN guess. Counted before anyone knows whether it's right, and only `prove`
   * clears the count. Before a lock exists there's nothing to guess at: that's setting a PIN.
   * Says until when it's refused, or 0 to go ahead.
   */
  guess(now = Date.now()): number {
    if (!this.enrolled) return 0;
    if (this.blockedUntil > now) return this.blockedUntil;
    this.guesses += 1;
    this.blockedUntil = now + waitAfterGuesses(this.guesses);
    this.write();
    return 0;
  }

  private write(): void {
    if (!this.file || !this.proofHash) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const record = { proofHash: this.proofHash, guesses: this.guesses, blockedUntil: this.blockedUntil, ...(this.screenLock ? {} : { screenLock: false }) };
    writeFileSync(this.file, JSON.stringify(record), { mode: 0o600 });
  }

  /** For main's own checks: Windows Hello or Touch ID said yes. */
  liftAfterOsCheck(): void {
    this.set(false);
  }

  disable(proof: unknown): boolean {
    if (!this.matches(proof)) return false;
    this.forget();
    return true;
  }

  /** The caller has made sure: see the feature's `forget`. */
  forget(): void {
    if (this.file) rmSync(this.file, { force: true });
    this.proofHash = null;
    this.guesses = 0;
    this.blockedUntil = 0;
    this.screenLock = true;
    this.set(false);
    this.emit('enrolled', false);
  }
}

/** One per run: a run is one mode and one origin. Locked until `init`. */
export const appLockGate = new AppLockGate();
