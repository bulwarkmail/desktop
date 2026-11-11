/**
 * The native helper (native/), wrapped. If its .node file is missing or won't load,
 * every feature here says it's unavailable and nothing throws at start-up: a build
 * without Rust, a Linux box and a broken file all run the app, just without Hello and
 * the OS keystore. No Electron in this file, so plain Node tests reach all of it.
 *
 * Node-API is stable across Electron versions, so one build serves any of them.
 */

import { createRequire } from 'node:module';
import path from 'node:path';

export interface NativeCertificate {
  id: string;
  certificate: Uint8Array;
  chain: Uint8Array[];
  subject: string;
  issuer: string;
  serial: string;
  notBefore: number;
  notAfter: number;
  usages: string[];
  extendedUsages: string[];
  algorithm: string;
  keyType: 'rsa' | 'ec';
  curve?: 'P-256' | 'P-384' | 'P-521';
  keyBits: number;
  source: 'software' | 'smartcard' | 'keychain' | 'unknown';
  signSchemes: string[];
  decryptSchemes: string[];
  canAgree: boolean;
  /** The key can also sign the user in somewhere: consent per use, not per session. */
  askEachUse: boolean;
}

/** What Windows' print dialog came to. `unavailable` and `invalid`: no dialog was shown. */
export type WindowsPrintResult = 'printed' | 'cancelled' | 'failed' | 'unavailable' | 'invalid';

export type HelloResult = 'verified' | 'cancelled' | 'busy' | 'unavailable' | 'timeout' | 'invalid' | 'failed';

/** What a Hello key credential's create or sign answers. `ok` is the only yes. */
export type HelloKeyResult = 'ok' | 'cancelled' | 'busy' | 'unavailable' | 'timeout' | 'invalid' | 'missing' | 'failed';

export interface HelloKeyAnswer {
  result: HelloKeyResult;
  signature?: Uint8Array;
  /** From a create: the key's public half, DER SubjectPublicKeyInfo. */
  publicKey?: Uint8Array;
}

export interface SignScheme {
  scheme: string;
  hash: string;
}

export interface DecryptScheme {
  scheme: string;
  hash?: string;
  label?: Uint8Array;
}

/** A Files drive sync root as Windows lists it. */
export interface NativeSyncRoot {
  id: string;
  path: string;
  displayName: string;
  /** `<file>,<index>`, as it was registered. Empty if Windows has none. */
  icon: string;
}

/** What Windows' FETCH_DATA and CANCEL_FETCH_DATA callbacks bring. Keys are 64-bit, so text. */
export interface NativeFetchEvent {
  kind: 'fetch' | 'cancel';
  connection: string;
  transferKey: string;
  requestKey: string;
  /** Absolute. */
  path: string;
  identity: string;
  offset: number;
  length: number;
  total: number;
  pid: number;
}

export interface NativePlacement {
  name: string;
  directory: boolean;
  size: number;
  mtimeMs: number;
  identity: string;
}

export interface NativePlaceholderInfo {
  placeholder: boolean;
  directory: boolean;
  identity?: string;
  inSync: boolean;
  hydrated: boolean;
  partial: boolean;
  pin: 'pinned' | 'unpinned' | 'unspecified';
  size: number;
  onDisk: number;
}

/**
 * The Files drive's calls (native/src/files_windows.rs). They throw `files:<code> (0x...)`;
 * see filesErrorCode. Optional on NativeModule: a helper built before them has none.
 */
