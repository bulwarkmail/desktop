import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import {
  layersFromJson,
  layersFromRegistry,
  policyFileProblem,
  managedPlistPaths,
  managedPlistProblem,
  readMacPolicies,
  readPolicyFile,
  readRegistry,
  readThroughWatcher,
  policySourceName,
  REAL_REGISTRY_TARGETS,
  testPolicyRoot,
  testRegistryTargets,
  watchRegistry,
  type CreateWatcher,
  policyValue,
  treeFromNodes,
  type ReadRegistryTree,
} from '../src/main/policy-read';
import { helperFile, loadHelperModule, registryFrom, type NativeRegistryNode, type NativeRegistryValue } from '../src/main/native-loader';
import { FORCED_SSO_LIMIT_MS, SsoChain } from '../src/main/navigation-rules';
import { connectionMustChange, decideStart, restartKey, standaloneAllowed } from '../src/main/policy-start';
import { deniedEnvironment, deniedSwitches, withoutDeniedSwitches } from '../src/main/switch-guard';
import { updatePolicyFrom } from '../src/main/update-rules';
import { EMPTY_POLICY_LAYERS, POLICY_CONSUMERS, POLICY_KEYS, pagePolicySnapshot, parseCertificateRule, policyProblems, resolvePolicies, type PolicyLayer } from '../src/shared/policy-schema';

/** A row per test. Playwright has no test.each. */
function each<const Row>(rows: readonly Row[]) {
  return (title: string, run: (...args: Row extends readonly unknown[] ? [...Row] : [Row]) => void | Promise<void>) => {
    for (const row of rows) {
      const args = (Array.isArray(row) ? row : [row]) as Row extends readonly unknown[] ? [...Row] : [Row];
      test(title.replace('%s', () => String(args[0] || '(empty)')), () => run(...args));
    }
  };
}

const TARGETS = testRegistryTargets('HKCU\\Software\\BulwarkTest\\Policies\\x');
const ROOT = path.resolve(import.meta.dirname, '..');

const snapshot = (forcedMachine: PolicyLayer = {}, recommendedMachine: PolicyLayer = {}) =>
  resolvePolicies({ ...EMPTY_POLICY_LAYERS, forcedMachine, recommendedMachine });

const sz = (name: string, text: string): NativeRegistryValue => ({ name, kind: 'sz', text });

/** The native helper's registry, as main reads policies with it. */
const helperRead = (): ReadRegistryTree => {
  const registry = registryFrom(loadHelperModule(helperFile({ packaged: false, mainDir: path.join(ROOT, 'dist'), platform: process.platform, arch: process.arch })));
  if (!registry) throw new Error('No native helper with registry calls: run npm run build:native');
  return (key, depth) => registry.read(key, depth);
};

test.describe('reading the registry through the native helper', () => {
  const nodes: NativeRegistryNode[] = [
    {
      path: '',
      subkeys: ['AllowedJmapServers', 'PluginAllowlist', 'Recommended'],
      values: [
        sz('InstanceUrl', 'https://mail.example.com'),
        { name: 'AllowStandalone', kind: 'dword', number: 0 },
        { name: 'AutoUpdate', kind: 'multi_sz', list: ['a', 'b'] },
        sz('QuickComposeShortcut', ''),
        sz('Name With Spaces', 'has    four    spaces'),
      ],
    },
    { path: 'AllowedJmapServers', subkeys: [], values: [sz('2', 'https://b.example'), sz('10', 'https://c.example'), sz('1', 'https://a.example'), sz('x', 'https://not-numbered.example')] },
    { path: 'PluginAllowlist', subkeys: [], values: [] },
    { path: 'Recommended', subkeys: ['PluginAllowlist'], values: [sz('UpdateChannel', 'beta')] },
    { path: 'Recommended\\PluginAllowlist', subkeys: [], values: [sz('1', 'good-plugin')] },
  ];

  const layers = () => layersFromRegistry(treeFromNodes(nodes), new Map());

  test('reads values, types and numbered lists in number order', () => {
    const { forcedMachine } = layers();
    expect(forcedMachine.InstanceUrl).toBe('https://mail.example.com');
    expect(forcedMachine.AllowStandalone).toBe(0);
    expect(forcedMachine.AllowedJmapServers).toEqual(['https://a.example', 'https://b.example', 'https://c.example']);
  });

  test('an empty value is empty, not missing', () => {
    expect(layers().forcedMachine.QuickComposeShortcut).toBe('');
  });

  test('a type no policy uses fails the parser, so a forced one fails closed', () => {
    const { forcedMachine } = layers();
    expect(forcedMachine.AutoUpdate).toEqual({ invalid: 'REG_MULTI_SZ' });
    expect(resolvePolicies({ ...EMPTY_POLICY_LAYERS, forcedMachine }).AutoUpdate).toMatchObject({ value: false, invalid: 'not_a_switch' });
    expect(policyValue({ name: 'a', kind: 'binary' })).toEqual({ invalid: 'REG_BINARY' });
    expect(policyValue({ name: 'a', kind: 'other' })).toEqual({ invalid: 'REG_OTHER' });
  });

  test('numbers as reg.exe read them: a DWORD unsigned, a QWORD only while a JS number holds it', () => {
    expect(policyValue({ name: 'a', kind: 'dword', number: 4294967295 })).toBe(4294967295);
    expect(policyValue({ name: 'a', kind: 'qword', text: '5' })).toBe(5);
    expect(policyValue({ name: 'a', kind: 'qword', text: '9007199254740993' })).toEqual({ invalid: 'REG_QWORD' });
  });

  test('an expandable string stays as written, not expanded', () => {
    expect(policyValue({ name: 'a', kind: 'expand_sz', text: '%APPDATA%\\x' })).toBe('%APPDATA%\\x');
  });

  test('an empty list key is what disabling leaves behind: not set, rather than "nothing allowed"', () => {
    expect(layers().forcedMachine.PluginAllowlist).toBeUndefined();
  });

  test('keeps Recommended apart from the forced values', () => {
    const { forcedMachine, recommendedMachine } = layers();
    expect(recommendedMachine.UpdateChannel).toBe('beta');
    expect(forcedMachine.UpdateChannel).toBeUndefined();
    expect(recommendedMachine.PluginAllowlist).toEqual(['good-plugin']);
    expect(recommendedMachine.InstanceUrl).toBeUndefined();
  });

  test('names and keys compare without case, as the registry does', () => {
    const tree = treeFromNodes([
      { path: '', subkeys: ['RECOMMENDED'], values: [sz('instanceurl', 'https://mail.example.com')] },
      { path: 'RECOMMENDED', subkeys: [], values: [sz('UPDATECHANNEL', 'beta')] },
    ]);
    const { forcedMachine, recommendedMachine } = layersFromRegistry(tree, new Map());
    expect(forcedMachine.InstanceUrl).toBe('https://mail.example.com');
    expect(recommendedMachine.UpdateChannel).toBe('beta');
  });

  test('a value with a line break is a bad value, and leaves the others as they are', () => {
    const tree = treeFromNodes([
      { path: '', subkeys: [], values: [sz('InstanceUrl', 'https://mail.example.com\r\nHKEY_LOCAL_MACHINE\\Software\\Else'), sz('PluginsMode', 'off')] },
    ]);
    const { forcedMachine } = layersFromRegistry(tree, new Map());
    expect(forcedMachine.InstanceUrl).toEqual({ invalid: 'line_break' });
    expect(forcedMachine.PluginsMode).toBe('off');
    expect(resolvePolicies({ ...EMPTY_POLICY_LAYERS, forcedMachine }).InstanceUrl).toMatchObject({ value: null, invalid: 'not_text' });
  });

  test('machine and user stay separate levels', async () => {
    const read: ReadRegistryTree = (key) => [{ path: '', subkeys: [], values: [sz('UpdateChannel', key.endsWith('Machine') ? 'beta' : 'stable')] }];
    const result = await readRegistry(TARGETS, read);
    expect(result.ok && result.layers.forcedMachine.UpdateChannel).toBe('beta');
    expect(result.ok && result.layers.forcedUser.UpdateChannel).toBe('stable');
  });

  test('asks for the Recommended lists, two levels down', async () => {
    const asked: [string, number][] = [];
    await readRegistry(REAL_REGISTRY_TARGETS, (key, depth) => {
      asked.push([key, depth]);
      return null;
    });
    expect(asked).toEqual([
      [REAL_REGISTRY_TARGETS.machine, 2],
      [REAL_REGISTRY_TARGETS.user, 2],
    ]);
  });
});

