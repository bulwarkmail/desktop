import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { createRequire } from 'node:module';
import { acceptDownload, compareVersions, differentialDownloads, effectiveChannel, installKind, installerSignatureCheck, isPrerelease, judgeFeedVersion, newestReleaseInFeed, nextReadiness, NOT_READY, nothingPublished, parseDn, quitPath, readyVersion, relaunchPath, signatureVerdict, updateAbility, UPDATER_LOG_LIMIT, updaterLogLine, updaterLogNeedsRotation, updatePolicyFrom, updateUrlAllowed } from '../src/main/update-rules';
import { sandboxRefused } from '../src/main/sandbox-check';
import { LABEL_KEY } from '../src/main/label-keys';
import { notifyUpdatePolicyChanged, onUpdatePolicyChange, readUpdatePolicy, setUpdatePolicySource } from '../src/main/update-policy';

const ROOT = path.resolve(import.meta.dirname, '..');

test.describe('version order', () => {
  test('follows semver, prereleases before their release', () => {
    const ordered = ['0.9.0', '0.9.1', '0.10.0', '1.0.0-alpha.1', '1.0.0-beta.1', '1.0.0-beta.2', '1.0.0-beta.10', '1.0.0-rc.1', '1.0.0', '1.0.1'];
    for (let i = 0; i < ordered.length - 1; i += 1) {
      expect(compareVersions(ordered[i], ordered[i + 1]), `${ordered[i]} < ${ordered[i + 1]}`).toBeLessThan(0);
      expect(compareVersions(ordered[i + 1], ordered[i]), `${ordered[i + 1]} > ${ordered[i]}`).toBeGreaterThan(0);
    }
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
    expect(isPrerelease('1.0.0-beta.1')).toBe(true);
    expect(isPrerelease('1.0.0')).toBe(false);
  });
});

test.describe('which channel applies', () => {
  test('forced beats the user, the user beats recommended, recommended beats what the build is', () => {
    expect(effectiveChannel({ channel: 'stable' }, 'beta', '1.0.0-beta.1')).toBe('stable');
    expect(effectiveChannel({ recommendedChannel: 'stable' }, 'beta', '1.0.0')).toBe('beta');
    expect(effectiveChannel({ recommendedChannel: 'beta' }, undefined, '1.0.0')).toBe('beta');
    expect(effectiveChannel({}, undefined, '1.0.0')).toBe('stable');
    expect(effectiveChannel({}, undefined, '1.0.0-beta.1')).toBe('beta');
    // Installed as a beta and updated to a stable: still on beta until someone chooses.
    expect(effectiveChannel({}, undefined, '1.0.0', 'beta')).toBe('beta');
    expect(effectiveChannel({}, 'stable', '1.0.0', 'beta')).toBe('stable');
    expect(effectiveChannel({ recommendedChannel: 'stable' }, undefined, '1.0.0', 'beta')).toBe('stable');
    // A beta is on beta, whatever this copy started as, so it finds the next one.
    expect(effectiveChannel({}, undefined, '1.1.0-beta.3', 'stable')).toBe('beta');
    expect(effectiveChannel({ channel: 'stable' }, undefined, '1.1.0-beta.3', 'beta')).toBe('stable');
  });
});

test.describe('what a copy can do', () => {
  const facts = { isPackaged: true, hasNsisUninstaller: false };

  test('an NSIS install replaces itself', () => {
    const kind = installKind({ ...facts, platform: 'win32', hasNsisUninstaller: true });
    expect(kind).toBe('nsis');
    expect(updateAbility(kind)).toBe('install');
  });

  test('an MSI never runs the NSIS installer', () => {
    const kind = installKind({ ...facts, platform: 'win32' });
    expect(kind).toBe('windows-other');
    expect(updateAbility(kind)).toBe('notify');
  });

  test('unsigned macOS only says a version exists, signed macOS replaces itself', () => {
    expect(updateAbility(installKind({ ...facts, platform: 'darwin' }))).toBe('notify');
    expect(updateAbility(installKind({ ...facts, platform: 'darwin', macSigned: true }))).toBe('install');
  });

  test('on Linux only an AppImage replaces itself', () => {
    expect(updateAbility(installKind({ ...facts, platform: 'linux', appImage: '/x/Bulwark.AppImage' }))).toBe('install');
    expect(updateAbility(installKind({ ...facts, platform: 'linux', packageType: 'deb' }))).toBe('notify');
    expect(updateAbility(installKind({ ...facts, platform: 'linux', packageType: 'rpm' }))).toBe('notify');
    expect(updateAbility(installKind({ ...facts, platform: 'linux' }))).toBe('notify');
  });

  test('a development run has nothing to update', () => {
    expect(updateAbility(installKind({ ...facts, platform: 'win32', isPackaged: false, hasNsisUninstaller: true }))).toBe('none');
  });
});

