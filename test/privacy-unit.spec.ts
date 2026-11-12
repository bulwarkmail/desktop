import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSync } from 'esbuild';
import { expect, test } from '@playwright/test';
import { buildCrashUpload, crashFilesOf, listCrashFiles, noteCrashRun, readCrashRuns, removeAllCrashFiles, removeCrashFilesOf, scrubMinidump, sweepCrashFiles, validUploadUrl, type ScrubNames } from '../src/main/crash-files';
import { MainErrorCounter, fingerprintOfMainError, mainErrorName } from '../src/main/main-errors';
import { serverEnv, profilePaths, telemetryOffInEnv } from '../src/main/profile';
import { normalizeStack } from '../src/server/protocol';
import { hasCollector, loadCollectorValidator } from './collector';
import { buildDesktopErrorBatch } from '../src/shared/desktop-telemetry';

function folder(): string {
  return mkdtempSync(path.join(tmpdir(), 'bw-crash-'));
}

/** Age in days, so nothing depends on how long a test takes. */
function plant(dir: string, id: string, bytes: number, daysOld: number, sub = 'reports'): string {
  mkdirSync(path.join(dir, sub), { recursive: true });
  const file = path.join(dir, sub, `${id}.dmp`);
  writeFileSync(file, Buffer.alloc(bytes, 1));
  const when = new Date(Date.now() - daysOld * 86_400_000);
  utimesSync(file, when, when);
  return file;
}

const ids = (dir: string) => listCrashFiles(dir).map((crash) => crash.id);

