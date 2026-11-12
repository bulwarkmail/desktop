/**
 * The crash files on this computer: where they are, how many stay, and what's done to one
 * before it leaves. Node only, so a test can load it.
 *
 * A minidump is part of the app's memory at the moment of the crash, so it can hold open
 * mail. The consent text says that. `scrubMinidump` takes out what it can find, in place
 * and at the same length, so the file's structure still holds. It can't promise more.
 * It runs in a process of its own, as a file can be 64 MB.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { APP_ORIGIN } from '../server/protocol';

export interface CrashLimits {
  count: number;
  bytes: number;
  ageMs: number;
}

export const CRASH_LIMITS: CrashLimits = { count: 10, bytes: 64 * 1024 * 1024, ageMs: 30 * 24 * 60 * 60_000 };

export interface CrashFile {
  id: string;
  file: string;
  createdAt: number;
  bytes: number;
}

/** Windows keeps reports in `reports`, macOS and Linux move them from `new` on. */
const DUMP_FOLDERS = ['reports', 'completed', 'pending', 'new'];
const ID = /^[\w-]{1,128}$/;

/** Newest first. */
export function listCrashFiles(dir: string): CrashFile[] {
  const found: CrashFile[] = [];
  for (const folder of DUMP_FOLDERS) {
    let names: string[];
    try {
      names = readdirSync(path.join(dir, folder));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith('.dmp')) continue;
      const id = name.slice(0, -'.dmp'.length);
      if (!ID.test(id)) continue;
      const file = path.join(dir, folder, name);
      try {
        const facts = statSync(file);
        if (facts.isFile()) found.push({ id, file, createdAt: facts.mtimeMs, bytes: facts.size });
      } catch {
        // Gone since the listing.
      }
    }
  }
  return found.sort((a, b) => b.createdAt - a.createdAt);
}

function removeCrash(dir: string, crash: CrashFile): void {
  rmSync(crash.file, { force: true });
  rmSync(path.join(dir, 'attachments', crash.id), { recursive: true, force: true });
}

/** Keeps the newest within the limits and removes the rest. Returns how many went. */
export function sweepCrashFiles(dir: string, limits: CrashLimits = CRASH_LIMITS, now = Date.now()): number {
  let kept = 0;
  let keptBytes = 0;
  let removed = 0;
  for (const crash of listCrashFiles(dir)) {
    const stays = kept < limits.count && keptBytes + crash.bytes <= limits.bytes && now - crash.createdAt <= limits.ageMs;
    if (stays) {
      kept += 1;
      keptBytes += crash.bytes;
      continue;
    }
    try {
      removeCrash(dir, crash);
      removed += 1;
    } catch (error) {
      // Still being written, or held by the crash handler. The next sweep gets it.
      console.warn('A crash file could not be removed:', error);
    }
  }
  return removed;
}

/** Consent taken back, a policy, a wipe: none stay. */
export function removeAllCrashFiles(dir: string): void {
  for (const crash of listCrashFiles(dir)) {
    try {
      removeCrash(dir, crash);
    } catch (error) {
      console.warn('A crash file could not be removed:', error);
    }
  }
}

/**
 * Which page each run of the app was for, by a hash of its origin, and when it started. A crash
 * file belongs to the page whose run it fell in, so a server's wipe can take its own. No address
 * is written: a hash says enough.
 */
export interface CrashRun {
  page: string;
  at: number;
}

const RUNS_FILE = 'runs.json';
const MAX_RUNS = 50;

export function crashPageOf(origin: string): string {
  return createHash('sha256').update(origin).digest('hex').slice(0, 16);
}

export function readCrashRuns(dir: string): CrashRun[] {
  try {
    const parsed = JSON.parse(readFileSync(path.join(dir, RUNS_FILE), 'utf8')) as unknown;
    return Array.isArray(parsed) ? parsed.filter((run): run is CrashRun => typeof run?.page === 'string' && typeof run?.at === 'number') : [];
  } catch {
    return [];
  }
}