test.describe('when the helper gives no answer', () => {
  test('no key is no policy', async () => {
    expect(await readRegistry(REAL_REGISTRY_TARGETS, () => null)).toEqual({ ok: true, layers: EMPTY_POLICY_LAYERS });
  });

  test('a key that is there and can\'t be read does not read as no policy', async () => {
    const read: ReadRegistryTree = (key) => {
      if (key.startsWith('HKCU')) throw new Error('registry:denied (0x80070005)');
      return null;
    };
    expect(await readRegistry(REAL_REGISTRY_TARGETS, read)).toEqual({ ok: false, reason: 'reg_failed' });
  });

  test('no helper does not either: the caller reads through the watcher', async () => {
    expect(await readRegistry(REAL_REGISTRY_TARGETS, null)).toEqual({ ok: false, reason: 'reg_failed' });
  });

  test('non-ASCII comes through whole, through the real helper', async () => {
    test.skip(process.platform !== 'win32', 'Windows registry');
    const key = `HKCU\\Software\\BulwarkTest\\Policies\\enc${process.pid}`;
    spawnSync('reg.exe', ['add', `${key}\\Machine`, '/v', 'InstanceUrl', '/t', 'REG_SZ', '/d', 'https://müller.de', '/f'], { windowsHide: true });
    spawnSync('reg.exe', ['add', `${key}\\Machine\\AllowedJmapServers`, '/v', '1', '/t', 'REG_SZ', '/d', 'https://ä.example', '/f'], { windowsHide: true });
    try {
      const read = await readRegistry(testRegistryTargets(key), helperRead());
      expect(read.ok && read.layers.forcedMachine.InstanceUrl).toBe('https://müller.de');
      expect(read.ok && read.layers.forcedMachine.AllowedJmapServers).toEqual(['https://ä.example']);
      if (read.ok) expect(resolvePolicies(read.layers).InstanceUrl.value).toBe('https://xn--mller-kva.de/');
    } finally {
      spawnSync('reg.exe', ['delete', key, '/f'], { windowsHide: true });
    }
  });

  test('an error page names where policies come from on this OS', () => {
    expect(policySourceName('darwin')).toContain('Managed Preferences');
    expect(policySourceName('darwin')).not.toContain('Software\\');
    expect(policySourceName('linux')).toBe('/etc/bulwark/policies.json');
    expect(policySourceName('win32')).toContain('Software\\Policies');
  });

  test('a single value where a list belongs fails closed through the watcher too', async () => {
    const root = 'Software\\Policies\\Bulwark\\Desktop';
    const create: CreateWatcher = (_name, _policies, onChange, options) => {
      setTimeout(() => onChange(options?.registryPath === root ? { AllowedJmapServers: 'https://a.example' } : {}), 1);
      return { dispose: () => {} };
    };
    const read = await readThroughWatcher(create, root);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(resolvePolicies(read.layers).AllowedJmapServers).toMatchObject({ value: [], invalid: 'not_a_list' });
    const throughReg = layersFromRegistry(treeFromNodes([{ path: '', subkeys: [], values: [sz('AllowedJmapServers', 'https://a.example')] }]), new Map());
    expect(read.layers.forcedMachine.AllowedJmapServers).toEqual(throughReg.forcedMachine.AllowedJmapServers);
  });

  test('the watcher takes over, lists included', async () => {
    const seen: string[] = [];
    const create: CreateWatcher = (_name, policies, onChange, options) => {
      const registryPath = options?.registryPath ?? '';
      seen.push(registryPath);
      const answers: Record<string, Record<string, unknown>> = {
        'Software\\Policies\\Bulwark\\Desktop': { InstanceUrl: 'https://mail.example.com' },
        'Software\\Policies\\Bulwark\\Desktop\\AllowedJmapServers': { 1: 'https://a.example', 3: 'https://c.example' },
        'Software\\Policies\\Bulwark\\Desktop\\Recommended': { UpdateChannel: 'beta' },
      };
      expect(Object.keys(policies).length).toBeGreaterThan(0);
      setTimeout(() => onChange(answers[registryPath] ?? {}), 1);
      return { dispose: () => {} };
    };
    const read = await readThroughWatcher(create, 'Software\\Policies\\Bulwark\\Desktop');
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.layers.forcedMachine.InstanceUrl).toBe('https://mail.example.com');
    expect(read.layers.forcedMachine.AllowedJmapServers).toEqual(['https://a.example', 'https://c.example']);
    expect(read.layers.recommendedMachine.UpdateChannel).toBe('beta');
  });

  test('a watcher that never answers is a failure, not an empty policy', async () => {
    const create: CreateWatcher = () => ({ dispose: () => {} });
    expect(await readThroughWatcher(create, 'x', 20)).toEqual({ ok: false, reason: 'watcher_failed' });
  });
});