export interface NativeFilesModule {
  filesDriveRegister(options: { provider: string; account: string; path: string; displayName: string; icon: string; version: string }): Promise<string>;
  filesDriveUnregister(id: string): Promise<void>;
  filesDriveRoots(): Promise<NativeSyncRoot[]>;
  filesDriveConnect(path: string, callback: (event: NativeFetchEvent) => void): string;
  filesDriveDisconnect(connection: string): void;
  filesDriveTransfer(connection: string, transferKey: string, requestKey: string, offset: number, data: Buffer): Promise<void>;
  filesDriveTransferFailed(connection: string, transferKey: string, requestKey: string, offset: number, length: number, reason: 'offline' | 'denied' | 'timeout' | 'not-running' | 'failed'): void;
  filesDrivePlace(parent: string, entries: NativePlacement[]): string[];
  filesDriveInfo(path: string): NativePlaceholderInfo;
  filesDriveUpdate(path: string, change: { size?: number; mtimeMs?: number; identity?: string; markInSync: boolean; dehydrate: boolean; verifyInSync: boolean }): void;
  filesDriveConvert(path: string, identity: string): void;
  filesDriveHydrate(path: string): Promise<void>;
  filesDriveDehydrate(path: string): void;
  filesUsedDriveLetters(): number;
  // Explorer's status for the drive (Windows 11). Optional: without them the drive works and
  // Explorer shows no status.
  filesDriveStatusServe?(clsid: string, icon: string, callback: (syncRootId: string) => void): boolean;
  filesDriveStatusStop?(): void;
  filesDriveStatusAttach?(id: string, clsid: string): void;
  filesDriveStatusSet?(id: string, status: NativeDriveStatus | undefined): void;
  filesDriveStatusRead?(id: string, waitMs: number): Promise<NativeDriveStatusSeen>;
  /** Explorer reads the letter's name and icon again. */
  filesDriveLetterChanged(letter: string): void;
}

/** What Explorer shows for a sync root. Absent, not null, for what isn't there: the helper takes undefined only. */
export interface NativeDriveStatus {
  state: 'synced' | 'syncing' | 'paused' | 'offline' | 'error';
  label: string;
  detail: string;
  quota?: { used: number; total?: number; label: string };
  notice?: string;
}

/** The status as Explorer reads it, out of process. */
export interface NativeDriveStatusSeen {
  state: string;
  label: string;
  detail: string;
  quotaUsed?: number;
  quotaTotal?: number;
  quotaLabel?: string;
  notice?: string;
  changed: boolean;
}

export const FILES_NATIVE_EXPORTS = [
  'filesDriveConnect',
  'filesDriveConvert',
  'filesDriveDehydrate',
  'filesDriveDisconnect',
  'filesDriveHydrate',
  'filesDriveInfo',
  'filesDriveLetterChanged',
  'filesDrivePlace',
  'filesDriveRegister',
  'filesDriveRoots',
  'filesDriveTransfer',
  'filesDriveTransferFailed',
  'filesDriveUnregister',
  'filesDriveUpdate',
  'filesUsedDriveLetters',
] as const satisfies readonly (keyof NativeFilesModule)[];

/** The code in a files call's error: `missing`, `busy`, `changed`, ... `failed` when there's none. */
export function filesErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /^files:([a-z-]+)/.exec(message)?.[1] ?? 'failed';
}

/** A registry value as the helper reads it (native/src/system_windows.rs). */
export interface NativeRegistryValue {
  /** Empty for the key's default value. */
  name: string;
  kind: 'sz' | 'expand_sz' | 'multi_sz' | 'dword' | 'qword' | 'binary' | 'none' | 'other';
  /** A string's text (an EXPAND_SZ not expanded), or a QWORD in decimal. */
  text?: string;
  list?: string[];
  /** A DWORD, unsigned. */
  number?: number;
}

/** A key the helper read: its path below the key asked for (empty for that key), its values, the names of its subkeys. */
export interface NativeRegistryNode {
  path: string;
  values: NativeRegistryValue[];
  subkeys: string[];
}

export type PinState = 'pinned' | 'unpinned' | 'unspecified';

/**
 * What main used to start Windows' own tools for: reg.exe, PowerShell, whoami and icacls,
 * subst, attrib. Endpoint protection blocks or flags an app that starts those. Optional: a
 * helper built before them has none, and each caller then does what it did when the tool failed.
 */
export interface NativeSystemModule {
  /** Null: the key isn't there. Throws `registry:<code>` when it is and can't be read. */
  registryRead(key: string, depth: number): NativeRegistryNode[] | null;
  /** Only under HKCU\Software\<name>. No name: the key's default value. */
  registrySetString(key: string, name: string | undefined, data: string): void;
  registryDeleteKey(key: string): boolean;
  registryDeleteValue(key: string, name: string): boolean;
  notificationQuietState(): Promise<{ profile: number; notificationState: number }>;
  clipboardWriteFiles(paths: string[]): Promise<void>;
  folderMakePrivate(path: string): Promise<void>;
  driveLetterList(): { letter: string; target: string }[];
  driveLetterAdd(letter: string, target: string): Promise<void>;
  driveLetterRemove(letter: string): Promise<void>;
  fileSetPin(path: string, pin: PinState): Promise<void>;
  codeSignatureCheck(path: string): Promise<CodeSignature>;
  windowToFront(hwnd: Buffer): boolean;
}