test.describe('the minidump cap', () => {
  const limits = { count: 3, bytes: 1000, ageMs: 30 * 86_400_000 };

  test('keeps the newest by count', () => {
    const dir = folder();
    for (const [index, id] of ['a', 'b', 'c', 'd', 'e'].entries()) plant(dir, id, 10, index);
    expect(sweepCrashFiles(dir, limits)).toBe(2);
    expect(ids(dir)).toEqual(['a', 'b', 'c']);
    rmSync(dir, { recursive: true, force: true });
  });

  test('keeps the newest by bytes, and one too big for the cap goes', () => {
    const dir = folder();
    plant(dir, 'new', 600, 0);
    plant(dir, 'middle', 300, 1);
    plant(dir, 'old', 300, 2);
    sweepCrashFiles(dir, limits);
    expect(ids(dir)).toEqual(['new', 'middle']);
    plant(dir, 'huge', 5000, -1);
    sweepCrashFiles(dir, limits);
    expect(ids(dir)).toEqual(['new', 'middle']);
    rmSync(dir, { recursive: true, force: true });
  });

  test('removes what has grown old, whatever the count', () => {
    const dir = folder();
    plant(dir, 'fresh', 10, 1);
    plant(dir, 'stale', 10, 40);
    sweepCrashFiles(dir, limits);
    expect(ids(dir)).toEqual(['fresh']);
    rmSync(dir, { recursive: true, force: true });
  });

  test('finds the folders each OS uses, and takes only dumps', () => {
    const dir = folder();
    plant(dir, 'win', 10, 0, 'reports');
    plant(dir, 'mac', 10, 1, 'completed');
    plant(dir, 'linux', 10, 2, 'pending');
    writeFileSync(path.join(dir, 'reports', 'metadata'), 'x');
    writeFileSync(path.join(dir, 'settings.dat'), 'x');
    expect(ids(dir)).toEqual(['win', 'mac', 'linux']);
    removeAllCrashFiles(dir);
    expect(ids(dir)).toEqual([]);
    // Crashpad's own files stay: it needs them to keep working.
    expect(existsSync(path.join(dir, 'settings.dat'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test('takes a dump\'s attachments with it', () => {
    const dir = folder();
    plant(dir, 'gone', 10, 0);
    mkdirSync(path.join(dir, 'attachments', 'gone'), { recursive: true });
    writeFileSync(path.join(dir, 'attachments', 'gone', 'log'), 'x');
    removeAllCrashFiles(dir);
    expect(existsSync(path.join(dir, 'attachments', 'gone'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a server's wipe takes the crash files of its runs; one from before any run was noted is the standalone page's", () => {
    const dir = folder();
    const instance = 'https://mail.example.org';
    const standalone = 'https://app.bulwark.localhost';
    const day = 86_400_000;
    const now = Date.now();
    plant(dir, 'before-notes', 10, 9);
    noteCrashRun(dir, instance, now - 8 * day);
    plant(dir, 'instance-1', 10, 7);
    noteCrashRun(dir, standalone, now - 6 * day);
    plant(dir, 'standalone-1', 10, 5);
    noteCrashRun(dir, instance, now - 4 * day);
    plant(dir, 'instance-2', 10, 3);
    expect(crashFilesOf(listCrashFiles(dir), readCrashRuns(dir), instance).map((crash) => crash.id)).toEqual(['instance-2', 'instance-1']);
    // No address in the list of runs.
    expect(readFileSync(path.join(dir, 'runs.json'), 'utf8')).not.toContain('example.org');
    removeCrashFilesOf(dir, instance);
    expect(ids(dir)).toEqual(['standalone-1', 'before-notes']);
    removeCrashFilesOf(dir, 'https://other.example');
    expect(ids(dir)).toEqual(['standalone-1', 'before-notes']);
    removeCrashFilesOf(dir, standalone);
    expect(ids(dir)).toEqual([]);
    plant(dir, 'any', 10, 0);
    removeCrashFilesOf(dir, null);
    expect(ids(dir)).toEqual([]);
    expect(existsSync(path.join(dir, 'runs.json'))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  test('a folder that isn\'t there is no crash files', () => {
    expect(listCrashFiles(path.join(tmpdir(), 'bw-no-such-folder'))).toEqual([]);
    expect(sweepCrashFiles(path.join(tmpdir(), 'bw-no-such-folder'))).toBe(0);
  });
});

test.describe('scrubbing a minidump', () => {
  const names = { home: 'C:\\Users\\Linus Rath', username: 'linusr', hostname: 'DESKTOP-ABC123' };
  const utf16 = (text: string) => Buffer.from(text, 'utf16le');
  const ascii = (text: string) => Buffer.from(text, 'latin1');
  const has = (bytes: Buffer, text: string) => bytes.includes(ascii(text)) || bytes.includes(utf16(text));

  const SECRETS = [
    'C:\\Users\\Linus Rath\\AppData\\Roaming\\Bulwark\\x.log',
    'C:/Users/Linus Rath/AppData/y.log',
    'linusr',
    'DESKTOP-ABC123',
    'ceo.private@acme-corp.example',
    'Bearer abc.def-123_456',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9P',
    'Subject: Merger plans for Acme Q3',
    '"subject":"Merger plans for Acme Q3"',
    '"preview":"We should buy them before the board meets"',
    'Xq7vLm2pR9sT4wZ8yB1nC6kD3fH5jG0aXq7vLm2p',
  ];

  for (const secret of SECRETS) {
    test(`takes out ${secret.slice(0, 30)} as bytes and as UTF-16, at the same length`, () => {
      const before = Buffer.concat([ascii('MDMP\0\0\x01\x02'), ascii(secret), Buffer.from([0, 255, 0]), utf16(secret), Buffer.from([0, 0, 7])]);
      const copy = Buffer.from(before);
      const after = scrubMinidump(before, names);
      expect(after.length).toBe(before.length);
      // The original is left alone: this is a copy for sending.
      expect(before.equals(copy)).toBe(true);
      // A file still begins as a minidump, and its binary parts don't move.
      expect(after.subarray(0, 8).equals(before.subarray(0, 8))).toBe(true);
      expect(after[8 + secret.length + 1]).toBe(255);
      expect(has(after, secret)).toBe(false);
    });
  }

  test('names and addresses go in any case', () => {
    const after = scrubMinidump(ascii('at c:\\users\\linus rath\\x and LINUSR and CEO.Private@Acme-Corp.example'), names);
    const text = after.toString('latin1');
    expect(text.toLowerCase()).not.toContain('linus');
    expect(text.toLowerCase()).not.toContain('acme');
  });

  test('a very short user name doesn\'t blank the file', () => {
    const body = 'a normal word appears here';
    expect(scrubMinidump(ascii(body), { home: '', username: 'a', hostname: '' }).toString('latin1')).toBe(body);
  });

  test('the words around them stay, so the file is still worth reading', () => {
    const after = scrubMinidump(ascii('electron.exe crashed in v8.dll near linusr'), names).toString('latin1');
    expect(after).toContain('electron.exe crashed in v8.dll');
  });
});

test.describe('scrubbing names in any script', () => {
  const forms = (text: string) => [Buffer.from(text, 'utf8'), Buffer.from(text, 'utf16le')];
  const scrubbed = (body: Buffer, names: Partial<ScrubNames>) => scrubMinidump(body, { home: '', username: '', hostname: '', ...names });

  const NAMES: [string, string, Partial<ScrubNames>][] = [
    ['Cyrillic', 'C:\\Users\\Иван\\AppData\\Roaming\\Bulwark', { home: 'C:\\Users\\Иван', username: 'Иван' }],
    ['German', 'C:\\Users\\Jürgen\\AppData\\Roaming\\Bulwark', { home: 'C:\\Users\\Jürgen', username: 'Jürgen' }],
    ['Chinese, two letters', 'C:\\Users\\李明\\AppData', { home: 'C:\\Users\\李明', username: '李明' }],
    ['POSIX', '/home/иван/.config/Bulwark', { home: '/home/иван', username: 'иван' }],
  ];
  for (const [label, text, names] of NAMES) {
    for (const [encoding, bytes] of [['UTF-8', Buffer.from(text, 'utf8')], ['UTF-16', Buffer.from(text, 'utf16le')]] as const) {
      test(`${label} in ${encoding}`, () => {
        const body = Buffer.concat([Buffer.from([1, 2, 0]), bytes, Buffer.from([0, 0, 9])]);
        const after = scrubbed(body, names);
        expect(after.length).toBe(body.length);
        for (const form of forms(names.username!)) expect(after.includes(form), `${label} ${encoding}`).toBe(false);
        expect(after[0]).toBe(1);
        expect(after[after.length - 1]).toBe(9);
      });
    }
  }

  test('with the name on its own, in another case', () => {
    for (const [text, username] of [['ИВАН сказал', 'Иван'], ['иван сказал', 'Иван'], ['JÜRGEN war hier', 'Jürgen']]) {
      for (const form of forms(text)) {
        const after = scrubbed(form, { username });
        for (const name of forms(text.split(' ')[0])) expect(after.includes(name), text).toBe(false);
      }
    }
  });

  test('in the one-byte code page Windows uses for names like Jürgen', () => {
    const after = scrubbed(Buffer.from('C:\\Daten\\Jürgen\\x', 'latin1'), { username: 'Jürgen' });
    expect(after.includes(Buffer.from('Jürgen', 'latin1'))).toBe(false);
  });

  const SHORT_PATHS = ['C:\\Users\\IVAN~1\\AppData\\Local\\Temp', 'C:\\Users\\JRGEN~1\\AppData', 'c:/users/LINUSR~1/x', 'D:\\Users\\ivan\\x', '/home/ivan/x', '/Users/ivan/Library/x', 'C:\\\\Users\\\\IVAN~1\\\\AppData'];
  for (const path of SHORT_PATHS) {
    test(`a user folder goes whatever it's called: ${path}`, () => {
      for (const form of forms(path)) {
        const after = scrubbed(form, { home: 'C:\\Users\\Someone Else', username: 'someone' });
        expect(after.length).toBe(form.length);
        const folder = path.split(/[\\/]+/)[2].toLowerCase() === 'users' ? path.split(/[\\/]+/)[3] : path.split(/[\\/]+/)[2];
        for (const name of forms(folder)) expect(after.includes(name), path).toBe(false);
      }
    });
  }

  test('the words after the user folder stay, so a path is still worth reading', () => {
    const after = scrubbed(Buffer.from('C:\\Users\\IVAN~1\\AppData\\Local\\Bulwark\\app.exe', 'utf8'), {}).toString('latin1');
    expect(after).toContain('AppData\\Local\\Bulwark\\app.exe');
  });

  test('the configured servers go, as an address and as a host, in both encodings', () => {
    const servers = ['https://mail.acme-corp.example:8443', 'https://почта.example'];
    for (const text of ['https://mail.acme-corp.example:8443/jmap/', 'connected to mail.acme-corp.example now', 'https://почта.example/x', 'host почта.example here']) {
      for (const form of forms(text)) {
        const after = scrubbed(form, { servers });
        for (const name of ['mail.acme-corp.example', 'почта.example']) {
          for (const needle of forms(name)) expect(after.includes(needle), text).toBe(false);
        }
      }
    }
  });
});

test.describe('scrubbing mail out of a dump', () => {
  const forms = (text: string) => [Buffer.from(text, 'utf8'), Buffer.from(text, 'utf16le')];
  const NAMES = { home: 'C:\\Users\\Nobody', username: 'nobody', hostname: 'NOHOST' };

  const SUBJECTS = ['Merger plans for Acme', 'Слияние с компанией', '合併計画について', 'مذكرة الاندماج'];
  for (const subject of SUBJECTS) {
    for (const template of ['"subject":"%"', '"subject" : "%"', '\\"subject\\":\\"%\\"', '\\\\\\"subject\\\\\\":\\\\\\"%\\\\\\"', 'Subject: %\r\n']) {
      const text = template.replace('%', subject);
      test(`${text}`, () => {
        for (const form of forms(`before ${text} after`)) {
          const after = scrubMinidump(form, NAMES);
          expect(after.length).toBe(form.length);
          for (const word of forms(subject)) expect(after.includes(word), form.toString('latin1').slice(0, 40)).toBe(false);
          // Only that field: the bytes around it stay.
          expect(after.includes(forms('after')[form.includes(Buffer.from('after', 'utf8')) ? 0 : 1])).toBe(true);
        }
      });
    }
  }

  for (const key of ['subject', 'preview', 'value', 'name', 'email', 'htmlBody', 'textBody', 'bodyValues', 'password', 'token', 'accessToken', 'refreshToken']) {
    test(`the key "${key}" goes, plain and escaped, in both encodings`, () => {
      for (const template of [`"${key}":"Wert-Секрет"`, `\\"${key}\\":\\"Wert-Секрет\\"`]) {
        for (const form of forms(template)) {
          const after = scrubMinidump(form, NAMES);
          for (const word of forms('Секрет')) expect(after.includes(word), `${key} ${template}`).toBe(false);
        }
      }
    });
  }

  test('an escaped quote inside a value doesn\'t end it', () => {
    for (const form of forms('"subject":"Re: \\"Секрет\\" more Секрет"')) {
      const after = scrubMinidump(form, NAMES);
      for (const word of forms('Секрет')) expect(after.includes(word)).toBe(false);
    }
  });

  test('a password in escaped JSON goes', () => {
    for (const form of forms('{\\"password\\":\\"hunter2-Пароль\\"}')) {
      const after = scrubMinidump(form, NAMES);
      for (const word of forms('hunter2')) expect(after.includes(word)).toBe(false);
    }
  });

  /** In a process of its own, as what hung ran for ever and a test can't time out sync code. */
  function timed(build: string, seconds: number): { status: number | null; ms: number } {
    const bundle = path.join(mkdtempSync(path.join(tmpdir(), 'bw-scrub-')), 'crash-files.cjs');
    buildSync({ entryPoints: [path.join(import.meta.dirname, '..', 'src/main/crash-files.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'silent' });
    const script = `
      const { scrubMinidump } = require(${JSON.stringify(bundle)});
      const input = (${build})();
      const after = scrubMinidump(input, { home: '', username: '', hostname: '' });
      if (after.length !== input.length) process.exit(3);
    `;
    const started = Date.now();
    const run = spawnSync(process.execPath, ['-e', script], { timeout: seconds * 1000, encoding: 'utf8' });
    return { status: run.status, ms: Date.now() - started };
  }

  const WIDE_OPEN = `Buffer.from('"subject":"', 'utf16le')`;

  test('the input that used to hang: a wide subject with no closing quote', () => {
    const result = timed(`() => Buffer.concat([${WIDE_OPEN}, Buffer.from('a'.repeat(200), 'utf16le')])`, 15);
    expect(result.status).toBe(0);
    expect(result.ms).toBeLessThan(10_000);
  });

  test('the same at length, and many of them, stays linear', () => {
    const result = timed(`() => Buffer.concat(Array.from({ length: 2000 }, () => Buffer.concat([${WIDE_OPEN}, Buffer.from('a'.repeat(4000), 'utf16le')])))`, 60);
    expect(result.status).toBe(0);
    expect(result.ms).toBeLessThan(45_000);
  });

  test('a dump of binary noise the size of the cap gets through', () => {
    const result = timed(`() => { const b = require('node:crypto').randomBytes(64 * 1024 * 1024); return b; }`, 90);
    expect(result.status).toBe(0);
    expect(result.ms).toBeLessThan(75_000);
  });
});

test.describe('BULWARK_TELEMETRY=off in the app\'s environment', () => {
  const paths = profilePaths('C:\\profile');

  test('reaches the embedded server, which gets nothing else from it', () => {
    expect(serverEnv(paths, { BULWARK_TELEMETRY: 'off' }, 'win32').BULWARK_TELEMETRY).toBe('off');
    expect(serverEnv(paths, { BULWARK_TELEMETRY_DISABLED: '1' }, 'win32').BULWARK_TELEMETRY).toBe('off');
    expect(serverEnv(paths, {}, 'win32').BULWARK_TELEMETRY).toBeUndefined();
    // Nothing but a no: a yes is the user's to give.
    expect(serverEnv(paths, { BULWARK_TELEMETRY: 'on' }, 'win32').BULWARK_TELEMETRY).toBeUndefined();
  });

  const OFF: [Record<string, string>, boolean][] = [
    [{ BULWARK_TELEMETRY: 'off' }, true],
    [{ BULWARK_TELEMETRY: 'OFF' }, true],
    [{ BULWARK_TELEMETRY: 'false' }, true],
    [{ BULWARK_TELEMETRY: '0' }, true],
    [{ BULWARK_TELEMETRY: 'no' }, true],
    [{ BULWARK_TELEMETRY_DISABLED: 'true' }, true],
    [{ BULWARK_TELEMETRY: 'on' }, false],
    [{ BULWARK_TELEMETRY_DISABLED: '0' }, false],
    [{}, false],
  ];
  for (const [env, expected] of OFF) {
    test(`${JSON.stringify(env)} is ${expected ? 'off' : 'nothing'}`, () => expect(telemetryOffInEnv(env)).toBe(expected));
  }
});

test.describe('where a crash file may go', () => {
  const allowed: [string, string][] = [
    ['https://crash.example.org/upload', 'https://crash.example.org/upload'],
    ['  https://crash.example.org/  ', 'https://crash.example.org/'],
    ['http://localhost:9000/x', 'http://localhost:9000/x'],
    ['http://127.0.0.1:9000/x', 'http://127.0.0.1:9000/x'],
  ];
  for (const [input, expected] of allowed) {
    test(`takes ${input.trim()}`, () => expect(validUploadUrl(input)).toBe(expected));
  }
  for (const input of ['http://crash.example.org/', 'http://192.168.1.5/x', 'ftp://crash.example.org/', 'https://user:pw@crash.example.org/', 'file:///C:/x', 'javascript:alert(1)', 'nonsense', '', 5, null, undefined]) {
    test(`refuses ${String(input)}`, () => expect(validUploadUrl(input)).toBeNull());
  }
});

test.describe('the upload', () => {
  test('has the dump and the named facts, and nothing of the file\'s name or place', () => {
    const dump = Buffer.from('MDMP\0binary\xff');
    const upload = buildCrashUpload(dump, { prod: 'Bulwark', ver: '0.3.0', platform: 'win32', build: 'desktop.instance.beta' }, 'edge');
    expect(upload.contentType).toBe('multipart/form-data; boundary=edge');
    const body = upload.body.toString('latin1');
    expect(body).toContain('name="upload_file_minidump"; filename="crash.dmp"');
    expect(body).toContain('name="ver"\r\n\r\n0.3.0');
    expect(body).toContain('name="build"\r\n\r\ndesktop.instance.beta');
    expect(upload.body.includes(dump)).toBe(true);
    expect(body.endsWith('--edge--\r\n')).toBe(true);
  });
});

test.describe('main-process stacks', () => {
  const posix = '/home/linus/.local/share/Bulwark/resources/app.asar/dist';
  const windows = 'C:\\Users\\Linus Rath\\AppData\\Local\\Programs\\Bulwark\\resources\\app.asar\\dist';

  test('an ESM stack on Windows loses the path to the app', () => {
    const stack = `TypeError: x\n    at send (file:///C:/Users/Linus%20Rath/x.js:1:1)\n    at ping (file:///${windows.replace(/\\/g, '/')}/main.mjs:10:5)`;
    const out = normalizeStack(stack, windows);
    expect(out).toContain('at ping (/desktop/main.mjs:10:5)');
    expect(out).not.toContain('AppData');
  });

  test('a plain path, a backslash path and POSIX do too', () => {
    expect(normalizeStack(`    at f (${windows}\\server-host.cjs:3:4)`, windows)).toBe('    at f (/desktop/server-host.cjs:3:4)');
    expect(normalizeStack(`    at f (${posix}/main.mjs:3:4)`, posix)).toBe('    at f (/desktop/main.mjs:3:4)');
    expect(normalizeStack(`    at file://${posix}/main.mjs:3:4`, posix)).toBe('    at /desktop/main.mjs:3:4');
  });

  test('a frame elsewhere isn\'t given the marker', () => {
    const line = '    at f (C:\\Users\\Linus Rath\\elsewhere\\x.js:1:1)';
    expect(normalizeStack(line, windows)).toBe(line);
    expect(normalizeStack('    at f (node:internal/x:1:1)', windows)).toBe('    at f (node:internal/x:1:1)');
  });
});

test.describe('counting main\'s errors, for instance mode', () => {
  const now = Date.parse('2026-11-03T12:00:00Z');
  const error = (name: string, at: string) => {
    const e = new Error('Merger plans for Acme');
    e.name = name;
    e.stack = `${name}: Merger plans for Acme\n    at f (C:\\Users\\linus\\x.js:${at})`;
    return e;
  };

  test('names and positions only, so nothing else can be in a fingerprint', () => {
    const one = fingerprintOfMainError('TypeError', '    at f (C:\\Users\\linus\\x.js:1:2)', '1.0.0');
    const two = fingerprintOfMainError('TypeError', '    at f (D:\\Users\\other\\y.js:1:2)', '1.0.0');
    expect(one).toBe(two);
    expect(one).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprintOfMainError('TypeError', '    at f (x.js:3:2)', '1.0.0')).not.toBe(one);
  });

  test('an odd name becomes Error', () => {
    expect(mainErrorName(new TypeError('x'))).toBe('TypeError');
    expect(mainErrorName({ name: 'Merger plans' })).toBe('Error');
    expect(mainErrorName('a string')).toBe('Error');
    expect(mainErrorName(null)).toBe('Error');
  });

  test('sends what\'s new, then only what changed, and a new day starts again', () => {
    const counter = new MainErrorCounter('0.3.0');
    counter.note(error('TypeError', '1:2'), now);
    counter.note(error('TypeError', '1:2'), now);
    const first = counter.unsent(now);
    expect(first).toEqual([expect.objectContaining({ name: 'TypeError', count: 2, version: '0.3.0+desktop' })]);
    counter.markSent(first);
    expect(counter.unsent(now)).toEqual([]);
    counter.note(error('TypeError', '1:2'), now);
    expect(counter.unsent(now)[0].count).toBe(3);
    expect(counter.unsent(now + 86_400_000)).toEqual([]);
  });

  test('the collector\'s real validator takes the batch, with no message or path in it', async () => {
    test.skip(!hasCollector, 'the dashboard repo isn\'t here');
    const { validateErrorBatch } = await loadCollectorValidator();
    const counter = new MainErrorCounter('0.3.0');
    const at = Date.now();
    counter.note(error('TypeError', '1:2'), at);
    const batch = buildDesktopErrorBatch('f0c1a2b3-c4d5-4e6f-8a9b-0c1d2e3f4a5b', at, counter.unsent(at));
    expect(validateErrorBatch(batch, at)).not.toBeNull();
    expect(JSON.stringify(batch)).not.toContain('Merger');
    expect(JSON.stringify(batch)).not.toContain('linus');
  });

  test('a beta\'s version with the tag is what the patched collector takes', async () => {
    test.skip(!hasCollector, 'the dashboard repo isn\'t here');
    const { validateErrorBatch } = await loadCollectorValidator();
    const counter = new MainErrorCounter('0.3.0-beta.1');
    const at = Date.now();
    counter.note(error('TypeError', '1:2'), at);
    const batch = buildDesktopErrorBatch('f0c1a2b3-c4d5-4e6f-8a9b-0c1d2e3f4a5b', at, counter.unsent(at));
    expect(validateErrorBatch(batch, at)?.errors[0].version).toBe('0.3.0-beta.1+desktop');
  });
});

test('the shell\'s copy of the pure module is the webmail\'s, byte for byte', () => {
  const webmail = process.env.BULWARK_WEBMAIL_DIR ?? '../..';
  const theirs = path.join(webmail, 'lib/desktop/desktop-telemetry.ts');
  test.skip(!existsSync(theirs), 'no webmail checkout here');
  const clean = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  expect(clean(path.join(import.meta.dirname, '..', 'src/shared/desktop-telemetry.ts'))).toBe(clean(theirs));
});
