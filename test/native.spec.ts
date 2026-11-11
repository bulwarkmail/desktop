import { createHash, constants, diffieHellman, generateKeyPairSync, publicEncrypt, verify, X509Certificate, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { helperFile, loadHelperModule, type NativeCertificate, type NativeModule } from '../src/main/native-loader';
import { readPe } from './pe-reader';
import { TestCerts, type TestCert } from './test-certs';

import { EXPORTS } from './native-exports';

/**
 * The helper binary itself, from Node. Electron is Node-API too: keystore-bridge.spec.ts
 * loads the same file there. `npm run build:native` first; on Windows a missing binary
 * fails here, on purpose, so these can't pass by not running.
 */

const ROOT = path.resolve(import.meta.dirname, '..');
const FILE = helperFile({ packaged: false, mainDir: path.join(ROOT, 'dist'), platform: process.platform, arch: process.arch });

// Everything the binary may export.

const load = (): NativeModule => {
  const loaded = loadHelperModule(FILE);
  if (!loaded) throw new Error(`${FILE} is missing: run npm run build:native`);
  return loaded;
};

const sha = (name: string, data = 'bulwark') => createHash(name).update(data).digest();

test.describe('what the binary exports', () => {
  test('exactly the agreed list, and the README names the same', () => {
    const native = load();
    expect(Object.keys(native).sort()).toEqual(EXPORTS);
    const readme = readFileSync(path.join(ROOT, 'native', 'README.md'), 'utf8');
    const section = /<!-- exports -->([\s\S]*?)<!-- \/exports -->/.exec(readme)![1];
    const named = [...section.matchAll(/^- `(\w+)\(/gm)].map((match) => match[1]).sort();
    expect(named).toEqual(EXPORTS);
  });

  test('all of them are functions, so nothing hangs off a constant', () => {
    for (const value of Object.values(load())) expect(typeof value).toBe('function');
  });
});

test.describe('what the binary needs from Windows', () => {
  test.skip(process.platform !== 'win32', 'reads a PE file');

  test('no Visual C++ runtime: it would not load on a machine without one', () => {
    const { imports } = readPe(FILE);
    expect(imports.filter((name) => /^(vcruntime|msvcp|ucrtbase|api-ms-win-crt-)/.test(name))).toEqual([]);
    // The rest is Windows itself. cldapi is the Cloud Files API, for the Files drive; shell32 tells Explorer a drive letter's name changed; wintrust checks an update's signature.
    for (const name of imports) expect(name, name).toMatch(/^(kernel32|kernelbase|ntdll|advapi32|bcrypt|bcryptprimitives|crypt32|ncrypt|user32|ole32|oleaut32|combase|ws2_32|userenv|cldapi|shell32|wintrust|api-ms-win-[a-z0-9-]+)\.dll$/);
  });

  test('what it loads comes from System32 only, not from a folder beside the app', () => {
    expect(readPe(FILE).dependentLoadFlags).toBe(0x800);
  });

  test('built with Control Flow Guard', () => {
    expect(readPe(FILE).controlFlowGuard).toBe(true);
  });
});

test.describe('the policy watcher', () => {
  const watcher = path.join(ROOT, '.native-modules', `win32-${process.arch}`, 'vscode-policy-watcher.node');
  test.skip(process.platform !== 'win32' || !existsSync(watcher), 'needs scripts/build-policy-watcher.mjs on Windows');

  test('built with Control Flow Guard', () => {
    expect(readPe(watcher).controlFlowGuard).toBe(true);
  });
});

test.describe('Hello, without a prompt', () => {
  test.skip(process.platform !== 'win32', 'Windows only');

  test('availability answers a boolean', async () => {
    expect(typeof (await load().helloAvailable())).toBe('boolean');
  });

  test('a window handle that is no window answers invalid and shows nothing', async () => {
    const native = load();
    // Handle 1 is not a window. Eight zero bytes aren't either. Neither reaches the prompt.
    expect(await native.helloVerify('test', Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]), 1000)).toBe('invalid');
    expect(await native.helloVerify('test', Buffer.alloc(8), 1000)).toBe('invalid');
    expect(await native.helloVerify('test', Buffer.alloc(3), 1000)).toBe('invalid');
  });

  test('it takes no empty reason and no missing or endless timeout', () => {
    const native = load();
    const window = Buffer.alloc(8);
    expect(() => native.helloVerify('', window, 1000)).toThrow(/reason/);
    expect(() => native.helloVerify('x'.repeat(257), window, 1000)).toThrow(/reason/);
    expect(() => native.helloVerify('test', window, 0)).toThrow(/timeout/);
    expect(() => native.helloVerify('test', window, 5 * 60_000 + 1)).toThrow(/timeout/);
    expect(() => (native.helloVerify as unknown as (a: string, b: Buffer) => unknown)('test', window)).toThrow();
  });
});

test.describe("Hello's key credentials, without a prompt and without touching the user's Hello container", () => {
  test.skip(process.platform !== 'win32', 'Windows only');
  const name = 'Bulwark test key never made';

  test('a window handle that is no window answers invalid before anything reaches Windows Hello', async () => {
    const native = load();
    for (const handle of [Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]), Buffer.alloc(8), Buffer.alloc(3)]) {
      expect(await native.helloKeyCreate!(name, Buffer.from('x'), handle, 1000)).toEqual({ result: 'invalid' });
      expect(await native.helloKeySign!(name, Buffer.from('x'), handle, 1000)).toEqual({ result: 'invalid' });
    }
  });

  test('it takes only plain names, some data, and a timeout of at most 5 minutes', () => {
    const native = load();
    const window = Buffer.alloc(8);
    for (const bad of ['', 'x'.repeat(65), 'a/b', 'a\\b', 'a\0b', 'Bulwark é']) {
      expect(() => native.helloKeyCreate!(bad, Buffer.from('x'), window, 1000), JSON.stringify(bad)).toThrow(/bad key name/);
      expect(() => native.helloKeySign!(bad, Buffer.from('x'), window, 1000)).toThrow(/bad key name/);
      expect(() => native.helloKeyOpen!(bad)).toThrow(/bad key name/);
      expect(() => native.helloKeyDelete!(bad)).toThrow(/bad key name/);
    }
    expect(() => native.helloKeyCreate!(name, Buffer.alloc(0), window, 1000)).toThrow(/data/);
    expect(() => native.helloKeySign!(name, Buffer.alloc(1025), window, 1000)).toThrow(/data/);
    expect(() => native.helloKeyCreate!(name, Buffer.from('x'), window, 0)).toThrow(/timeout/);
    expect(() => native.helloKeySign!(name, Buffer.from('x'), window, 5 * 60_000 + 1)).toThrow(/timeout/);
    expect(() => (native.helloKeySign as unknown as (a: string, b: Buffer, c: Buffer) => unknown)(name, Buffer.from('x'), window)).toThrow();
  });

  test('a cancel with nothing waiting does nothing', () => {
    expect(() => load().helloKeyCancel!()).not.toThrow();
  });
});

test.describe('policy', () => {
  test('off macOS nothing is forced, and a bad key is refused', () => {
    const native = load();
    if (process.platform !== 'darwin') expect(native.policyIsForced('SomeKey')).toBe(false);
    expect(() => native.policyIsForced('')).toThrow(/bad key/);
    expect(() => native.policyIsForced('a key with spaces')).toThrow(/bad key/);
    expect(() => native.policyIsForced('x'.repeat(129))).toThrow(/bad key/);
  });
});

test.describe('Windows\u2019 print dialog', () => {
  test('a handle that is no window is refused before any dialog, and a PDF must have bytes', async () => {
    const native = load() as NativeModule & { printDialog(hwnd: Buffer, pdf: Buffer, landscape: Buffer | undefined, title: string): Promise<string> };
    const pdf = Buffer.from('%PDF-1.4\n%%EOF\n');
    expect(await native.printDialog(Buffer.alloc(8), pdf, undefined, 'Test')).toBe(process.platform === 'win32' ? 'invalid' : 'unavailable');
    expect(() => native.printDialog(Buffer.alloc(8), Buffer.alloc(2), undefined, 'Test')).toThrow(/PDF/);
    expect(() => native.printDialog(Buffer.alloc(8), pdf, Buffer.alloc(0), 'Test')).toThrow(/PDF/);
  });
});

test.describe('a window to the front', () => {
  test('a handle that is no window is refused, and nothing else moves', () => {
    const native = load() as NativeModule & { windowToFront(hwnd: Buffer): boolean };
    expect(native.windowToFront(Buffer.alloc(8))).toBe(false);
    expect(native.windowToFront(Buffer.alloc(3, 1))).toBe(false);
    expect(native.windowToFront(Buffer.alloc(0))).toBe(false);
  });
});

test('before anything has been listed, no id works', () => {
  // Runs before the block below in this worker, so this process hasn't listed yet.
  expect(() => load().keystoreSign('a'.repeat(64), sha('sha256'), { scheme: 'rsa-pkcs1', hash: 'SHA-256' })).toThrow(/keystore:not-found/);
});

test.describe('the keystore on real certificates', () => {
  test.skip(process.platform !== 'win32', 'creates certificates in CurrentUser\\My');
  test.setTimeout(240_000);

  const MAIL = "-TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.4')";
  let certs: TestCerts;
  let native: NativeModule;
  let list: NativeCertificate[];
  const made: Record<string, TestCert> = {};

  const entry = (name: string): NativeCertificate => {
    const found = list.find((certificate) => certificate.subject === made[name].subject);
    if (!found) throw new Error(`${name} is not listed`);
    return found;
  };
  const publicKeyOf = (certificate: NativeCertificate) => new X509Certificate(certificate.certificate).publicKey;

  test.beforeAll(async () => {
    native = load();
    certs = new TestCerts();
    const rsa = '-KeyExportPolicy NonExportable -KeyAlgorithm RSA -KeyLength 2048 -Provider "Microsoft Software Key Storage Provider"';
    made.rsa = certs.create({ name: 'rsa', args: `-Type Custom ${rsa} -KeyUsage DigitalSignature,KeyEncipherment ${MAIL}` });
    made.p256 = certs.create({ name: 'ecdsa-p256', args: `-Type Custom -KeyExportPolicy NonExportable -KeyAlgorithm ECDSA_nistP256 -CurveExport CurveName -KeyUsage DigitalSignature ${MAIL}` });
    made.p384 = certs.create({ name: 'ecdsa-p384', args: `-Type Custom -KeyExportPolicy NonExportable -KeyAlgorithm ECDSA_nistP384 -CurveExport CurveName -KeyUsage DigitalSignature ${MAIL}` });
    made.p521 = certs.create({ name: 'ecdsa-p521', args: `-Type Custom -KeyExportPolicy NonExportable -KeyAlgorithm ECDSA_nistP521 -CurveExport CurveName -KeyUsage DigitalSignature ${MAIL}` });
    // Asked for ECDH on its own key, or with the name ECDH_nistP256, New-SelfSignedCertificate
    // makes a plain ECDSA key that CNG won't agree with. ECDH_P256 with another key signing
    // is a real ECDH key.
    made.fakeEcdh = certs.create({ name: 'ecdh-really-ecdsa', args: `-Type Custom -KeyExportPolicy NonExportable -KeyAlgorithm ECDH_nistP256 -CurveExport CurveName -KeyUsage KeyAgreement ${MAIL}` });
    made.legacy = certs.create({ name: 'rsa-legacy-csp', args: `-Type Custom -KeyExportPolicy NonExportable -KeyAlgorithm RSA -KeyLength 2048 -Provider "Microsoft Enhanced RSA and AES Cryptographic Provider" -KeySpec KeyExchange -KeyUsage DigitalSignature,KeyEncipherment ${MAIL}` });
    made.encryptOnly = certs.create({ name: 'rsa-encrypt-only', args: `-Type Custom ${rsa} -KeyUsage KeyEncipherment ${MAIL}` });
    made.clientAuth = certs.create({ name: 'rsa-client-auth-only', args: `-Type Custom ${rsa} -KeyUsage DigitalSignature -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.2')` });
    made.codeSigning = certs.create({ name: 'rsa-code-signing-only', args: `-Type Custom ${rsa} -KeyUsage DigitalSignature -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.3')` });
    made.caSigning = certs.create({ name: 'ca-with-digital-signature', args: `-Type Custom ${rsa} -KeyUsage DigitalSignature,CertSign -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.4','2.5.29.19={text}CA=true')` });
    made.caFlagOnly = certs.create({ name: 'ca-flag-only', args: `-Type Custom ${rsa} -KeyUsage DigitalSignature -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.4','2.5.29.19={text}CA=true')` });
    made.crlSign = certs.create({ name: 'crl-signer', args: `-Type Custom ${rsa} -KeyUsage DigitalSignature,CRLSign ${MAIL}` });
    made.anyUse = certs.create({ name: 'any-eku', args: `-Type Custom ${rsa} -KeyUsage DigitalSignature -TextExtension @('2.5.29.37={text}2.5.29.37.0')` });
    made.mailAndLogin = certs.create({ name: 'mail-and-client-auth', args: `-Type Custom ${rsa} -KeyUsage DigitalSignature -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.4,1.3.6.1.5.5.7.3.2')` });
    made.mailAndSmartcard = certs.create({ name: 'mail-and-smartcard-logon', args: `-Type Custom ${rsa} -KeyUsage DigitalSignature -TextExtension @('2.5.29.37={text}1.3.6.1.5.5.7.3.4,1.3.6.1.4.1.311.20.2.2')` });
    made.root = certs.create({ name: 'chain-root', args: `-Type Custom ${rsa} -KeyUsage CertSign,CRLSign -TextExtension @('2.5.29.19={text}CA=true')` });
    made.intermediate = certs.create({ name: 'chain-intermediate', args: certs.signedArgs(made.root, `-Type Custom ${rsa} -KeyUsage CertSign,CRLSign -TextExtension @('2.5.29.19={text}CA=true')`) });
    made.ecdh = certs.create({ name: 'ecdh-p256', args: certs.signedArgs(made.root, `-Type Custom -KeyExportPolicy NonExportable -KeyAlgorithm ECDH_P256 -KeyUsage KeyAgreement ${MAIL}`) });
    made.leaf = certs.create({ name: 'chain-leaf', args: certs.signedArgs(made.intermediate, `-Type Custom ${rsa} -KeyUsage DigitalSignature,KeyEncipherment ${MAIL}`) });
    list = await native.keystoreList();
  });

  test.afterAll(() => {
    // Also checks the store has what it had before: same thumbprints, same count.
    certs?.finish();
  });

  test('it lists mail certificates with the details X.509 says', () => {
    const rsa = entry('rsa');
    const parsed = new X509Certificate(rsa.certificate);
    expect(rsa.id).toBe(createHash('sha256').update(rsa.certificate).digest('hex'));
    expect(rsa.subject).toBe(made.rsa.subject);
    expect(rsa.issuer).toBe(made.rsa.subject);
    expect(rsa.serial.toUpperCase()).toBe(parsed.serialNumber.toUpperCase());
    expect(rsa.notBefore).toBe(new Date(parsed.validFrom).getTime());
    expect(rsa.notAfter).toBe(new Date(parsed.validTo).getTime());
    expect(rsa.keyType).toBe('rsa');
    expect(rsa.keyBits).toBe(2048);
    expect(rsa.algorithm).toBe('1.2.840.113549.1.1.1');
    expect(rsa.usages).toEqual(['digitalSignature', 'keyEncipherment']);
    expect(rsa.extendedUsages).toEqual(['1.3.6.1.5.5.7.3.4']);
    expect(rsa.source).toBe('software');
    expect(rsa.signSchemes).toEqual(['rsa-pkcs1', 'rsa-pss']);
    expect(rsa.decryptSchemes).toEqual(['rsa-pkcs1', 'rsa-oaep']);
    expect(rsa.canAgree).toBe(false);
    expect(rsa.chain).toEqual([]);
    expect('curve' in rsa, 'no curve on an RSA key, not a null one').toBe(false);

    const p256 = entry('p256');
    expect(p256.keyType).toBe('ec');
    expect(p256.curve).toBe('P-256');
    expect(p256.keyBits).toBe(256);
    expect(p256.signSchemes).toEqual(['ecdsa']);
    expect(p256.decryptSchemes).toEqual([]);
    expect(entry('p384').curve).toBe('P-384');
    expect(entry('p521').keyBits).toBe(521);
  });

  test('certificates not fit for mail have no id at all', () => {
    const subjects = list.map((certificate) => certificate.subject);
    expect(subjects).not.toContain(made.clientAuth.subject);
    expect(subjects).not.toContain(made.codeSigning.subject);
    expect(subjects).not.toContain(made.root.subject);
    expect(subjects).not.toContain(made.intermediate.subject);
    expect(subjects).toContain(made.leaf.subject);
  });

  test('a CA is refused however it presents itself, also with digitalSignature', () => {
    const subjects = list.map((certificate) => certificate.subject);
    expect(subjects).not.toContain(made.caSigning.subject);
    expect(subjects, 'cA=true with an ordinary key usage').not.toContain(made.caFlagOnly.subject);
    expect(subjects, 'cRLSign').not.toContain(made.crlSign.subject);
  });

  test('a certificate that also works for sign-in asks each time, a mail-only one does not', () => {
    expect(entry('rsa').askEachUse).toBe(false);
    expect(entry('anyUse').askEachUse).toBe(true);
    expect(entry('mailAndLogin').askEachUse).toBe(true);
    expect(entry('mailAndSmartcard').askEachUse).toBe(true);
  });

  test('a certificate without a private key is not listed', async () => {
    const before = await native.keystoreList();
    const publicOnly = certs.importPublicOnly(certs.create({ name: 'public-only', args: `-Type Custom -KeyExportPolicy NonExportable -KeyAlgorithm RSA -KeyLength 2048 -KeyUsage DigitalSignature ${MAIL}` }).thumbprint);
    const after = await native.keystoreList();
    expect(after.map((certificate) => certificate.subject)).not.toContain(publicOnly.subject);
    expect(after.map((certificate) => certificate.id).sort()).toEqual(before.map((certificate) => certificate.id).sort());
  });

  test('the chain has the intermediate, without leaf and root', () => {
    const leaf = entry('leaf');
    expect(leaf.issuer).toBe(made.intermediate.subject);
    expect(leaf.chain).toHaveLength(1);
    expect(new X509Certificate(leaf.chain[0]).subject).toContain('chain-intermediate');
  });

  test('the keys are not exportable, and everything below works anyway', () => {
    for (const name of ['rsa', 'p256', 'p384', 'ecdh', 'legacy', 'leaf']) expect(certs.canExport(made[name].thumbprint), name).toBe(false);
    // The check can say yes, so its no means something.
    const exportable = certs.create({ name: 'exportable-control', args: `-Type Custom -KeyExportPolicy Exportable -KeyAlgorithm RSA -KeyLength 2048 -KeyUsage DigitalSignature ${MAIL}` });
    expect(certs.canExport(exportable.thumbprint)).toBe(true);
    certs.remove(exportable.thumbprint);
  });

  for (const [hash, node] of [['SHA-256', 'sha256'], ['SHA-384', 'sha384'], ['SHA-512', 'sha512']] as const) {
    test(`RSA PKCS#1 v1.5 with ${hash} verifies in Node`, async () => {
      const certificate = entry('rsa');
      const signature = await native.keystoreSign(certificate.id, sha(node), { scheme: 'rsa-pkcs1', hash });
      expect(signature).toHaveLength(256);
      const key = publicKeyOf(certificate);
      expect(verify(node, Buffer.from('bulwark'), { key, padding: constants.RSA_PKCS1_PADDING }, signature)).toBe(true);
      expect(verify(node, Buffer.from('other'), { key, padding: constants.RSA_PKCS1_PADDING }, signature)).toBe(false);
    });

    test(`RSA PSS with ${hash}, salt the hash's length, verifies in Node`, async () => {
      const certificate = entry('rsa');
      const signature = await native.keystoreSign(certificate.id, sha(node), { scheme: 'rsa-pss', hash });
      const key = publicKeyOf(certificate);
      const saltLength = sha(node).length;
      expect(verify(node, Buffer.from('bulwark'), { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength }, signature)).toBe(true);
      // A wrong salt length fails, so the test does see the salt.
      expect(verify(node, Buffer.from('bulwark'), { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: saltLength - 1 }, signature)).toBe(false);
    });
  }

  test('ECDSA comes back as DER and verifies in Node, on all three curves', async () => {
    for (const [name, node, hash] of [['p256', 'sha256', 'SHA-256'], ['p384', 'sha384', 'SHA-384'], ['p521', 'sha512', 'SHA-512']] as const) {
      const certificate = entry(name);
      const signature = await native.keystoreSign(certificate.id, sha(node), { scheme: 'ecdsa', hash });
      expect(signature[0], 'a DER SEQUENCE, not r||s').toBe(0x30);
      // P-521's body passes 127 bytes, so it uses the long form of the length.
      expect(signature[1] === 0x81 ? signature[2] + 3 : signature[1] + 2).toBe(signature.length);
      expect(verify(node, Buffer.from('bulwark'), { key: publicKeyOf(certificate), dsaEncoding: 'der' }, signature)).toBe(true);
    }
  });

  test('a key behind an old CSP signs and decrypts through CNG too', async () => {
    const certificate = entry('legacy');
    const signature = await native.keystoreSign(certificate.id, sha('sha256'), { scheme: 'rsa-pkcs1', hash: 'SHA-256' });
    const key = publicKeyOf(certificate);
    expect(verify('sha256', Buffer.from('bulwark'), { key, padding: constants.RSA_PKCS1_PADDING }, signature)).toBe(true);
    const plain = randomBytes(32);
    const data = publicEncrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' }, plain);
    expect(Buffer.compare(await native.keystoreDecrypt(certificate.id, data, { scheme: 'rsa-oaep', hash: 'SHA-1' }), plain)).toBe(0);
  });

  for (const [hash, node] of [['SHA-1', 'sha1'], ['SHA-256', 'sha256'], ['SHA-384', 'sha384'], ['SHA-512', 'sha512']] as const) {
    test(`RSA OAEP with ${hash} unwraps what Node wrapped`, async () => {
      const certificate = entry('rsa');
      const plain = randomBytes(32);
      const data = publicEncrypt({ key: publicKeyOf(certificate), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: node }, plain);
      const out = await native.keystoreDecrypt(certificate.id, data, { scheme: 'rsa-oaep', hash });
      expect(Buffer.compare(out, plain)).toBe(0);
    });
  }

  test('OAEP takes a label, and a wrong hash or label fails', async () => {
    const certificate = entry('rsa');
    const plain = randomBytes(32);
    const label = Buffer.from('a label');
    const data = publicEncrypt({ key: publicKeyOf(certificate), padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256', oaepLabel: label }, plain);
    expect(Buffer.compare(await native.keystoreDecrypt(certificate.id, data, { scheme: 'rsa-oaep', hash: 'SHA-256', label }), plain)).toBe(0);
    await expect(native.keystoreDecrypt(certificate.id, data, { scheme: 'rsa-oaep', hash: 'SHA-256' })).rejects.toThrow(/keystore:failed/);
    await expect(native.keystoreDecrypt(certificate.id, data, { scheme: 'rsa-oaep', hash: 'SHA-1', label })).rejects.toThrow(/keystore:failed/);
  });

  test('RSA v1.5 unwraps what Node wrapped', async () => {
    const certificate = entry('rsa');
    const plain = randomBytes(16);
    const data = publicEncrypt({ key: publicKeyOf(certificate), padding: constants.RSA_PKCS1_PADDING }, plain);
    expect(Buffer.compare(await native.keystoreDecrypt(certificate.id, data, { scheme: 'rsa-pkcs1' }), plain)).toBe(0);
  });

  test('v1.5 answers only with the size of a content key, and every failure reads the same', async () => {
    const certificate = entry('rsa');
    const key = publicKeyOf(certificate);
    const wrap = (size: number) => publicEncrypt({ key, padding: constants.RSA_PKCS1_PADDING }, randomBytes(size));
    for (const size of [16, 24, 32]) expect(await native.keystoreDecrypt(certificate.id, wrap(size), { scheme: 'rsa-pkcs1' })).toHaveLength(size);
    const message = (promise: Promise<unknown>) => promise.then(() => 'answered', (error: Error) => error.message);
    const wrongSizes = await Promise.all([1, 20, 31, 33, 65].map((size) => message(native.keystoreDecrypt(certificate.id, wrap(size), { scheme: 'rsa-pkcs1' }))));
    const badPadding = await message(native.keystoreDecrypt(certificate.id, randomBytes(256), { scheme: 'rsa-pkcs1' }));
    expect(new Set([...wrongSizes, badPadding]).size, 'one message, so it says nothing about the padding').toBe(1);
    expect(badPadding).toMatch(/^keystore:failed/);
  });

  test('OAEP refuses an answer past 64 bytes with that same message', async () => {
    const certificate = entry('rsa');
    const key = publicKeyOf(certificate);
    const data = publicEncrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' }, randomBytes(65));
    await expect(native.keystoreDecrypt(certificate.id, data, { scheme: 'rsa-oaep', hash: 'SHA-1' })).rejects.toThrow(/^keystore:failed/);
    const small = publicEncrypt({ key, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha1' }, randomBytes(20));
    expect(await native.keystoreDecrypt(certificate.id, small, { scheme: 'rsa-oaep', hash: 'SHA-1' })).toHaveLength(20);
  });

  test('ECDH gives the same secret Node computes from the other side, big-endian', async () => {
    const certificate = entry('ecdh');
    expect(certificate.canAgree).toBe(true);
    const peer = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const secret = await native.keystoreAgree(certificate.id, peer.publicKey.export({ type: 'spki', format: 'der' }));
    expect(secret.toString('hex')).toBe(diffieHellman({ privateKey: peer.privateKey, publicKey: publicKeyOf(certificate) }).toString('hex'));
  });

  test('an ECDSA-only key says it cannot agree, and refuses if asked', async () => {
    const certificate = entry('p256');
    expect(certificate.canAgree).toBe(false);
    const peer = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    expect(() => native.keystoreAgree(certificate.id, peer.publicKey.export({ type: 'spki', format: 'der' }))).toThrow(/keystore:unsupported/);
  });

  test('a plain ECDSA key that claims key agreement says it cannot, since CNG refuses', async () => {
    const certificate = entry('fakeEcdh');
    expect(certificate.usages).toContain('keyAgreement');
    expect(certificate.canAgree).toBe(false);
    const peer = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    await expect(native.keystoreAgree(certificate.id, peer.publicKey.export({ type: 'spki', format: 'der' }))).rejects.toThrow(/keystore:unsupported/);
  });

  test('a peer key on another curve, compressed, off the curve or not a key is refused', async () => {
    const { id } = entry('ecdh');
    const p384 = generateKeyPairSync('ec', { namedCurve: 'P-384' }).publicKey.export({ type: 'spki', format: 'der' });
    expect(() => native.keystoreAgree(id, p384)).toThrow(/keystore:invalid/);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' });
    expect(() => native.keystoreAgree(id, rsa)).toThrow(/keystore:invalid/);
    expect(() => native.keystoreAgree(id, Buffer.alloc(0))).toThrow(/keystore:invalid/);
    expect(() => native.keystoreAgree(id, Buffer.alloc(300))).toThrow(/keystore:invalid/);

    const good = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'der' });
    const compressed = Buffer.from(good);
    compressed[compressed.length - 65] = 0x02;
    expect(() => native.keystoreAgree(id, compressed)).toThrow(/keystore:invalid/);
    const offCurve = Buffer.from(good);
    offCurve[offCurve.length - 1] ^= 1;
    // Refused here, before any provider sees it, and not left to whichever provider it is.
    expect(() => native.keystoreAgree(id, offCurve)).toThrow(/keystore:invalid/);
  });

  test('wrong input is refused before the OS sees it', async () => {
    const rsa = entry('rsa');
    const scheme = { scheme: 'rsa-pkcs1', hash: 'SHA-256' };
    expect(() => native.keystoreSign(rsa.id, Buffer.alloc(31), scheme)).toThrow(/keystore:invalid/);
    expect(() => native.keystoreSign(rsa.id, Buffer.alloc(48), scheme)).toThrow(/keystore:invalid/);
    expect(() => native.keystoreSign(rsa.id, Buffer.alloc(20), { scheme: 'rsa-pkcs1', hash: 'SHA-1' })).toThrow(/keystore:unsupported/);
    expect(() => native.keystoreSign(rsa.id, sha('sha256'), { scheme: 'ecdsa', hash: 'SHA-256' })).toThrow(/keystore:unsupported/);
    expect(() => native.keystoreSign(rsa.id, sha('sha256'), { scheme: 'nonsense', hash: 'SHA-256' })).toThrow(/keystore:invalid/);
    expect(() => native.keystoreDecrypt(rsa.id, Buffer.alloc(255), { scheme: 'rsa-pkcs1' })).toThrow(/keystore:invalid/);
    expect(() => native.keystoreDecrypt(rsa.id, Buffer.alloc(1 << 20), { scheme: 'rsa-pkcs1' })).toThrow(/keystore:invalid/);
    expect(() => native.keystoreDecrypt(rsa.id, Buffer.alloc(256), { scheme: 'rsa-oaep' })).toThrow(/keystore:invalid/);
    expect(() => native.keystoreDecrypt(rsa.id, Buffer.alloc(256), { scheme: 'rsa-oaep', hash: 'SHA-256', label: Buffer.alloc(257) })).toThrow(/keystore:invalid/);
    expect(() => native.keystoreDecrypt(entry('p256').id, Buffer.alloc(64), { scheme: 'rsa-pkcs1' })).toThrow(/keystore:unsupported/);
  });

  test('key usage holds: an encrypt-only certificate does not sign', async () => {
    const certificate = entry('encryptOnly');
    expect(certificate.signSchemes).toEqual([]);
    expect(certificate.decryptSchemes).toEqual(['rsa-pkcs1', 'rsa-oaep']);
    expect(() => native.keystoreSign(certificate.id, sha('sha256'), { scheme: 'rsa-pkcs1', hash: 'SHA-256' })).toThrow(/keystore:unsupported/);
  });

  test('only ids from the list work: a client-auth certificate in the store does not', () => {
    const scheme = { scheme: 'rsa-pkcs1', hash: 'SHA-256' };
    const unlisted = thumbprintId(made.clientAuth.thumbprint);
    expect(() => native.keystoreSign(unlisted, sha('sha256'), scheme)).toThrow(/keystore:not-found/);
    expect(() => native.keystoreSign('not hex', sha('sha256'), scheme)).toThrow(/keystore:invalid/);
    expect(() => native.keystoreSign('A'.repeat(64), sha('sha256'), scheme)).toThrow(/keystore:invalid/);
    expect(() => native.keystoreSign('0'.repeat(64), sha('sha256'), scheme)).toThrow(/keystore:not-found/);
  });

  test('a certificate removed since the list answers not-found', async () => {
    const gone = certs.create({ name: 'removed-while-listed', args: `-Type Custom -KeyExportPolicy NonExportable -KeyAlgorithm RSA -KeyLength 2048 -KeyUsage DigitalSignature ${MAIL}` });
    const current = await native.keystoreList();
    const listed = current.find((certificate) => certificate.subject === gone.subject)!;
    certs.remove(gone.thumbprint);
    await expect(native.keystoreSign(listed.id, sha('sha256'), { scheme: 'rsa-pkcs1', hash: 'SHA-256' })).rejects.toThrow(/keystore:not-found/);
  });

  // The store's copy, to get the id of something the list left out.
  function thumbprintId(thumbprint: string): string {
    const pem = certs.exportPem(thumbprint);
    return createHash('sha256').update(new X509Certificate(pem).raw).digest('hex');
  }
});

test('the binary is where electron-builder picks it up', () => {
  test.skip(process.platform !== 'win32', 'built here on Windows');
  expect(existsSync(FILE)).toBe(true);
});