/** A file's embedded Authenticode signature, from WinVerifyTrust. */
export interface CodeSignature {
  status: 'valid' | 'unsigned' | 'invalid' | 'unsupported';
  /** WinVerifyTrust's answer, `0x...`. */
  code: string;
  /** `CN=..., O=..., C=...`, as .NET's X509Certificate.Subject. */
  subject?: string;
}

export const REGISTRY_NATIVE_EXPORTS = ['registryRead', 'registrySetString', 'registryDeleteKey', 'registryDeleteValue'] as const satisfies readonly (keyof NativeSystemModule)[];
export const DRIVE_LETTER_NATIVE_EXPORTS = ['driveLetterList', 'driveLetterAdd', 'driveLetterRemove'] as const satisfies readonly (keyof NativeSystemModule)[];

/** The registry, through the helper. Writes and deletes only under HKCU\Software. */
export interface Registry {
  /** The key and `depth` levels below it. Null: not there. Throws when it is there and can't be read. */
  read(key: string, depth?: number): NativeRegistryNode[] | null;
  /** A REG_SZ, the key made if it isn't there. Undefined name: the default value. False if it failed. */
  setString(key: string, name: string | undefined, data: string): boolean;
  /** The key and all below it. False if it wasn't there or couldn't go. */
  deleteKey(key: string): boolean;
  deleteValue(key: string, name: string): boolean;
}

/** Drive letters mapped to folders, as `subst` makes them, for this sign-in session. */
export interface DriveLetters {
  /** Letter to folder. Empty when the helper can't say. */
  list(): Map<string, string>;
  add(letter: string, target: string): Promise<boolean>;
  remove(letter: string): Promise<boolean>;
}

/** Every export of the helper. test/native.spec.ts holds the binary to this list. */
export interface NativeModule extends Partial<NativeFilesModule>, Partial<NativeSystemModule> {
  /** Optional: a helper built before it has none, and the app's own print window shows instead. */
  printDialog?(hwnd: Buffer, pdf: Buffer, landscape: Buffer | undefined, title: string): Promise<WindowsPrintResult>;
  helloAvailable(): Promise<boolean>;
  helloVerify(reason: string, hwnd: Buffer, timeoutMs: number): Promise<HelloResult>;
  // Optional: a helper built before these existed still loads, and Hello's key credential is unavailable.
  helloKeyCreate?(name: string, data: Buffer, hwnd: Buffer, timeoutMs: number): Promise<HelloKeyAnswer>;
  helloKeyOpen?(name: string): Promise<'ok' | 'missing' | 'unavailable' | 'failed'>;
  helloKeySign?(name: string, data: Buffer, hwnd: Buffer, timeoutMs: number): Promise<HelloKeyAnswer>;
  helloKeyDelete?(name: string): Promise<'ok' | 'missing' | 'failed'>;
  helloKeyCancel?(): void;
  keystoreList(): Promise<NativeCertificate[]>;
  keystoreSign(id: string, digest: Buffer, scheme: SignScheme, hwnd?: Buffer | null): Promise<Buffer>;
  keystoreDecrypt(id: string, data: Buffer, scheme: { scheme: string; hash?: string; label?: Buffer }, hwnd?: Buffer | null): Promise<Buffer>;
  keystoreAgree(id: string, peerPublicKey: Buffer, hwnd?: Buffer | null): Promise<Buffer>;
  policyIsForced(key: string): boolean;
}

export const KEYSTORE_ERRORS = ['keystore:cancelled', 'keystore:ask-first', 'keystore:not-found', 'keystore:unsupported', 'keystore:locked', 'keystore:invalid', 'keystore:failed'] as const;
export type KeystoreErrorCode = (typeof KEYSTORE_ERRORS)[number];

