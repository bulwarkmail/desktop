/**
 * Windows Hello as a second way to the app lock's key. Not a yes or no in front of a key
 * kept somewhere else: a key credential in the user's Hello container signs a fixed
 * challenge, and the page derives the key that wraps its lock key from that signature
 * (the webmail's lib/app-lock/vault.ts). Without a Hello prompt answered by the user there's
 * no signature, so a program running as this user gets nothing from DPAPI here, and a copy of
 * the disk gets nothing either: the private key stays in Windows, in the TPM where there is one.
 *
 * It relies on the signature being the same every time. Windows signs with RSA PKCS#1 v1.5 and
 * SHA-256, where one key and one message have exactly one valid signature. A new key's first
 * signature is checked against its public key as exactly that, and a key that fails the check
 * is deleted and refused, so nothing is ever wrapped under a signature that could change.
 *
 * One key credential per profile and origin, named from both, so a development run, a test run
 * and the installed app never share one. A small file next to the gate's record says it exists
 * and holds its name, so a wipe can delete every origin's. No Electron in this file.
 */

import { constants, createHash, verify } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { HelloKeyAnswer, NativeHelper } from './native-loader';

export type HelloKeys = NativeHelper['hello']['key'];

/** What a page gets back from main. Only `ok` carries a signature. */
export type HelloAnswer =
  | { ok: true; signature: Uint8Array }
  | { ok: false; reason: 'cancelled' | 'busy' | 'unavailable' | 'missing' | 'unsupported' | 'policy' | 'not-locked' | 'failed' };

export const HELLO_SALT_BYTES = 32;
const CHALLENGE_DOMAIN = 'bulwark-app-lock-hello-v1';
const MARKER_SUFFIX = '.hello.json';

/** Per profile folder and origin. Windows lists no name anywhere, so a hash says enough. */
export function helloKeyName(userData: string, origin: string): string {
  const id = createHash('sha256').update(`${path.resolve(userData).toLowerCase()}\n${origin}`).digest('hex').slice(0, 24);
  return `Bulwark app lock ${id}`;
}

/** What the key signs: never the page's bytes alone, so it signs nothing that means anything elsewhere. */
export function helloChallenge(site: string, salt: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from(`${CHALLENGE_DOMAIN}\0${site}\0`, 'utf8'), Buffer.from(salt)]);
}

/**
 * Whether this is an RSA PKCS#1 v1.5 signature over SHA-256 of `data` by this key. If it is, it's
 * the only one there can be, so the next sign gives the same bytes. A PSS signature, or any other
 * kind, fails here.
 */
export function deterministicSignature(publicKey: Uint8Array, data: Uint8Array, signature: Uint8Array): boolean {
  try {
    return verify('sha256', data, { key: Buffer.from(publicKey), format: 'der', type: 'spki', padding: constants.RSA_PKCS1_PADDING }, signature);
  } catch {
    return false;
  }
}

function reasonOf(result: HelloKeyAnswer['result']): Exclude<HelloAnswer, { ok: true }>['reason'] {
  switch (result) {
    case 'cancelled':
    case 'timeout':
      return 'cancelled';
    case 'busy':
    case 'unavailable':
    case 'missing':
      return result;
    default:
      return 'failed';
  }
}

/** Every origin's key credential this profile set up, by its marker. A wipe deletes them all. */
export async function removeAllHelloKeys(folder: string, keys: HelloKeys): Promise<void> {
  let names: string[] = [];
  try {
    names = readdirSync(folder).filter((name) => name.endsWith(MARKER_SUFFIX));
  } catch {
    return;
  }
  for (const marker of names) {
    try {
      const { name } = JSON.parse(readFileSync(path.join(folder, marker), 'utf8')) as { name?: unknown };
      if (typeof name === 'string') await keys.delete(name);
    } catch {
      // An unreadable marker names nothing to delete. The folder goes with the wipe.
    }
  }
}

