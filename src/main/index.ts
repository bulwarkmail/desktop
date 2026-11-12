/**
 * Bulwark's main process.
 *
 * ESM, with top-level await, because of one thing: the random port has to be
 * known before Chromium's network service starts, so it can go in
 * --host-resolver-rules, and Electron holds `ready` until this module finishes
 * loading. So: never await `app.whenReady()` at the top level here. It deadlocks.
 */

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, screen, session as electronSession, shell } from 'electron';
import { APP_HOST, APP_ORIGIN, type InitMessage } from '../server/protocol';
import { CHANNEL, type Mode } from '../shared/bridge';
import { jmapServerAllowed, parseInstanceUrl } from '../shared/policy-schema';
import { firstPageUrl, parseWelcomeAddress, parseWelcomeEmail, welcomeLinkUrl } from '../shared/welcome-address';
import { APP_PARTITION, instancePartition, keepSignInsOnDisk, setupAppSession } from './app-session';
import { certificateFitsKey, fingerprintOf, generateCertificate } from './cert';
import { CorsInjector } from './cors';
import { setupFeatures, type FeatureContext } from './features';
import { registerImportScheme } from './features/import';
import { holdEarlyLaunches } from './features/os-launch';
import { appUserModelId, electronRegistersScheme } from './features/os-rules';
import { takeResumeUrl } from './resume-rules';
import { setToastActivator } from './features/os-toasts';
import { holdUpdateInstall } from './features/updater';
import { addRestartTimers, askToRestart, policies } from './features/policies';
import { devToolsForcedOff } from './features/dev-tools';
import { privacy } from './features/privacy';
import { clientAuth } from './features/client-certificates';
import { createChannels, registerBridge } from './ipc';
import { durableWrite, holdsAppLockRecords, KEY_CHECK_FOLDER, KEY_CHECK_SWITCH, KEY_INIT_SWITCH, keyInitArgs, keyOnDisk, keyOpens, KEYS_FOLDER, savedKey, saveKey, settleKeyBeforeChromium, waitForKeyOnDisk } from './key-on-disk';
import { addWipeStep, notePartition, removeWipedPartitions, restartAfterWipe, wipeForConnectionChange } from './features/local-wipe';
import { native } from './native';
import { LocalAdmin } from './local-admin';
import { requestGate } from './request-gate';
import { MenuController } from './menu';
import { attachWindowGuards, type GuardOptions } from './navigation';
import { applyPermissionPolicy } from './permissions';
import { sandboxRefused } from './sandbox-check';
import { connectionMustChange, decideStart, restartKey, type StartDecision } from './policy-start';
import { policyProblems } from '../shared/policy-schema';
import { deniedEnvironment, deniedSwitches, withoutDeniedSwitches } from './switch-guard';
import { pluginFeatures, profilePaths, seedProfile, serverEnv } from './profile';
import { randomSecret, SecretStore, SecretStoreError } from './secrets';
import { startServerProcess, ServerStartError, type ServerProcess } from './server-process';
import { ServerRegistry } from './servers';
import { StateFile } from './state';
import { strings, uiLanguageNow, unsentDetail } from './strings';
import { checkInstance } from './instance-check';
import { useWelcomeMenu } from './welcome-menu';
import { changeConnectionUrl, loadErrorPage, noteLoadErrorPage, retryTarget, showsLoadError } from './load-error';
import { leaveLaunchFolder } from './launch-folder';
import { ThemeController } from './theme';
import { WindowManager } from './windows';
import { showMainStep } from './window-logic';
import { ZoomController } from './zoom';
import { printWindow, saveWindowAsPdf } from './print';
import { printFromMenu } from './features/print';
import { navigateHistory } from './features/window-input';
import { appPathOfDeepLink, deepLinkWindowKey, LinkRateLimit, DEEP_LINK_SCHEME, type WindowLink } from './deep-link';
import { closeDictionaryDownloads } from './spellcheck';
import { isInstalledBuild, osRegistrationAllowed } from './installed';
import { registryRoot, sendToFolder } from './features/os-default-app';
import { asksForUninstallCleanup, uninstallCleanup } from './uninstall-cleanup';
import { showMessageBox, useMessageBoxLook } from './message-box';

// Set by build.mjs. Not app.isPackaged: Electron decides that by the exe's name, and
// anyone can rename it. See installed.ts.
declare const __BULWARK_TEST_BUILD__: boolean;
declare const __BULWARK_TEST_PROFILE__: string;

// Before anything else, with or without a policy: see switch-guard.ts.
if (!__BULWARK_TEST_BUILD__) {
  const denied = deniedSwitches(process.argv);
  // An AppImage's AppRun adds --no-sandbox where the sandbox can't work. Restarting without it
  // would die in Chromium before any window. Left alone, the app says why and exits.
  const refusing = sandboxRefused({ platform: process.platform, appImage: process.env.APPIMAGE, noSandboxSwitch: process.argv.includes('--no-sandbox'), disableSandboxEnv: process.env.ELECTRON_DISABLE_SANDBOX });
  const deniedEnv = deniedEnvironment(process.env);
  if ((denied.length > 0 || deniedEnv.length > 0) && !refusing) {
    console.warn(`Ignoring these switches and environment variables: ${[...denied, ...deniedEnv].join(', ')}`);
    for (const name of denied) app.commandLine.removeSwitch(name);
    for (const name of deniedEnv) delete process.env[name];
    app.relaunch({ args: withoutDeniedSwitches(process.argv).slice(1) });
    app.exit(0);
    await new Promise(() => {});
  }
}