/** A stuck card driver mustn't hold mail forever. Longer than anyone types a PIN. */
export const KEYSTORE_CAP_MS = 5 * 60_000;
export const HELLO_TIMEOUT_MS = 2 * 60_000;

/** Key operations waiting behind the running one. More than this fail fast. */
const MAX_QUEUED = 8;

const MAX_ID = 64;
const MAX_DIGEST = 64;
// A 16384-bit modulus, the most anything issues.
const MAX_CIPHERTEXT = 2048;
const MAX_LABEL = 256;
const MAX_PEER_KEY = 256;

export function helperFile(options: { packaged: boolean; mainDir: string; platform: string; arch: string }): string {
  const root = path.dirname(options.mainDir);
  // In app.asar, unpacked by electron-builder. Electron's loader follows the link.
  if (options.packaged) return path.join(root, 'native', 'bulwark-native.node');
  return path.join(root, 'native', 'dist', `${options.platform}-${options.arch}`, 'bulwark-native.node');
}

/** Null if it's not there or doesn't load. */
export function loadHelperModule(file: string, warn: (message: string) => void = console.warn): NativeModule | null {
  try {
    return createRequire(import.meta.url)(file) as NativeModule;
  } catch (error) {
    // Not there is an ordinary state for a build without Rust. Anything else is news.
    if ((error as NodeJS.ErrnoException).code !== 'MODULE_NOT_FOUND') warn(`The native helper didn't load: ${(error as Error).message}`);
    return null;
  }
}

export function keystoreErrorCode(error: unknown): KeystoreErrorCode {
  const message = error instanceof Error ? error.message : String(error);
  const code = /keystore:[a-z-]+/.exec(message)?.[0];
  return KEYSTORE_ERRORS.find((known) => known === code) ?? 'keystore:failed';
}

/** Throws with only the code in the message: that's all a plugin frame ever gets. */
function rethrow(error: unknown, warn: (message: string) => void): never {
  const code = keystoreErrorCode(error);
  // An HRESULT or OSStatus, for a bug report. Never key material.
  if (code === 'keystore:failed') warn(`A keystore call failed: ${(error as Error)?.message ?? error}`);
  throw new Error(code);
}

function bytes(value: unknown, max: number): Buffer {
  const view = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
  if (!(view instanceof Uint8Array) || view.byteLength > max) throw new Error('keystore:invalid');
  return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
}

function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > MAX_ID) throw new Error('keystore:invalid');
  return value;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.length > 32) throw new Error('keystore:invalid');
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') throw new Error('keystore:invalid');
  return value as Record<string, unknown>;
}

function lockedError(): Error {
  return new Error('keystore:locked');
}

export interface SerialQueue {
  <T>(job: () => Promise<T>): Promise<T>;
  /** A job passed the cap and its native call hasn't ended. */
  stuck(): boolean;
}

/**
 * Runs jobs one at a time, so one PIN dialog holds one libuv thread and two dialogs never
 * stack up. A job past the cap rejects, and so does what waited behind it, but its native
 * call can't be interrupted and still holds its thread. So nothing new starts until it
 * really ends: new calls fail fast. That's also why UV_THREADPOOL_SIZE stays as it is:
 * this holds one thread at most, and on Windows libuv doesn't read the variable once the
 * process runs.
 */
export function serialQueue(capMs: number, maxWaiting = MAX_QUEUED): SerialQueue {
  interface Entry {
    job: () => Promise<unknown>;
    resolve: (value: never) => void;
    reject: (error: Error) => void;
  }
  const waiting: Entry[] = [];
  let running = false;
  let stuck = false;

  const start = (entry: Entry): void => {
    running = true;
    let capped = false;
    const timer = setTimeout(() => {
      capped = true;
      stuck = true;
      entry.reject(lockedError());
      for (const behind of waiting.splice(0)) behind.reject(lockedError());
    }, capMs);
    const finish = (settle: () => void): void => {
      clearTimeout(timer);
      if (!capped) settle();
      running = false;
      stuck = false;
      const next = waiting.shift();
      if (next) start(next);
    };
    let native: Promise<unknown>;
    try {
      native = entry.job();
    } catch (error) {
      native = Promise.reject(error);
    }
    native.then(
      (value) => finish(() => entry.resolve(value as never)),
      (error) => finish(() => entry.reject(error as Error)),
    );
  };

  const run = <T>(job: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (stuck || waiting.length >= maxWaiting) {
        reject(lockedError());
        return;
      }
      const entry: Entry = { job, resolve: resolve as (value: never) => void, reject };
      if (running) waiting.push(entry);
      else start(entry);
    });
  return Object.assign(run, { stuck: () => stuck });
}

