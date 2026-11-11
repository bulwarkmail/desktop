import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { FilesFetchRequest } from '../src/shared/bridge';
import { DRIVE_NO_HOLD_MS, DRIVE_QUESTIONS_MAX, DriveController, type StoredDrive } from '../src/main/files/drive-controller';
import { ALIGN, FetchRelay, PIECE } from '../src/main/files/drive-fetch';
import { helperLetters, settleLetter, type LetterSystem } from '../src/main/files/drive-letter';
import { isOurLabel, registryLetterLabels, type LetterLabel, type LetterLabelSystem } from '../src/main/files/drive-letter-label';
import {
  accountKey,
  displayNameFor,
  filesErrorOf,
  folderNameFor,
  driveBase,
  freeLetters,
  letterTarget,
  nativeStatusOf,
  relativeParts,
  resolveUnder,
  rootKey,
  statusClassId,
  wantedLetter,
  driveProvider,
  DRIVE_PROVIDER,
} from '../src/main/files/drive-places';
import type { NativeFetchEvent, NativeFilesModule, NativeSyncRoot } from '../src/main/native-loader';
import { fakeRegistry } from './fake-registry';

/**
 * The Files drive's rules that need no Windows: the fetch relay against a fake helper, names,
 * paths and the letter. test/files-drive-native.spec.ts runs the real thing.
 */

interface Sent {
  offset: number;
  bytes: number[];
}

function fakeHelper() {
  const sent: Sent[] = [];
  const failed: { offset: number; length: number; reason: string }[] = [];
  return {
    sent,
    failed,
    native: {
      filesDriveTransfer: async (_c: string, _t: string, _r: string, offset: number, data: Buffer) => {
        sent.push({ offset, bytes: [...data] });
      },
      filesDriveTransferFailed: (_c: string, _t: string, _r: string, offset: number, length: number, reason: string) => {
        failed.push({ offset, length, reason });
      },
    },
  };
}

function relayWith(options: { ask?: (request: FilesFetchRequest) => true | 'not-running'; firstAnswerMs?: number; idleMs?: number } = {}) {
  const helper = fakeHelper();
  const asked: FilesFetchRequest[] = [];
  const cancelled: string[] = [];
  const relay = new FetchRelay({
    native: helper.native,
    locate: (connection, file) => (connection === 'c1' && file.startsWith('C:\\root\\') ? { rootId: 'r1', path: file.slice('C:\\root\\'.length).replaceAll('\\', '/') } : null),
    ask: options.ask ?? ((request) => {
      asked.push(request);
      return true;
    }),
    cancelled: (id) => cancelled.push(id),
    firstAnswerMs: options.firstAnswerMs,
    idleMs: options.idleMs,
    warn: () => {},
  });
  return { relay, helper, asked, cancelled };
}

const fetchEvent = (over: Partial<NativeFetchEvent> = {}): NativeFetchEvent => ({
  kind: 'fetch',
  connection: 'c1',
  transferKey: 't1',
  requestKey: 'q1',
  path: 'C:\\root\\Ordner mit Ümlaut\\a b.bin',
  identity: 'node-1',
  offset: 0,
  length: 10,
  total: 10,
  pid: 1,
  ...over,
});

const pattern = (length: number, from = 0) => Uint8Array.from({ length }, (_, index) => (from + index) % 251);

test.describe('the fetch relay', () => {
  test('asks the page with the path in the root, and hands Windows the bytes', async () => {
    const { relay, helper, asked } = relayWith();
    relay.onNative(fetchEvent());
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ rootId: 'r1', identity: 'node-1', path: 'Ordner mit Ümlaut/a b.bin', offset: 0, length: 10, total: 10 });
    expect(await relay.supply(asked[0].fetchId, 0, pattern(10))).toBe(true);
    expect(helper.sent).toEqual([{ offset: 0, bytes: [...pattern(10)] }]);
    // Done: more is refused.
    expect(await relay.supply(asked[0].fetchId, 10, pattern(1))).toBe(false);
    expect(relay.active()).toEqual([]);
  });

  test('pieces start at 4 KB aligned offsets and only the last may be short, whatever sizes the page sends', async () => {
    const total = PIECE * 2 + 5000;
    const { relay, helper, asked } = relayWith();
    relay.onNative(fetchEvent({ total, length: total }));
    const data = pattern(total);
    // Odd sizes on purpose.
    let at = 0;
    for (const size of [1000, 777_777, 1_500_000, total]) {
      const end = Math.min(at + size, total);
      expect(await relay.supply(asked[0].fetchId, at, data.subarray(at, end))).toBe(true);
      at = end;
      if (at === total) break;
    }
    expect(helper.sent.map((piece) => piece.offset)).toEqual([0, PIECE, PIECE * 2]);
    for (const piece of helper.sent.slice(0, -1)) expect(piece.bytes.length % ALIGN).toBe(0);
    expect(Buffer.concat(helper.sent.map((piece) => Buffer.from(piece.bytes)))).toEqual(Buffer.from(data));
  });

  test('a request in the middle asks from the 4 KB before it, and the page may start at 0', async () => {
    const total = 3 * ALIGN;
    const { relay, helper, asked } = relayWith();
    relay.onNative(fetchEvent({ offset: ALIGN + 100, length: 50, total }));
    expect(asked[0]).toMatchObject({ offset: ALIGN, length: total - ALIGN, total });
    expect(await relay.supply(asked[0].fetchId, 0, pattern(total))).toBe(true);
    expect(helper.sent).toHaveLength(1);
    expect(helper.sent[0].offset).toBe(ALIGN);
    expect(helper.sent[0].bytes).toEqual([...pattern(total - ALIGN, ALIGN)]);
  });

  test('a gap fails the fetch, and Windows is told', async () => {
    const { relay, helper, asked, cancelled } = relayWith();
    relay.onNative(fetchEvent({ total: 100, length: 100 }));
    expect(await relay.supply(asked[0].fetchId, 50, pattern(50))).toBe(false);
    expect(helper.failed).toHaveLength(1);
    expect(cancelled).toEqual([asked[0].fetchId]);
  });

  test('a fetch the page never answers fails on its own, so the program that opened it gets an error', async () => {
    const { relay, helper, asked, cancelled } = relayWith({ firstAnswerMs: 50 });
    relay.onNative(fetchEvent());
    await expect.poll(() => helper.failed.map((entry) => entry.reason)).toEqual(['timeout']);
    expect(cancelled).toEqual([asked[0].fetchId]);
    expect(await relay.supply(asked[0].fetchId, 0, pattern(10))).toBe(false);
  });

  test('a page that stops in the middle times out too', async () => {
    const { relay, helper, asked } = relayWith({ idleMs: 60 });
    relay.onNative(fetchEvent({ total: 100, length: 100 }));
    expect(await relay.supply(asked[0].fetchId, 0, pattern(40))).toBe(true);
    await expect.poll(() => helper.failed.map((entry) => entry.reason)).toEqual(['timeout']);
  });

  test('no page to ask: Windows hears at once', () => {
    const { relay, helper } = relayWith({ ask: () => 'not-running' });
    relay.onNative(fetchEvent());
    expect(helper.failed.map((entry) => entry.reason)).toEqual(['not-running']);
    expect(relay.active()).toEqual([]);
  });

  test('a path outside every root, or no identity, is refused', () => {
    const { relay, helper, asked } = relayWith();
    relay.onNative(fetchEvent({ path: 'C:\\elsewhere\\x' }));
    relay.onNative(fetchEvent({ identity: '' }));
    expect(asked).toEqual([]);
    expect(helper.failed).toHaveLength(2);
  });

  test("Windows' cancel reaches the page, and later bytes are refused", async () => {
    const { relay, asked, cancelled } = relayWith();
    relay.onNative(fetchEvent({ total: 100, length: 100 }));
    relay.onNative(fetchEvent({ kind: 'cancel' }));
    expect(cancelled).toEqual([asked[0].fetchId]);
    expect(await relay.supply(asked[0].fetchId, 0, pattern(100))).toBe(false);
  });

  test('the page saying offline ends it as offline', () => {
    const { relay, helper, asked } = relayWith();
    relay.onNative(fetchEvent());
    relay.fail(asked[0].fetchId, 'offline');
    expect(helper.failed.map((entry) => entry.reason)).toEqual(['offline']);
  });

  test('a root that goes ends its fetches', () => {
    const { relay, helper, cancelled } = relayWith();
    relay.onNative(fetchEvent());
    relay.dropRoot('r1');
    expect(helper.failed.map((entry) => entry.reason)).toEqual(['not-running']);
    expect(cancelled).toHaveLength(1);
  });
});

