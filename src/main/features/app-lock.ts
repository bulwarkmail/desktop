/**
 * App lock's shell side: the gate (app-lock-gate.ts), the screen lock, "Lock now" in the
 * menu, window titles, and Windows Hello and Touch ID.
 *
 * Windows Hello is a second way to the lock key (app-lock-hello.ts): a key credential in the
 * user's Hello container signs a fixed challenge, and the page derives the key that wraps its
 * lock key from the signature. Nothing here holds the lock key for Hello. The page proves the
 * unlock to the gate with the key it opened, as after a PIN. The PIN stays either way.
 *
 * Touch ID answers yes or no, and that can't wrap a key. So on macOS the lock key sits in
 * safeStorage, and main reads it only after the yes. That stops someone at the keyboard who
 * doesn't know the PIN, not a program running as this user, and the settings page says so.
 * Windows used the same until Hello's key credential replaced it; a key left from then is
 * deleted at start. Linux has neither prompt, so it's PIN only there.
 *
 * `wrap` and `unwrap` put safeStorage around the page's PIN record and the store's keys, so
 * a copy of the disk can't be guessed at without this user's OS login. They go to the page
 * through `claim`, not to a frame.
 *
 * `pinStep` makes a guess cost a trip through here. The key under the PIN also takes a secret
 * that stays in main, and each trip is counted in the gate. So what a page could read out of
 * storage isn't enough to guess at elsewhere, only someone who can open this user's DPAPI can.
 */

import { createHmac } from 'node:crypto';
import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, powerMonitor, safeStorage, systemPreferences } from 'electron';
import { CHANNEL, type AppLockStatus, type OsUnlockAnswer, type OsUnlockKind, type PinStepAnswer } from '../../shared/bridge';
import { appLockGate, appLockSite as siteOf, isSiteFile } from '../app-lock-gate';
import { AppLockHello, HELLO_SALT_BYTES, helloKeyName, removeAllHelloKeys, removeHelloKeyOf, type HelloAnswer, type HelloKeys } from '../app-lock-hello';
import { fakeHelloKeys } from '../app-lock-hello-fake';
import { native } from '../native';
import { effectivePolicyValue } from '../../shared/policy-schema';
import { policies } from './policies';
import { randomSecret, SecretStore } from '../secrets';
import { strings } from '../strings';
import { replacingRenderer } from '../windows';
import { addWipeStep, finishWipeForPage, runLocalWipe, wipeForPage } from './local-wipe';
import type { Feature, FeatureContext } from '.';
import { showMessageBox } from '../message-box';

const OS_KEY_NAME = 'app-lock-key';
/** A PIN record or a database key. Nothing here wraps anything big. */
const MAX_WRAP_BYTES = 4096;
/** A lock's new renderer: how long its page gets to load, and how often it's tried. */
const REPLACE_LOAD_MS = 8_000;
const REPLACE_TRIES = 3;

/** The backend that only obfuscates would make this look safer than it is. */
async function wrapAvailable(): Promise<boolean> {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) return false;
  return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text';
}

// Set by build.mjs. Not app.isPackaged, which only looks at the exe's name.
declare const __BULWARK_TEST_BUILD__: boolean;

let testHelloKeys: HelloKeys | null = null;

/** Windows Hello's key credentials. Tests get made-up ones, so no real prompt comes up on anyone's desktop. */
function helloKeys(): HelloKeys {
  if (__BULWARK_TEST_BUILD__ && process.env.BULWARK_TEST_HELLO_KEY) {
    testHelloKeys ??= fakeHelloKeys(() => process.env.BULWARK_TEST_HELLO_KEY);
    return testHelloKeys;
  }
  return native().hello.key;
}

async function helloAvailableNow(): Promise<boolean> {
  if (__BULWARK_TEST_BUILD__ && process.env.BULWARK_TEST_HELLO_KEY) return true;
  return process.platform === 'win32' && native().hello.available();
}

/** The AppLockHelloAllowed policy. Off: no switch in settings, and an existing key credential goes. */
function helloAllowed(): boolean {
  return effectivePolicyValue(policies.snapshot.AppLockHelloAllowed, undefined) !== false;
}