export interface NativeHelper {
  hello: {
    available(): Promise<boolean>;
    /** A yes or no that gates the UI. It doesn't unlock a key. Always has a timeout. */
    verify(reason: string, windowHandle: Buffer, timeoutMs?: number): Promise<HelloResult>;
    /** Key credentials in the user's Hello container. Never throw: anything wrong is `failed`. */
    key: {
      create(name: string, data: Uint8Array, windowHandle: Buffer, timeoutMs?: number): Promise<HelloKeyAnswer>;
      open(name: string): Promise<'ok' | 'missing' | 'unavailable' | 'failed'>;
      sign(name: string, data: Uint8Array, windowHandle: Buffer, timeoutMs?: number): Promise<HelloKeyAnswer>;
      delete(name: string): Promise<'ok' | 'missing' | 'failed'>;
      cancel(): void;
    };
  };
  keystore: {
    /** Whether this build and system have an OS keystore to offer. */
    readonly available: boolean;
    /** An operation passed the cap and still holds its thread. Key calls fail fast now. */
    stuck(): boolean;
    list(): Promise<NativeCertificate[]>;
    sign(id: unknown, digest: unknown, scheme: unknown, windowHandle?: Buffer | null): Promise<Uint8Array>;
    decrypt(id: unknown, data: unknown, scheme: unknown, windowHandle?: Buffer | null): Promise<Uint8Array>;
    agree(id: unknown, peerPublicKey: unknown, windowHandle?: Buffer | null): Promise<Uint8Array>;
  };
  policy: {
    /** macOS: is this preference forced by a configuration profile? False elsewhere. */
    isForced(key: string): boolean;
  };
  /** The Files drive's calls, on Windows with a helper that has them. Null elsewhere. */
  files: NativeFilesModule | null;
  /**
   * Windows' print dialog with the document's pages in its preview. Null off Windows and without
   * a helper that has it. Never throws: anything wrong is `unavailable`.
   */
  print: { dialog(windowHandle: Buffer, pdf: Uint8Array, landscape: Uint8Array | null, title: string): Promise<WindowsPrintResult> } | null;
  /**
   * Windows, in place of its own tools. Without the helper or the call, each answers what its
   * caller got when the tool failed. Only `registry.read` throws.
   */
  system: {
    /** Null without a helper that reads the registry, and off Windows. */
    registry: Registry | null;
    /** Do Not Disturb's profile and the shell's notification state. Null: Windows didn't say. */
    quietState(): Promise<{ profile: number; notificationState: number } | null>;
    /** Files on the clipboard as Explorer copies them. */
    clipboardWriteFiles(paths: string[]): Promise<boolean>;
    /** Only this user and SYSTEM, nothing inherited. */
    makeFolderPrivate(folder: string): Promise<boolean>;
    /** Null without a helper that has them, and off Windows. */
    driveLetters: DriveLetters | null;
    setPin(file: string, pin: PinState): Promise<boolean>;
    /** An update installer's signature. Null: the helper can't say. */
    codeSignature(file: string): Promise<CodeSignature | null>;
    /** This process's window in front, where Windows wouldn't let a focus do it. True when it is. */
    windowToFront(windowHandle: Buffer): boolean;
  };
}