/** This run is for `origin`: noted at its start, the newest last. */
export function noteCrashRun(dir: string, origin: string, at = Date.now()): void {
  try {
    mkdirSync(dir, { recursive: true });
    const runs = [...readCrashRuns(dir), { page: crashPageOf(origin), at }].slice(-MAX_RUNS);
    writeFileSync(path.join(dir, RUNS_FILE), JSON.stringify(runs));
  } catch (error) {
    console.warn('The crash files\' run list could not be written:', error);
  }
}

/**
 * The crash files of `origin`'s runs: those written after a run for it started and before the
 * next run did. One from before any run was noted is the standalone page's.
 */
export function crashFilesOf(crashes: readonly CrashFile[], runs: readonly CrashRun[], origin: string): CrashFile[] {
  const page = crashPageOf(origin);
  const standalone = crashPageOf(APP_ORIGIN);
  const ordered = [...runs].sort((a, b) => a.at - b.at);
  return crashes.filter((crash) => {
    const run = ordered.filter((candidate) => candidate.at <= crash.createdAt).at(-1);
    return (run?.page ?? standalone) === page;
  });
}

/** A server's wipe: its crash files go. Null: all of them, and the run list with them. */
export function removeCrashFilesOf(dir: string, origin: string | null): void {
  if (origin === null) {
    removeAllCrashFiles(dir);
    rmSync(path.join(dir, RUNS_FILE), { force: true });
    return;
  }
  for (const crash of crashFilesOf(listCrashFiles(dir), readCrashRuns(dir), origin)) {
    try {
      removeCrash(dir, crash);
    } catch (error) {
      console.warn('A crash file could not be removed:', error);
    }
  }
}

/** Where crash files may go: https, or http that stays on this computer. No sign-in in the address. */
export function validUploadUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value.trim());
    if (url.username || url.password) return null;
    if (url.protocol === 'https:') return url.toString();
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
    return url.protocol === 'http:' && local ? url.toString() : null;
  } catch {
    return null;
  }
}

/*
 * Everything below works on the bytes read as Latin-1, one character a byte, so a replacement
 * can't move anything and a pattern can name any byte. So text in a pattern has to be the
 * bytes it really has on disk: UTF-8, UTF-16LE, or the one-byte code page.
 *
 * Every value pattern ends in an optional closing quote and has one way through each unit,
 * so it never backtracks: time grows with the size of the file, whatever is in it.
 */

/** Keeps the zero bytes, so what's left of UTF-16 text still reads as UTF-16. */
const blank = (match: string) => match.replace(/[^\0]/g, 'x');

function escapeForRegex(text: string): string {
  return text.replace(/[\s\S]/g, (char) => {
    const code = char.charCodeAt(0);
    return /[A-Za-z0-9]/.test(char) ? char : `\\x${code.toString(16).padStart(2, '0')}`;
  });
}

const latin1 = (bytes: Buffer) => bytes.toString('latin1');

/** A pattern as it looks in UTF-16LE: a zero byte after each character. For ASCII patterns. */
function wide(source: string): string {
  return [...source].map((char) => `${escapeForRegex(char)}\\x00`).join('');
}

/** What a piece of text can look like in a dump, as Latin-1 strings of its bytes. */
function byteForms(text: string): string[] {
  const forms = new Set<string>();
  for (const variant of [text, text.toLowerCase(), text.toUpperCase()]) {
    forms.add(latin1(Buffer.from(variant, 'utf8')));
    forms.add(latin1(Buffer.from(variant, 'utf16le')));
    // eslint-disable-next-line no-control-regex
    if (/^[\u0000-\u00ff]*$/.test(variant)) forms.add(variant);
  }
  return [...forms];
}

/** Names of a few letters would blank half the file, and tell nobody anything. */
const longEnough = (text: string | undefined): text is string => !!text && Buffer.byteLength(text, 'utf8') >= 3;