test.describe('what a version in the feed means', () => {
  test('newer is an update on any channel', () => {
    expect(judgeFeedVersion('1.0.0', '1.0.1', 'stable')).toBe('newer');
    expect(judgeFeedVersion('1.0.0-beta.1', '1.0.0', 'beta')).toBe('newer');
    expect(judgeFeedVersion('1.0.0-beta.1', '1.0.0', 'stable')).toBe('newer');
  });

  test('older is only ever an offer, to a beta user on stable', () => {
    expect(judgeFeedVersion('1.0.0-beta.1', '0.9.1', 'stable')).toBe('older-offer');
    // A pulled release: stable stays where it is, with no offer to go back.
    expect(judgeFeedVersion('1.0.0', '0.9.1', 'stable')).toBe('ignore');
    expect(judgeFeedVersion('1.0.0-beta.2', '1.0.0-beta.1', 'beta')).toBe('ignore');
  });

  test('the same version is nothing', () => {
    expect(judgeFeedVersion('1.0.0', '1.0.0', 'stable')).toBe('same');
  });

  test('stable never takes a prerelease, newer or older', () => {
    expect(judgeFeedVersion('1.0.0', '1.1.0-beta.1', 'stable')).toBe('ignore');
    expect(judgeFeedVersion('1.0.0-beta.2', '1.0.0-beta.3', 'stable')).toBe('ignore');
    expect(judgeFeedVersion('1.0.0-beta.2', '1.0.0-beta.1', 'stable')).toBe('ignore');
    expect(judgeFeedVersion('1.0.0', '1.1.0-beta.1', 'beta')).toBe('newer');
  });
});

test.describe('a finished download', () => {
  const facts = { allowed: true, wanted: { version: '1.1.0', older: false }, version: '1.1.0', current: '1.0.0', channel: 'stable' as const };

  test('installs when it is still what was asked for', () => {
    expect(acceptDownload(facts)).toBe(true);
  });

  test('does not when updates were turned off meanwhile', () => {
    expect(acceptDownload({ ...facts, allowed: false })).toBe(false);
  });

  test('does not when it was given up on, or is something else', () => {
    expect(acceptDownload({ ...facts, wanted: null })).toBe(false);
    expect(acceptDownload({ ...facts, version: '1.2.0' })).toBe(false);
  });

  test('does not when the channel moved and it is a beta', () => {
    expect(acceptDownload({ ...facts, wanted: { version: '1.1.0-beta.1', older: false }, version: '1.1.0-beta.1' })).toBe(false);
    expect(acceptDownload({ ...facts, wanted: { version: '1.1.0-beta.1', older: false }, version: '1.1.0-beta.1', channel: 'beta' })).toBe(true);
  });

  test('an older version only with the yes that asked for it', () => {
    const older = { allowed: true, version: '0.9.0', current: '1.0.0-beta.1', channel: 'stable' as const };
    expect(acceptDownload({ ...older, wanted: { version: '0.9.0', older: true } })).toBe(true);
    expect(acceptDownload({ ...older, wanted: { version: '0.9.0', older: false } })).toBe(false);
  });
});

test.describe('where update traffic may go', () => {
  test('https to GitHub and its asset hosts, nowhere else', () => {
    for (const url of ['https://github.com/bulwarkmail/desktop/releases.atom', 'https://objects.githubusercontent.com/x', 'https://release-assets.githubusercontent.com/y', 'https://GITHUB.com/z']) {
      expect(updateUrlAllowed(url), url).toBe(true);
    }
    for (const url of ['http://github.com/x', 'https://github.com.evil.example/x', 'https://evilgithubusercontent.com/x', 'https://github.com@evil.example/x', 'https://x:y@github.com/', 'https://example.org/x', 'not a url']) {
      expect(updateUrlAllowed(url), url).toBe(false);
    }
  });

  test('a test build adds its own feed, exactly', () => {
    expect(updateUrlAllowed('http://127.0.0.1:5000/a', 'http://127.0.0.1:5000')).toBe(true);
    expect(updateUrlAllowed('http://localhost:5000/a', 'http://127.0.0.1:5000')).toBe(false);
  });
});