/** The registry calls, wrapped so that only a read throws. */
export function registryFrom(native: Partial<NativeSystemModule> | null, warn: (message: string) => void = console.warn): Registry | null {
  if (!native || !REGISTRY_NATIVE_EXPORTS.every((name) => typeof native[name] === 'function')) return null;
  const module = native as NativeSystemModule;
  const quietly = <T>(run: () => T, otherwise: T, what: string): T => {
    try {
      return run();
    } catch (error) {
      warn(`Registry ${what}: ${(error as Error).message}`);
      return otherwise;
    }
  };
  return {
    read: (key, depth = 0) => module.registryRead(key, depth),
    setString: (key, name, data) =>
      quietly(
        () => {
          module.registrySetString(key, name, data);
          return true;
        },
        false,
        'write',
      ),
    deleteKey: (key) => quietly(() => module.registryDeleteKey(key), false, 'delete'),
    deleteValue: (key, name) => quietly(() => module.registryDeleteValue(key, name), false, 'delete'),
  };
}

/** What `subst` did, in process. */
export function driveLettersFrom(native: Partial<NativeSystemModule> | null, warn: (message: string) => void = console.warn): DriveLetters | null {
  if (!native || !DRIVE_LETTER_NATIVE_EXPORTS.every((name) => typeof native[name] === 'function')) return null;
  const module = native as NativeSystemModule;
  return {
    list: () => {
      try {
        return new Map(module.driveLetterList().map((mapping) => [mapping.letter.toUpperCase(), mapping.target]));
      } catch {
        return new Map();
      }
    },
    add: (letter, target) => tried(() => module.driveLetterAdd(letter, target), warn, `Drive letter ${letter}: add`),
    remove: (letter) => tried(() => module.driveLetterRemove(letter), warn, `Drive letter ${letter}: remove`),
  };
}

/** A call into the helper that may not be there: true if it was, and it worked. */
async function tried(run: (() => Promise<unknown>) | null, warn: (message: string) => void, what: string): Promise<boolean> {
  if (!run) return false;
  try {
    await run();
    return true;
  } catch (error) {
    warn(`${what}: ${(error as Error)?.message ?? error}`);
    return false;
  }
}

