// Windows Hello's key credential for the app lock, in plain Node with made-up key credentials:
// no prompt, nothing in anyone's Hello container.
import { constants, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { appLockSite, isSiteFile } from '../src/main/app-lock-gate';
import { AppLockHello, deterministicSignature, helloChallenge, helloKeyName, removeAllHelloKeys, removeHelloKeyOf, type HelloKeys } from '../src/main/app-lock-hello';
import { fakeHelloKeys } from '../src/main/app-lock-hello-fake';

const salt = (seed: number) => new Uint8Array(32).fill(seed);
const window = Buffer.alloc(8);

let folder: string;
test.beforeEach(() => {
  folder = mkdtempSync(path.join(tmpdir(), 'bulwark-hello-'));
});
test.afterEach(() => rmSync(folder, { recursive: true, force: true }));

function setup(mode: { value: string | undefined }, allowed = { value: true }, keys: HelloKeys & { names(): string[] } = fakeHelloKeys(() => mode.value)) {
  const hello = new AppLockHello({ keys, name: helloKeyName(folder, 'http://127.0.0.1:1'), site: 'abcd', folder, allowed: () => allowed.value });
  return { hello, keys };
}

test('the name is per profile and origin, and one the helper takes', () => {
  const names = [
    helloKeyName('C:\\Users\\a\\AppData\\Roaming\\Bulwark', 'http://127.0.0.1:1'),
    helloKeyName('C:\\Users\\a\\AppData\\Roaming\\Bulwark Dev', 'http://127.0.0.1:1'),
    helloKeyName('C:\\Users\\a\\AppData\\Roaming\\Bulwark', 'https://mail.example.com'),
  ];
  expect(new Set(names).size).toBe(3);
  for (const name of names) expect(name).toMatch(/^[A-Za-z0-9 ._-]{1,64}$/);
  // The same folder written another way is the same profile.
  expect(helloKeyName('C:\\Users\\a\\AppData\\Roaming\\Bulwark\\', 'http://127.0.0.1:1')).toBe(names[0]);
});

test('the challenge says what it is for, so the key signs nothing a page picked alone', () => {
  const one = helloChallenge('abcd', salt(1));
  expect(one.subarray(0, 26).toString()).toBe('bulwark-app-lock-hello-v1\0');
  expect(one.subarray(-32)).toEqual(Buffer.from(salt(1)));
  expect(helloChallenge('abcd', salt(2)).equals(one)).toBe(false);
  expect(helloChallenge('efgh', salt(1)).equals(one)).toBe(false);
});

test('only an RSA PKCS#1 v1.5 signature over SHA-256 counts as the same each time', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const data = Buffer.from('challenge');
  const pkcs1 = sign('sha256', data, { key: privateKey, padding: constants.RSA_PKCS1_PADDING });
  const pss = sign('sha256', data, { key: privateKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 });
  expect(deterministicSignature(spki, data, pkcs1)).toBe(true);
  expect(sign('sha256', data, { key: privateKey, padding: constants.RSA_PKCS1_PADDING })).toEqual(pkcs1);
  expect(deterministicSignature(spki, data, pss)).toBe(false);
  expect(deterministicSignature(spki, Buffer.from('other'), pkcs1)).toBe(false);
  expect(deterministicSignature(Buffer.from('not a key'), data, pkcs1)).toBe(false);
});

test('turning it on makes a key credential whose signature is the same at the unlock', async () => {
  const mode = { value: 'yes' };
  const { hello, keys } = setup(mode);
  expect(hello.enrolled).toBe(false);
  const enrolled = await hello.enroll(salt(1), window);
  expect(enrolled.ok).toBe(true);
  expect(hello.enrolled).toBe(true);
  expect(keys.names()).toEqual([helloKeyName(folder, 'http://127.0.0.1:1')]);
  const signed = await hello.sign(salt(1), window);
  expect(signed).toEqual(enrolled);
  // Another salt, another signature: a new wrap after a PIN change isn't the old one.
  const other = await hello.sign(salt(2), window);
  expect(other.ok && enrolled.ok && Buffer.from(other.signature).equals(Buffer.from(enrolled.signature))).toBe(false);
});

test('a key that signs another way is refused and deleted, and nothing says Hello is on', async () => {
  const mode = { value: 'pss' };
  const { hello, keys } = setup(mode);
  expect(await hello.enroll(salt(1), window)).toEqual({ ok: false, reason: 'unsupported' });
  expect(hello.enrolled).toBe(false);
  expect(keys.names()).toEqual([]);
});

