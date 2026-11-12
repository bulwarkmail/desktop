// Whose things a wipe takes, and what goes of a wiped partition's folder, in plain Node:
// src/main/wipe-scope.ts.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { isAsideName, partitionFolder, removeAsideFolders, settlePendingRemovals, urlOfOrigin, wipeCovers } from '../src/main/wipe-scope';

const STANDALONE = 'https://app.bulwark.localhost';
const SERVER = 'https://mail.example.org';

test("a server's wipe takes its own records only; a record with no origin is the standalone page's", () => {
  expect(wipeCovers(SERVER, SERVER)).toBe(true);
  expect(wipeCovers(SERVER, STANDALONE)).toBe(false);
  expect(wipeCovers(SERVER, undefined)).toBe(false);
  expect(wipeCovers(STANDALONE, undefined)).toBe(true);
  expect(wipeCovers(STANDALONE, SERVER)).toBe(false);
  // Same host, another port or scheme: another server.
  expect(wipeCovers(SERVER, 'https://mail.example.org:8443')).toBe(false);
  expect(wipeCovers(SERVER, 'http://mail.example.org')).toBe(false);
  // The policy's wipe takes everyone's.
  for (const owner of [SERVER, STANDALONE, undefined]) expect(wipeCovers(null, owner)).toBe(true);
});

test("a window to bring back is a server's when its page is on that origin", () => {
  expect(urlOfOrigin(`${SERVER}/mail/inbox`, SERVER)).toBe(true);
  expect(urlOfOrigin(`${STANDALONE}/mail/inbox`, SERVER)).toBe(false);
  expect(urlOfOrigin('https://mail.example.org.evil.example/', SERVER)).toBe(false);
  expect(urlOfOrigin('https://mail.example.org:8443/', SERVER)).toBe(false);
  expect(urlOfOrigin('not a url', SERVER)).toBe(false);
  expect(urlOfOrigin('not a url', null)).toBe(true);
});

test('a partition names its folder under Partitions, lowercased as Electron does, and nothing else can be named', () => {
  const profile = path.join('C:', 'profile');
  expect(partitionFolder(profile, 'persist:bulwark')).toBe(path.join(profile, 'Partitions', 'bulwark'));
  expect(partitionFolder(profile, 'persist:instance-aHR0cHM6Ly9tYWlsLmV4YW1wbGUub3Jn')).toBe(path.join(profile, 'Partitions', 'instance-ahr0chm6ly9tywlslmv4yw1wbguub3jn'));
  for (const name of ['bulwark', 'bulwark-dialog', 'persist:', 'persist:../keys', 'persist:a/b', 'persist:a\\b', 'persist:..', 'persist:a b', 'persist:%2e%2e', `persist:${'a'.repeat(201)}`]) {
    expect(partitionFolder(profile, name), name).toBeNull();
  }
});

/** A partition folder with network state and local storage, as Chromium leaves one. */
function partitionAt(profile: string, name: string): string {
  const folder = path.join(profile, 'Partitions', name);
  mkdirSync(path.join(folder, 'Network'), { recursive: true });
  writeFileSync(path.join(folder, 'Network', 'Network Persistent State'), '{"servers":["https://mail.example.org"]}');
  mkdirSync(path.join(folder, 'Local Storage', 'leveldb'), { recursive: true });
  writeFileSync(path.join(folder, 'Local Storage', 'leveldb', '000003.log'), 'kept');
  return folder;
}