function needlePattern(needles: readonly string[]): RegExp | null {
  const alternatives = [...new Set(needles.filter(longEnough).flatMap(byteForms))]
    .filter((form) => form.length >= 3)
    .sort((a, b) => b.length - a.length)
    .map(escapeForRegex);
  return alternatives.length ? new RegExp(alternatives.join('|'), 'gi') : null;
}

const SLASH = '[\\\\/]';
const WIDE_SLASH = '[\\\\/]\\x00';

/**
 * Whoever's folder it is, under whatever name: `C:\Users\IVAN~1`, a short name nothing here
 * knows, or another account's. The rest of the path stays, to be read.
 */
const USER_FOLDER = new RegExp(`(?:[A-Za-z]:${SLASH}{1,2}Users${SLASH}{1,2}|${SLASH}home${SLASH}|${SLASH}Users${SLASH})[^\\\\/\\0"'<>|:*?\\r\\n]{1,128}`, 'gi');
const USER_FOLDER_WIDE = new RegExp(
  `(?:[A-Za-z]\\x00:\\x00(?:${WIDE_SLASH}){1,2}${wide('Users')}(?:${WIDE_SLASH}){1,2}|${WIDE_SLASH}${wide('home')}${WIDE_SLASH}|${WIDE_SLASH}${wide('Users')}${WIDE_SLASH})(?:(?!${WIDE_SLASH}|"\\x00|:\\x00|\\x00\\x00)[\\s\\S]{2}){1,128}`,
  'gi',
);

const MAIL_KEYS = ['subject', 'preview', 'value', 'name', 'email', 'htmlBody', 'textBody', 'bodyValues', 'password', 'token', 'accessToken', 'refreshToken'];
const KEYS = MAIL_KEYS.join('|');
const KEYS_WIDE = MAIL_KEYS.map(wide).join('|');
const MAX_VALUE = 8192;

const MAIL_JSON = new RegExp(`"(?:${KEYS})"\\s*:\\s*"(?:\\\\[\\s\\S]|[^"\\\\\\0]){0,${MAX_VALUE}}"?`, 'g');
/** JSON inside JSON: `\"subject\":\"…\"`, with however many backslashes. */
const MAIL_JSON_ESCAPED = new RegExp(`\\\\+"(?:${KEYS})\\\\+"\\s*:\\s*\\\\+"(?:(?!\\\\+")[^\\0]){0,${MAX_VALUE}}(?:\\\\+")?`, 'g');
const WIDE_SPACE = '(?:\\s\\x00)*';
const MAIL_JSON_WIDE = new RegExp(
  `"\\x00(?:${KEYS_WIDE})"\\x00${WIDE_SPACE}:\\x00${WIDE_SPACE}"\\x00(?:\\\\\\x00[\\s\\S]{2}|(?!"\\x00|\\x00\\x00)[\\s\\S]{2}){0,${MAX_VALUE}}(?:"\\x00)?`,
  'g',
);
const WIDE_BACKSLASHES = '(?:\\\\\\x00)+';
const MAIL_JSON_WIDE_ESCAPED = new RegExp(
  `${WIDE_BACKSLASHES}"\\x00(?:${KEYS_WIDE})${WIDE_BACKSLASHES}"\\x00${WIDE_SPACE}:\\x00${WIDE_SPACE}${WIDE_BACKSLASHES}"\\x00(?:(?!${WIDE_BACKSLASHES}"\\x00|\\x00\\x00)[\\s\\S]{2}){0,${MAX_VALUE}}(?:${WIDE_BACKSLASHES}"\\x00)?`,
  'g',
);