test.describe('the real watcher module', () => {
  test.skip(process.platform !== 'win32', 'Windows registry');
  const KEY = `HKCU\\Software\\BulwarkTest\\Policies\\watcher-${process.pid}`;
  const reg = (...args: string[]) => spawnSync('reg.exe', args, { encoding: 'utf8', windowsHide: true });
  const watcher = () => createRequire(import.meta.url)('@vscode/policy-watcher').createWatcher as CreateWatcher;

  test.afterAll(() => {
    reg('delete', KEY, '/f');
  });

  test('takes a registry path and reads strings, numbers and numbered lists', async () => {
    reg('add', KEY, '/v', 'InstanceUrl', '/t', 'REG_SZ', '/d', 'https://mail.example.com', '/f');
    reg('add', KEY, '/v', 'AutoUpdate', '/t', 'REG_DWORD', '/d', '0', '/f');
    reg('add', `${KEY}\\AllowedJmapServers`, '/v', '1', '/t', 'REG_SZ', '/d', 'https://a.example', '/f');
    const read = await readThroughWatcher(watcher(), KEY.replace('HKCU\\', ''));
    expect(read.ok && read.layers.forcedMachine).toEqual({
      InstanceUrl: 'https://mail.example.com',
      AutoUpdate: 0,
      AllowedJmapServers: ['https://a.example'],
    });
  });

  test('does not signal a change for what it finds at the start', async () => {
    let changes = 0;
    const stop = watchRegistry(watcher(), [KEY.replace('HKCU\\', '')], () => (changes += 1));
    await new Promise((resolve) => setTimeout(resolve, 300));
    stop();
    expect(changes).toBe(0);
  });
});

test.describe('the Linux policy file', () => {
  const stat = (over: Partial<{ uid: number; mode: number; size: number; file: boolean; link: boolean; dir: boolean }> = {}) => ({
    uid: over.uid ?? 0,
    mode: over.mode ?? 0o100644,
    size: over.size ?? 100,
    isFile: () => over.file ?? true,
    isSymbolicLink: () => over.link ?? false,
    isDirectory: () => over.dir ?? false,
  });
  const dir = (over: Parameters<typeof stat>[0] = {}) => stat({ mode: 0o40755, file: false, dir: true, ...over });

  test('root-owned and 644 is trusted', () => {
    expect(policyFileProblem(stat(), dir())).toBeNull();
    expect(policyFileProblem(stat({ mode: 0o100600 }), dir())).toBeNull();
  });

  each([
    ['owned by a user', stat({ uid: 1000 }), dir(), 'not_root_owned'],
    ['writable by the group', stat({ mode: 0o100664 }), dir(), 'writable_by_others'],
    ['writable by anyone', stat({ mode: 0o100666 }), dir(), 'writable_by_others'],
    ['a link', stat({ link: true, file: false }), dir(), 'not_a_file'],
    ['a directory', stat({ file: false, dir: true }), dir(), 'not_a_file'],
    ['a folder others can write to', stat(), dir({ mode: 0o40777 }), 'dir_unsafe'],
    ['a folder of a user', stat(), dir({ uid: 1000 }), 'dir_unsafe'],
    ['huge', stat({ size: 5 * 1024 * 1024 }), dir(), 'too_large'],
  ] as const)('%s fails closed', (_name, file, folder, problem) => {
    expect(policyFileProblem(file, folder)).toBe(problem);
  });

  const fs = (files: Record<string, ReturnType<typeof stat> | Error>, text = '{}') => ({
    lstat(file: string) {
      const found = files[file];
      if (found instanceof Error) throw found;
      if (!found) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return found;
    },
    read: () => text,
  });
  const FILE = '/etc/bulwark/policies.json';

  test('no file is no policy', () => {
    expect(readPolicyFile(FILE, fs({}))).toEqual({ ok: true, layers: EMPTY_POLICY_LAYERS });
  });

  test('an unsafe file is refused without reading it', () => {
    expect(readPolicyFile(FILE, fs({ [FILE]: stat({ mode: 0o100666 }), '/etc/bulwark': dir() }))).toEqual({ ok: false, reason: 'writable_by_others' });
  });

  test('a file that can\'t be read isn\'t no policy', () => {
    expect(readPolicyFile(FILE, fs({ [FILE]: Object.assign(new Error('no'), { code: 'EACCES' }) }))).toEqual({ ok: false, reason: 'unreadable' });
  });

  test('reads forced values and Recommended, and nothing else', () => {
    const read = readPolicyFile(FILE, fs({ [FILE]: stat(), '/etc/bulwark': dir() }, '{"InstanceUrl":"https://a.example","Other":1,"__proto__":{"AllowStandalone":1},"Recommended":{"UpdateChannel":"beta"}}'));
    expect(read).toEqual({
      ok: true,
      layers: { forcedMachine: { InstanceUrl: 'https://a.example' }, forcedUser: {}, recommendedMachine: { UpdateChannel: 'beta' }, recommendedUser: {} },
    });
  });

  each(['not json', '[]', 'null', '7'])('%s fails closed', (text) => {
    expect(layersFromJson(text)).toEqual({ ok: false, reason: 'not_json' });
  });

  test('the sample the webmail generates reads clean', () => {
    // Keeps the generator and this reader honest about the file's shape.
    const read = layersFromJson('{"PluginsMode":"off","AllowedJmapServers":["https://a.example"],"Recommended":{"UpdateChannel":"stable"}}');
    expect(read.ok).toBe(true);
    if (read.ok) expect(resolvePolicies(read.layers).AllowedJmapServers.value).toEqual(['https://a.example']);
  });
});