test('the folders a wipe left go aside under a name no session opens; the kept local storage comes back into a fresh folder; a bad entry touches nothing', () => {
  const profile = mkdtempSync(path.join(tmpdir(), 'bw-wipe-aside-'));
  try {
    const whole = partitionAt(profile, 'instance-whole');
    const keep = partitionAt(profile, 'instance-keep');
    mkdirSync(path.join(profile, 'keys'));
    const pending = [
      { partition: 'persist:instance-WHOLE' },
      { partition: 'persist:instance-keep', keepLocalStorage: true },
      { partition: 'persist:instance-none' },
      { partition: 'persist:../keys' },
      { nothing: true },
      'persist:instance-whole',
    ];
    const { left, gone, aside } = settlePendingRemovals(profile, pending);
    expect(left).toEqual([]);
    expect(gone).toEqual(['persist:instance-WHOLE', 'persist:instance-none']);
    expect(aside).toHaveLength(2);
    for (const name of aside) expect(isAsideName(name), name).toBe(true);
    // A fresh start for both: the whole folder is gone, the kept one holds only its local storage.
    expect(existsSync(whole)).toBe(false);
    expect(readdirSync(keep)).toEqual(['Local Storage']);
    expect(readdirSync(path.join(keep, 'Local Storage', 'leveldb'))).toEqual(['000003.log']);
    const asideFolders = aside.map((name) => path.join(profile, 'Partitions', name));
    expect(asideFolders.map((folder) => readdirSync(folder).sort())).toEqual([['Local Storage', 'Network'], ['Network']]);
    expect(existsSync(path.join(profile, 'keys'))).toBe(true);
    expect(settlePendingRemovals(profile, undefined)).toEqual({ left: [], gone: [], aside: [] });
    // Then the moved folders go.
    expect(removeAsideFolders(profile, aside)).toEqual([]);
    expect(readdirSync(path.join(profile, 'Partitions')).sort()).toEqual(['instance-keep']);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});

test('a folder that can not go aside stays where it is and stays noted, untouched', () => {
  const profile = mkdtempSync(path.join(tmpdir(), 'bw-wipe-held-'));
  try {
    const folder = partitionAt(profile, 'instance-held');
    let tries = 0;
    const refuse = () => {
      tries += 1;
      throw Object.assign(new Error('in use'), { code: 'EBUSY' });
    };
    const { left, gone, aside } = settlePendingRemovals(profile, [{ partition: 'persist:instance-held', keepLocalStorage: true }], { waitMs: 600, rename: refuse });
    expect({ left, gone, aside }).toEqual({ left: [{ partition: 'persist:instance-held', keepLocalStorage: true }], gone: [], aside: [] });
    expect(tries, 'tried again while it waited').toBeGreaterThan(1);
    expect(readdirSync(folder).sort()).toEqual(['Local Storage', 'Network']);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});

test('Windows refuses to move a folder aside while another program holds a file in it', () => {
  test.skip(process.platform !== 'win32', 'holds the file the Windows way');
  const profile = mkdtempSync(path.join(tmpdir(), 'bw-wipe-hold-'));
  const held = path.join(partitionAt(profile, 'instance-held'), 'held.bin');
  writeFileSync(held, 'held');
  try {
    // The file open with no sharing, and the folder's move tried while it is.
    const script = path.join(profile, 'try.ps1');
    writeFileSync(script, `$f = [IO.File]::Open('${held}', 'Open', 'Read', 'None')
try { [IO.Directory]::Move('${path.dirname(held)}', '${path.join(profile, 'Partitions', 'wiped~0000000000000000')}'); 'moved' } catch { 'refused' } finally { $f.Close() }`);
    const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script], { encoding: 'utf8', windowsHide: true });
    expect(run.stdout.trim()).toBe('refused');
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});

test('folders moved aside are removed a few per start; one still held, or past the limit, waits for the next; nothing else is touched', () => {
  const profile = mkdtempSync(path.join(tmpdir(), 'bw-wipe-removal-'));
  try {
    const root = path.join(profile, 'Partitions');
    const names = Array.from({ length: 7 }, (_, at) => `wiped~${String(at).padStart(16, '0')}`);
    for (const name of names) partitionAt(profile, name);
    partitionAt(profile, 'instance-live');
    // A crash between the move and its note: an aside folder no note names is found on disk.
    const noted = [...names.slice(0, 6), 'wiped~ffffffffffffffff', '../keys', 'instance-live', 42];
    const removed: string[] = [];
    const left = removeAsideFolders(profile, noted, 5, (folder) => {
      if (path.basename(folder) === names[1]) throw new Error('held');
      removed.push(path.basename(folder));
      rmSync(folder, { recursive: true, force: true });
    });
    expect(removed).toEqual([names[0], names[2], names[3], names[4]]);
    expect(left).toEqual([names[1], names[5], names[6]]);
    expect(readdirSync(root).sort()).toEqual(['instance-live', names[1], names[5], names[6]].sort());
    expect(removeAsideFolders(profile, left)).toEqual([]);
    expect(readdirSync(root)).toEqual(['instance-live']);
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});