test.describe('names and paths', () => {
  test('one account is "Bulwark Files", several are told apart by address', () => {
    expect(displayNameFor('alice@example.org', 1)).toBe('Bulwark Files');
    expect(displayNameFor('alice@example.org', 2)).toBe('Bulwark Files - alice@example.org');
  });

  test('a folder name Windows can hold, and a second one for the same address', () => {
    expect(folderNameFor('alice@example.org', [])).toBe('alice@example.org');
    expect(folderNameFor('a<b>c:d"e/f\\g|h?i*j.', [])).toBe('a_b_c_d_e_f_g_h_i_j');
    expect(folderNameFor('con', [])).toBe('_con');
    expect(folderNameFor('Alice@example.org', ['alice@example.org'])).toBe('Alice@example.org (2)');
  });

  test("the page's paths: relative, `/` between parts, nothing that leaves", () => {
    expect(relativeParts('Ordner mit Ümlaut/a b.txt')).toEqual(['Ordner mit Ümlaut', 'a b.txt']);
    for (const bad of ['', '/a', 'a//b', 'a/../b', '..', 'a\\b', 'C:/x', 'a/./b', 'file.txt:stream', 'a\u0000']) expect(relativeParts(bad), bad).toBeNull();
  });

  test('a link on the way is refused', () => {
    const links = new Set(['C:\\root\\link']);
    const lstat = (file: string) => ({ isSymbolicLink: () => links.has(file) });
    expect(resolveUnder('C:\\root', 'dir/file', lstat)).toEqual({ ok: true, absolute: 'C:\\root\\dir\\file', parts: ['dir', 'file'] });
    expect(resolveUnder('C:\\root', 'link/file', lstat)).toEqual({ ok: false, error: 'outside' });
  });

  test("the helper's codes become the page's errors", () => {
    expect(filesErrorOf('not-placeholder')).toBe('changed');
    expect(filesErrorOf('changed')).toBe('changed');
    expect(filesErrorOf('pinned')).toBe('busy');
    expect(filesErrorOf('timeout')).toBe('failed');
  });
});

test.describe('the drive letter', () => {
  test('the policy wins over the choice, and none without a drive', () => {
    expect(wantedLetter(null, 'X', true)).toBe('X');
    expect(wantedLetter('none', 'X', true)).toBeNull();
    expect(wantedLetter('Q', 'X', true)).toBe('Q');
    expect(wantedLetter(null, 'X', false)).toBeNull();
    expect(wantedLetter(null, null, true)).toBeNull();
  });

  test('one account: its folder; several: the folder that holds them', () => {
    expect(letterTarget('C:\\B', [])).toBeNull();
    expect(letterTarget('C:\\B', ['C:\\B\\a'])).toBe('C:\\B\\a');
    expect(letterTarget('C:\\B', ['C:\\B\\a', 'C:\\B\\b'])).toBe('C:\\B');
  });

  test('free letters skip what the system uses, but keep our own', () => {
    const used = (letters: string) => [...letters].reduce((mask, letter) => mask | (1 << (letter.charCodeAt(0) - 65)), 0);
    const free = freeLetters(used('CDZ'), 'Z');
    expect(free).not.toContain('C');
    expect(free).not.toContain('D');
    expect(free).toContain('Z');
    expect(free).toContain('E');
  });

  test('the letters come from the native helper, and without it there are none and none are made', async () => {
    const added: string[] = [];
    const letters = helperLetters(
      {
        list: () => new Map([['X', 'C:\\Users\\a\\Bulwark Files\\a@b.c']]),
        add: async (letter, target) => {
          added.push(`${letter}:${target}`);
          return true;
        },
        remove: async () => true,
      },
      () => 0,
    );
    expect(await letters.list()).toEqual(new Map([['X', 'C:\\Users\\a\\Bulwark Files\\a@b.c']]));
    expect(await letters.add('Y', 'C:\\f')).toBe(true);
    expect(added).toEqual(['Y:C:\\f']);
    const none = helperLetters(null, () => 0);
    expect(await none.list()).toEqual(new Map());
    expect(await none.add('Y', 'C:\\f')).toBe(false);
    expect(await none.remove('Y')).toBe(false);
  });

  function fakeLetters(initial: Record<string, string>, usedMask = 0): LetterSystem & { map: Map<string, string> } {
    const map = new Map(Object.entries(initial));
    return {
      map,
      list: async () => new Map(map),
      add: async (letter, target) => {
        map.set(letter, target);
        return true;
      },
      remove: async (letter) => map.delete(letter),
      usedMask: () => [...map.keys()].reduce((mask, letter) => mask | (1 << (letter.charCodeAt(0) - 65)), usedMask),
    };
  }

  test("settling never touches someone else's subst, and moves ours", async () => {
    const system = fakeLetters({ Y: 'D:\\other', X: 'C:\\B\\a' });
    expect(await settleLetter(system, 'C:\\B', 'W', 'C:\\B', () => {})).toBe('W');
    expect(system.map).toEqual(new Map([['Y', 'D:\\other'], ['W', 'C:\\B']]));
    expect(await settleLetter(system, 'C:\\B', null, null, () => {})).toBeNull();
    expect(system.map).toEqual(new Map([['Y', 'D:\\other']]));
  });

  test('a letter in use by something else is not taken', async () => {
    const system = fakeLetters({ Y: 'D:\\other' });
    expect(await settleLetter(system, 'C:\\B', 'Y', 'C:\\B\\a', () => {})).toBeNull();
    expect(system.map.get('Y')).toBe('D:\\other');
  });
});