test.describe('macOS managed preferences', () => {
  const prefs = (values: Record<string, unknown>) => ({
    // What Electron gives for a key that isn't there.
    getUserDefault: (key: string, type: string) => values[key] ?? (type === 'array' ? [] : type === 'dictionary' ? {} : ''),
  });
  const PATHS = { machine: '/m.plist', user: '/u.plist' };
  const plists = (files: Record<string, Record<string, unknown>> = {}) => (file: string) => ({ ok: true as const, values: files[file] ?? null });
  const read = (values: Record<string, unknown>, isForced: ((key: string) => boolean) | null, files?: Record<string, Record<string, unknown>>) => {
    const result = readMacPolicies(prefs(values), isForced, PATHS, plists(files));
    if (!result.ok) throw new Error(result.reason);
    return result.layers;
  };

  test('`defaults write` alone is never forced: with no helper and no managed file, it can only recommend', () => {
    const layers = read({ AllowStandalone: '1', AllowInsecureInstance: '1', InstanceUrl: 'http://evil.example', PluginsMode: 'allowed', UpdateChannel: 'beta' }, null);
    expect(layers.forcedMachine).toEqual({});
    const snapshot = resolvePolicies(layers);
    // Forced-only keys don't hear it at all.
    expect(snapshot.AllowStandalone).toMatchObject({ source: 'default', locked: false });
    expect(snapshot.AllowInsecureInstance).toMatchObject({ value: false, source: 'default' });
    expect(snapshot.InstanceUrl.locked).toBe(false);
    expect(snapshot.UpdateChannel).toMatchObject({ value: 'beta', locked: false });
  });

  test('a user\'s default can\'t open what the managed file closed', () => {
    const layers = read({ AllowStandalone: '1', InstanceUrl: 'https://mine.example' }, () => false, { '/m.plist': { InstanceUrl: 'https://mail.example.com' } });
    const snapshot = resolvePolicies(layers);
    expect(snapshot.InstanceUrl).toMatchObject({ value: 'https://mail.example.com/', source: 'forced-machine', locked: true });
    expect(snapshot.AllowStandalone).toMatchObject({ source: 'default', locked: false });
  });

  test('the managed files give machine and user levels, and their Recommended', () => {
    const layers = read({}, null, {
      '/m.plist': { UpdateChannel: 'beta', Recommended: { AutoUpdate: false } },
      '/u.plist': { AutoUpdate: true, Junk: 1 },
    });
    expect(layers.forcedMachine).toEqual({ UpdateChannel: 'beta' });
    expect(layers.forcedUser).toEqual({ AutoUpdate: true });
    expect(layers.recommendedMachine).toEqual({ AutoUpdate: false });
  });

  test('objectIsForcedForKey vouches for a value in NSUserDefaults', () => {
    const layers = read({ InstanceUrl: 'https://a.example', AutoUpdate: '0' }, (key) => key === 'InstanceUrl');
    expect(layers.forcedMachine).toEqual({ InstanceUrl: 'https://a.example' });
    expect(layers.recommendedUser).toEqual({ AutoUpdate: '0' });
  });

  test('an absent key isn\'t read as false or empty', () => {
    const layers = read({}, () => true);
    expect(layers.forcedMachine).toEqual({});
    expect(resolvePolicies(layers).AllowStandalone.source).toBe('default');
  });

  test('a managed file that can\'t be trusted or read stops, rather than counting as no policy', () => {
    expect(readMacPolicies(prefs({}), null, PATHS, () => ({ ok: false, reason: 'plist_unsafe' }))).toEqual({ ok: false, reason: 'plist_unsafe' });
  });

  test('only a root-owned file that others can\'t write passes', () => {
    const file = (uid: number, mode: number, link = false) => ({ uid, mode, size: 1, isFile: () => !link, isSymbolicLink: () => link, isDirectory: () => false });
    expect(managedPlistProblem(file(0, 0o100644))).toBeNull();
    expect(managedPlistProblem(file(501, 0o100644))).toBe('plist_unsafe');
    expect(managedPlistProblem(file(0, 0o100666))).toBe('plist_unsafe');
    expect(managedPlistProblem(file(0, 0o120777, true))).toBe('plist_unsafe');
    expect(managedPlistPaths('org.bulwarkmail.desktop', 'me').user).toBe('/Library/Managed Preferences/me/org.bulwarkmail.desktop.plist');
  });
});

test.describe('the test root', () => {
  const ARG = '--bulwark-test-policy-root=HKCU\\Software\\BulwarkTest\\Policies\\abc';

  test('works unpackaged', () => {
    expect(testPolicyRoot([ARG], false)).toBe('HKCU\\Software\\BulwarkTest\\Policies\\abc');
  });

  test('a package never takes it', () => {
    expect(testPolicyRoot([ARG], true)).toBeNull();
  });

  each([
    'HKCU\\Software\\Other',
    'HKLM\\Software\\BulwarkTest\\Policies',
    'HKCU\\Software\\BulwarkTest\\Policies\\..\\..\\Elsewhere',
    'HKCU\\Software\\BulwarkTest\\PoliciesX',
    '',
  ])('it can\'t name anything else: %s', (root) => {
    expect(testPolicyRoot([`--bulwark-test-policy-root=${root}`], false)).toBeNull();
  });

  test('no switch means no test root, whatever the environment says', () => {
    process.env.BULWARK_TEST_POLICY_ROOT = 'HKCU\\Software\\BulwarkTest\\Policies\\env';
    try {
      expect(testPolicyRoot([], false)).toBeNull();
    } finally {
      delete process.env.BULWARK_TEST_POLICY_ROOT;
    }
  });

  test('the production build has no test root at all, and a test build can\'t be packaged', () => {
    const root = path.resolve(import.meta.dirname, '..');
    const build = (...args: string[]) => {
      const run = spawnSync(process.execPath, ['build.mjs', ...args], { cwd: root, encoding: 'utf8' });
      expect(run.status, run.stderr).toBe(0);
      return readFileSync(path.join(root, 'dist', 'main.mjs'), 'utf8');
    };
    const production = build();
    const withHooks = build('--test');
    expect(withHooks).toContain('--bulwark-test-policy-poll=');
    expect(withHooks).toContain('BulwarkTest');
    expect(production).not.toContain('--bulwark-test-policy');
    expect(production).not.toContain('BulwarkTest');
    // A renamed exe mustn't be able to answer the app lock's question, or hand out what the tests read.
    for (const hook of ['BULWARK_TEST_OS_VERIFY', 'BULWARK_TEST_HELLO_KEY', '__bulwarkAppLock', '__bulwarkOs', 'bulwark-test-no-native']) {
      expect(withHooks, hook).toContain(hook);
      expect(production, hook).not.toContain(hook);
    }
    // Nothing in a real build can move the quick compose keys, or hold none.
    expect(withHooks).toContain('--bulwark-test-quick-compose-default=');
    expect(production).not.toContain('--bulwark-test-quick-compose-default=');
    // Nor can it move where the app registers itself.
    expect(withHooks).toContain('--bulwark-test-registry-root=');
    expect(production).not.toContain('--bulwark-test-registry-root=');
    // Dev switches hang on the build, not on the exe's name.
    for (const name of ['bulwark-user-data', 'bulwark-server-dir', 'bulwark-test-wrong-pin']) expect(production).not.toContain(name);
    expect(withHooks).toContain('bulwark-user-data');
    // A switch can't point telemetry or a crash file anywhere in a real build.
    expect(withHooks).toContain('--bulwark-test-${name}=');
    expect(production).not.toContain('--bulwark-test-${name}=');
  });
});