// The MSI's uninstall runs this as the user, before it removes the files (uninstall-cleanup.ts).
// Nothing else of the app starts. A test build only cleans a stand-in key and folders of its own.
if (asksForUninstallCleanup(process.argv)) {
  const root = registryRoot();
  const allowed = process.platform === 'win32' && (!__BULWARK_TEST_BUILD__ || root !== 'HKCU');
  if (allowed) {
    const local = __BULWARK_TEST_BUILD__ ? argValue('bulwark-test-local-dir') ?? null : process.env.LOCALAPPDATA ?? null;
    await uninstallCleanup({ root, exe: process.execPath, sendTo: sendToFolder(), local }, native().system.registry).catch(() => undefined);
  }
  app.exit(allowed || process.platform !== 'win32' ? 0 : 1);
  await new Promise(() => {});
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD = path.join(HERE, 'preload.cjs');
const WELCOME_PRELOAD = path.join(HERE, 'welcome-preload.cjs');
const WELCOME_PAGE = path.join(HERE, 'pages', 'welcome.html');
const SERVER_HOST = path.join(HERE, 'server-host.cjs');
/** In memory: the first run's check of an address leaves nothing on disk. Same proxy and certificate checks as a window. */
const INSTANCE_CHECK_PARTITION = 'bulwark-instance-check';

const DEV = __BULWARK_TEST_BUILD__ && !app.isPackaged;
const MAX_SERVER_RESTARTS = 3;
const devTools = __BULWARK_TEST_BUILD__ && DEV && process.argv.includes('--dev');

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

// A test or a second development copy points this elsewhere.
const userDataArg = __BULWARK_TEST_BUILD__ && DEV ? argValue('bulwark-user-data') : undefined;
if (userDataArg) app.setPath('userData', userDataArg);
if (__BULWARK_TEST_PROFILE__) app.setPath('userData', __BULWARK_TEST_PROFILE__);

// Before anything can run a program: see launch-folder.ts.
leaveLaunchFolder(app.getPath('userData'));

app.setName('Bulwark');
const ABOUT_COPYRIGHT = 'AGPL-3.0-only';
app.setAboutPanelOptions({ applicationName: 'Bulwark', applicationVersion: app.getVersion(), copyright: ABOUT_COPYRIGHT, website: 'https://bulwarkmail.org' });
if (process.platform === 'win32') {
  // A test build, a package with its profile baked in for the tests, and a folder no installer
  // put there keep off the user's jump list, taskbar group and notifications.
  app.setAppUserModelId(appUserModelId(!osRegistrationAllowed()));
  setToastActivator();
}

/** A free port on 127.0.0.1, asked of the OS: Windows' excluded ranges made random picks hang. */
function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

const keyInitOnly = process.argv.includes(KEY_INIT_SWITCH) || process.argv.includes(KEY_CHECK_SWITCH);
if (process.argv.includes(KEY_CHECK_SWITCH)) app.setPath('userData', path.join(app.getPath('userData'), KEY_CHECK_FOLDER));
const gotLock = !keyInitOnly && app.requestSingleInstanceLock();
// A clean quit is the one thing that makes Chromium write Local State at once.
if (keyInitOnly) void app.whenReady().then(() => app.quit());
else if (!gotLock) app.exit(0);

// Before `ready`: Chromium takes the auth lists from its command line at start.
if (gotLock) {
  if (process.platform === 'darwin') policies.useForcedCheck(native().policy.isForced);
  await policies.start({ argv: process.argv, isPackaged: app.isPackaged });
  policies.applySwitches(app.commandLine);
}

const stateFile = new StateFile(path.join(app.getPath('userData'), 'shell-state.json'));
// Before any session can open one of them: what the last wipe left of its partitions.
if (gotLock) removeWipedPartitions(app.getPath('userData'), stateFile);
policies.attachState(stateFile);
if (gotLock) privacy.start(stateFile);
if (gotLock) clientAuth.start(stateFile);

/** A production build has refused the switches that move the profile by now. */
function runKeyInit(run: string): void {
  spawnSync(process.execPath, keyInitArgs(process.argv, isInstalledBuild(), path.join(HERE, 'main.mjs'), run, __BULWARK_TEST_BUILD__ ? '--bulwark-user-data=' : undefined), { stdio: 'ignore', windowsHide: true, timeout: 20_000 });
}

// Holding the lock, so no other run of the app is making a key for this profile.
if (gotLock && process.platform === 'win32') {
  const userData = app.getPath('userData');
  settleKeyBeforeChromium(userData, {
    // A development switch for the test of what happens if that run gets nothing onto the disk.
    runKeyInit: () => {
      if (!(__BULWARK_TEST_BUILD__ && DEV && process.argv.includes('--bulwark-test-no-key-init'))) runKeyInit(KEY_INIT_SWITCH);
    },
    keyOpens: (key) => keyOpens(userData, key, () => runKeyInit(KEY_CHECK_SWITCH)),
    firstSecretsMayFollow: startDecision().kind !== 'instance',
  });
}

// After those runs, so another program has as little time as possible to take the port.
registerImportScheme();
const SERVER_PORT = await reservePort();
app.commandLine.appendSwitch('host-resolver-rules', `MAP ${APP_HOST}:443 127.0.0.1:${SERVER_PORT}`);

let windowManager: WindowManager | null = null;
let appStartUrl = '';
let mainWindowAllowed = false;
let menu: MenuController | null = null;
const zoom = new ZoomController(stateFile);
/** A bulwark:// link from before anyone was signed in: a pop-out borrows the main window's session. */
let pendingDeepLink: WindowLink | null = null;
/** The page this run is on and its partition: what "Change connection…" offers to remove. */
let runningOn: { mode: Mode; origin: string; session: Electron.Session } | null = null;
let sessionReady = false;
const linkLimit = new LinkRateLimit();

function serverDirectory(): string {
  if (isInstalledBuild()) return path.join(process.resourcesPath, 'server.asar');
  const chosen = __BULWARK_TEST_BUILD__ && DEV ? argValue('bulwark-server-dir') : undefined;
  return chosen ?? path.join(HERE, '..', 'webmail');
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function errorPageUrl(title: string, body: string): string {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Bulwark</title><style>body{font:15px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;height:100vh}main{max-width:32em;padding:2em}h1{font-size:1.3em;font-weight:600}@media(prefers-color-scheme:dark){body{background:#17181b;color:#f4f4f5}}</style></head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></main></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/** Says what's wrong, in the window, and changes nothing. */
async function showErrorPage(title: string, body: string): Promise<void> {
  const window = new BrowserWindow({
    width: 640,
    height: 420,
    autoHideMenuBar: true,
    title: 'Bulwark',
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  await window.loadURL(errorPageUrl(title, body));
}

let pinFailed = false;

/**
 * The pin failed: something between the app and its own server on this machine
 * replaced the certificate, usually a security program inspecting TLS. Chromium's
 * error page would explain nothing.
 */
function watchForReplacedCertificate(window: BrowserWindow): void {
  window.webContents.on('did-fail-load', (_event, _code, _description, url, isMainFrame) => {
    if (!pinFailed || !isMainFrame || !url.startsWith(APP_ORIGIN)) return;
    const text = strings();
    void window.loadURL(errorPageUrl(text.errorCertificateTitle, text.errorCertificateBody));
  });
}

/**
 * An organisation's server that doesn't load leaves a window with nothing in it, and no way out
 * but a menu item nothing points to. So the window says so, with a button to try again and one
 * to change the connection (load-error.ts).
 */
function watchForFailedLoads(window: BrowserWindow, origin: string, startUrl: string): void {
  const contents = window.webContents;
  let page: string | null = null;
  let changeUrl: string | null = null;
  contents.on('did-fail-load', (_event, code, _description, url, isMainFrame) => {
    if (!showsLoadError(code, isMainFrame) || window.isDestroyed()) return;
    if (page && url === page) return;
    changeUrl = bootedDecision?.canSwitch ? changeConnectionUrl(origin, randomBytes(16).toString('base64url')) : null;
    page = loadErrorPage(uiLanguageNow(), new URL(origin).host, retryTarget(url, origin, startUrl), changeUrl);
    noteLoadErrorPage(contents, page);
    void window.loadURL(page).catch(() => {});
  });
  contents.on('did-navigate', (_event, url) => {
    if (!page || url === page) return;
    page = null;
    changeUrl = null;
    noteLoadErrorPage(contents, null);
  });
  // "Try again" is a plain link to the server. "Change connection…" stops here.
  contents.on('will-navigate', (event) => {
    if (!changeUrl || event.url !== changeUrl || !page || contents.getURL() !== page) return;
    event.preventDefault();
    switchMode();
  });
}

function createWindowManager(mode: Mode, origin: string, session: Electron.Session, theme: ThemeController, startUrl: string): WindowManager {
  const guard: GuardOptions = { mode, origin, windows: () => windowManager!, forced: () => policies.snapshot.InstanceUrl.locked };
  windowManager = new WindowManager({
    state: stateFile,
    theme,
    session,
    origin,
    mode,
    preloadPath: PRELOAD,
    // Opening them is up to features/dev-tools.ts; only the policy keeps them out of a window altogether.
    devTools: () => devTools || !devToolsForcedOff(),
    spare: !(__BULWARK_TEST_BUILD__ && DEV && process.argv.includes('--bulwark-no-spare')),
    spareIdleMs: __BULWARK_TEST_BUILD__ && DEV && argValue('bulwark-test-spare-idle') ? Number(argValue('bulwark-test-spare-idle')) : undefined,
    attachGuards: (window) => attachWindowGuards(window, guard),
  });
  zoom.attach(windowManager);
  menu!.attach(windowManager);
  // Windows to bring back can't be told apart by account, and bringing them back costs little. By
  // server they can: a server's wipe takes its own pages.
  addWipeStep(async ({ origin, account }) => windowManager?.forgetSession(account === null ? origin : null), { perAccount: true });
  windowManager.on('sessionReady', onSessionReady);
  // A development switch for the test of the tray's hook, until the tray exists.
  if (__BULWARK_TEST_BUILD__ && DEV && process.argv.includes('--bulwark-test-close-to-background')) windowManager.setCloseToBackground(() => true);
  appStartUrl = startUrl;
  windowManager.on('stayed', () => {
    switching = false;
    quitFlushed = false;
    windowManager?.cancelQuit();
  });
  return windowManager;
}

/** The TLS pair of this install. A lost one only means a new one: the pin is set anew each launch. */
async function tlsMaterial(secrets: SecretStore, dir: string): Promise<{ keyPem: string; certPem: string; fingerprint: string }> {
  const certFile = path.join(dir, 'app-cert.pem');
  let keyPem: string | null = null;
  try {
    keyPem = await secrets.get('tls-key');
  } catch (error) {
    if (error instanceof SecretStoreError && error.code === 'unavailable') throw error;
  }
  if (keyPem && existsSync(certFile)) {
    const certPem = readFileSync(certFile, 'utf8');
    if (certificateFitsKey(certPem, keyPem)) return { keyPem, certPem, fingerprint: fingerprintOf(certPem) };
  }
  const fresh = generateCertificate(APP_HOST);
  await secrets.set('tls-key', fresh.keyPem);
  durableWrite(certFile, fresh.certPem);
  return fresh;
}

/**
 * In instance mode a replaced key costs no error page: the page just asks for a sign-in, with
 * nothing to say why. So it's said here, once for each key lost. A standalone profile shows the
 * error page instead, since its secrets went too.
 */
function tellSignInsLost(lostKey: string): void {
  const told = createHash('sha256').update(lostKey).digest('base64url');
  if (stateFile.data.keyLossTold === told) return;
  stateFile.data.keyLossTold = told;
  stateFile.save();
  const text = strings();
  void showMessageBox({ type: 'info', title: 'Bulwark', message: text.signInsLostTitle, detail: text.signInsLostDetail }).catch(() => {});
}

/**
 * Nothing that encrypts runs before this: not the secrets, the server, the pages or their
 * cookies. The saved copy of the key goes before the first secret, and isn't changed while
 * secrets can't be read, as then it's the only copy that opens them.
 *
 * Instance mode has no secrets to protect, so it always goes on. All it risks is a sign-in.
 */
async function keySafeOnDisk(instance: boolean): Promise<boolean> {
  if (process.platform !== 'win32') return true;
  const userData = app.getPath('userData');
  const saveIfReadable = async () => {
    // What the app lock holds can't be tried from here, so the copy that may open it stays.
    if (savedKey(userData) && holdsAppLockRecords(userData)) return;
    if (await new SecretStore(path.join(userData, KEYS_FOLDER)).allReadable()) saveKey(userData);
  };
  try {
    if (!(await waitForKeyOnDisk(userData))) return instance;
    const onDisk = keyOnDisk(userData);
    const saved = savedKey(userData);
    if (instance && saved && saved !== onDisk) tellSignInsLost(saved);
    if (saved === onDisk && stateFile.data.keyLossTold) {
      stateFile.data.keyLossTold = undefined;
      stateFile.save();
    }
    if (instance) {
      // Chromium's new key reaches the disk within its ten seconds, if this start was given one.
      const deadline = Date.now() + 30_000;
      const watch = setInterval(() => {
        const now = keyOnDisk(userData);
        if (now && onDisk && now !== onDisk) {
          tellSignInsLost(onDisk);
          void saveIfReadable().catch((error) => console.error(error));
        }
        if ((now && now !== onDisk) || Date.now() >= deadline) clearInterval(watch);
      }, 1000);
      watch.unref();
    }
    if (saved !== onDisk) await saveIfReadable();
    return true;
  } catch (error) {
    console.error(error);
    return instance;
  }
}

/**
 * The server spawned before the secrets are read, until it has its init message. A start
 * that never gets that far (secrets refused, a throw on the way) stops it, or it would stay
 * up with Next loaded and nothing to serve.
 */
let serverAwaitingInit: ServerProcess | null = null;

async function bootStandalone(theme: ThemeController): Promise<void> {
  try {
    await bootStandaloneServer(theme);
  } finally {
    serverAwaitingInit?.stop();
    serverAwaitingInit = null;
  }
}

async function bootStandaloneServer(theme: ThemeController): Promise<void> {
  const userData = app.getPath('userData');
  const secretsDir = path.join(userData, KEYS_FOLDER);
  mkdirSync(secretsDir, { recursive: true });
  const secrets = new SecretStore(secretsDir);
  const profile = profilePaths(userData);

  // The server's process starts now and loads Next's code while the secrets are read. They,
  // and everything else it needs, go to it by message once they're here.
  const serverOptions = (append: boolean, init: InitMessage | Promise<InitMessage>) => ({
    hostScript: SERVER_HOST,
    serverDir: serverDirectory(),
    env: {
      ...serverEnv(profile, process.env, process.platform),
      // Only a test build: the local stand-in for the collector needs it.
      ...(__BULWARK_TEST_BUILD__ && process.env.BULWARK_TELEMETRY_ALLOW_PRIVATE === '1' ? { BULWARK_TELEMETRY_ALLOW_PRIVATE: '1' } : {}),
    },
    logDir: path.join(userData, 'logs'),
    append,
    init,
  });
  let giveFirstInit: (init: InitMessage) => void = () => {};
  const firstServer = startServerProcess(serverOptions(false, new Promise<InitMessage>((resolve) => (giveFirstInit = resolve))));
  serverAwaitingInit = firstServer;

  let sessionSecret: string;
  let adminPassword: string;
  let tlsPair: Awaited<ReturnType<typeof tlsMaterial>>;
  try {
    // getOrCreate never replaces one it can't read: that would wipe every account.
    // The first run makes the secret before it seeds the profile, so a seeded profile
    // without one lost it. A new one would sign out every account just the same.
    const seeded = existsSync(path.join(profile.adminConfig, 'config.json'));
    sessionSecret = await secrets.getOrCreate('session-secret', () => randomSecret(48), { mustExist: seeded });
    // A new credential only takes if the stored hash goes with the old one.
    const admin = await secrets.getOrReplace('admin-credential', () => randomSecret(32), () => rmSync(path.join(profile.adminConfig, 'admin.json'), { force: true }));
    adminPassword = admin.value;
    tlsPair = await tlsMaterial(secrets, secretsDir);
  } catch (error) {
    serverAwaitingInit = null;
    firstServer.stop();
    if (error instanceof SecretStoreError) {
      const text = strings();
      if (error.code === 'missing') await showErrorPage(text.errorSecretMissingTitle, text.errorSecretMissingBody(secretsDir));
      else await showErrorPage(text.errorSecretsTitle, text.errorSecretsBody);
      return;
    }
    throw error;
  }

  seedProfile(profile, pluginFeatures(policies.snapshot.PluginsMode.value));

  const launchSecret = randomBytes(32).toString('base64url');
  const mainSecret = randomBytes(32).toString('base64url');
  // A development switch for the test of a replaced certificate.
  const pin = __BULWARK_TEST_BUILD__ && DEV && process.argv.includes('--bulwark-test-wrong-pin') ? 'sha256/wrong' : tlsPair.fingerprint;
  const session = setupAppSession(pin, launchSecret, () => {
    pinFailed = true;
  });
  keepSignInsOnDisk(session);
  notePartition(stateFile, APP_PARTITION);
  runningOn = { mode: 'standalone', origin: APP_ORIGIN, session };
  applyPermissionPolicy(session, APP_ORIGIN);

  const cors = new CorsInjector(session, APP_ORIGIN);
  const initMessage = (): InitMessage => ({
    type: 'init',
    serverDir: serverDirectory(),
    port: SERVER_PORT,
    parentPid: process.pid,
    launchSecret,
    mainSecret,
    tls: { key: tlsPair.keyPem, cert: tlsPair.certPem },
    secrets: { sessionSecret, adminPassword },
    trustedOrigins: stateFile.data.approvedServers.map((s) => s.origin).filter((origin) => policies.serverAllowed(origin)),
    policy: policies.serverPolicy(),
    privacy: privacy.serverView('standalone'),
  });
  // A restart after a crash gets what holds then.
  const spawnServer = (append: boolean) => startServerProcess(serverOptions(append, initMessage()));
  giveFirstInit(initMessage());
  serverAwaitingInit = null;
  let server = firstServer;
  const servers = new ServerRegistry({ state: stateFile, cors, sendTrusted: (origins) => server.sendTrusted(origins), isAllowedByPolicy: policies.serverAllowed });
  requestGate(session).add((url) => servers.refusesRequest(url));
  // config-manager notices the changed file by itself, within seconds.
  policies.on('changed', (snapshot) => {
    server.sendPolicy(policies.serverPolicy());
    servers.applyPolicy();
    seedProfile(profile, pluginFeatures(snapshot.PluginsMode.value));
  });
  privacy.on('changed', () => server.sendPrivacy(privacy.serverView('standalone')));
  const localAdmin = new LocalAdmin({ port: SERVER_PORT, certPem: tlsPair.certPem, launchSecret, mainSecret, password: adminPassword });

  const windows = createWindowManager('standalone', APP_ORIGIN, session, theme, `${APP_ORIGIN}/`);
  const ctx: FeatureContext = {
    mode: 'standalone',
    origin: APP_ORIGIN,
    session,
    state: stateFile,
    theme,
    windows,
    menu: menu!,
    zoom,
    servers,
    localAdmin,
    showMain,
    openLink: openDeepLink,
    ...createChannels(APP_ORIGIN),
  };
  registerBridge(ctx, { origin: APP_ORIGIN, pluginPolicy: policies.pluginPolicy });
  setupFeatures(ctx);

  // The window opens once the port listens: it starts its renderer and sends its first request
  // while Next is still loading, and the host holds that request until Next can answer it.
  try {
    await server.listening;
  } catch (error) {
    // Only a port someone took between the probe and now can be fixed by trying again.
    if (error instanceof ServerStartError && error.code === 'EADDRINUSE' && !process.argv.includes('--port-retry')) {
      app.relaunch({ args: [...process.argv.slice(1), '--port-retry'] });
      app.exit(0);
      return;
    }
    console.error(error);
    const text = strings();
    await showErrorPage(text.errorServerTitle, text.errorServerBody);
    return;
  }

  windows.on('created', ({ window }) => watchForReplacedCertificate(window));
  mainWindowAllowed = true;
  // Once: the first screen's address fills the sign-in page, and only on this start.
  const email = welcomeEmail;
  welcomeEmail = null;
  // After a restart with "Open again after a restart" on: the page it was on (features/os-restart.ts).
  windows.open({ type: 'main', url: takeResumeUrl(stateFile, 'standalone', APP_ORIGIN, Date.now()) ?? firstPageUrl(APP_ORIGIN, email) });

  try {
    const ready = await server.ready;
    if (ready.caError) console.warn('System certificates are not in use:', ready.caError);
  } catch (error) {
    console.error(error);
    // As before the window opened early: the error page, and no window waiting on a server
    // that isn't coming. The error page first, so the app doesn't quit with its last window.
    const text = strings();
    const shown = showErrorPage(text.errorServerTitle, text.errorServerBody);
    mainWindowAllowed = false;
    for (const managed of windows.all()) if (!managed.window.isDestroyed()) managed.window.destroy();
    await shown;
    return;
  }

  privacy.useServerSink((error) => server.sendMainError(error));

  // A crash shouldn't end the app: same port, same secret, so open windows carry on.
  let restarts = 0;
  const watch = () => {
    const current = server;
    current.process.once('exit', () => {
      if (current.stopped() || restarts >= MAX_SERVER_RESTARTS) return;
      restarts += 1;
      server = spawnServer(true);
      watch();
      server.ready.catch((error) => console.error(error));
    });
  };
  watch();
}

async function bootInstance(instanceUrl: string, theme: ThemeController): Promise<void> {
  const origin = new URL(instanceUrl).origin;
  const partition = instancePartition(origin);
  const session = electronSession.fromPartition(partition);
  keepSignInsOnDisk(session);
  notePartition(stateFile, partition);
  runningOn = { mode: 'instance', origin, session };
  closeDictionaryDownloads(session);
  applyPermissionPolicy(session, origin);
  const windows = createWindowManager('instance', origin, session, theme, instanceUrl);
  const ctx: FeatureContext = { mode: 'instance', origin, session, state: stateFile, theme, windows, menu: menu!, zoom, showMain, openLink: openDeepLink, ...createChannels(origin) };
  registerBridge(ctx, { origin });
  setupFeatures(ctx);
  windows.on('created', ({ window }) => watchForFailedLoads(window, origin, instanceUrl));
  mainWindowAllowed = true;
  windows.open({ type: 'main', url: takeResumeUrl(stateFile, 'instance', origin, Date.now()) ?? instanceUrl });
}

/** The first-run window's width; its height follows the page's card. */
const WELCOME_WIDTH = 520;

/** The address typed on the first screen, for the sign-in page. Kept in memory only. */
let welcomeEmail: string | null = null;

/** The first run asks which of the two the user wants. A forced InstanceUrl skips this. */
function showWelcome(theme: ThemeController, decision: Extract<StartDecision, { kind: 'welcome' }>): void {
  const colours = theme.colours();
  const questions = privacy.firstRunQuestions();
  const window = new BrowserWindow({
    width: WELCOME_WIDTH,
    // Until the page says how tall its card is (welcomeFit).
    height: 560,
    useContentSize: true,
    resizable: false,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: colours.background,
    title: 'Bulwark',
    webPreferences: {
      preload: WELCOME_PRELOAD,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools,
      // Encoded: quotes don't survive Chromium's command line on Windows.
      // dark: as the app was last; null follows the system (nothing from the app yet).
      additionalArguments: [`--bulwark-welcome=${encodeURIComponent(JSON.stringify({ allowStandalone: decision.allowStandalone, instanceUrl: decision.instanceUrl, urlLocked: decision.urlLocked, askTelemetry: questions.telemetry, askCrashReports: questions.crashReports, dark: stateFile.data.theme ? colours.dark : null }))}`],
    },
  });
  // Shown once it has its height, so it doesn't jump. A page that never says shows anyway.
  let shown = false;
  const showOnce = () => {
    if (shown || window.isDestroyed()) return;
    shown = true;
    window.show();
  };
  window.once('ready-to-show', () => setTimeout(showOnce, 1000));
  // "Bulwark" on every step: the page's headings name the steps.
  window.on('page-title-updated', (event) => event.preventDefault());
  ipcMain.removeAllListeners(CHANNEL.welcomeFit);
  ipcMain.on(CHANNEL.welcomeFit, (event, height: unknown) => {
    if (event.sender !== window.webContents || !event.senderFrame?.url.startsWith('data:')) return;
    if (typeof height !== 'number' || !Number.isFinite(height)) return;
    const area = screen.getDisplayMatching(window.getBounds()).workArea;
    const fitted = Math.round(Math.min(Math.max(height, 320), area.height - 60));
    const [, current] = window.getContentSize();
    if (fitted !== current) window.setContentSize(WELCOME_WIDTH, fitted);
    if (!shown) {
      window.center();
      showOnce();
    }
  });
  window.once('closed', () => ipcMain.removeAllListeners(CHANNEL.welcomeFit));
  useWelcomeMenu(window, () => menu?.rebuild());
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // "Learn more": only a page main has by name goes to the browser.
  ipcMain.removeAllListeners(CHANNEL.welcomeOpenLink);
  ipcMain.on(CHANNEL.welcomeOpenLink, (event, name: unknown) => {
    if (event.sender !== window.webContents || !event.senderFrame?.url.startsWith('data:')) return;
    const url = welcomeLinkUrl(name);
    if (url) void shell.openExternal(url).catch(() => {});
  });
  window.once('closed', () => ipcMain.removeAllListeners(CHANNEL.welcomeOpenLink));

  let latestChoice = 0;
  ipcMain.handle(CHANNEL.welcomeChoose, async (event, choice: { mode?: unknown; url?: unknown; email?: unknown }) => {
    if (event.sender !== window.webContents || !event.senderFrame?.url.startsWith('data:')) throw new Error('Not allowed');
    const thisChoice = ++latestChoice;
    let instanceUrl: string | undefined;
    if (choice?.mode === 'standalone') {
      if (!decision.allowStandalone) return { ok: false, error: 'invalid_choice' };
      const email = parseWelcomeEmail(choice.email);
      if (!email.ok) return { ok: false, error: email.error };
      welcomeEmail = email.email;
    } else if (choice?.mode === 'instance') {
      const allowInsecure = policies.snapshot.AllowInsecureInstance.value;
      // A locked address is the admin's, already full. A typed one may be a bare host.
      const parsed = decision.urlLocked ? parseInstanceUrl(decision.instanceUrl, allowInsecure) : parseWelcomeAddress(choice.url, allowInsecure);
      if (!parsed.ok) return { ok: false, error: 'error' in parsed ? parsed.error : 'invalid_url' };
      // A forced one needs no listing, and only a forced one is locked here.
      if (!decision.urlLocked && !jmapServerAllowed(policies.snapshot.AllowedJmapServers.value, parsed.value)) return { ok: false, error: 'policy' };
      // A typed address has to be a Bulwark that answers: a typo would open an empty window.
      // The admin's locked one isn't the user's to fix, and gets the window's error page instead.
      if (!decision.urlLocked) {
        const check = await checkInstance(parsed.value, (url, init) => electronSession.fromPartition(INSTANCE_CHECK_PARTITION).fetch(url, { ...init, cache: 'no-store' }));
        if (thisChoice !== latestChoice) return { ok: false, error: 'superseded' };
        if (!check.ok) return { ok: false, error: check.error };
      }
      instanceUrl = parsed.value;
    } else {
      return { ok: false, error: 'invalid_choice' };
    }
    // Kept until the last answer: closing the window here leaves the first run still to do.
    const mode = choice.mode as Mode;
    const finish = async () => {
      stateFile.data.mode = mode;
      if (instanceUrl) stateFile.data.instanceUrl = instanceUrl;
      stateFile.data.askConnection = undefined;
      stateFile.save();
      ipcMain.removeHandler(CHANNEL.welcomeChoose);
      ipcMain.removeHandler(CHANNEL.welcomePrivacy);
      await boot(theme);
      window.destroy();
      return { ok: true };
    };
    if (!questions.telemetry && !questions.crashReports) return finish();
    ipcMain.removeHandler(CHANNEL.welcomePrivacy);
    ipcMain.handle(CHANNEL.welcomePrivacy, async (answerEvent, answers: { telemetry?: unknown; crashReports?: unknown }) => {
      if (answerEvent.sender !== window.webContents || !answerEvent.senderFrame?.url.startsWith('data:')) throw new Error('Not allowed');
      privacy.answerFirstRun(answers ?? {});
      return finish();
    });
    return { ok: true, next: 'privacy' };
  });
  // A data: page: with the grantFileProtocolExtraPrivileges fuse off, a file: one doesn't run.
  void window.loadURL(`data:text/html;charset=utf-8;base64,${readFileSync(WELCOME_PAGE).toString('base64')}`);
}

function startDecision(): StartDecision {
  return decideStart(policies.snapshot, policies.problem, {
    mode: stateFile.data.mode,
    instanceUrl: stateFile.data.instanceUrl,
    askConnection: stateFile.data.askConnection,
    devInstance: __BULWARK_TEST_BUILD__ && DEV ? argValue('instance') : null,
    devStandalone: __BULWARK_TEST_BUILD__ && DEV && process.argv.includes('--standalone'),
  });
}

/** The policy fails closed: this is all the user gets, with no way around it. */
async function showPolicyError(decision: Extract<StartDecision, { kind: 'policy-error' }>): Promise<void> {
  const text = strings();
  const reason = text.policyReasons[decision.reason] ?? text.policyReasons.other;
  const others = policyProblems(policies.snapshot).map((problem) => problem.key).filter((key) => key !== decision.policy);
  const body = text.policyErrorBody(decision.policy, reason, decision.raw);
  await showErrorPage(text.policyErrorTitle, others.length ? `${body} ${text.policyProblemsLine(others)}` : body);
}

/** Where an admin can look when a value doesn't seem to do anything. Also in the log. */
function showPolicyProblemsInAbout(): void {
  const keys = policyProblems(policies.snapshot).map((problem) => problem.key);
  app.setAboutPanelOptions({ copyright: keys.length ? `${ABOUT_COPYRIGHT}\n\n${strings().policyProblemsLine(keys)}` : ABOUT_COPYRIGHT });
}

let bootedKey = '';
let bootedDecision: StartDecision | null = null;
let askedKey = '';

async function boot(theme: ThemeController): Promise<void> {
  // First, before any window has a database open, and whatever comes next.
  await policies.settleLocalData();
  const decision = startDecision();
  bootedKey = restartKey(decision, policies.snapshot);
  bootedDecision = decision;
  menu?.allowSwitchingMode(decision.canSwitch ? askThenSwitchMode : undefined, switchMode);
  if (decision.kind === 'policy-error') await showPolicyError(decision);
  else if (decision.kind === 'welcome') showWelcome(theme, decision);
  else if (!(await keySafeOnDisk(decision.kind === 'instance'))) await showErrorPage(strings().errorKeyNotSavedTitle, strings().errorKeyNotSavedBody);
  else if (decision.kind === 'instance') await bootInstance(decision.url, theme);
  else await bootStandalone(theme);
}

function restartNow(): void {
  // Installing now would kill the app relaunched here. It's on disk for the next quit.
  holdUpdateInstall();
  app.relaunch();
  // Quitting asks each page to save first (before-quit).
  app.quit();
}

restartAfterWipe(restartNow);

/**
 * A change that needs a restart asks for one, once for each outcome. Where a forced
 * connection is what changed, "Later" isn't for good: it asks again, and after the
 * deadline it restarts by itself.
 */
function watchPolicyForRestart(booted: StartDecision): void {
  let cancelTimers = () => {};
  let asking = false;
  const ask = (key: string) => {
    // One question at a time, or they'd pile up on an unattended machine.
    if (asking) return;
    asking = true;
    const text = strings();
    void askToRestart(text.policyChangedTitle, text.policyChangedDetail, text.policyRestart, text.policyLater).then((restart) => {
      asking = false;
      if (restart && askedKey === key) restartNow();
    });
  };
  policies.on('changed', () => {
    const decision = startDecision();
    const key = restartKey(decision, policies.snapshot);
    if (key === askedKey) return;
    cancelTimers();
    cancelTimers = () => {};
    if (key === bootedKey) {
      askedKey = '';
      return;
    }
    askedKey = key;
    ask(key);
    if (connectionMustChange(booted, decision, policies.snapshot)) {
      cancelTimers = addRestartTimers(() => ask(key), () => {
        if (askedKey === key) restartNow();
      });
    }
  });
}

// "Show me the app". With only a pop-out left open, that's a new main window. A second launch
// comes here through features/os-launch.ts, which knows the ones that show nothing.
// `hidden`: a main window for the page's sake, left in the tray if it's new.
function showMain(options: { hidden?: boolean } = {}): void {
  const windows = windowManager;
  if (!windows) return;
  const hidden = options.hidden === true;
  // Until the server is up, the boot opens it: a window now would load an error page. A toast
  // clicked meanwhile still shows it then, even on a start in the tray.
  switch (showMainStep({ booted: mainWindowAllowed, hasMain: !!windows.mainWindow(), hidden })) {
    case 'keep-wish':
      windows.showMainWhenOpened();
      break;
    case 'start-hidden':
      windows.startMainHidden();
      break;
    case 'focus':
      windows.focus();
      break;
    case 'open':
      if (hidden) windows.startMainHidden();
      windows.open({ type: 'main', url: appStartUrl });
      break;
    case 'none':
      break;
  }
}

// Quitting closes the windows, and each may ask first. Nothing is forgotten until all
// of them have gone, so choosing Stay keeps the mode.
let switching = false;
let offering = false;

function switchMode(): void {
  if (offering) return;
  offering = true;
  void offerToRemoveServer().catch((error) => console.error(error)).finally(() => {
    offering = false;
    switching = true;
    app.quit();
  });
}

/**
 * The server being left keeps its partition, sign-in and offline mail on this device, so coming
 * back to it finds them. Main offers in its own words to remove them instead; Keep is the safe
 * default. Nothing a page sent words this question (strings.ts).
 */
async function offerToRemoveServer(): Promise<void> {
  const run = runningOn;
  if (!run) return;
  const text = strings();
  const options: Electron.MessageBoxOptions = {
    type: 'question',
    title: 'Bulwark',
    message: run.mode === 'instance' ? text.connectionWipeTitle(new URL(run.origin).host) : text.connectionWipeTitleApp,
    detail: text.connectionWipeDetail,
    buttons: [text.connectionWipeRemove, text.connectionWipeKeep],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  };
  const parent = windowManager?.mainWindow() ?? null;
  const { response } = await showMessageBox(parent && !parent.isDestroyed() ? parent : null, options);
  if (response !== 0) return;
  const failed = await wipeForConnectionChange(run.session, run.origin, stateFile);
  if (failed.length > 0) console.warn(`Removing what ${run.origin} kept on this device left: ${failed.join(', ')}`);
}

/** Where the page can't ask (an older webmail, an error page): the OS's question, never none. */
function askThenSwitchMode(): void {
  const text = strings();
  void showMessageBox({ type: 'question', title: 'Bulwark', message: text.menuSwitchModeTitle, detail: text.menuSwitchModeDetail, buttons: [text.menuSwitchModeConfirm, text.menuSwitchModeCancel], defaultId: 0, cancelId: 1, noLink: true })
    .then(({ response }) => {
      if (response === 0) switchMode();
    });
}

function finishSwitch(): void {
  // Installing now would kill the app relaunched below. It's on disk for the next quit.
  holdUpdateInstall();
  stateFile.data.mode = undefined;
  stateFile.data.instanceUrl = undefined;
  stateFile.data.askConnection = true;
  stateFile.save();
  app.relaunch();
}

let quitFlushed = false;

function openDeepLink(link: WindowLink): void {
  const windows = windowManager;
  if (!windows || !sessionReady) {
    pendingDeepLink = link;
    if (windows?.mainWindow() && linkLimit.allow(Date.now())) windows.focus();
    return;
  }
  if (!linkLimit.allow(Date.now())) return;
  const target = `${windows.originUrl()}${appPathOfDeepLink(link)}`;
  if (link.kind === 'message') {
    windows.open({ type: 'message', url: target, key: deepLinkWindowKey(link.emailId) });
    return;
  }
  const main = windows.mainWindow();
  if (!main) {
    windows.open({ type: 'main', url: target });
    return;
  }
  // Without a load: there may be a draft on that page. The webmail's router takes it.
  windows.focusWindow(main);
  main.webContents.send(CHANNEL.menuCommand, `link.folder:${link.folder}`);
}

/** A window can lend its session now. Links and windows from last time were waiting for that. */
function onSessionReady(): void {
  sessionReady = true;
  windowManager?.restoreSession();
  flushDeepLink();
}

function flushDeepLink(): void {
  if (!pendingDeepLink) return;
  const link = pendingDeepLink;
  pendingDeepLink = null;
  openDeepLink(link);
}

function buildMenu(): MenuController {
  return new MenuController({
    devTools,
    newWindow: () => {
      // Unique across runs: one restored from last time may hold a low number.
      windowManager?.open({ type: 'main', url: appStartUrl, key: `main:${randomBytes(6).toString('hex')}` });
    },
    zoom: (step) => zoom.step(step),
    // The app's own preview (features/print.ts); the OS's dialog only before it's there.
    print: (window) => {
      const state = menu?.commandState(window);
      if (!printFromMenu(window, state)) printWindow(window, state);
    },
    saveAsPdf: (window) => void saveWindowAsPdf(window, menu?.commandState(window)),
    back: (window, direction) => navigateHistory(window, direction),
  });
}

if (gotLock) {
  // Nothing may attach a webview or open a window behind the window manager's back.
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
    // With no handler Electron picks the first device. Nothing in the app uses Bluetooth.
    contents.on('select-bluetooth-device', (event, _devices, choose) => {
      event.preventDefault();
      choose('');
    });
  });

  // Registered here: macOS sends a launch's file or link before `ready`.
  holdEarlyLaunches();
  // Unpackaged, the shell isn't what the OS should start for these. Windows: os-default-app.ts.
  if (electronRegistersScheme(process.platform, osRegistrationAllowed())) app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);

  app.on('window-all-closed', () => {
    // Closing to the tray hides the main window, so this means there's nothing left.
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (windowManager && windowManager.noneVisible()) showMain();
  });

  // Pages save first, within limits, and then the quit goes on. A preventDefault in a
  // window's own close would call the quit off, so it's done here.
  app.on('before-quit', (event) => {
    stateFile.save();
    windowManager?.beginQuit();
    // A page is asking whether to leave its unsaved changes: closing would take the question
    // away as a Stay. It stays, and its Leave quits.
    if (windowManager?.askingToLeave()) {
      event.preventDefault();
      return;
    }
    if (quitFlushed || !windowManager) return;
    event.preventDefault();
    quitFlushed = true;
    const windows = windowManager;
    void windows.flushAll().then(async (summary) => {
      if (summary.failed > 0 || summary.unsent > 0) {
        const text = strings();
        const parent = windows.focusedManaged()?.window ?? windows.mainWindow();
        const options: Electron.MessageBoxOptions = {
          type: 'warning',
          title: 'Bulwark',
          message: summary.failed > 0 ? text.unsavedTitle : text.unsentTitle,
          detail: summary.failed > 0 ? text.unsavedDetail : unsentDetail(text, summary.unsent),
          buttons: [summary.failed > 0 ? text.closeAnyway : text.closeNow, text.stay],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        };
        const { response: choice } = await showMessageBox(parent ?? null, options);
        if (choice !== 0) {
          quitFlushed = false;
          switching = false;
          windows.cancelQuit();
          return;
        }
      }
      windows.beginQuit();
      app.quit();
    });
  });

  app.on('will-quit', () => {
    if (switching) finishSwitch();
  });

  app.whenReady().then(async () => {
    if (sandboxRefused({ platform: process.platform, appImage: process.env.APPIMAGE, noSandboxSwitch: app.commandLine.hasSwitch('no-sandbox'), disableSandboxEnv: process.env.ELECTRON_DISABLE_SANDBOX })) {
      const text = strings();
      // Native on purpose: the app's own dialog window is sandboxed, and the sandbox is what's missing.
      dialog.showMessageBoxSync({ type: 'error', title: 'Bulwark', message: text.sandboxTitle, detail: text.sandboxDetail, buttons: [text.ok], noLink: true });
      app.exit(1);
      return;
    }
    menu = buildMenu();
    menu.rebuild();
    showPolicyProblemsInAbout();
    policies.on('changed', showPolicyProblemsInAbout);
    const theme = new ThemeController(stateFile);
    // The shell's own questions take the app's theme, the one its page last reported.
    useMessageBoxLook(() => {
      const colours = theme.colours();
      return { dark: colours.dark, background: colours.background, foreground: colours.symbol };
    });
    await boot(theme);
    policies.watch();
    watchPolicyForRestart(bootedDecision!);
  }).catch((error) => {
    console.error(error);
    // Native on purpose: the start failed, and nothing of the app's can be shown.
    dialog.showErrorBox('Bulwark', String(error instanceof Error ? error.message : error));
    app.exit(1);
  });
}