test.describe("Explorer's status for the drive", () => {
  const good = { state: 'syncing', label: 'Syncing', detail: 'Syncing: 1 done, 2 to go', quota: { used: 10, total: 100, label: '10 B of 100 B used' }, notice: null };

  test('a status from the page goes to the helper without nulls, which it refuses', () => {
    expect(nativeStatusOf(good)).toEqual({ state: 'syncing', label: 'Syncing', detail: 'Syncing: 1 done, 2 to go', quota: { used: 10, total: 100, label: '10 B of 100 B used' } });
    expect(nativeStatusOf({ ...good, quota: { used: 10, total: null, label: '10 B used' }, notice: 'Almost full' })).toEqual({
      state: 'syncing',
      label: 'Syncing',
      detail: 'Syncing: 1 done, 2 to go',
      quota: { used: 10, label: '10 B used' },
      notice: 'Almost full',
    });
    expect(nativeStatusOf({ ...good, quota: null })).toEqual({ state: 'syncing', label: 'Syncing', detail: 'Syncing: 1 done, 2 to go' });
  });

  test('anything else is no status', () => {
    for (const bad of [
      null,
      'synced',
      { ...good, state: 'idle' },
      { ...good, label: '' },
      { ...good, label: 'x'.repeat(201) },
      { ...good, detail: 'two\nlines' },
      { ...good, quota: { used: -1, total: 100, label: 'x' } },
      { ...good, quota: { used: 1.5, total: 100, label: 'x' } },
      { ...good, quota: { used: 1, total: 0, label: 'x' } },
      { ...good, quota: { used: 1, total: 100, label: '' } },
      { ...good, notice: 'x'.repeat(501) },
    ]) {
      expect(nativeStatusOf(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  test('one CLSID per profile, a name-based GUID, the same each start', () => {
    const installed = statusClassId('C:\\Users\\a\\AppData\\Roaming\\Bulwark');
    expect(installed).toMatch(/^\{[0-9A-F]{8}-[0-9A-F]{4}-5[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}\}$/);
    expect(statusClassId('C:\\Users\\a\\AppData\\Roaming\\Bulwark')).toBe(installed);
    expect(statusClassId('C:\\Users\\a\\AppData\\Local\\Temp\\bulwark-test')).not.toBe(installed);
  });
});

test.describe('the icon of a drive from before', () => {
  const PROVIDER = 'Bulwark Test Unit';
  const PROFILE = 'C:\profile';
  const NEW = 'C:\Program Files\Bulwark\resources\os-icons\bulwark.ico,0';
  type Registration = Parameters<NativeFilesModule['filesDriveRegister']>[0];

  function setUp(roots: NativeSyncRoot[], accounts: StoredDrive['accounts'], forcedOff = false) {
    const base = mkdtempSync(path.join(tmpdir(), 'bw-drive-icon-'));
    const registered: Registration[] = [];
    const unregistered: string[] = [];
    const native = {
      filesDriveRoots: async () => roots.map((root) => ({ ...root })),
      filesDriveRegister: async (options: Registration) => {
        registered.push(options);
        return `${options.provider}!S-1-5-21-1!${options.account}`;
      },
      filesDriveUnregister: async (id: string) => {
        unregistered.push(id);
      },
    } as unknown as NativeFilesModule;
    const drive = new DriveController({
      native,
      supported: true,
      provider: PROVIDER,
      base,
      profile: PROFILE,
      icon: NEW,
      version: '1.2.3',
      store: { read: () => ({ accounts }), write: () => {} },
      policy: () => ({ forcedOff, letter: null }),
      page: { fetch: () => true, fetchCancelled: () => {}, stateChanged: () => {} },
      registry: { add: () => {}, remove: () => {} },
      letters: null,
      warn: () => {},
      watchPins: false,
    });
    return { drive, registered, unregistered, remove: () => rmSync(base, { recursive: true, force: true }) };
  }

  // Ids in the form older versions registered (the account's key alone), which a stored account
  // names; `fresh` gives one this profile registered with its own key in it.
  const root = (account: string, icon: string | undefined, displayName = 'Bulwark Files', fresh = false): NativeSyncRoot =>
    ({ id: `${PROVIDER}!S-1-5-21-1!${fresh ? rootKey(PROFILE, account) : accountKey(PROFILE, account)}`, path: `C:\Users\a\Bulwark Files\${account}`, displayName, ...(icon === undefined ? {} : { icon }) }) as NativeSyncRoot;
  const wish = (label: string, signedOut = false) => ({ label, folder: label, rootId: `r-${label}`, createdAt: 1, ...(signedOut ? { signedOut } : {}) });

  test("a start registers a wanted root with another icon again, in place, with this version's", async () => {
    const roots = [
      root('acct-old', 'C:\dev\node_modules\electron\dist\electron.exe,0', 'Bulwark Files - a@example.org'),
      root('acct-same', NEW.toUpperCase(), 'Bulwark Files - b@example.org'),
      root('acct-gone', 'C:\dev\electron.exe,0', 'Bulwark Files', true),
      root('acct-out', 'C:\dev\electron.exe,0'),
      // An older helper lists no icon: left as it is.
      root('acct-unknown', undefined),
    ];
    const { drive, registered, unregistered, remove } = setUp(roots, {
      'acct-old': wish('a@example.org'),
      'acct-same': wish('b@example.org'),
      'acct-out': wish('c@example.org', true),
      'acct-unknown': wish('d@example.org'),
    });
    try {
      await drive.startUp();
      expect(registered).toEqual([
        { provider: PROVIDER, account: accountKey(PROFILE, 'acct-old'), path: roots[0].path, displayName: 'Bulwark Files - a@example.org', icon: NEW, version: '1.2.3' },
      ]);
      // Not wanted any more: they go, and get no new icon first.
      expect(unregistered.sort()).toEqual([roots[2].id, roots[3].id].sort());
    } finally {
      remove();
    }
  });

  test('nothing is registered again while the policy keeps the drive off', async () => {
    const { drive, registered, remove } = setUp([root('acct-old', 'C:\dev\electron.exe,0')], { 'acct-old': wish('a@example.org') }, true);
    try {
      await drive.startUp();
      expect(registered).toEqual([]);
    } finally {
      remove();
    }
  });
});

test.describe('the tray line of the drive (files-p3-5)', () => {
  test("shows the page's line per drive and the folder to open, and says when it changed", async () => {
    const base = mkdtempSync(path.join(tmpdir(), 'bw-drive-tray-'));
    let changes = 0;
    const native = {
      filesDriveRoots: async () => [],
      filesDriveRegister: async (options: { provider: string; account: string }) => `${options.provider}!S-1-5-21-1!${options.account}`,
      filesDriveConnect: () => 'c1',
      filesDriveDisconnect: () => {},
      filesDriveUnregister: async () => {},
      filesDriveInfo: () => ({ placeholder: false, directory: true, inSync: false, hydrated: true, partial: false, pin: 'unspecified', size: 0, onDisk: 0 }),
    } as unknown as NativeFilesModule;
    const store = { value: {} as StoredDrive };
    const drive = new DriveController({
      native,
      supported: true,
      provider: 'Bulwark Test Unit',
      base,
      profile: 'C:\\profile',
      icon: 'x.ico,0',
      version: '1',
      store: { read: () => store.value, write: (next) => (store.value = next) },
      policy: () => ({ forcedOff: false, letter: null }),
      page: { fetch: () => true, fetchCancelled: () => {}, stateChanged: () => {} },
      registry: { add: () => {}, remove: () => {} },
      letters: null,
      warn: () => {},
      watchPins: false,
      summaryChanged: () => changes++,
    });
    try {
      expect(drive.traySummary()).toEqual({ lines: [], folder: null, paused: false });
      const on = await drive.enable('acct-1', 'alice@example.org', () => true);
      expect(on.ok).toBe(true);
      expect(changes).toBeGreaterThan(0);
      const status = { state: 'offline', label: 'Offline', detail: 'Offline. 3 changes wait', quota: null, notice: null, tray: 'Bulwark Files: Offline. Waiting: 3' };
      const before = changes;
      drive.setStatus('acct-1', status);
      expect(changes).toBe(before + 1);
      // The same line again is no change.
      drive.setStatus('acct-1', { ...status, detail: 'other' });
      expect(changes).toBe(before + 1);
      expect(drive.traySummary()).toEqual({ lines: ['Bulwark Files: Offline. Waiting: 3'], folder: path.join(realpathSync.native(base), 'alice@example.org'), paused: false });
      // Paused: the tray offers to resume (files-p3-14).
      drive.setStatus('acct-1', { ...status, state: 'paused', tray: 'Bulwark Files: Paused' });
      expect(drive.traySummary().paused).toBe(true);
      expect(changes).toBe(before + 2);
      // A line that isn't one line of text is left out.
      drive.setStatus('acct-1', { ...status, tray: 'two\nlines' });
      expect(drive.traySummary().lines).toEqual([]);
      await drive.enable('acct-2', 'bob@example.org', () => true);
      drive.setStatus('acct-1', status);
      drive.setStatus('acct-2', { ...status, state: 'synced', tray: 'Bulwark Files: Up to date' });
      expect(drive.traySummary()).toEqual({
        lines: ['alice@example.org: Bulwark Files: Offline. Waiting: 3', 'bob@example.org: Bulwark Files: Up to date'],
        folder: realpathSync.native(base),
        paused: false,
      });
      await drive.disable('acct-1', 'wipe');
      await drive.disable('acct-2', 'wipe');
      expect(drive.traySummary()).toEqual({ lines: [], folder: null, paused: false });
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

test.describe("the drive letter's name and icon in This PC", () => {
  const ICON = 'C:\\Program Files\\Bulwark\\resources\\os-icons\\bulwark.ico,0';

  function fakeLabels(events: string[], initial: Record<string, LetterLabel> = {}): LetterLabelSystem & { keys: Map<string, LetterLabel> } {
    const keys = new Map(Object.entries(initial));
    return {
      keys,
      read: async (letter) => keys.get(letter) ?? { label: null, icon: null },
      write: async (letter, wanted) => {
        events.push(`name ${letter}`);
        keys.set(letter, { ...wanted });
        return true;
      },
      remove: async (letter) => {
        events.push(`unname ${letter}`);
        keys.delete(letter);
      },
      changed: (letter) => events.push(`notify ${letter}`),
    };
  }

  function driveWith(options: { used?: Record<string, string>; labels?: Record<string, LetterLabel>; policyLetter?: () => string | null } = {}) {
    const base = mkdtempSync(path.join(tmpdir(), 'bw-drive-label-'));
    const events: string[] = [];
    const map = new Map(Object.entries(options.used ?? {}));
    const letters: LetterSystem = {
      list: async () => new Map([...map].filter(([, target]) => target !== 'disk')),
      add: async (letter, target) => {
        events.push(`subst ${letter}`);
        map.set(letter, target);
        return true;
      },
      remove: async (letter) => {
        events.push(`unsubst ${letter}`);
        return map.delete(letter);
      },
      usedMask: () => [...map.keys()].reduce((mask, letter) => mask | (1 << (letter.charCodeAt(0) - 65)), 0),
    };
    const labels = fakeLabels(events, options.labels);
    const store = { value: {} as StoredDrive };
    const native = {
      filesDriveRoots: async () => [],
      filesDriveRegister: async (o: { provider: string; account: string }) => `${o.provider}!S-1-5-21-1!${o.account}`,
      filesDriveUnregister: async () => {},
      filesDriveConnect: () => 'c1',
      filesDriveDisconnect: () => {},
    } as unknown as NativeFilesModule;
    const drive = new DriveController({
      native,
      supported: true,
      provider: 'Bulwark Test Unit',
      base,
      profile: 'C:\\profile',
      icon: ICON,
      version: '1.2.3',
      store: { read: () => store.value, write: (next) => (store.value = next) },
      policy: () => ({ forcedOff: false, letter: options.policyLetter?.() ?? null }),
      page: { fetch: () => true, fetchCancelled: () => {}, stateChanged: () => {} },
      registry: { add: () => {}, remove: () => {} },
      letters,
      letterLabels: labels,
      warn: () => {},
      watchPins: false,
    });
    return { drive, events, labels, map, remove: () => rmSync(base, { recursive: true, force: true }) };
  }

  const yes = () => true;

  test('a letter is named before it comes, and the name goes after it went: off, sign-out, another letter, wipe', async () => {
    const { drive, events, labels, remove } = driveWith();
    try {
      expect((await drive.enable('acct-1', 'alice@example.org', yes)).ok).toBe(true);
      expect((await drive.setLetter('Q', yes)).ok).toBe(true);
      expect(events).toEqual(['name Q', 'notify Q', 'subst Q']);
      expect(labels.keys.get('Q')).toEqual({ label: 'Bulwark Files', icon: ICON });

      events.length = 0;
      expect((await drive.setLetter('R', yes)).ok).toBe(true);
      expect(events).toEqual(['name R', 'notify R', 'unsubst Q', 'subst R', 'unname Q', 'notify Q']);
      expect([...labels.keys.keys()]).toEqual(['R']);

      events.length = 0;
      await drive.disable('acct-1', 'signed-out');
      expect(events).toEqual(['unsubst R', 'unname R', 'notify R']);
      expect(labels.keys.size).toBe(0);

      expect((await drive.enable('acct-1', 'alice@example.org', yes)).ok).toBe(true);
      expect(labels.keys.get('R')).toEqual({ label: 'Bulwark Files', icon: ICON });
      expect((await drive.setLetter(null, yes)).ok).toBe(true);
      expect(labels.keys.size).toBe(0);

      expect((await drive.setLetter('S', yes)).ok).toBe(true);
      await drive.wipe();
      expect(labels.keys.size).toBe(0);
    } finally {
      remove();
    }
  });

  test("someone else's name or icon for the letter is never replaced or removed", async () => {
    const theirs = { label: 'Backup disk', icon: 'C:\\Tools\\disk.ico,0' };
    const { drive, events, labels, remove } = driveWith({ labels: { Q: theirs, R: { label: null, icon: 'C:\\Tools\\disk.ico,0' } } });
    try {
      expect((await drive.enable('acct-1', 'alice@example.org', yes)).ok).toBe(true);
      expect((await drive.setLetter('Q', yes)).ok).toBe(true);
      // The letter is set; its name stays theirs.
      expect(events).toEqual(['subst Q']);
      expect((await drive.setLetter('R', yes)).ok).toBe(true);
      await drive.disable('acct-1', 'user');
      expect(labels.keys.get('Q')).toEqual(theirs);
      expect(labels.keys.get('R')).toEqual({ label: null, icon: 'C:\\Tools\\disk.ico,0' });
      expect(events.filter((event) => event.startsWith('name') || event.startsWith('unname'))).toEqual([]);
    } finally {
      remove();
    }
  });

  test('a letter something else holds gets no name, not even for a moment', async () => {
    let policyLetter: string | null = null;
    const { drive, events, labels, remove } = driveWith({ used: { T: 'disk' }, policyLetter: () => policyLetter });
    try {
      expect((await drive.enable('acct-1', 'alice@example.org', yes)).ok).toBe(true);
      policyLetter = 'T';
      await drive.policyChanged();
      expect(drive.state().letter.letter).toBeNull();
      expect(events).toEqual([]);
      expect(labels.keys.size).toBe(0);
    } finally {
      remove();
    }
  });

  test('a name from an install somewhere else counts as ours', () => {
    expect(isOurLabel({ label: 'Bulwark Files', icon: 'D:\\Apps\\Bulwark\\resources\\os-icons\\bulwark.ico,0' }, ICON)).toBe(true);
    expect(isOurLabel({ label: null, icon: ICON.toUpperCase() }, ICON)).toBe(true);
    expect(isOurLabel({ label: 'Backup disk', icon: ICON }, ICON)).toBe(false);
    expect(isOurLabel({ label: 'Bulwark Files', icon: 'C:\\Tools\\disk.ico,0' }, ICON)).toBe(false);
    expect(isOurLabel({ label: 'Bulwark Files', icon: null }, ICON)).toBe(false);
  });

  test('the default values are read, as text of either kind, and a key without one has none', async () => {
    const drives = 'HKCU\\Software\\Classes\\Applications\\Explorer.exe\\Drives';
    const registry = fakeRegistry({
      [`${drives}\\X\\DefaultLabel`]: [{ name: '', kind: 'sz', text: 'Bulwark Files' }],
      [`${drives}\\X\\DefaultIcon`]: [{ name: '', kind: 'expand_sz', text: 'C:\\a b\\bulwark.ico,0 ' }],
      [`${drives}\\Y\\DefaultLabel`]: [{ name: 'Other', kind: 'sz', text: 'x' }],
      [`${drives}\\Y\\DefaultIcon`]: [{ name: '', kind: 'binary' }],
    });
    const labels = registryLetterLabels('HKCU', registry, null);
    expect(await labels.read('X')).toEqual({ label: 'Bulwark Files', icon: 'C:\\a b\\bulwark.ico,0' });
    expect(await labels.read('Y')).toEqual({ label: null, icon: null });
    expect(await labels.read('Z')).toEqual({ label: null, icon: null });
    expect(await registryLetterLabels('HKCU', null, null).read('X')).toEqual({ label: null, icon: null });
  });

  test('a letter\'s labels are written as default values, and its key goes only when nothing else is in it', async () => {
    const drives = 'HKCU\\Software\\Classes\\Applications\\Explorer.exe\\Drives';
    const registry = fakeRegistry({ [`${drives}\\Q\\Other`]: [] });
    const labels = registryLetterLabels('HKCU', registry, null);
    expect(await labels.write('P', { label: 'Bulwark Files', icon: 'i.ico,0' })).toBe(true);
    expect(await labels.write('Q', { label: 'Bulwark Files', icon: 'i.ico,0' })).toBe(true);
    expect(registry.read(`${drives}\\P\\DefaultLabel`)?.[0].values).toEqual([{ name: '', kind: 'sz', text: 'Bulwark Files' }]);
    await labels.remove('P');
    await labels.remove('Q');
    expect(registry.read(`${drives}\\P`)).toBeNull();
    expect(registry.read(`${drives}\\Q`)?.[0].subkeys).toEqual(['Other']);
    expect(await registryLetterLabels('HKCU', null, null).write('P', { label: 'a', icon: 'b' })).toBe(false);
  });
});

test("a test build keeps its drive in its own profile, never in the user's Bulwark Files", () => {
  const where = { profile: 'C:\\Temp\\test-profile', home: 'C:\\Users\\someone' };
  expect(driveBase({ ...where, chosen: null, testBuild: true })).toBe(path.join(where.profile, 'Bulwark Files'));
  expect(driveBase({ ...where, chosen: null, testBuild: false })).toBe(path.join(where.home, 'Bulwark Files'));
  expect(driveBase({ ...where, chosen: 'C:\\elsewhere', testBuild: true })).toBe('C:\\elsewhere');
});

test('a test build names its sync roots with a provider of its own, even when a run names none', () => {
  expect(driveProvider({ chosen: null, testBuild: false })).toBe(DRIVE_PROVIDER);
  expect(driveProvider({ chosen: null, testBuild: true })).not.toBe(DRIVE_PROVIDER);
  expect(driveProvider({ chosen: undefined, testBuild: true }).startsWith(`${DRIVE_PROVIDER}!`)).toBe(false);
  expect(driveProvider({ chosen: 'Bulwark Run 1', testBuild: true })).toBe('Bulwark Run 1');
});

test.describe("another profile's Files drive", () => {
  const PROVIDER = 'Bulwark';
  const SID = 'S-1-5-21-1-2-3-1001';
  const HOME = path.win32.join('C:', 'Users', 'someone');
  const INSTALLED = path.win32.join(HOME, 'AppData', 'Roaming', 'Bulwark');
  const OTHER = path.win32.join(HOME, 'AppData', 'Local', 'Temp', 'other-profile');
  const INSTALLED_ICON = 'C:\\Program Files\\Bulwark\\resources\\os-icons\\bulwark.ico,0';
  const TEST_ICON = 'C:\\src\\desktop\\dist\\os-icons\\bulwark.ico,0';

  /** Every sync root of this Windows user, as the helper lists them, and what was done to them. */
  function world(roots: NativeSyncRoot[] = []) {
    const registered = [...roots];
    const calls: string[] = [];
    const native = {
      filesDriveRoots: async () => registered.map((root) => ({ ...root })),
      filesDriveRegister: async (options: { provider: string; account: string; path: string; displayName: string }) => {
        const id = `${options.provider}!${SID}!${options.account}`;
        const at = registered.findIndex((root) => root.id === id);
        const root = { id, path: options.path, displayName: options.displayName } as NativeSyncRoot;
        if (at === -1) registered.push(root);
        else registered[at] = root;
        return id;
      },
      filesDriveUnregister: async (id: string) => {
        calls.push(`unregister ${id}`);
        const at = registered.findIndex((root) => root.id === id);
        if (at !== -1) registered.splice(at, 1);
      },
      filesDriveConnect: (dir: string) => {
        calls.push(`connect ${dir}`);
        return `c-${dir}`;
      },
      filesDriveDisconnect: () => {},
      filesDriveInfo: () => {
        throw new Error('files:missing');
      },
    } as unknown as NativeFilesModule;
    return { registered, calls, native };
  }

  /** The installed app's drive, registered by a version that put the account's key alone in the id. */
  const installedRoot = (): NativeSyncRoot =>
    ({ id: `${PROVIDER}!${SID}!${accountKey(INSTALLED, 'user@example.org')}`, path: path.win32.join(HOME, 'Bulwark Files', 'user@example.org'), displayName: 'Bulwark Files' }) as NativeSyncRoot;

  const bases: string[] = [];
  test.afterEach(() => {
    for (const base of bases.splice(0)) rmSync(base, { recursive: true, force: true });
  });

  function profileDrive(native: NativeFilesModule, profile: string, options: { stored?: StoredDrive; letters?: LetterSystem; letterLabels?: LetterLabelSystem; policyLetter?: string | null; icon?: string } = {}) {
    const base = mkdtempSync(path.join(tmpdir(), 'bw-drive-profiles-'));
    bases.push(base);
    const store = { value: options.stored ?? ({} as StoredDrive) };
    const drive = new DriveController({
      native,
      supported: true,
      provider: PROVIDER,
      base,
      profile,
      icon: options.icon ?? TEST_ICON,
      version: '0',
      store: { read: () => store.value, write: (next) => (store.value = next) },
      policy: () => ({ forcedOff: false, letter: options.policyLetter ?? null }),
      page: { fetch: () => 'not-running', fetchCancelled: () => {}, stateChanged: () => {} },
      registry: { add: () => {}, remove: () => {} },
      letters: options.letters ?? null,
      letterLabels: options.letterLabels ?? null,
      warn: () => {},
      watchPins: false,
    });
    return { drive, store, base };
  }

  test('a start of a second profile neither connects to it nor unregisters it', async () => {
    const { registered, calls, native } = world([installedRoot()]);
    await profileDrive(native, OTHER).drive.startUp();
    expect.soft(calls, "calls on the other profile's sync root").toEqual([]);
    expect(registered).toEqual([installedRoot()]);
  });

  test('a wipe in a second profile leaves it registered', async () => {
    const { registered, native } = world([installedRoot()]);
    await profileDrive(native, OTHER).drive.wipe();
    expect(registered).toEqual([installedRoot()]);
  });

  test('two profiles, the same account on the same server: two sync roots, and neither profile touches the other\'s', async () => {
    const { registered, calls, native } = world();
    const first = profileDrive(native, INSTALLED);
    const second = profileDrive(native, OTHER);
    expect((await first.drive.enable('acct-1', 'user@example.org', () => true)).ok).toBe(true);
    expect((await second.drive.enable('acct-1', 'user@example.org', () => true)).ok).toBe(true);
    expect(registered).toHaveLength(2);
    expect(registered[0].id).not.toBe(registered[1].id);
    const firstRoot = registered.find((root) => root.id.endsWith(`!${rootKey(INSTALLED, 'acct-1')}`));
    expect(firstRoot).toBeTruthy();
    calls.length = 0;
    // The second profile's user signs out and the next start finds nothing wanted; then a wipe.
    await second.drive.disable('acct-1', 'user');
    await second.drive.startUp();
    await second.drive.wipe();
    expect(registered.map((root) => root.id)).toEqual([firstRoot!.id]);
    expect(calls.filter((call) => call.includes(firstRoot!.id) || call.includes(firstRoot!.path))).toEqual([]);
    // And the other way round.
    expect((await second.drive.enable('acct-1', 'user@example.org', () => true)).ok).toBe(true);
    await first.drive.disable('acct-1', 'user');
    await first.drive.wipe();
    expect(registered.map((root) => root.id)).toEqual([`${PROVIDER}!${SID}!${rootKey(OTHER, 'acct-1')}`]);
  });

  test('a root in the form older versions registered is this profile\'s while its stored accounts name it: kept while wanted, then swept as any other', async () => {
    const old = { id: `${PROVIDER}!${SID}!${accountKey(INSTALLED, 'acct-1')}`, path: 'C:\\x\\acct-1', displayName: 'Bulwark Files' } as NativeSyncRoot;
    const signedOut = { id: `${PROVIDER}!${SID}!${accountKey(INSTALLED, 'acct-2')}`, path: 'C:\\x\\acct-2', displayName: 'Bulwark Files' } as NativeSyncRoot;
    const { registered, native } = world([old, signedOut]);
    const stored: StoredDrive = {
      accounts: {
        'acct-1': { label: 'a@example.org', folder: 'a@example.org', rootId: 'r1', createdAt: 1 },
        'acct-2': { label: 'b@example.org', folder: 'b@example.org', rootId: 'r2', createdAt: 1, signedOut: true },
      },
    };
    const { drive } = profileDrive(native, INSTALLED, { stored });
    await drive.startUp();
    // Wanted: it stays. Signed out: it goes, as a root of this profile's would.
    expect(registered.map((root) => root.id)).toEqual([old.id]);
    // Turned on again: registered in place, under the same id, also at the next start.
    expect((await drive.enable('acct-1', 'a@example.org', () => false)).ok).toBe(true);
    expect(registered.map((root) => root.id)).toEqual([old.id]);
    await drive.startUp();
    expect(registered.map((root) => root.id)).toEqual([old.id]);
    await drive.disable('acct-1', 'user');
    expect(registered).toEqual([]);
  });

  test('a root in the older form that no stored account names is nobody\'s this profile knows: a start and a wipe leave it', async () => {
    const stray = { id: `${PROVIDER}!${SID}!${accountKey(INSTALLED, 'acct-gone')}`, path: 'C:\\x\\gone', displayName: 'Bulwark Files' } as NativeSyncRoot;
    const { registered, calls, native } = world([stray]);
    const { drive } = profileDrive(native, INSTALLED, { stored: { accounts: { 'acct-1': { label: 'a@example.org', folder: 'a@example.org', rootId: 'r1', createdAt: 1 } } } });
    await drive.startUp();
    await drive.wipe();
    expect(calls).toEqual([]);
    expect(registered).toEqual([stray]);
  });

  test("the drive letter another profile's drive is on keeps its name, and its mapping, whichever letter this profile wants", async () => {
    const theirs = { label: 'Bulwark Files', icon: INSTALLED_ICON };
    const map = new Map([['Q', path.win32.join(HOME, 'Bulwark Files', 'user@example.org')]]);
    const events: string[] = [];
    const labels = new Map<string, LetterLabel>([['Q', theirs]]);
    const letters: LetterSystem = {
      list: async () => new Map(map),
      add: async (letter, target) => {
        events.push(`subst ${letter}`);
        map.set(letter, target);
        return true;
      },
      remove: async (letter) => {
        events.push(`unsubst ${letter}`);
        return map.delete(letter);
      },
      usedMask: () => [...map.keys()].reduce((mask, letter) => mask | (1 << (letter.charCodeAt(0) - 65)), 0),
    };
    const letterLabels: LetterLabelSystem = {
      read: async (letter) => labels.get(letter) ?? { label: null, icon: null },
      write: async (letter, wanted) => {
        events.push(`name ${letter}`);
        labels.set(letter, { ...wanted });
        return true;
      },
      remove: async (letter) => {
        events.push(`unname ${letter}`);
        labels.delete(letter);
      },
      changed: () => {},
    };
    const { native } = world([installedRoot()]);
    // The policy names the same letter for every profile, and this one chose it too.
    const { drive } = profileDrive(native, OTHER, { stored: { letter: 'Q' }, letters, letterLabels, policyLetter: 'Q' });
    await drive.startUp();
    expect((await drive.enable('acct-1', 'other@example.org', () => true)).ok).toBe(true);
    await drive.disable('acct-1', 'user');
    await drive.wipe();
    expect(labels.get('Q')).toEqual(theirs);
    expect(map.get('Q')).toBe(path.win32.join(HOME, 'Bulwark Files', 'user@example.org'));
    expect(events.filter((event) => event.endsWith(' Q'))).toEqual([]);
  });
});

test.describe('turning the drive on: a click, and then the user\'s yes', () => {
  const PROFILE = 'C:\\profile';

  /** A drive over a fake helper, with the question answered from `answers` (true is yes) and counted. */
  function askingDrive(answers: boolean[], options: { stored?: StoredDrive; now?: () => number } = {}) {
    const base = mkdtempSync(path.join(tmpdir(), 'bw-drive-ask-'));
    const registered: string[] = [];
    const native = {
      filesDriveRoots: async () => registered.map((id) => ({ id, path: base, displayName: 'Bulwark Files' })),
      filesDriveRegister: async (o: { provider: string; account: string }) => {
        const id = `${o.provider}!S-1-5-21-1!${o.account}`;
        if (!registered.includes(id)) registered.push(id);
        return id;
      },
      filesDriveUnregister: async (id: string) => {
        registered.splice(registered.indexOf(id), 1);
      },
      filesDriveConnect: () => 'c1',
      filesDriveDisconnect: () => {},
      filesDrivePlace: (_dir: string, batch: unknown[]) => batch.map(() => ''),
      filesDriveInfo: () => {
        throw new Error('files:missing');
      },
    } as unknown as NativeFilesModule;
    const yes = new Set<string>();
    const asked: { account: string; label: string; folder: string }[] = [];
    const letters: LetterSystem = { list: async () => new Map(), add: async () => true, remove: async () => true, usedMask: () => 0 };
    const store = { value: options.stored ?? ({} as StoredDrive) };
    const drive = new DriveController({
      native,
      supported: true,
      provider: 'Bulwark Test Unit',
      base,
      profile: PROFILE,
      icon: 'x.ico,0',
      version: '1',
      store: { read: () => store.value, write: (next) => (store.value = next) },
      policy: () => ({ forcedOff: false, letter: null }),
      page: { fetch: () => true, fetchCancelled: () => {}, stateChanged: () => {} },
      registry: { add: () => {}, remove: () => {} },
      letters,
      warn: () => {},
      watchPins: false,
      ...(options.now ? { now: options.now } : {}),
      consent: {
        origin: 'https://mail.example.org',
        has: (account) => (account === undefined ? yes.size > 0 : yes.has(account)),
        add: (account) => yes.add(account),
        remove: (account) => yes.delete(account),
        clear: () => yes.clear(),
        ask: async (account, label, folder) => {
          asked.push({ account, label, folder });
          return answers.shift() ?? false;
        },
      },
    });
    return { drive, base, registered, asked, yes, store, remove: () => rmSync(base, { recursive: true, force: true }) };
  }

  test('after a no, the page can not put the question up again by naming another account', async () => {
    let now = 1_000_000;
    const { drive, asked, remove } = askingDrive([false, false, false, false, false, false], { now: () => now });
    try {
      expect(await drive.enable('acct-1', 'alice@example.org', click)).toEqual({ ok: false, error: 'cancelled' });
      // The account is the page's word. Five more clicks, a new name each time.
      for (let n = 2; n <= 6; n += 1) expect(await drive.enable(`acct-${n}`, 'alice@example.org', click), `acct-${n}`).toEqual({ ok: false, error: 'cancelled' });
      expect(asked.map((question) => question.account), 'questions inside the hold time of the first no').toEqual(['acct-1']);
      // Once the no has run out, the server may ask again.
      now += DRIVE_NO_HOLD_MS + 1;
      await drive.enable('acct-7', 'alice@example.org', click);
      expect(asked).toHaveLength(2);
    } finally {
      remove();
    }
  });

  test('one server puts the question up three times at most while the app runs, yes or no', async () => {
    let now = 1_000_000;
    const { drive, asked, remove } = askingDrive([true, true, false, true], { now: () => now });
    try {
      expect((await drive.enable('acct-1', 'a@example.org', click)).ok).toBe(true);
      expect((await drive.enable('acct-2', 'b@example.org', click)).ok).toBe(true);
      expect(await drive.enable('acct-3', 'c@example.org', click)).toEqual({ ok: false, error: 'cancelled' });
      now += DRIVE_NO_HOLD_MS + 1;
      expect(await drive.enable('acct-4', 'd@example.org', click)).toEqual({ ok: false, error: 'cancelled' });
      expect(asked).toHaveLength(DRIVE_QUESTIONS_MAX);
      // The accounts that got a yes still come back with no question.
      expect((await drive.enable('acct-1', 'a@example.org', () => false)).ok).toBe(true);
    } finally {
      remove();
    }
  });

  const click = () => true;
  const noClick = () => false;

  test('no click: refused before anything is asked; a click: the question names the folder, and a no makes nothing', async () => {
    const { drive, base, registered, asked, remove } = askingDrive([false]);
    try {
      expect(await drive.enable('acct-1', 'alice@example.org', noClick)).toEqual({ ok: false, error: 'gesture' });
      expect(asked).toEqual([]);
      expect(await drive.enable('acct-1', 'alice@example.org', click)).toEqual({ ok: false, error: 'cancelled' });
      expect(asked).toEqual([{ account: 'acct-1', label: 'alice@example.org', folder: path.win32.join(realpathSync.native(base), 'alice@example.org') }]);
      expect(registered).toEqual([]);
      expect(drive.state().wanted).toEqual([]);
    } finally {
      remove();
    }
  });

  test('after a no, five more clicks ask nothing until the no has run out; then a yes turns it on', async () => {
    let now = 1_000_000;
    const { drive, registered, asked, remove } = askingDrive([false, true], { now: () => now });
    try {
      await drive.enable('acct-1', 'alice@example.org', click);
      for (let call = 0; call < 5; call += 1) expect(await drive.enable('acct-1', 'alice@example.org', click)).toEqual({ ok: false, error: 'cancelled' });
      expect(asked).toHaveLength(1);
      now += DRIVE_NO_HOLD_MS + 1;
      expect((await drive.enable('acct-1', 'alice@example.org', click)).ok).toBe(true);
      expect(asked).toHaveLength(2);
      expect(registered).toHaveLength(1);
    } finally {
      remove();
    }
  });

  test('a second account of the same server is asked for again: its folder is another', async () => {
    const { drive, asked, remove } = askingDrive([true, false]);
    try {
      expect((await drive.enable('acct-1', 'alice@example.org', click)).ok).toBe(true);
      expect(await drive.enable('acct-2', 'bob@example.org', click)).toEqual({ ok: false, error: 'cancelled' });
      expect(asked.map((question) => path.win32.basename(question.folder))).toEqual(['alice@example.org', 'bob@example.org']);
    } finally {
      remove();
    }
  });

  test('a label with path characters, a turned-round mark or 300 characters is cleaned before the question shows it', async () => {
    // Each says yes: a no would hold the question back for the next account.
    const { drive, base, asked, remove } = askingDrive([true, true, true]);
    try {
      await drive.enable('acct-1', '..\\..\\Windows\\System32', click);
      await drive.enable('acct-2', 'x'.repeat(300), click);
      await drive.enable('acct-3', 'Invoices\u202Efdp.exe', click);
      const real = realpathSync.native(base);
      for (const { folder } of asked) expect(path.win32.dirname(folder), folder).toBe(real);
      expect(asked.map((question) => path.win32.basename(question.folder))).toEqual(['.._.._Windows_System32', 'x'.repeat(120), 'Invoicesfdp.exe']);
      // A label longer than the drive takes is refused before anything is asked.
      expect(await drive.enable('acct-4', 'x'.repeat(321), click)).toEqual({ ok: false, error: 'failed' });
      expect(asked).toHaveLength(3);
    } finally {
      remove();
    }
  });

  test('the yes stays through a sign-out, so a sign-in brings the drive back with no click; turned off by the user, it asks again', async () => {
    const { drive, asked, remove } = askingDrive([true, true]);
    try {
      expect((await drive.enable('acct-1', 'alice@example.org', click)).ok).toBe(true);
      await drive.disable('acct-1', 'signed-out');
      expect((await drive.enable('acct-1', 'alice@example.org', noClick)).ok).toBe(true);
      expect(asked).toHaveLength(1);
      await drive.disable('acct-1', 'user');
      expect(await drive.enable('acct-1', 'alice@example.org', noClick)).toEqual({ ok: false, error: 'gesture' });
      expect((await drive.enable('acct-1', 'alice@example.org', click)).ok).toBe(true);
      expect(asked).toHaveLength(2);
    } finally {
      remove();
    }
  });

  test('a wish stored with no yes for this server takes the click and the question too', async () => {
    const stored: StoredDrive = { accounts: { 'acct-1': { label: 'alice@example.org', folder: 'alice@example.org', rootId: 'r1', createdAt: 1 } } };
    const { drive, asked, remove } = askingDrive([true], { stored });
    try {
      expect(await drive.enable('acct-1', 'alice@example.org', noClick)).toEqual({ ok: false, error: 'gesture' });
      expect((await drive.enable('acct-1', 'alice@example.org', click)).ok).toBe(true);
      expect(asked).toHaveLength(1);
    } finally {
      remove();
    }
  });

  test('a drive letter only for a server with a yes, and a wipe takes every yes', async () => {
    const { drive, yes, remove } = askingDrive([true]);
    try {
      expect(await drive.setLetter('Q', click)).toEqual({ ok: false, error: 'gesture' });
      expect((await drive.enable('acct-1', 'alice@example.org', click)).ok).toBe(true);
      expect((await drive.setLetter('Q', click)).ok).toBe(true);
      await drive.wipe();
      expect(yes.size).toBe(0);
      expect(await drive.setLetter('R', click)).toEqual({ ok: false, error: 'gesture' });
    } finally {
      remove();
    }
  });

  test('placing takes names through the same check as every other path: no device name, no trailing dot or space', async () => {
    const { drive, remove } = askingDrive([true]);
    try {
      const on = await drive.enable('acct-1', 'alice@example.org', click);
      if (!on.ok) throw new Error(on.error);
      const entry = (name: string) => ({ path: name, kind: 'file' as const, size: 1, mtimeMs: 1, identity: 'i' });
      const placed = await drive.place(on.value.id, ['ok.txt', 'con', 'aux.txt', 'trailing.', 'trailing ', 'note:stream', '../out'].map(entry));
      expect(placed).toEqual({ ok: true, value: [{ path: 'ok.txt' }, { path: 'con', error: 'name' }, { path: 'aux.txt', error: 'name' }, { path: 'trailing.', error: 'name' }, { path: 'trailing ', error: 'name' }, { path: 'note:stream', error: 'name' }, { path: '../out', error: 'outside' }] });
    } finally {
      remove();
    }
  });
});