export function wrapHelper(
  native: NativeModule | null,
  options: { platform?: string; capMs?: number; warn?: (message: string) => void } = {},
): NativeHelper {
  const { platform = process.platform, capMs = KEYSTORE_CAP_MS, warn = console.warn } = options;
  const queue = serialQueue(capMs);
  let listing: Promise<NativeCertificate[]> | null = null;
  const keyed = async <T>(run: (module: NativeModule) => Promise<T>): Promise<T> => {
    if (!native || !keystoreOffered) throw new Error('keystore:unsupported');
    try {
      return await run(native);
    } catch (error) {
      rethrow(error, warn);
    }
  };
  // The Linux keystore isn't in scope, and the helper's stubs would only ever say so.
  const keystoreOffered = platform === 'win32' || platform === 'darwin';

  return {
    hello: {
      available: async () => {
        if (!native) return false;
        try {
          return await native.helloAvailable();
        } catch {
          return false;
        }
      },
      verify: async (reason, windowHandle, timeoutMs = HELLO_TIMEOUT_MS) => {
        if (!native) return 'unavailable';
        try {
          return await native.helloVerify(reason, windowHandle, timeoutMs);
        } catch (error) {
          warn(`Hello: ${(error as Error).message}`);
          return 'failed';
        }
      },
      key: {
        create: async (name, data, windowHandle, timeoutMs = HELLO_TIMEOUT_MS) => {
          if (typeof native?.helloKeyCreate !== 'function') return { result: 'unavailable' };
          try {
            return await native.helloKeyCreate(name, Buffer.from(data), windowHandle, timeoutMs);
          } catch (error) {
            warn(`Hello key: ${(error as Error).message}`);
            return { result: 'failed' };
          }
        },
        open: async (name) => {
          if (typeof native?.helloKeyOpen !== 'function') return 'unavailable';
          try {
            return await native.helloKeyOpen(name);
          } catch {
            return 'failed';
          }
        },
        sign: async (name, data, windowHandle, timeoutMs = HELLO_TIMEOUT_MS) => {
          if (typeof native?.helloKeySign !== 'function') return { result: 'unavailable' };
          try {
            return await native.helloKeySign(name, Buffer.from(data), windowHandle, timeoutMs);
          } catch (error) {
            warn(`Hello key: ${(error as Error).message}`);
            return { result: 'failed' };
          }
        },
        delete: async (name) => {
          if (typeof native?.helloKeyDelete !== 'function') return 'missing';
          try {
            return await native.helloKeyDelete(name);
          } catch {
            return 'failed';
          }
        },
        cancel: () => {
          try {
            native?.helloKeyCancel?.();
          } catch {
            // Nothing was waiting.
          }
        },
      },
    },
    keystore: {
      available: Boolean(native) && keystoreOffered,
      stuck: () => queue.stuck(),
      // Never prompts, so it doesn't wait behind a PIN dialog. Calls at once share one
      // trip, so none of them can eat the pool either.
      list: () => {
        listing ??= keyed((module) => module.keystoreList()).finally(() => {
          listing = null;
        });
        return listing;
      },
      sign: (id, digest, scheme, windowHandle) =>
        keyed((module) => {
          const name = identifier(id);
          const hash = bytes(digest, MAX_DIGEST);
          const asked = record(scheme);
          const plan = { scheme: text(asked.scheme), hash: text(asked.hash) };
          return queue(() => module.keystoreSign(name, hash, plan, windowHandle));
        }),
      decrypt: (id, data, scheme, windowHandle) =>
        keyed((module) => {
          const name = identifier(id);
          const input = bytes(data, MAX_CIPHERTEXT);
          const asked = record(scheme);
          const plan = {
            scheme: text(asked.scheme),
            hash: asked.hash === undefined ? undefined : text(asked.hash),
            label: asked.label === undefined ? undefined : bytes(asked.label, MAX_LABEL),
          };
          return queue(() => module.keystoreDecrypt(name, input, plan, windowHandle));
        }),
      agree: (id, peerPublicKey, windowHandle) =>
        keyed((module) => {
          const name = identifier(id);
          const peer = bytes(peerPublicKey, MAX_PEER_KEY);
          return queue(() => module.keystoreAgree(name, peer, windowHandle));
        }),
    },
    policy: {
      isForced: (key) => {
        if (!native) return false;
        try {
          return native.policyIsForced(key);
        } catch {
          return false;
        }
      },
    },
    files: platform === 'win32' && native && FILES_NATIVE_EXPORTS.every((name) => typeof native[name] === 'function') ? (native as NativeFilesModule) : null,
    print:
      platform === 'win32' && typeof native?.printDialog === 'function'
        ? {
            dialog: async (windowHandle, pdf, landscape, title) => {
              try {
                return await native.printDialog!(windowHandle, Buffer.from(pdf), landscape ? Buffer.from(landscape) : undefined, title);
              } catch (error) {
                warn(`Windows' print dialog: ${(error as Error)?.message ?? error}`);
                return 'unavailable';
              }
            },
          }
        : null,
    system: {
      registry: platform === 'win32' ? registryFrom(native, warn) : null,
      quietState: async () => {
        if (platform !== 'win32' || typeof native?.notificationQuietState !== 'function') return null;
        try {
          return await native.notificationQuietState();
        } catch {
          return null;
        }
      },
      clipboardWriteFiles: (paths) => {
        const write = native?.clipboardWriteFiles;
        return tried(platform === 'win32' && typeof write === 'function' ? () => write(paths) : null, warn, 'Files to the clipboard');
      },
      makeFolderPrivate: (folder) => {
        const make = native?.folderMakePrivate;
        return tried(platform === 'win32' && typeof make === 'function' ? () => make(folder) : null, warn, 'A private folder');
      },
      driveLetters: platform === 'win32' ? driveLettersFrom(native, warn) : null,
      setPin: (file, pin) => {
        const set = native?.fileSetPin;
        return tried(platform === 'win32' && typeof set === 'function' ? () => set(file, pin) : null, warn, 'A pin');
      },
      codeSignature: async (file) => {
        if (platform !== 'win32' || typeof native?.codeSignatureCheck !== 'function') return null;
        try {
          return await native.codeSignatureCheck(file);
        } catch (error) {
          warn(`A signature check: ${(error as Error)?.message ?? error}`);
          return null;
        }
      },
      windowToFront: (windowHandle) => {
        if (platform !== 'win32' || typeof native?.windowToFront !== 'function') return false;
        try {
          return native.windowToFront(windowHandle);
        } catch (error) {
          warn(`A window to the front: ${(error as Error)?.message ?? error}`);
          return false;
        }
      },
    },
  };
}