test.describe('what the app opens with', () => {
  const INSTANCE = 'https://mail.example.com/';

  test('nothing set: ask', () => {
    expect(decideStart(snapshot(), null, {})).toMatchObject({ kind: 'welcome', allowStandalone: true, instanceUrl: null, urlLocked: false });
  });

  test('forced goes over any choice, including the development switches', () => {
    const forced = snapshot({ InstanceUrl: INSTANCE });
    for (const choice of [{}, { mode: 'standalone' as const }, { mode: 'instance' as const, instanceUrl: 'https://other.example/' }, { devStandalone: true }, { devInstance: 'https://other.example' }, { askConnection: true }]) {
      expect(decideStart(forced, null, choice)).toEqual({ kind: 'instance', url: INSTANCE, forced: true, canSwitch: false });
    }
  });

  test('the user\'s choice goes over a recommendation, which goes over asking', () => {
    const recommended = snapshot({}, { InstanceUrl: INSTANCE });
    expect(decideStart(recommended, null, {})).toMatchObject({ kind: 'instance', url: INSTANCE, forced: false, canSwitch: true });
    expect(decideStart(recommended, null, { mode: 'standalone' })).toMatchObject({ kind: 'standalone' });
    expect(decideStart(recommended, null, { mode: 'instance', instanceUrl: 'https://mine.example/' })).toMatchObject({ kind: 'instance', url: 'https://mine.example/' });
  });

  test('"Change Connection" shows the choice once, also over a recommendation', () => {
    expect(decideStart(snapshot({}, { InstanceUrl: INSTANCE }), null, { askConnection: true })).toMatchObject({ kind: 'welcome', instanceUrl: INSTANCE, urlLocked: false });
  });

  each([
    ['http://mail.example.com', 'insecure'],
    ['file:///c:/evil', 'scheme'],
    ['not a url', 'invalid_url'],
  ])('a forced %s stops with an error naming the policy, whatever was chosen before', (raw, reason) => {
    const bad = snapshot({ InstanceUrl: raw });
    for (const choice of [{}, { mode: 'standalone' as const }, { mode: 'instance' as const, instanceUrl: 'https://mine.example/' }, { devStandalone: true }]) {
      expect(decideStart(bad, null, choice)).toEqual({ kind: 'policy-error', policy: 'InstanceUrl', reason, raw, canSwitch: false });
    }
  });

  test('http works with AllowInsecureInstance', () => {
    expect(decideStart(snapshot({ InstanceUrl: 'http://bulwark.lan', AllowInsecureInstance: 1 }), null, {})).toMatchObject({ kind: 'instance', url: 'http://bulwark.lan/' });
  });

  test('a problem with the policy source itself also stops', () => {
    expect(decideStart(snapshot(), { policy: '/etc/bulwark/policies.json', reason: 'writable_by_others' }, { mode: 'standalone' })).toMatchObject({ kind: 'policy-error', policy: '/etc/bulwark/policies.json' });
  });

  test('AllowStandalone 0 takes direct connections away, also from who chose them, and keeps their choice stored', () => {
    const off = snapshot({ AllowStandalone: 0 });
    expect(decideStart(off, null, { mode: 'standalone' })).toMatchObject({ kind: 'welcome', allowStandalone: false });
    expect(decideStart(off, null, { devStandalone: true })).toMatchObject({ kind: 'welcome', allowStandalone: false });
    expect(decideStart(off, null, { mode: 'instance', instanceUrl: 'https://mine.example/' })).toMatchObject({ kind: 'instance' });
  });

  test('a forced server with AllowStandalone 1 lets the user pick direct connections', () => {
    const both = snapshot({ InstanceUrl: INSTANCE, AllowStandalone: 1 });
    expect(standaloneAllowed(both)).toBe(true);
    expect(decideStart(both, null, {})).toEqual({ kind: 'instance', url: INSTANCE, forced: true, canSwitch: true });
    expect(decideStart(both, null, { mode: 'standalone' })).toMatchObject({ kind: 'standalone' });
    expect(decideStart(both, null, { askConnection: true })).toMatchObject({ kind: 'welcome', allowStandalone: true, instanceUrl: INSTANCE, urlLocked: true });
  });

  test('AllowedJmapServers also covers a server anyone chose', () => {
    const listed = { AllowedJmapServers: ['https://mail.example.com'] };
    const stored = { mode: 'instance' as const, instanceUrl: 'https://mine.example/' };
    expect(decideStart(snapshot(listed), null, stored)).toMatchObject({ kind: 'welcome' });
    expect(decideStart(snapshot(listed), null, { mode: 'instance', instanceUrl: INSTANCE })).toMatchObject({ kind: 'instance', url: INSTANCE });
    expect(decideStart(snapshot(listed), null, { devInstance: 'https://mine.example' })).toMatchObject({ kind: 'welcome' });
    // A recommendation has to be on it as well.
    expect(decideStart(snapshot(listed, { InstanceUrl: 'https://mine.example' }), null, {})).toMatchObject({ kind: 'welcome', instanceUrl: null });
    // A forced one is the admin's own word.
    expect(decideStart(snapshot({ ...listed, InstanceUrl: 'https://mine.example' }), null, {})).toMatchObject({ kind: 'instance', forced: true });
  });

  test('a recommended AllowStandalone can\'t open what a forced server closed', () => {
    const both = snapshot({ InstanceUrl: INSTANCE }, { AllowStandalone: 1 });
    expect(standaloneAllowed(both)).toBe(false);
    expect(decideStart(both, null, { mode: 'standalone' })).toEqual({ kind: 'instance', url: INSTANCE, forced: true, canSwitch: false });
  });

  test('"Later" only lasts where nothing forced moved', () => {
    const on = (url: string) => ({ kind: 'instance' as const, url, forced: true, canSwitch: false });
    const chosen = { kind: 'instance' as const, url: INSTANCE, forced: false, canSwitch: true };
    const standalone = { kind: 'standalone' as const, canSwitch: true };
    const welcome = { kind: 'welcome' as const, allowStandalone: false, instanceUrl: null, urlLocked: false, canSwitch: false as const };
    const error = { kind: 'policy-error' as const, policy: 'InstanceUrl', reason: 'scheme', canSwitch: false as const };
    const none = snapshot();
    expect(connectionMustChange(on('https://a.example/'), on('https://b.example/'), none)).toBe(true);
    expect(connectionMustChange(chosen, on('https://b.example/'), none)).toBe(true);
    expect(connectionMustChange(on('https://a.example/'), error, none)).toBe(true);
    expect(connectionMustChange(standalone, welcome, none)).toBe(true);
    // Lifted: nothing is wrong with staying.
    expect(connectionMustChange(on('https://a.example/'), chosen, none)).toBe(false);
    expect(connectionMustChange(on('https://a.example/'), on('https://a.example/'), none)).toBe(false);
    expect(connectionMustChange(error, error, none)).toBe(false);
  });

  test('a server nobody forced has to stay allowed, or "Later" runs out', () => {
    const at = (url: string) => ({ kind: 'instance' as const, url, forced: false, canSwitch: true });
    const welcome = { kind: 'welcome' as const, allowStandalone: true, instanceUrl: null, urlLocked: false, canSwitch: false as const };
    const offTheList = snapshot({ AllowedJmapServers: ['https://other.example.com'] });
    expect(connectionMustChange(at('https://chosen.example.com/'), welcome, offTheList)).toBe(true);
    expect(connectionMustChange(at('https://chosen.example.com/'), decideStart(offTheList, null, { mode: 'instance', instanceUrl: 'https://chosen.example.com/' }), offTheList)).toBe(true);
    expect(connectionMustChange(at('http://mail.lan/'), welcome, snapshot())).toBe(true);
    expect(connectionMustChange(at('http://mail.lan/'), at('http://mail.lan/'), snapshot({ AllowInsecureInstance: 1 }))).toBe(false);
    // A recommendation moving on leaves a server that's still fine.
    expect(connectionMustChange(at('https://a.example/'), at('https://b.example/'), snapshot())).toBe(false);
  });

  test('a list nobody can read stops the app and says so, unless a forced server needs no list', () => {
    for (const [list, reason] of [['https://a.example.com', 'not_a_list'], [['not a server'], 'no_usable_entries']] as const) {
      const bad = snapshot({ AllowedJmapServers: list as never });
      expect(decideStart(bad, null, {})).toMatchObject({ kind: 'policy-error', policy: 'AllowedJmapServers', reason });
      expect(decideStart(bad, null, { mode: 'standalone' })).toMatchObject({ kind: 'policy-error', policy: 'AllowedJmapServers' });
      expect(decideStart(snapshot({ AllowedJmapServers: list as never, InstanceUrl: INSTANCE }), null, {})).toMatchObject({ kind: 'instance', url: INSTANCE });
    }
    // Part of a list is still a list.
    expect(decideStart(snapshot({ AllowedJmapServers: ['https://a.example.com', 'not a server'] }), null, {})).toMatchObject({ kind: 'welcome' });
  });

  test('a restart is only worth asking for when the outcome changes', () => {
    const a = snapshot({ InstanceUrl: INSTANCE });
    const key = (s: typeof a) => restartKey(decideStart(s, null, {}), s);
    expect(key(snapshot({ InstanceUrl: INSTANCE, UpdateChannel: 'beta' }))).toBe(key(a));
    expect(key(snapshot({ InstanceUrl: 'https://other.example' }))).not.toBe(key(a));
    expect(key(snapshot({ InstanceUrl: INSTANCE, AuthServerAllowlist: '*.example.com' }))).not.toBe(key(a));
  });
});