test('a cancelled prompt leaves no key credential and no marker', async () => {
  const mode = { value: 'cancel' };
  const { hello, keys } = setup(mode);
  expect(await hello.enroll(salt(1), window)).toEqual({ ok: false, reason: 'cancelled' });
  expect(hello.enrolled).toBe(false);
  expect(keys.names()).toEqual([]);
  mode.value = 'yes';
  await hello.enroll(salt(1), window);
  mode.value = 'cancel';
  // At the unlock a no is only a no: Hello stays on for the next try.
  expect(await hello.sign(salt(1), window)).toEqual({ ok: false, reason: 'cancelled' });
  expect(hello.enrolled).toBe(true);
});

test('a key credential Windows lost reads as missing, and the marker goes', async () => {
  const mode = { value: 'yes' };
  const { hello, keys } = setup(mode);
  expect(await hello.sign(salt(1), window)).toEqual({ ok: false, reason: 'missing' });
  await hello.enroll(salt(1), window);
  await keys.delete(keys.names()[0]);
  expect(await hello.sign(salt(1), window)).toEqual({ ok: false, reason: 'missing' });
  expect(hello.enrolled).toBe(false);
});

test('the policy refuses both, and turning it off deletes the key credential', async () => {
  const mode = { value: 'yes' };
  const allowed = { value: false };
  const { hello, keys } = setup(mode, allowed);
  expect(await hello.enroll(salt(1), window)).toEqual({ ok: false, reason: 'policy' });
  expect(keys.names()).toEqual([]);
  allowed.value = true;
  await hello.enroll(salt(1), window);
  allowed.value = false;
  expect(await hello.sign(salt(1), window)).toEqual({ ok: false, reason: 'policy' });
  await hello.enforcePolicy();
  expect(hello.enrolled).toBe(false);
  expect(keys.names()).toEqual([]);
});

test('removing asks Windows only when there is something of ours, and the wipe takes every origin', async () => {
  const deleted: string[] = [];
  const fake = fakeHelloKeys(() => 'yes');
  const keys = { ...fake, delete: async (name: string) => { deleted.push(name); return fake.delete(name); } };
  const one = new AppLockHello({ keys, name: 'Bulwark app lock one', site: 'one', folder, allowed: () => true });
  const two = new AppLockHello({ keys, name: 'Bulwark app lock two', site: 'two', folder, allowed: () => true });
  await one.remove();
  expect(deleted).toEqual([]);
  await one.enroll(salt(1), window);
  await two.enroll(salt(1), window);
  expect(readdirSync(folder).sort()).toEqual(['one.hello.json', 'two.hello.json']);
  await removeAllHelloKeys(folder, keys);
  expect(deleted.sort()).toEqual(['Bulwark app lock one', 'Bulwark app lock two']);
  expect(fake.names()).toEqual([]);
  await removeAllHelloKeys(path.join(folder, 'not-there'), keys);
  expect(existsSync(folder)).toBe(true);
});

test("a server's wipe takes its own key credential and marker, and leaves another origin's", async () => {
  const deleted: string[] = [];
  const fake = fakeHelloKeys(() => 'yes');
  const keys = { ...fake, delete: async (name: string) => { deleted.push(name); return fake.delete(name); } };
  const mine = appLockSite('https://mail.example.org');
  const theirs = appLockSite('https://app.bulwark.localhost');
  await new AppLockHello({ keys, name: 'Bulwark app lock mine', site: mine, folder, allowed: () => true }).enroll(salt(1), window);
  await new AppLockHello({ keys, name: 'Bulwark app lock theirs', site: theirs, folder, allowed: () => true }).enroll(salt(1), window);
  await removeHelloKeyOf(folder, mine, keys);
  expect(deleted).toEqual(['Bulwark app lock mine']);
  expect(readdirSync(folder)).toEqual([`${theirs}.hello.json`]);
  expect(fake.names()).toEqual(['Bulwark app lock theirs']);
  // Nothing set up: nothing asked of Windows.
  await removeHelloKeyOf(folder, mine, keys);
  expect(deleted).toEqual(['Bulwark app lock mine']);
});

test("an origin's files in the app-lock folder are told apart by its site, and only its own match", () => {
  const site = appLockSite('https://mail.example.org');
  const other = appLockSite('https://app.bulwark.localhost');
  expect(site).toMatch(/^[0-9a-f]{16}$/);
  expect(site).not.toBe(other);
  for (const name of [`${site}.json`, `${site}.hello.json`, `app-lock-key-${site}.bin`, `app-lock-pepper-${site}.bin`]) expect(isSiteFile(name, site), name).toBe(true);
  for (const name of [`${other}.json`, `${other}.hello.json`, `app-lock-pepper-${other}.bin`, `${site}`, `x${site}.json`, `app-lock-pepper-${site}x.bin`, `app-lock-pepper-${site}.bin.tmp`]) expect(isSiteFile(name, site), name).toBe(false);
});
