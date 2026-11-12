// Whose things a wipe takes, and what goes of a wiped partition's folder, in plain Node:
// src/main/wipe-scope.ts.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { partitionFolder, partitionLeftovers, removePartitionFolder, settlePendingRemovals, urlOfOrigin, wipeCovers } from '../src/main/wipe-scope';

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

test("what goes of a wiped partition's folder: everything, or all but the local storage the page keeps", () => {
  const entries = ['Cache', 'Code Cache', 'DIPS', 'Local Storage', 'Network', 'Session Storage', 'Shared Dictionary', 'WebStorage'];
  expect(partitionLeftovers(entries, false)).toEqual(entries);
  expect(partitionLeftovers(entries, true)).toEqual(['Cache', 'Code Cache', 'DIPS', 'Network', 'Session Storage', 'Shared Dictionary', 'WebStorage']);
});

test('the removals left for this start: done ones go from the note, a folder that stays is tried again, a bad entry touches nothing', () => {
  const profile = mkdtempSync(path.join(tmpdir(), 'bw-wipe-folders-'));
  try {
    const make = (name: string) => {
      const folder = path.join(profile, 'Partitions', name);
      mkdirSync(path.join(folder, 'Network'), { recursive: true });
      writeFileSync(path.join(folder, 'Network', 'Network Persistent State'), '{"servers":["https://mail.example.org"]}');
      mkdirSync(path.join(folder, 'Local Storage', 'leveldb'), { recursive: true });
      writeFileSync(path.join(folder, 'Local Storage', 'leveldb', '000003.log'), 'kept');
      return folder;
    };
    const whole = make('instance-whole');
    const keep = make('instance-keep');
    const stuck = make('instance-stuck');
    const outside = path.join(profile, 'keys');
    mkdirSync(outside);
    const pending = [
      { partition: 'persist:instance-WHOLE' },
      { partition: 'persist:instance-keep', keepLocalStorage: true },
      { partition: 'persist:instance-stuck' },
      { partition: 'persist:../keys' },
      { nothing: true },
      'persist:instance-whole',
    ];
    const tried: string[] = [];
    const { left, gone } = settlePendingRemovals(profile, pending, (folder, keepLocalStorage) => {
      tried.push(path.basename(folder));
      return folder === stuck ? false : removePartitionFolder(folder, keepLocalStorage);
    });
    expect(tried).toEqual(['instance-whole', 'instance-keep', 'instance-stuck']);
    expect(gone).toEqual(['persist:instance-WHOLE']);
    expect(left).toEqual([{ partition: 'persist:instance-stuck' }]);
    expect(existsSync(whole)).toBe(false);
    expect(readdirSync(keep)).toEqual(['Local Storage']);
    expect(existsSync(path.join(stuck, 'Network'))).toBe(true);
    expect(existsSync(outside)).toBe(true);
    // Already gone: nothing to do, and done.
    expect(removePartitionFolder(whole, false)).toBe(true);
    expect(removePartitionFolder(whole, true)).toBe(true);
    expect(settlePendingRemovals(profile, undefined)).toEqual({ left: [], gone: [] });
  } finally {
    rmSync(profile, { recursive: true, force: true });
  }
});