test.describe('the switches a production build refuses', () => {
  const EXE = 'Bulwark.exe';

  each([
    '--remote-debugging-port=9347', '--remote-debugging-pipe', '--remote-allow-origins=*', '--inspect=9229', '--inspect-brk', '--user-data-dir=C:\\x',
    '--host-rules=MAP * 1.2.3.4', '--host-resolver-rules=MAP * 1.2.3.4', '--ignore-certificate-errors', '--ignore-certificate-errors-spki-list=a',
    '--proxy-server=1.2.3.4:80', '--proxy-pac-url=http://x', '--proxy-bypass-list=*', '--no-proxy-server', '--no-sandbox', '--disable-gpu-sandbox',
    '--disable-web-security', '--allow-running-insecure-content', '--disable-features=X', '--enable-features=X', '--js-flags=--x', '--load-extension=C:\\x',
    '--disable-site-isolation-trials', '--auth-server-whitelist=*', '--renderer-cmd-prefix=x', '--browser-subprocess-path=x', '--ssl-key-log-file=x', '--log-net-log=x',
    '--unsafely-treat-insecure-origin-as-secure=http://x',
  ])('%s', (arg) => {
    expect(deniedSwitches([EXE, arg], 'linux').length).toBe(1);
    expect(withoutDeniedSwitches([EXE, arg, 'bulwark://x'], 'linux')).toEqual([EXE, 'bulwark://x']);
  });

  // Chromium trims each argument first, so these reach it as the switch they contain.
  each([
    ' --remote-debugging-port=9392', '\t--remote-debugging-port=9392', '--remote-debugging-port=9392 ', '  --remote-debugging-port=9392\t',
    ' --user-data-dir=C:\\x', '\t--user-data-dir=C:\\x', '--user-data-dir ', ' --proxy-server=1.2.3.4:80', ' --js-flags=--x', ' --ignore-certificate-errors',
    '\u00a0--no-sandbox', '\u3000--no-sandbox', '\u2003--no-sandbox', '\u0085--no-sandbox', '\r\n--no-sandbox',
    // Not trimmed by Chromium, but nothing anyone needs as a file name.
    '"--no-sandbox"', '\u200b--no-sandbox', '\ufeff--no-sandbox', '\u0001--no-sandbox', '---no-sandbox',
  ])('padded: %s', (arg) => {
    for (const platform of ['win32', 'linux', 'darwin'] as const) {
      expect(deniedSwitches([EXE, arg], platform).length, platform).toBe(1);
      expect(withoutDeniedSwitches([EXE, arg, 'bulwark://x'], platform), platform).toEqual([EXE, 'bulwark://x']);
    }
  });

  test('a padded switch comes out under its own name, so it can be removed', () => {
    expect(deniedSwitches([EXE, ' --Remote-Debugging-Port=9'], 'win32')).toEqual(['remote-debugging-port']);
    expect(deniedSwitches([EXE, ' /no-sandbox'], 'win32')).toEqual(['no-sandbox']);
    expect(deniedSwitches([EXE, ' /no-sandbox'], 'linux')).toEqual([]);
  });

  test('a padded -- ends the switches, as it does for Chromium, and files stay files', () => {
    expect(deniedSwitches([EXE, ' -- ', '--no-sandbox'], 'win32')).toEqual([]);
    const files = [EXE, ' C:\\some mail.eml ', 'mailto:a@example.org', '--lang=de '];
    expect(deniedSwitches(files, 'win32')).toEqual([]);
    expect(withoutDeniedSwitches(files, 'win32')).toEqual(files);
  });

  test('the environment Electron, Node and Chromium read before any of our code', () => {
    const refused = ['ELECTRON_DISABLE_SANDBOX', 'ELECTRON_NO_ASAR', 'ELECTRON_ENABLE_LOGGING', 'ELECTRON_LOG_FILE', 'ELECTRON_ENABLE_STACK_DUMPING', 'ELECTRON_LOG_ASAR_READS', 'ELECTRON_NO_ATTACH_CONSOLE', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_SOMETHING_NEW', 'electron_disable_sandbox', 'NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_EXTRA_CA_CERTS', 'NODE_PATH', 'SSLKEYLOGFILE', 'CHROME_LOG_FILE'];
    const left = ['PATH', 'NODE_ENV', 'APPIMAGE', 'HOME', 'ELECTRON_OZONE_PLATFORM_HINT', 'ELECTRON_TRASH', 'ELECTRON_FORCE_WINDOW_MENU_BAR', 'NODENAME'];
    const env = Object.fromEntries([...refused, ...left].map((name) => [name, '1']));
    expect(deniedEnvironment(env).sort()).toEqual([...refused].sort());
    expect(deniedEnvironment({ ELECTRON_DISABLE_SANDBOX: undefined })).toEqual([]);
  });

  test('Windows also takes -name and /name, in any case', () => {
    for (const arg of ['-remote-debugging-port=9', '/remote-debugging-port=9', '--REMOTE-DEBUGGING-PORT=9', '/NO-SANDBOX']) {
      expect(deniedSwitches([EXE, arg], 'win32').length).toBe(1);
    }
    expect(deniedSwitches([EXE, '/remote-debugging-port=9'], 'linux')).toEqual([]);
  });

  test('leaves the rest alone: the exe itself, ordinary switches, a link, and what follows --', () => {
    const argv = [EXE, '--lang=de', '--ozone-platform=wayland', '--port-retry', 'mailto:a@example.org', '--', '--no-sandbox'];
    expect(deniedSwitches(argv, 'linux')).toEqual([]);
    expect(withoutDeniedSwitches(argv, 'linux')).toEqual(argv);
  });

  test('names each once', () => {
    expect(deniedSwitches([EXE, '--no-sandbox', '--no-sandbox=1'], 'linux')).toEqual(['no-sandbox']);
  });
});

test.describe('a sign-in chain', () => {
  test('runs until it ends, with no limit where nothing is forced', () => {
    let now = 0;
    const chain = new SsoChain(() => null, () => now);
    expect(chain.active()).toBe(false);
    chain.start();
    now = FORCED_SSO_LIMIT_MS * 10;
    expect(chain.active()).toBe(true);
    chain.end();
    expect(chain.active()).toBe(false);
  });

  test('has a limit when the server is forced', () => {
    let now = 0;
    const chain = new SsoChain(() => FORCED_SSO_LIMIT_MS, () => now);
    chain.start();
    now = FORCED_SSO_LIMIT_MS;
    expect(chain.active()).toBe(true);
    now += 1;
    expect(chain.active()).toBe(false);
    expect(chain.active()).toBe(false);
  });
});

test.describe('every key has someone acting on it', () => {
  test('the shell\'s named consumers read their key', () => {
    for (const key of POLICY_KEYS) {
      const consumer = POLICY_CONSUMERS[key];
      if ('repo' in consumer && consumer.repo === 'shell') {
        expect(readFileSync(path.resolve(import.meta.dirname, '..', consumer.file), 'utf8'), key).toContain(key);
      }
    }
  });

  test('a key nobody wired yet names who owes it', () => {
    const pending = POLICY_KEYS.filter((key) => 'pendingConsumer' in POLICY_CONSUMERS[key]);
    expect(pending).toEqual([]);
  });
});

test.describe('values that make no sense', () => {
  test('each forced one is named, with what was set', () => {
    const bad = snapshot({ AllowStandalone: 'no', PluginsMode: 'OFF', AllowedJmapServers: 'x', OfflineEnabled: 'yes', AppLockTimeoutMinutes: '99999', WipeOfflineData: 'w'.repeat(200), InstanceUrl: 'https://mail.example.com' });
    const problems = policyProblems(bad);
    expect(problems.map((problem) => problem.key).sort()).toEqual(['AllowStandalone', 'AllowedJmapServers', 'AppLockTimeoutMinutes', 'OfflineEnabled', 'PluginsMode', 'WipeOfflineData']);
    expect(problems.find((problem) => problem.key === 'PluginsMode')).toEqual({ key: 'PluginsMode', reason: 'unknown_value', raw: 'OFF' });
    expect(problems.find((problem) => problem.key === 'WipeOfflineData')?.reason).toBe('too_long');
    // Each still fails closed.
    expect(bad.AllowStandalone.value).toBe(false);
    expect(bad.PluginsMode.value).toBe('off');
    expect(bad.AllowedJmapServers.value).toEqual([]);
    expect(bad.WipeOfflineData.value).toBeNull();
  });

  test('a list with entries left out is named, and a good or absent value isn\'t', () => {
    expect(policyProblems(snapshot({ AllowedJmapServers: ['https://a.example.com', 'not a server'] }))).toEqual([{ key: 'AllowedJmapServers', reason: 'entries_left_out' }]);
    expect(policyProblems(snapshot({ AllowStandalone: 0, PluginsMode: 'off' }))).toEqual([]);
    expect(policyProblems(snapshot({}, { AppLockTimeoutMinutes: 'nonsense' }))).toEqual([]);
  });

  test('an unusable lock timeout is the shortest there is, for the user\'s choice not to win', () => {
    for (const raw of ['99999', 0, 'soon']) {
      expect(snapshot({ AppLockTimeoutMinutes: raw }).AppLockTimeoutMinutes).toMatchObject({ value: 1, locked: true });
    }
    expect(snapshot({ AppLockTimeoutMinutes: 15 }).AppLockTimeoutMinutes).toMatchObject({ value: 15, locked: true });
  });

  test('a PIN minimum under 5 is refused and stays at 5, a longer one reaches the page, a recommended one doesn\'t count', () => {
    for (const raw of [3, '4', 'long', 65]) {
      expect(snapshot({ AppLockPinMinLength: raw }).AppLockPinMinLength, String(raw)).toMatchObject({ value: 5, locked: true });
    }
    expect(policyProblems(snapshot({ AppLockPinMinLength: 3 }))).toEqual([{ key: 'AppLockPinMinLength', reason: 'out_of_range', raw: '3' }]);
    expect(pagePolicySnapshot(snapshot({ AppLockPinMinLength: 8 })).AppLockPinMinLength).toMatchObject({ value: 8, locked: true });
    expect(snapshot({}, { AppLockPinMinLength: 8 }).AppLockPinMinLength).toMatchObject({ value: null, locked: false, source: 'default' });
  });

  test('a list of auth servers can\'t name a whole top-level domain', () => {
    for (const raw of ['com', '.com', 'COM', '..com', 'com.', 'com:443', '*.com', '*', 'de', 'example.org,net']) {
      expect(snapshot({ AuthServerAllowlist: raw }).AuthServerAllowlist, raw).toMatchObject({ value: null, invalid: 'invalid_host_list' });
    }
    for (const raw of ['intranet', 'sso', 'example.com', '.example.com', '*.example.com', 'dc1.corp.example.com:8443']) {
      expect(snapshot({ AuthServerAllowlist: raw }).AuthServerAllowlist, raw).toMatchObject({ value: raw, locked: true });
    }
    expect(snapshot({ AuthNegotiateDelegateAllowlist: '.com' }).AuthNegotiateDelegateAllowlist.invalid).toBe('invalid_host_list');
  });

  test('a certificate rule can\'t cover a whole top-level domain', () => {
    const rule = (pattern: string) => parseCertificateRule(JSON.stringify({ pattern }));
    for (const pattern of ['[*.]com', 'https://[*.]com', '*.com', '[*.]com:443', '[*.]intranet']) expect(rule(pattern), pattern).toBeNull();
    expect(rule('https://[*.]example.com')).toMatchObject({ host: 'example.com', subdomains: true });
    expect(rule('https://intranet')).toMatchObject({ host: 'intranet', subdomains: false });
  });
});

test.describe('what a recommendation can do', () => {
  test('nothing, where there is no user\'s choice to sit under', () => {
    for (const key of ['AppLockRequired', 'TelemetryAllowed', 'CrashReportsAllowed', 'AutoUpdate'] as const) {
      expect(snapshot({}, { [key]: 0 })[key], key).toMatchObject({ source: 'default', locked: false });
      expect(snapshot({ [key]: 0 })[key], key).toMatchObject({ value: false, locked: true });
    }
  });

  test('AutoUpdate from `defaults write` on macOS doesn\'t stop updates', () => {
    const read = readMacPolicies(
      { getUserDefault: (key: string, type: string) => (key === 'AutoUpdate' ? '0' : type === 'array' ? [] : '') },
      () => false,
      { machine: 'm', user: 'u' },
      () => ({ ok: true, values: null }),
    );
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.layers.recommendedUser.AutoUpdate).toBe('0');
    expect(updatePolicyFrom(resolvePolicies(read.layers))).toEqual({});
  });
});