test.describe('the beta feed', () => {
  const entry = (tag: string) => `<entry><link rel="alternate" type="text/html" href="https://github.com/bulwarkmail/desktop/releases/tag/${tag}"/></entry>`;

  test('a stable hotfix published last does not hide a higher beta', () => {
    expect(newestReleaseInFeed(entry('v1.0.1') + entry('v1.1.0-beta.2') + entry('v1.0.0'))).toBe('1.1.0-beta.2');
  });

  test('a stable newer than every beta wins, alpha and odd tags stay out', () => {
    expect(newestReleaseInFeed(entry('v1.1.0') + entry('v1.1.0-rc.1') + entry('v1.1.0-beta.2'))).toBe('1.1.0');
    expect(newestReleaseInFeed(entry('v9.0.0-alpha.1') + entry('v1.0.0') + entry('nightly'))).toBe('1.0.0');
    expect(newestReleaseInFeed('<feed></feed>')).toBeNull();
  });
});

test.describe('differential downloads', () => {
  test('on Windows only, where the release has blockmaps, and each range in a request of its own', () => {
    expect(differentialDownloads('win32')).toBe(true);
    for (const platform of ['darwin', 'linux'] as const) expect(differentialDownloads(platform), platform).toBe(false);
    const updater = readFileSync(path.join(ROOT, 'src', 'main', 'features', 'updater.ts'), 'utf8');
    expect(updater).toContain('autoUpdater.disableDifferentialDownload = !differentialDownloads(process.platform);');
    // GitHub's download servers answer one range at a time; the github provider knows, the
    // generic one the beta channel uses has to be told.
    expect(updater).toMatch(/provider: 'generic', url: [^\n]*useMultipleRangeRequest: false \}/);
    // A download given up on settles: its requests end with an error, not only an abort.
    expect(updater).toContain("if (request.listenerCount('error') > 0) request.emit('error'");
  });
});

test.describe('the sandbox', () => {
  test('an AppImage started without it is refused', () => {
    expect(sandboxRefused({ platform: 'linux', appImage: '/x/B.AppImage', noSandboxSwitch: true })).toBe(true);
    expect(sandboxRefused({ platform: 'linux', appImage: '/x/B.AppImage', noSandboxSwitch: false, disableSandboxEnv: '1' })).toBe(true);
    expect(sandboxRefused({ platform: 'linux', appImage: '/x/B.AppImage', noSandboxSwitch: false })).toBe(false);
  });

  test('nothing else is this check\'s business', () => {
    expect(sandboxRefused({ platform: 'linux', noSandboxSwitch: true })).toBe(false);
    expect(sandboxRefused({ platform: 'win32', appImage: 'x', noSandboxSwitch: true })).toBe(false);
  });
});

test.describe('what the policy reader passes on', () => {
  const entry = <T>(value: T, source: string, locked: boolean) => ({ value, source, locked }) as never;
  const defaults = { AutoUpdate: entry(true, 'default', false), UpdateChannel: entry('stable', 'default', false) };

  test('nothing, for values nobody set: a default is no decision', () => {
    expect(updatePolicyFrom(defaults)).toEqual({});
  });

  test('forced values, with the channel locked', () => {
    expect(updatePolicyFrom({ AutoUpdate: entry(false, 'forced-machine', true), UpdateChannel: entry('beta', 'forced-user', true) })).toEqual({ autoUpdate: false, channel: 'beta' });
  });

  test('a recommended AutoUpdate is no decision: there is no user\'s choice to set it for', () => {
    expect(updatePolicyFrom({ ...defaults, AutoUpdate: entry(false, 'recommended-machine', false) })).toEqual({});
    expect(updatePolicyFrom({ ...defaults, AutoUpdate: entry(false, 'recommended-user', false) })).toEqual({});
  });

  test('a recommended channel is only a default for the user', () => {
    expect(updatePolicyFrom({ ...defaults, UpdateChannel: entry('beta', 'recommended-machine', false) })).toEqual({ recommendedChannel: 'beta' });
  });
});