const HEADERS = ['Subject', 'From', 'To', 'Cc', 'Bcc', 'Reply-To', 'Authorization', 'Cookie', 'Set-Cookie'];
/** Raw mail and HTTP, as far as they sit in memory in one piece. */
const MAIL_HEADER = new RegExp(`\\b(?:${HEADERS.join('|')}):[^\\r\\n\\0]{1,2000}`, 'gi');
const MAIL_HEADER_WIDE = new RegExp(`(?:${HEADERS.map(wide).join('|')}):\\x00(?:(?!\\r\\x00|\\n\\x00|\\x00\\x00)[\\s\\S]{2}){1,2000}`, 'gi');

const EMAIL = /[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63})+/g;
const EMAIL_WIDE = /(?:[\w.+-]\x00){1,64}@\x00(?:[\w-]\x00){1,63}(?:\.\x00(?:[\w-]\x00){1,63})+/g;
const AUTH = /\b(?:Bearer|Basic|Token)\s[^\s\0,;"']{4,}/gi;
const AUTH_WIDE = new RegExp(`(?:${['Bearer', 'Basic', 'Token'].map(wide).join('|')})\\s\\x00(?:[^\\s\\0,;"']\\x00){4,}`, 'gi');
const LONG_RUN = /[A-Za-z0-9+/_=-]{32,}/g;
const LONG_RUN_WIDE = /(?:[A-Za-z0-9+/_=-]\x00){32,}/g;

const PATTERNS = [
  USER_FOLDER, USER_FOLDER_WIDE,
  MAIL_HEADER, MAIL_HEADER_WIDE,
  MAIL_JSON_ESCAPED, MAIL_JSON_WIDE_ESCAPED, MAIL_JSON, MAIL_JSON_WIDE,
  AUTH, AUTH_WIDE, EMAIL, EMAIL_WIDE, LONG_RUN, LONG_RUN_WIDE,
];

export interface ScrubNames {
  home: string;
  username: string;
  hostname: string;
  /** The mail and Bulwark servers this app is set up with, as addresses. */
  servers?: readonly string[];
}

function hostsOf(address: string): string[] {
  try {
    const url = new URL(address);
    // A URL holds a non-ASCII host in punycode, and memory holds both.
    const unicode = /^[a-z]+:\/\/([^/:]+)/i.exec(address)?.[1];
    return [url.origin, url.host, url.hostname, ...(unicode ? [unicode] : [])];
  } catch {
    return [address];
  }
}

/**
 * Takes the user's name and home folder, the computer's name, the configured servers,
 * addresses, tokens and anything that looks like mail out of a crash file's bytes, in any
 * script. Same length, so offsets in the file stay right. Only a copy changes: `bytes` is left
 * as it is. A dump can still hold the text of mail after this, and the consent text says so.
 */
export function scrubMinidump(bytes: Buffer, names: ScrubNames): Buffer {
  let text = latin1(bytes);
  const needles = needlePattern([
    names.home,
    names.home.replace(/\\/g, '/'),
    names.home.replace(/\\/g, '\\\\'),
    names.username,
    names.hostname,
    ...(names.servers ?? []).flatMap(hostsOf),
  ]);
  if (needles) text = text.replace(needles, blank);
  for (const pattern of PATTERNS) text = text.replace(pattern, blank);
  return Buffer.from(text, 'latin1');
}

export interface CrashUpload {
  contentType: string;
  body: Buffer;
}

/**
 * The form Breakpad's and Sentry's receivers take: the dump as `upload_file_minidump`, and
 * only these facts beside it. No file names, paths or ids of ours.
 */
export function buildCrashUpload(dump: Buffer, facts: { prod: string; ver: string; platform: string; build: string }, boundary: string): CrashUpload {
  const fields = Object.entries(facts)
    .map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`)
    .join('');
  const head = `${fields}--${boundary}\r\nContent-Disposition: form-data; name="upload_file_minidump"; filename="crash.dmp"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: Buffer.concat([Buffer.from(head, 'latin1'), dump, Buffer.from(`\r\n--${boundary}--\r\n`, 'latin1')]),
  };
}