test.describe('what a page gets', () => {
  const full = () => snapshot({
    AuthServerAllowlist: '*.corp.example.com',
    AuthNegotiateDelegateAllowlist: 'dc1.corp.example.com',
    AutoSelectCertificateForUrls: [JSON.stringify({ pattern: 'https://sso.corp.example.com', filter: { ISSUER: { CN: 'Corp CA' } } })],
    KeystoreAllowedOrigins: ['https://mail.corp.example.com'],
    WipeOfflineData: 'guess-me',
    PluginsMode: 'OFF',
    PluginAllowlist: ['good-plugin'],
    OfflineEnabled: 'yes',
    AppLockRequired: 1,
    AppLockTimeoutMinutes: 7,
    CrashReportsAllowed: 0,
    RecentFilesInAttach: 0,
    ComposeInNewWindow: 1,
  }, { InstanceUrl: 'https://mail.corp.example.com' });

  test('no internal hosts, no wipe code, no recommended server and no raw value', () => {
    const page = JSON.stringify(pagePolicySnapshot(full()));
    for (const secret of ['corp.example.com', 'Corp CA', 'guess-me']) expect(page).not.toContain(secret);
    expect(pagePolicySnapshot(full()).OfflineEnabled.raw).toBeUndefined();
  });

  test('every key is still there, with what the webmail reads intact', () => {
    const page = pagePolicySnapshot(full());
    for (const key of POLICY_KEYS) expect(page[key], key).toBeDefined();
    expect(page.AuthServerAllowlist).toMatchObject({ value: null, locked: false, source: 'default' });
    expect(page.InstanceUrl).toMatchObject({ value: null, locked: false });
    // A forced server is the only one a page from a server can be on.
    expect(pagePolicySnapshot(snapshot({ InstanceUrl: 'https://mail.example.com' })).InstanceUrl).toMatchObject({ value: 'https://mail.example.com/', locked: true });
    expect(page.PluginsMode).toMatchObject({ value: 'off', invalid: 'unknown_value', locked: true });
    expect(page.PluginAllowlist.value).toEqual(['good-plugin']);
    expect(page.OfflineEnabled).toMatchObject({ value: false, invalid: 'not_a_switch', locked: true });
    expect(page.AppLockRequired).toMatchObject({ value: true, locked: true });
    expect(page.AppLockTimeoutMinutes).toMatchObject({ value: 7, locked: true });
    expect(page.CrashReportsAllowed).toMatchObject({ value: false, locked: true });
    // The Attach menu hides its recent files by it.
    expect(page.RecentFilesInAttach).toMatchObject({ value: false, locked: true });
    // Every composer opens in a window of its own by it.
    expect(page.ComposeInNewWindow).toMatchObject({ value: true, locked: true });
  });
});