test.describe('nothing published yet', () => {
  test('the webmail can translate what the updater says', () => {
    for (const key of ['menuRestartToUpdate', 'updateReadyTitle', 'updateOlderDetail']) expect(LABEL_KEY.test(key), key).toBe(true);
    expect(LABEL_KEY.test('sandboxTitle')).toBe(false);
  });

  test('is what electron-updater says when a channel has no release, and nothing else', () => {
    const noStable = (status: string) =>
      `Cannot parse releases feed: Error: Unable to find latest version on GitHub (https://github.com/o/r/releases/latest), please ensure a production release exists: HttpError: ${status}\nHeaders: {}`;
    expect(nothingPublished({ code: 'ERR_UPDATER_INVALID_RELEASE_FEED', message: noStable('406 Not Acceptable') })).toBe(true);
    expect(nothingPublished({ code: 'ERR_UPDATER_INVALID_RELEASE_FEED', message: noStable('503 Unavailable') })).toBe(false);
    expect(nothingPublished({ code: 'ERR_UPDATER_INVALID_RELEASE_FEED', message: 'Cannot parse releases feed: TypeError: x of null' })).toBe(false);
    expect(nothingPublished({ code: 'ERR_XML_MISSED_ELEMENT', message: 'No published versions on GitHub' })).toBe(true);
    expect(nothingPublished({ code: 'ERR_XML_MISSED_ELEMENT', message: 'No element "link"' })).toBe(false);
    expect(nothingPublished({ code: 'ERR_UPDATER_NO_PUBLISHED_VERSIONS' })).toBe(true);
    expect(nothingPublished({ code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' })).toBe(false);
    expect(nothingPublished(new Error('net::ERR_INTERNET_DISCONNECTED'))).toBe(false);
    expect(nothingPublished(null)).toBe(false);
  });
});

test.describe('the policy hook', () => {
  test.afterEach(() => setUpdatePolicySource(() => ({})));

  test('reads the current value and tells listeners', () => {
    let calls = 0;
    const stop = onUpdatePolicyChange(() => {
      calls += 1;
    });
    expect(readUpdatePolicy()).toEqual({});
    setUpdatePolicySource(() => ({ autoUpdate: false }));
    expect(calls).toBe(1);
    expect(readUpdatePolicy().autoUpdate).toBe(false);
    notifyUpdatePolicyChanged();
    expect(calls).toBe(2);
    stop();
    notifyUpdatePolicyChanged();
    expect(calls).toBe(2);
  });
});

test.describe("an update installer's signature, without PowerShell", () => {
  const publisher = 'CN=Rath & Blume GbR, O=Rath & Blume GbR, L=Berlin, C=DE';

  test('reads a name as electron-updater\'s own parseDn does', () => {
    const { parseDn: theirs } = createRequire(import.meta.url)('builder-util-runtime') as { parseDn: (text: string) => Map<string, string> };
    for (const name of [
      'Rath & Blume GbR',
      publisher,
      'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US',
      'CN="Doe, John", O=Example;C=DE',
      'CN=a\\2Cb + OU=x',
      '  CN = spaced  name , O = x ',
      'CN=Mozilla Corporation, OU=Firefox Engineering Operations, O=Mozilla Corporation',
      '',
    ]) {
      expect([...parseDn(name)], name).toEqual([...theirs(name)]);
    }
  });

  test('a plain name has to be the CN, a name with attributes all of them', () => {
    const valid = { status: 'valid', code: '0x00000000', subject: publisher };
    expect(signatureVerdict(['Rath & Blume GbR'], valid)).toBeNull();
    expect(signatureVerdict(['CN=Rath & Blume GbR, C=DE'], valid)).toBeNull();
    expect(signatureVerdict(['Someone Else', 'Rath & Blume GbR'], valid)).toBeNull();
    expect(signatureVerdict(['Rath & Blume'], valid)).toContain('publisherNames: Rath & Blume');
    expect(signatureVerdict(['CN=Rath & Blume GbR, C=US'], valid)).not.toBeNull();
  });

  test('only a valid signature counts, whoever signed it', () => {
    expect(signatureVerdict(['Rath & Blume GbR'], { status: 'invalid', code: '0x80096010', subject: publisher })).toContain('invalid (0x80096010)');
    expect(signatureVerdict(['Rath & Blume GbR'], { status: 'unsigned', code: '0x800b0100' })).toContain('unsigned');
  });

  test('asks the helper for the downloaded file, and goes unchecked only when it cannot answer', async () => {
    const asked: string[] = [];
    const warned: string[] = [];
    const check = installerSignatureCheck(async (file) => {
      asked.push(file);
      return file.endsWith('good.exe') ? { status: 'valid', subject: publisher } : file.endsWith('none.exe') ? null : { status: 'invalid', code: '0x80096010', subject: publisher };
    }, (message) => warned.push(message));
    expect(await check(['Rath & Blume GbR'], 'C:\\t\\good.exe')).toBeNull();
    expect(await check(['Rath & Blume GbR'], 'C:\\t\\bad.exe')).not.toBeNull();
    expect(await check(['Rath & Blume GbR'], 'C:\\t\\none.exe')).toBeNull();
    expect(asked).toEqual(['C:\\t\\good.exe', 'C:\\t\\bad.exe', 'C:\\t\\none.exe']);
    expect(warned).toHaveLength(1);
  });

  test('the updater uses it on Windows, so electron-updater never starts PowerShell', () => {
    const updater = readFileSync(path.join(ROOT, 'src', 'main', 'features', 'updater.ts'), 'utf8');
    expect(updater).toMatch(/verifyUpdateCodeSignature = installerSignatureCheck\(native\(\)\.system\.codeSignature\)/);
  });
});

test.describe('the normal build', () => {
  test('has no way to set another update feed', () => {
    // Run after a plain `node build.mjs`. This string only exists in a test build.
    const main = readFileSync(path.join(ROOT, 'dist', 'main.mjs'), 'utf8');
    expect(main).toContain('update-downloaded');
    expect(main).not.toContain('bulwark-test-update-policy');
    expect(main).not.toContain('__bulwarkUpdaterTest');
    expect(main).not.toContain('bulwark-test-update-feed');
  });
});

test.describe('when an update is ready on macOS', () => {
  test('signed macOS waits for Squirrel, the others only for the download', () => {
    const downloaded = nextReadiness(NOT_READY, { type: 'downloaded', version: '1.1.0' });
    expect(readyVersion('mac-signed', NOT_READY)).toBeNull();
    expect(readyVersion('mac-signed', downloaded)).toBeNull();
    expect(readyVersion('nsis', downloaded)).toBe('1.1.0');
    expect(readyVersion('appimage', downloaded)).toBe('1.1.0');
    const staged = nextReadiness(downloaded, { type: 'squirrel-downloaded' });
    expect(staged.squirrelReady).toBe(true);
    expect(readyVersion('mac-signed', staged)).toBe('1.1.0');
  });

  test('a download given up on, a channel that moved or a new download start over', () => {
    const staged = nextReadiness(nextReadiness(NOT_READY, { type: 'downloaded', version: '1.1.0' }), { type: 'squirrel-downloaded' });
    const reset = nextReadiness(staged, { type: 'reset' });
    expect(reset).toEqual(NOT_READY);
    expect(readyVersion('mac-signed', reset)).toBeNull();
    // Squirrel finishing the one given up on doesn't bring it back.
    expect(nextReadiness(reset, { type: 'squirrel-downloaded' })).toEqual(NOT_READY);
    // electron-updater's next download waits for Squirrel again.
    const next = nextReadiness(staged, { type: 'downloaded', version: '1.2.0' });
    expect(next).toEqual({ downloaded: '1.2.0', squirrelReady: false });
    expect(readyVersion('mac-signed', next)).toBeNull();
  });
});

test.describe('which way the app quits', () => {
  const facts = { restarting: true, squirrelReady: true, stayed: false };

  test('Restart to Update on signed macOS hands the quit to Squirrel', () => {
    expect(quitPath({ ...facts, kind: 'mac-signed' })).toBe('squirrel');
  });

  test('a plain quit or a page that stayed leaves it to Squirrel, without a relaunch', () => {
    expect(quitPath({ ...facts, kind: 'mac-signed', restarting: false })).toBe('plain');
    expect(quitPath({ ...facts, kind: 'mac-signed', stayed: true })).toBe('plain');
    expect(quitPath({ ...facts, kind: 'mac-signed', squirrelReady: false })).toBe('plain');
  });

  test('NSIS and AppImage still install at will-quit', () => {
    expect(quitPath({ ...facts, kind: 'nsis', squirrelReady: false })).toBe('install-at-will-quit');
    expect(quitPath({ ...facts, kind: 'appimage', squirrelReady: false })).toBe('install-at-will-quit');
    expect(quitPath({ ...facts, kind: 'nsis', restarting: false })).toBe('plain');
    expect(quitPath({ ...facts, kind: 'nsis', stayed: true })).toBe('plain');
  });
});

test.describe('a relaunch for something else', () => {
  test('goes through the update only on signed macOS with one staged', () => {
    expect(relaunchPath({ kind: 'mac-signed', squirrelReady: true })).toBe('update');
    expect(relaunchPath({ kind: 'mac-signed', squirrelReady: false })).toBe('relaunch');
    expect(relaunchPath({ kind: 'mac-unsigned', squirrelReady: true })).toBe('relaunch');
    expect(relaunchPath({ kind: 'nsis', squirrelReady: true })).toBe('relaunch');
    expect(relaunchPath({ kind: 'appimage', squirrelReady: false })).toBe('relaunch');
  });

  test('index.ts asks the updater before app.relaunch and hands the quit over after the save', () => {
    const index = readFileSync(path.join(ROOT, 'src', 'main', 'index.ts'), 'utf8');
    expect(index).toMatch(/if \(!relaunchThroughUpdate\([^)]*\)\) \{[^}]*?holdUpdateInstall\(\);\s*app\.relaunch\(\);/);
    expect(index).toMatch(/windows\.beginQuit\(\);[\s\S]{0,400}if \(!handOffAfterSave\(\)\) app\.quit\(\);/);
    expect(index).toMatch(/function handOffAfterSave\(\)[\s\S]{0,300}return handOffQuit\(\);/);
    const updater = readFileSync(path.join(ROOT, 'src', 'main', 'features', 'updater.ts'), 'utf8');
    expect(updater).not.toMatch(/autoUpdater\.logger = null/);
  });
});

test.describe('the updater log', () => {
  test('rotates past about 1 MB', () => {
    expect(updaterLogNeedsRotation(0)).toBe(false);
    expect(updaterLogNeedsRotation(UPDATER_LOG_LIMIT)).toBe(false);
    expect(updaterLogNeedsRotation(UPDATER_LOG_LIMIT + 1)).toBe(true);
    expect(UPDATER_LOG_LIMIT).toBe(1024 * 1024);
  });

  test('has a timestamp on each line and no secrets', () => {
    const time = new Date('2026-11-15T10:00:00.000Z');
    expect(updaterLogLine(time, 'info', 'Checking for update')).toBe('2026-11-15T10:00:00.000Z INFO Checking for update\n');
    const file = 'a'.repeat(32) + '0123456789abcdef'.repeat(6);
    const line = updaterLogLine(time, 'warn', [
      `/${file}.zip requested by Squirrel.Mac`,
      'Authorization: Basic dXNlcjpwYXNzd29yZA==',
      'url: https://example.test/x?token=abcdef123&b=1',
      'Bearer abcdefghijklmnop',
      '404 Not Found',
      'Headers: {',
      '  "set-cookie": "session=secret"',
      '}',
    ].join('\n'));
    expect(line.startsWith('2026-11-15T10:00:00.000Z WARN ')).toBe(true);
    expect(line.endsWith('\n')).toBe(true);
    expect(line.slice(0, -1)).not.toMatch(/\n(?! {4})/);
    for (const secret of [file, 'dXNlcjpwYXNzd29yZA==', 'abcdef123', 'abcdefghijklmnop', 'session=secret']) expect(line).not.toContain(secret);
    expect(line).toContain('404 Not Found');
    expect(line).toContain('requested by Squirrel.Mac');
    const error = updaterLogLine(time, 'error', new Error('App Still Running Error'));
    expect(error).toContain('ERROR Error: App Still Running Error');
  });
});