// Whatever the mode: a wipe can run before or without the feature's setup. The folder holds the
// gate's record, the DPAPI-wrapped lock key, the pepper and the Hello marker of every origin, each
// named by its site. A server's wipe takes its own and its Hello key credential; the policy's
// wipe takes every origin's.
addWipeStep(async ({ origin }) => {
  const userData = app.getPath('userData');
  const folder = path.join(userData, 'app-lock');
  if (origin === null) {
    await removeAllHelloKeys(folder, helloKeys());
    rmSync(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    appLockGate.forget();
    return;
  }
  const site = siteOf(origin);
  await removeHelloKeyOf(folder, site, helloKeys());
  let names: string[] = [];
  try {
    names = readdirSync(folder);
  } catch {
    // No lock was ever set up here.
  }
  for (const name of names.filter((entry) => isSiteFile(entry, site))) rmSync(path.join(folder, name), { force: true });
  if (appLockGate.isFor(userData, origin)) appLockGate.forget();
  try {
    if (readdirSync(folder).length === 0) rmSync(folder, { recursive: true, force: true });
  } catch {
    // Gone already.
  }
});

type Verifier = (window: BrowserWindow | null, reason: string) => Promise<'yes' | 'no' | 'unavailable'>;

/** The yes-or-no unlock: Touch ID only. On Windows, Hello's key credential took its place. */
function osKindNow(): OsUnlockKind | null {
  // Tests name what the check does, so no real prompt comes up on anyone's desktop.
  if (__BULWARK_TEST_BUILD__ && process.env.BULWARK_TEST_OS_VERIFY) return 'touchid';
  if (process.platform === 'darwin') return systemPreferences.canPromptTouchID() ? 'touchid' : null;
  return null;
}

const verifyWithOs: Verifier = async (window, reason) => {
  if (__BULWARK_TEST_BUILD__ && process.env.BULWARK_TEST_OS_VERIFY) {
    return process.env.BULWARK_TEST_OS_VERIFY === 'yes' ? 'yes' : 'no';
  }
  if (process.platform === 'darwin') {
    try {
      await systemPreferences.promptTouchID(reason);
      return 'yes';
    } catch {
      return 'no';
    }
  }
  return 'unavailable';
};

function setup(ctx: FeatureContext): void {
  const { windows } = ctx;
  const site = siteOf(ctx.origin);
  const folder = path.join(app.getPath('userData'), 'app-lock');
  const secrets = new SecretStore(folder);
  const osKeyName = `${OS_KEY_NAME}-${site}`;
  const PEPPER_NAME = `app-lock-pepper-${site}`;
  appLockGate.initForProfile(app.getPath('userData'), ctx.origin);
  const hello = new AppLockHello({ keys: helloKeys(), name: helloKeyName(app.getPath('userData'), ctx.origin), site, folder, allowed: helloAllowed });
  // The yes-or-no Hello from before kept the lock key under DPAPI alone. Hello's key credential
  // replaces it, and the switch shows off until the user turns Hello on again.
  if (process.platform === 'win32' && !(__BULWARK_TEST_BUILD__ && process.env.BULWARK_TEST_OS_VERIFY)) {
    rmSync(path.join(folder, `${osKeyName}.bin`), { force: true });
  }
  void hello.enforcePolicy();
  policies.on('changed', () => void hello.enforcePolicy());
  /** Everything of the lock's that main keeps besides the gate: the OS's key and Hello's key credential. */
  const removeWaysIn = async () => {
    rmSync(path.join(folder, `${osKeyName}.bin`), { force: true });
    await hello.remove();
  };

  let prompting = false;
  const oneAtATime = async <T>(busy: T, run: () => Promise<T>): Promise<T> => {
    if (prompting) return busy;
    prompting = true;
    try {
      return await run();
    } finally {
      prompting = false;
    }
  };

  // Everything that can show on screen without a page.
  const blankTitles = () => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.setTitle(app.getName());
    }
  };

  windows.on('created', (managed) => {
    managed.window.webContents.on('page-title-updated', (event) => {
      if (!appLockGate.locked) return;
      event.preventDefault();
      managed.window.setTitle(app.getName());
    });
  });

  // Only with a lock, as in the tray: a greyed line with no way to make it work says nothing.
  // Locked, it's Unlock instead: the main window, where the lock screen asks for the PIN.
  ctx.menu.extend('file', () => (appLockGate.enrolled ? [appLockGate.locked ? {
    id: 'file.unlock',
    label: strings().menuUnlock,
    click: () => ctx.showMain(),
  } : {
    id: 'file.lockNow',
    label: strings().menuLockNow,
    click: () => appLockGate.requestLock(),
  }] : []));

  ctx.menu.setLocked(appLockGate.enrolled && appLockGate.locked);
  appLockGate.on('locked', (locked) => {
    if (locked) blankTitles();
    ctx.menu.setLocked(locked && appLockGate.enrolled);
    ctx.menu.rebuild();
  });

  appLockGate.on('enrolled', () => ctx.menu.rebuild());

  // Tells the pages, which save what's open and go to the lock screen.
  appLockGate.on('requested', () => windows.broadcast(CHANNEL.appLockRequest, null));

  // Unless the user chose "when I sign out or restart". A timeout the organisation sets wins over
  // that choice, as it does on the page.
  powerMonitor.on('lock-screen', () => {
    if (appLockGate.locksWithScreen || policies.snapshot.AppLockTimeoutMinutes.locked) appLockGate.requestLock();
  });
  // Toasts, the jump list and window titles outlive this run, or come up before the next page does.
  app.on('before-quit', () => {
    if (appLockGate.enrolled) appLockGate.lock();
  });

  ctx.handle(CHANNEL.appLockStatus, async (): Promise<AppLockStatus> => ({
    locked: appLockGate.locked,
    enrolled: appLockGate.enrolled,
    os: await osKindNow(),
    // Whether it's there, not whether it opens: nothing here decrypts before someone said yes.
    osEnrolled: secrets.has(osKeyName),
    wrap: await wrapAvailable(),
    ...(process.platform === 'win32' || (__BULWARK_TEST_BUILD__ && process.env.BULWARK_TEST_HELLO_KEY)
      ? { hello: { available: await helloAvailableNow(), allowed: helloAllowed(), enrolled: hello.enrolled } }
      : {}),
  }));
  ctx.on(CHANNEL.appLockLock, () => appLockGate.lock());
  // Only the page that claimed the controls, and only while unlocked: see the gate.
  ctx.handle(CHANNEL.appLockScreenLock, (_event, _window, on) => appLockGate.setLocksWithScreen(on));

  /** The first button is the yes. A no holds for this run, so nothing can keep asking. */
  const askOnce = (message: string, detail: string, yes: string, no: string, window: BrowserWindow | null) => {
    const options = { type: 'question' as const, message, detail, buttons: [yes, no], defaultId: 1, cancelId: 1, noLink: true };
    return (window ? showMessageBox(window, options) : showMessageBox(options)).then(({ response }) => response === 0);
  };

  let enrollDeclined = false;
  // A lock survives a restart and only its PIN opens it, so setting one up isn't for just any
  // call: a same-origin plugin frame gets here too. The page's own setup comes from a click, and
  // whatever took longer than a click lasts is the user's to allow.
  ctx.handle(CHANNEL.appLockEnroll, async (_event, window, proof, clicked) => {
    if (clicked !== true) {
      if (enrollDeclined || !(proof instanceof Uint8Array) || proof.length !== 32 || appLockGate.enrolled) return false;
      const text = strings();
      const allowed = await oneAtATime<boolean | null>(null, () => askOnce(text.appLockEnrollTitle, text.appLockEnrollDetail, text.appLockEnrollConfirm, text.appLockForgetCancel, window));
      if (allowed === false) enrollDeclined = true;
      if (!allowed) return false;
    }
    return appLockGate.enroll(proof);
  });

  let orphanAsked = false;
  // Main keeps a lock and the page has no PIN for it (the webmail's clearOrphanedDesktopLock).
  // Nothing can prove that lock, and no page's word can lift it, so the user decides, once a run.
  ctx.handle(CHANNEL.appLockClearOrphan, (_event, window) => oneAtATime(false, async () => {
    if (!appLockGate.enrolled) return true;
    if (orphanAsked) return false;
    orphanAsked = true;
    const text = strings();
    if (!(await askOnce(text.appLockOrphanTitle, text.appLockOrphanDetail, text.appLockOrphanConfirm, text.appLockOrphanCancel, window))) return false;
    appLockGate.forget();
    await removeWaysIn();
    return true;
  }));
  ctx.handle(CHANNEL.appLockProve, (_event, _window, proof) => appLockGate.prove(proof));
  ctx.handle(CHANNEL.appLockDisable, async (_event, _window, proof) => {
    if (!appLockGate.disable(proof)) return false;
    await removeWaysIn();
    return true;
  });

  ctx.handle(CHANNEL.appLockForget, async (_event, window, proof) => {
    if (!appLockGate.enrolled) return true;
    // Lifting a lock on a page's word alone would be no lock, and while unlocked a word followed
    // by `enroll` would replace it. So with no proof of the current lock it's the user's to say.
    if (appLockGate.locked || !appLockGate.matches(proof)) {
      const text = strings();
      const options = {
        type: 'warning' as const,
        message: text.appLockForgetTitle,
        detail: text.appLockForgetDetail,
        buttons: [text.appLockForgetConfirm, text.appLockForgetCancel],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      };
      const { response } = window ? await showMessageBox(window, options) : await showMessageBox(options);
      if (response !== 0) return false;
    }
    appLockGate.forget();
    await removeWaysIn();
    return true;
  });

  ctx.handle(CHANNEL.appLockOsEnroll, (_event, window, proof, key) => oneAtATime(false, async () => {
    if (appLockGate.locked || !appLockGate.matches(proof)) return false;
    if (!(key instanceof Uint8Array) || key.length !== 32) return false;
    // The backend that only obfuscates would make this worse than the PIN and call it safer.
    if (process.platform === 'linux') return false;
    if ((await verifyWithOs(window, strings().appLockOsEnrollReason)) !== 'yes') return false;
    await secrets.set(osKeyName, Buffer.from(key).toString('base64'));
    return true;
  }));
  ctx.handle(CHANNEL.appLockOsRemove, () => {
    // Only ever narrows.
    rmSync(path.join(folder, `${osKeyName}.bin`), { force: true });
  });

  const isSalt = (salt: unknown): salt is Uint8Array => salt instanceof Uint8Array && salt.length === HELLO_SALT_BYTES;
  const handleOf = (window: BrowserWindow | null) => (window && !window.isDestroyed() ? window.getNativeWindowHandle() : Buffer.alloc(8));

  // Turning Hello on, from settings: only with the proof of the lock as it stands, and unlocked.
  ctx.handle(CHANNEL.appLockHelloEnroll, (_event, window, proof, salt) => oneAtATime<HelloAnswer>({ ok: false, reason: 'busy' }, async () => {
    if (appLockGate.locked || !appLockGate.matches(proof) || !isSalt(salt)) return { ok: false, reason: 'failed' };
    if (!(await helloAvailableNow())) return { ok: false, reason: 'unavailable' };
    return hello.enroll(salt, handleOf(window));
  }));

  // The unlock, and the new wrap after a changed PIN. Unlocked it takes the proof, or a frame that
  // got this far could collect a way to the key while nobody is looking.
  ctx.handle(CHANNEL.appLockHelloSign, (_event, window, salt, proof) => oneAtATime<HelloAnswer>({ ok: false, reason: 'busy' }, async () => {
    if (!isSalt(salt)) return { ok: false, reason: 'failed' };
    if (!appLockGate.locked && !appLockGate.matches(proof)) return { ok: false, reason: 'not-locked' };
    return hello.sign(salt, handleOf(window));
  }));
  ctx.on(CHANNEL.appLockHelloCancel, () => hello.cancel());
  // Only ever narrows.
  ctx.handle(CHANNEL.appLockHelloRemove, () => hello.remove());

  // What a lock leaves in the renderer can't be overwritten, only ended with the process: a page
  // reloads into the same one. Only while locked, or a frame could use it to take a window down.
  // Windows replaced at the same moment can lose a load between them: one window's new page
  // lands in the process of another that is ended next, or never commits. The crash handling
  // leaves a window being replaced alone, so it would stay blank, with no lock screen to unlock
  // from. Until its page has loaded, a window here loads it again.
  ctx.on(CHANNEL.appLockReplaceRenderer, (_event, window) => {
    if (!window || window.isDestroyed() || !appLockGate.locked) return;
    const { webContents } = window;
    if (replacingRenderer.has(webContents)) return;
    replacingRenderer.add(webContents);
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      clearTimeout(timer);
      webContents.off('render-process-gone', reloadNow);
      webContents.off('did-finish-load', finish);
      replacingRenderer.delete(webContents);
    };
    function reloadNow() {
      clearTimeout(timer);
      if (webContents.isDestroyed()) return finish();
      if (tries === 0) webContents.on('did-finish-load', finish);
      tries += 1;
      webContents.reload();
      // Past the last try the window's own crash handling takes over.
      timer = setTimeout(() => (tries < REPLACE_TRIES ? reloadNow() : finish()), REPLACE_LOAD_MS);
    }
    webContents.on('render-process-gone', reloadNow);
    // Ended from outside rather than crashed: a crash would write its memory to a dump.
    process.kill(webContents.getOSProcessId());
  });

  // The webmail's remote wipe and its wipe from settings run in the page, and end here. The page has
  // asked its own questions by now: a remote wipe has nobody to ask, and settings have asked already.
  // It takes this server's things only: the page speaks for its own origin and no other.
  ctx.handle(CHANNEL.localWipeRun, async (event, _window, request) => {
    const { reason, account } = (request ?? {}) as { reason?: unknown; account?: unknown };
    if ((reason !== 'remote' && reason !== 'settings') || (account !== null && typeof account !== 'string')) return { failed: ['bad request'] };
    return { failed: await wipeForPage({ reason, account }, event.sender.session, ctx.origin, ctx.state) };
  });
  ctx.handle(CHANNEL.localWipeFinish, (event, _window, options) => finishWipeForPage(event.sender.session, (options as { keepLocalStorage?: unknown } | undefined)?.keepLocalStorage === true));

  // Only ever deletes. What the app's pages already fetched comes back from the local server.
  ctx.handle(CHANNEL.httpCacheClear, (event) => event.sender.session.clearCache());

  ctx.handle(CHANNEL.appLockPinStep, async (_event, _window, data): Promise<PinStepAnswer> => {
    if (!(data instanceof Uint8Array) || data.length !== 32 || !(await wrapAvailable())) return { ok: false };
    const blockedUntil = appLockGate.guess();
    if (blockedUntil > 0) return { ok: false, blockedUntil };
    try {
      // Unreadable throws, and the page says main couldn't. Gone with a lock on reads as a wrong PIN,
      // and the way out of that is the same as for a forgotten one.
      const pepper = await secrets.getOrCreate(PEPPER_NAME, () => randomSecret(32));
      return { ok: true, bytes: new Uint8Array(createHmac('sha256', pepper).update(data).digest()) };
    } catch {
      return { ok: false };
    }
  });

  ctx.handle(CHANNEL.appLockWrap, async (_event, _window, data) => {
    if (!(data instanceof Uint8Array) || data.length > MAX_WRAP_BYTES || !(await wrapAvailable())) return null;
    const sealed = await safeStorage.encryptStringAsync(`${site}:${Buffer.from(data).toString('base64')}`);
    return new Uint8Array(sealed);
  });
  ctx.handle(CHANNEL.appLockUnwrap, async (_event, _window, data) => {
    if (!(data instanceof Uint8Array) || data.length > MAX_WRAP_BYTES * 2 || !(await wrapAvailable())) return null;
    try {
      const { result } = await safeStorage.decryptStringAsync(Buffer.from(data));
      return result.startsWith(`${site}:`) ? new Uint8Array(Buffer.from(result.slice(site.length + 1), 'base64')) : null;
    } catch {
      return null;
    }
  });

  ctx.handle(CHANNEL.appLockOsUnlock, (_event, window) => oneAtATime<OsUnlockAnswer>({ ok: false, reason: 'failed' }, async () => {
    // Asking while unlocked would pop prompts and collect the key.
    if (!appLockGate.locked) return { ok: false, reason: 'not-locked' };
    if (!secrets.has(osKeyName)) return { ok: false, reason: 'unavailable' };
    const answer = await verifyWithOs(window, strings().appLockOsUnlockReason);
    if (answer === 'unavailable') return { ok: false, reason: 'unavailable' };
    if (answer !== 'yes') return { ok: false, reason: 'denied' };
    try {
      const stored = await secrets.get(osKeyName);
      if (!stored) return { ok: false, reason: 'unavailable' };
      appLockGate.liftAfterOsCheck();
      return { ok: true, key: new Uint8Array(Buffer.from(stored, 'base64')) };
    } catch {
      return { ok: false, reason: 'failed' };
    }
  }));

  // The checks in test/ read and fire these. An installed app has none of it.
  if (__BULWARK_TEST_BUILD__) {
    (globalThis as unknown as { __bulwarkAppLock: unknown }).__bulwarkAppLock = {
      gate: appLockGate,
      helloKeys: () => (testHelloKeys as (HelloKeys & { names?: () => string[] }) | null)?.names?.() ?? [],
      lockScreen: () => powerMonitor.emit('lock-screen'),
      wipe: () => runLocalWipe('remote', app.getPath('userData'), ctx.state),
      addWipeStep,
    };
  }
}

export const appLockFeature: Feature = { name: 'app-lock', modes: ['standalone', 'instance'], setup };