test.describe('the MSI properties', () => {
  const require = createRequire(import.meta.url);
  const { addPolicies } = require('../scripts/msi-policies.cjs') as { addPolicies: (project: string) => string };
  const project = '<Wix><Product Id="*"><Feature Id="ProductFeature" Absent="disallow">\n<ComponentGroupRef Id="ProductComponents"/></Feature>\n  </Product></Wix>';

  test('writes the forced key with FORCE_INSTANCE=1, and Recommended without, and clears the other', () => {
    const out = addPolicies(project);
    expect(out).toMatch(/INSTANCE_URL AND FORCE_INSTANCE = "1"[\s\S]*?Key="SOFTWARE\\Policies\\Bulwark\\Desktop" Name="InstanceUrl"[^>]*Value="\[INSTANCE_URL\]"[\s\S]*?RemoveRegistryValue Root="HKLM" Key="SOFTWARE\\Policies\\Bulwark\\Desktop\\Recommended" Name="InstanceUrl"/);
    expect(out).toMatch(/INSTANCE_URL AND NOT FORCE_INSTANCE = "1"[\s\S]*?Key="SOFTWARE\\Policies\\Bulwark\\Desktop\\Recommended" Name="InstanceUrl"[\s\S]*?RemoveRegistryValue Root="HKLM" Key="SOFTWARE\\Policies\\Bulwark\\Desktop" Name="InstanceUrl"/);
    expect(out).toMatch(/FORCE_INSTANCE = "1"[\s\S]*?Key="SOFTWARE\\Policies\\Bulwark\\Desktop" Name="UpdateChannel"/);
  });

  test('a standard user\'s repair can\'t set them: not secure properties', () => {
    const out = addPolicies(project);
    for (const id of ['INSTANCE_URL', 'FORCE_INSTANCE', 'UPDATE_CHANNEL']) expect(out).not.toContain(`<Property Id="${id}"`);
    expect(out).not.toContain('Secure="yes"');
  });

  test('a repair or upgrade writes back what was there, and a real uninstall removes it', () => {
    const out = addPolicies(project);
    expect(out).toContain('<Property Id="BW_PREV_FORCED_URL">');
    expect(out).toMatch(/RegistrySearch[^>]*Key="SOFTWARE\\Policies\\Bulwark\\Desktop"[^>]*Name="InstanceUrl"[^>]*Win64="yes"/);
    expect(out).toContain('<SetProperty Id="INSTANCE_URL" Value="[BW_PREV_FORCED_URL]"');
    expect(out).not.toContain('Permanent="yes"');
    for (const [, id] of out.matchAll(/<Component Id="([^"]+)"/g)) expect(out).toContain(`<ComponentRef Id="${id}"/>`);
    expect(out.match(/<RegistryValue Root="HKLM"/g)).toHaveLength(4);
  });

  test('FORCE_INSTANCE without a server stops the install', () => {
    expect(addPolicies(project)).toMatch(/<Condition Message="FORCE_INSTANCE=1 needs INSTANCE_URL[^"]*"><!\[CDATA\[Installed OR NOT FORCE_INSTANCE = "1" OR INSTANCE_URL/);
  });

  test('refuses a project it does not recognise, rather than shipping without the switches', () => {
    expect(() => addPolicies('<Wix/>')).toThrow('does not look as expected');
  });
});