/** One origin's key credential, by its marker, and the marker with it. A server's wipe deletes its own only. */
export async function removeHelloKeyOf(folder: string, site: string, keys: HelloKeys): Promise<void> {
  const marker = path.join(folder, `${site}${MARKER_SUFFIX}`);
  try {
    const { name } = JSON.parse(readFileSync(marker, 'utf8')) as { name?: unknown };
    if (typeof name === 'string') await keys.delete(name);
  } catch {
    // No marker: no key credential. An unreadable one names nothing to delete.
  }
  rmSync(marker, { force: true });
}

export class AppLockHello {
  private readonly marker: string;

  constructor(private readonly options: {
    keys: HelloKeys;
    name: string;
    site: string;
    folder: string;
    /** The AppLockHelloAllowed policy, as it stands. */
    allowed: () => boolean;
  }) {
    this.marker = path.join(options.folder, `${options.site}${MARKER_SUFFIX}`);
  }

  /** Whether this profile has a key credential for the lock. Asks Windows nothing. */
  get enrolled(): boolean {
    try {
      readFileSync(this.marker);
      return true;
    } catch {
      return false;
    }
  }

  private mark(): void {
    mkdirSync(path.dirname(this.marker), { recursive: true });
    writeFileSync(this.marker, JSON.stringify({ name: this.options.name }), { mode: 0o600 });
  }

  /**
   * A new key credential, replacing this profile's, and its signature over the challenge for this
   * salt. Anything short of a checked signature leaves no key credential behind.
   */
  async enroll(salt: Uint8Array, windowHandle: Buffer): Promise<HelloAnswer> {
    if (!this.options.allowed()) return { ok: false, reason: 'policy' };
    const data = helloChallenge(this.options.site, salt);
    const answer = await this.options.keys.create(this.options.name, data, windowHandle);
    if (answer.result === 'invalid' || answer.result === 'unavailable') return { ok: false, reason: reasonOf(answer.result) };
    // Made and then not signed with, or signed the wrong way: whatever Windows holds now goes.
    if (answer.result !== 'ok' || !answer.signature || !answer.publicKey) {
      await this.drop();
      return { ok: false, reason: reasonOf(answer.result) };
    }
    if (!deterministicSignature(answer.publicKey, data, answer.signature)) {
      await this.drop();
      return { ok: false, reason: 'unsupported' };
    }
    this.mark();
    return { ok: true, signature: new Uint8Array(answer.signature) };
  }

  /** The signature for this salt, behind a Hello prompt. The caller decides whether anyone may ask. */
  async sign(salt: Uint8Array, windowHandle: Buffer): Promise<HelloAnswer> {
    if (!this.options.allowed()) return { ok: false, reason: 'policy' };
    if (!this.enrolled) return { ok: false, reason: 'missing' };
    const answer = await this.options.keys.sign(this.options.name, helloChallenge(this.options.site, salt), windowHandle);
    // Gone from Windows: a reset Hello PIN, or a new Windows profile. The PIN still opens the app.
    if (answer.result === 'missing') rmSync(this.marker, { force: true });
    if (answer.result !== 'ok' || !answer.signature) return { ok: false, reason: reasonOf(answer.result) };
    return { ok: true, signature: new Uint8Array(answer.signature) };
  }

  cancel(): void {
    this.options.keys.cancel();
  }

  private async drop(): Promise<void> {
    rmSync(this.marker, { force: true });
    await this.options.keys.delete(this.options.name);
  }

  /**
   * Only ever narrows. Without a marker there's nothing of ours to delete, and Windows isn't asked.
   * The marker goes even when Windows won't delete: nothing asks for that key again.
   */
  async remove(): Promise<void> {
    if (this.enrolled) await this.drop();
  }

  /** The policy turned it off: the key credential goes, and the page drops its wrap. */
  async enforcePolicy(): Promise<void> {
    if (!this.options.allowed() && this.enrolled) await this.remove();
  }
}
