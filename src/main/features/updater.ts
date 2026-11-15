/**
 * Updates through electron-updater, on GitHub Releases of bulwarkmail/desktop.
 * Prereleases are the beta channel.
 *
 * Quiet by design: it checks in the background and downloads by itself. When an update
 * is ready there's a menu item, one notification and the row in settings, and nothing
 * ever blocks work. It installs at the next quit, or when the user picks "Restart to
 * update".
 *
 * Both go through the normal quit, so pages save their drafts first (`before-quit` in
 * index.ts) and a page that asks to stay calls the restart off.
 *
 * Windows and Linux: only then, at `will-quit`, does the installer start. The other way
 * round NSIS would kill the app in the middle of saving.
 *
 * Signed macOS: electron-updater says "downloaded" before it has handed the zip to
 * Squirrel.Mac (through a local proxy), and only Squirrel can install it. So the update is
 * ready only when Electron's own autoUpdater says `update-downloaded`. A plain quit then
 * lets ShipIt install it, without reopening the app. "Restart to update" waits for pages
 * to save and then hands the quit to Squirrel (`handOffQuit`, where index.ts would call
 * `app.quit()`): Squirrel writes its relaunch request and ends the app itself. Asked from
 * `will-quit`, the app was gone before that request was written, and ShipIt installed
 * without a relaunch or not at all. A relaunch for something else (a policy, a wipe,
 * Change Connection) goes the same way while an update is staged (`relaunchThroughUpdate`):
 * ShipIt installs at the exit whatever electron-updater is told, and drops the update when
 * the instance `app.relaunch()` started is already running.
 *
 * What happens goes to <userData>/logs/updater.log, on every platform.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { app, autoUpdater as nativeUpdater, BrowserWindow, Notification, powerMonitor } from 'electron';
import type { AppUpdater, CancellationToken, UpdateInfo } from 'electron-updater';
import { CHANNEL, type UpdateChannel, type UpdateState } from '../../shared/bridge';
import { native } from '../native';
import { openExternally } from '../navigation';
import { notifyUpdatePolicyChanged, onUpdatePolicyChange, readUpdatePolicy, setUpdatePolicySource } from '../update-policy';
import {
  acceptDownload,
  differentialDownloads,
  effectiveChannel,
  installKind,
  installerSignatureCheck,
  isPrerelease,
  judgeFeedVersion,
  nothingPublished,
  newestReleaseInFeed,
  nextReadiness,
  NOT_READY,
  quitPath,
  readyVersion,
  relaunchPath,
  updateAbility,
  updaterLogLine,
  updaterLogNeedsRotation,
  updatePolicyFrom,
  updateUrlAllowed,
  type InstallKind,
  type QuitPath,
  type ReadinessEvent,
  type UpdatePolicy,
  type WantedDownload,
} from '../update-rules';
import { fill, strings } from '../strings';
import type { Feature, FeatureContext } from './index';
import { policies } from './policies';
import { isInstalledBuild } from '../installed';
import { showMessageBox } from '../message-box';

declare const __BULWARK_UPDATER_TEST__: boolean;

const FIRST_CHECK_MS = 30_000;
const CHECK_EVERY_MS = 4 * 3600_000;
const ABANDON_WAIT_MS = 10_000;
const OWNER = 'bulwarkmail';
const REPO = 'desktop';
const RELEASES_URL = `https://github.com/${OWNER}/${REPO}/releases`;

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function readText(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return undefined;
  }
}

function detectKind(): InstallKind {
  const resources = process.resourcesPath;
  let macSigned = false;
  try {
    macSigned = JSON.parse(readText(path.join(resources, 'bulwark-build.json')) ?? '{}').macSigned === true;
  } catch {
    // An unreadable file is an unsigned build.
  }
  return installKind({
    platform: process.platform,
    isPackaged: isInstalledBuild(),
    hasNsisUninstaller: existsSync(path.join(path.dirname(process.execPath), `Uninstall ${app.getName()}.exe`)),
    appImage: process.env.APPIMAGE,
    packageType: readText(path.join(resources, 'package-type')),
    macSigned,
  });
}

let logFile: string | null = null;

/** Appends to <userData>/logs/updater.log. Past ~1 MB at start the old one moves aside. */
function updaterLog(level: string, message: unknown): void {
  try {
    if (!logFile) {
      const dir = path.join(app.getPath('userData'), 'logs');
      mkdirSync(dir, { recursive: true });
      logFile = path.join(dir, 'updater.log');
      try {
        if (updaterLogNeedsRotation(statSync(logFile).size)) renameSync(logFile, path.join(dir, 'updater.old.log'));
      } catch {
        // None yet.
      }
    }
    // Synchronous: the lines that matter most come just before the app goes.
    appendFileSync(logFile, updaterLogLine(new Date(), level, message));
  } catch {
    // A log that can't be written mustn't stop an update.
  }
}

const logger = {
  info: (message?: unknown) => updaterLog('info', message),
  warn: (message?: unknown) => updaterLog('warn', message),
  error: (message?: unknown) => updaterLog('error', message),
  debug: (message: string) => updaterLog('debug', message),
};

let testPolicy: UpdatePolicy | null = null;
let active: Updater | null = null;

/** The app is restarting for something else, without the update: it waits for the next quit. */
export function holdUpdateInstall(): void {
  active?.hold();
}

/**
 * The app wants to relaunch for something else (a policy, a wipe, Change Connection). True: an
 * update is staged on macOS, and its relaunch takes the place of `app.relaunch()`. The caller
 * quits as usual (or index.ts does, for Change Connection), and `handOffQuit` does the rest.
 */
export function relaunchThroughUpdate(reason: string): boolean {
  return active?.relaunchThroughUpdate(reason) ?? false;
}

/**
 * Where index.ts would call `app.quit()` once pages have saved. True: Squirrel has taken the
 * quit over, and ends the app itself once it has written its relaunch request.
 */
export function handOffQuit(): boolean {
  return active?.handOffQuit() ?? false;
}

class Updater {
  private updater: AppUpdater | null = null;
  private timer: NodeJS.Timeout | null = null;
  private restarting = false;
  /** A page chose to stay since the restart was asked for. */
  private stayed = false;
  /** Squirrel has the quit: once only. */
  private handedOff = false;
  private installing = false;
  private readiness = NOT_READY;
  private lastCheckAt = 0;
  private readonly kind: InstallKind = detectKind();
  private readonly testFeed: string | undefined = __BULWARK_UPDATER_TEST__ ? argValue('bulwark-test-update-feed') : undefined;

  private status: UpdateState['status'] = 'idle';
  private target: string | undefined;
  private percent: number | undefined;

  private downloadToken: CancellationToken | null = null;
  private activeDownload: Promise<void> | null = null;
  private wanted: WantedDownload | null = null;
  private readonly requests = new Set<Electron.ClientRequest>();
  private menuLines = '';
  private lastChannel: UpdateChannel | null = null;

  constructor(private readonly ctx: FeatureContext) {}

  private get channel(): UpdateChannel {
    return effectiveChannel(this.policy(), this.ctx.state.data.updateChannel, app.getVersion(), this.ctx.state.data.updateChannelInitial);
  }

  private policy(): UpdatePolicy {
    // The real reader's stand-in root doesn't work in a package. updater-policy.spec.ts tests
    // that way in; a package under test gets its policy here.
    if (__BULWARK_UPDATER_TEST__ && testPolicy) return testPolicy;
    return readUpdatePolicy();
  }

  /** Off by policy: no timer, no requests. */
  private get allowed(): boolean {
    return this.policy().autoUpdate !== false;
  }

  private get ability(): UpdateState['ability'] {
    if (this.testFeed) return updateAbility(this.kind);
    if (!isInstalledBuild() || !existsSync(path.join(process.resourcesPath, 'app-update.yml'))) return 'none';
    return updateAbility(this.kind);
  }

  state(): UpdateState {
    return {
      version: app.getVersion(),
      channel: this.channel,
      channelLocked: this.policy().channel !== undefined,
      allowed: this.allowed,
      ability: this.ability,
      perMachine: this.kind === 'windows-other',
      status: this.allowed ? this.status : 'off',
      target: this.target,
      percent: this.percent,
    };
  }

  private publish(): void {
    this.ctx.windows.broadcast(CHANNEL.updatesChanged, this.state());
    this.refreshMenu();
  }

  private setStatus(status: UpdateState['status'], target?: string, percent?: number): void {
    this.status = status;
    this.target = target;
    this.percent = percent;
    this.publish();
  }

  /** Only when a line changes: progress comes many times a second, and a new menu closes an open one. */
  private refreshMenu(): void {
    const lines = JSON.stringify(this.menuItems().map(({ id, label, enabled }) => [id, label, enabled]));
    if (lines === this.menuLines) return;
    this.menuLines = lines;
    this.ctx.menu.refresh();
  }

  private menuItems(): Electron.MenuItemConstructorOptions[] {
    const text = strings();
    if (!this.allowed || this.ability === 'none') return [];
    const items: Electron.MenuItemConstructorOptions[] = [];
    if (this.status === 'ready' && this.target) {
      items.push({ id: 'update-restart', label: text.menuRestartToUpdate, click: () => this.restart() });
    } else if (this.status === 'available' && this.target) {
      // On a per-machine install the person using it can't do anything about it.
      if (this.kind !== 'windows-other') {
        items.push({ id: 'update-download', label: fill(text.menuUpdateAvailable, { version: this.target }), click: () => this.openDownload() });
      }
    } else {
      items.push({
        id: 'update-check',
        label: text.menuCheckForUpdates,
        enabled: this.status !== 'checking' && this.status !== 'downloading',
        click: () => void this.checkFromMenu(),
      });
    }
    return items;
  }

  /** electron-updater only when it's first needed, so it costs a start nothing. */
  private load(): AppUpdater {
    if (this.updater) return this.updater;
    const require = createRequire(import.meta.url);
    const { autoUpdater } = require('./updater-lib.cjs') as { autoUpdater: AppUpdater };
    autoUpdater.logger = logger;
    autoUpdater.autoDownload = false;
    // Only true once a right version is on disk: see `onDownloaded`.
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowDowngrade = false;
    // On Windows only the blocks that changed come down (see differentialDownloads). Its
    // differential path ignores the cancellation token: abandonDownload ends its requests with
    // an error, which settles it.
    autoUpdater.disableDifferentialDownload = !differentialDownloads(process.platform);
    // The installer's publisher, through the native helper: electron-updater would start
    // PowerShell for it (Get-AuthenticodeSignature), and endpoint protection blocks that.
    if (process.platform === 'win32') {
      (autoUpdater as unknown as { verifyUpdateCodeSignature: (names: string[], file: string) => Promise<string | null> }).verifyUpdateCodeSignature = installerSignatureCheck(native().system.codeSignature);
    }
    // Every hop of every request, redirects included: only GitHub. TLS doesn't help against a
    // release asset that points somewhere else.
    const testOrigin = __BULWARK_UPDATER_TEST__ && this.testFeed ? new URL(this.testFeed).origin : undefined;
    autoUpdater.netSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
      callback({ cancel: !updateUrlAllowed(details.url, testOrigin) });
    });
    autoUpdater.on('download-progress', (progress: { percent: number }) => {
      if (this.wanted) this.setStatus('downloading', this.wanted.version, Math.round(progress.percent));
    });
    autoUpdater.on('update-downloaded', (info: UpdateInfo) => this.onDownloaded(info));
    // electron-updater's cancel only settles its promise: nothing aborts the request, which
    // runs on and keeps writing. So the requests it makes are kept here, to abort.
    const executor = (autoUpdater as unknown as { httpExecutor: { createRequest: (...args: unknown[]) => Electron.ClientRequest } }).httpExecutor;
    const createRequest = executor.createRequest.bind(executor);
    executor.createRequest = (...args) => {
      const request = createRequest(...args);
      this.requests.add(request);
      const done = () => this.requests.delete(request);
      // Not `close`: a request fires that once it has been sent, with the answer still to come.
      request.once('abort', done);
      request.once('error', done);
      request.once('response', (response) => {
        response.once('end', done);
        response.once('error', done);
      });
      return request;
    };
    autoUpdater.on('error', (error: Error) => this.onError(error));
    if (process.platform === 'darwin') {
      // electron-updater passes Squirrel's errors on as its own `error`: onError has them.
      nativeUpdater.on('error', (error: Error) => {
        updaterLog('error', `Squirrel: ${error.message}`);
        // Squirrel had the quit and failed: the windows are gone, so the app goes too.
        if (this.handedOff) app.quit();
      });
      nativeUpdater.on('update-downloaded', () => this.onSquirrelDownloaded());
      nativeUpdater.on('before-quit-for-update', () => updaterLog('info', 'Squirrel: before-quit-for-update'));
    }
    this.updater = autoUpdater;
    return autoUpdater;
  }

  private get feedBase(): { host?: string; protocol?: 'http'; base: string } {
    if (__BULWARK_UPDATER_TEST__ && this.testFeed) {
      const feed = new URL(this.testFeed);
      return { host: feed.host, protocol: 'http', base: feed.origin };
    }
    return { base: 'https://github.com' };
  }

  /**
   * Stable asks GitHub's "latest release". Beta reads the feed itself and takes the highest
   * version: electron-updater takes the newest entry, so a stable hotfix published after a
   * beta would hide that beta until the next one.
   */
  private async pointFeed(updater: AppUpdater, channel: UpdateChannel): Promise<void> {
    const { host, protocol, base } = this.feedBase;
    if (channel === 'beta') {
      try {
        const response = await updater.netSession.fetch(`${base}/${OWNER}/${REPO}/releases.atom`, { headers: { accept: 'application/atom+xml' } });
        const newest = response.ok ? newestReleaseInFeed(await response.text()) : null;
        if (newest) {
          // One range per request, as electron-updater's GitHub provider does: GitHub's
          // download servers don't answer several ranges in one.
          updater.setFeedURL({ provider: 'generic', url: `${base}/${OWNER}/${REPO}/releases/download/v${newest}/`, useMultipleRangeRequest: false });
          return;
        }
      } catch (error) {
        console.warn('[updater]', error instanceof Error ? error.message : error);
      }
    }
    updater.setFeedURL({ provider: 'github', owner: OWNER, repo: REPO, ...(host ? { host, protocol } : {}) });
  }

  /** Offline, a release still uploading. Quiet: the next check tries again. What's on disk stays ready. */
  private onError(error: unknown): void {
    // electron-updater emits this as well as rejecting, so it's decided here and only here.
    if (nothingPublished(error)) {
      if (this.status === 'checking') this.setStatus('up-to-date');
      return;
    }
    console.warn('[updater]', error instanceof Error ? error.message : error);
    if (this.status !== 'ready') this.setStatus('error');
  }

  private onDownloaded(info: UpdateInfo): void {
    const updater = this.load();
    // The channel or a policy may have moved while this came down.
    if (!acceptDownload({ allowed: this.allowed, wanted: this.wanted, version: info.version, current: app.getVersion(), channel: this.channel })) {
      updater.autoInstallOnAppQuit = false;
      this.ready({ type: 'reset' });
      return;
    }
    // On macOS this is what makes electron-updater hand the zip to Squirrel, right after.
    updater.autoInstallOnAppQuit = true;
    this.ready({ type: 'downloaded', version: info.version });
    this.announceReady();
  }

  private ready(event: ReadinessEvent): void {
    this.readiness = nextReadiness(this.readiness, event);
  }

  /** Squirrel has it staged: only now can it install on macOS. */
  private onSquirrelDownloaded(): void {
    updaterLog('info', `Squirrel: update-downloaded (${this.readiness.downloaded ? `for ${this.readiness.downloaded}` : 'nothing wanted'})`);
    // Given up on meanwhile.
    if (!this.readiness.downloaded || this.status === 'ready') return;
    this.ready({ type: 'squirrel-downloaded' });
    this.announceReady();
  }

  /** On macOS the download stays at 100 % until Squirrel has it. */
  private announceReady(): void {
    const version = readyVersion(this.kind, this.readiness);
    if (!version) {
      updaterLog('info', `${this.readiness.downloaded} downloaded, waiting for Squirrel`);
      this.setStatus('downloading', this.readiness.downloaded ?? undefined, 100);
      return;
    }
    updaterLog('info', `${version} is ready`);
    this.setStatus('ready', version);
    const { state } = this.ctx;
    if (state.data.updateNotified === version) return;
    state.data.updateNotified = version;
    state.touch();
    if (!Notification.isSupported()) return;
    const text = strings();
    const notification = new Notification({ title: text.updateReadyTitle, body: fill(text.updateReadyBody, { version }), silent: true });
    notification.on('click', () => this.restart());
    notification.show();
  }

  private download(updater: AppUpdater, version: string, older: boolean): Promise<unknown> {
    const require = createRequire(import.meta.url);
    const { CancellationToken: Token } = require('./updater-lib.cjs') as { CancellationToken: new () => CancellationToken };
    const token = new Token();
    this.downloadToken = token;
    this.wanted = { version, older };
    this.ready({ type: 'reset' });
    const run = updater.downloadUpdate(token);
    this.activeDownload = run.then(
      () => {},
      () => {},
    );
    return run
      .catch((error) => {
        // A download given up on isn't a failure: whoever gave it up says what happens next.
        if (this.wanted?.version === version) this.onError(error);
      })
      .finally(() => {
        if (this.downloadToken === token) this.downloadToken = null;
      });
  }

  /** Whatever is coming down or sitting on disk no longer counts. Waits until it has stopped. */
  private async abandonDownload(): Promise<void> {
    this.wanted = null;
    // Squirrel may still finish it: that doesn't make it ready, and a relaunch doesn't wait for it.
    this.ready({ type: 'reset' });
    if (this.downloadToken) {
      this.downloadToken.cancel();
      this.downloadToken = null;
      // Only with a download on: nothing would ever settle a check whose request went away.
      // An aborted request says nothing to whoever waits on it, so each gets an error too:
      // the differential download waits on its range requests that way.
      for (const request of this.requests) {
        request.abort();
        if (request.listenerCount('error') > 0) request.emit('error', new Error('The update download was given up.'));
      }
      this.requests.clear();
    }
    if (this.updater) this.updater.autoInstallOnAppQuit = false;
    // Not forever, whatever the network does: a setting mustn't hang on it.
    await Promise.race([this.activeDownload, new Promise((resolve) => setTimeout(resolve, ABANDON_WAIT_MS))]);
    this.activeDownload = null;
  }

  async check(): Promise<UpdateState> {
    if (!this.allowed || this.ability === 'none' || this.status === 'checking' || this.status === 'downloading') return this.state();
    // One's waiting on disk, and looking again would take "Restart to Update" away for a moment.
    if (this.status === 'ready') return this.state();
    this.lastCheckAt = Date.now();
    const updater = this.load();
    // `update-downloaded` puts this back. A download from another channel doesn't count.
    updater.autoInstallOnAppQuit = false;
    const channel = this.channel;
    this.lastChannel = channel;
    updater.allowPrerelease = channel === 'beta';
    // Lets an older stable release reach `judgeFeedVersion`. Nothing downloads on its own.
    updater.allowDowngrade = true;
    this.setStatus('checking');
    try {
      await this.pointFeed(updater, channel);
      const result = await updater.checkForUpdates();
      const version = result?.updateInfo.version;
      if (!version) {
        this.setStatus('up-to-date');
        return this.state();
      }
      const verdict = judgeFeedVersion(app.getVersion(), version, channel);
      if (verdict === 'older-offer') {
        this.setStatus('older-available', version);
      } else if (verdict !== 'newer') {
        this.setStatus('up-to-date');
      } else if (this.ability === 'install') {
        this.setStatus('downloading', version, 0);
        void this.download(updater, version, false);
      } else {
        this.setStatus('available', version);
        this.notifyAvailable(version);
      }
    } catch (error) {
      this.onError(error);
    }
    return this.state();
  }

  /** One notice per version, and none on an MSI: that's for IT, not for the person using it. */
  private notifyAvailable(version: string): void {
    const { state } = this.ctx;
    if (this.kind === 'windows-other' || state.data.updateNotified === version || !Notification.isSupported()) return;
    state.data.updateNotified = version;
    state.touch();
    const text = strings();
    const notification = new Notification({ title: text.updateAvailableTitle, body: fill(text.menuUpdateAvailable, { version }), silent: true });
    notification.on('click', () => this.openDownload());
    notification.show();
  }

  private async checkFromMenu(): Promise<void> {
    const after = await this.check();
    if (after.status !== 'up-to-date' && after.status !== 'error') return;
    const text = strings();
    const options = {
      type: 'info' as const,
      title: 'Bulwark',
      message: after.status === 'up-to-date' ? text.updateNoneTitle : text.updateFailedTitle,
      detail: after.status === 'up-to-date' ? fill(text.updateNoneDetail, { version: after.version }) : text.updateFailedDetail,
      buttons: [text.ok],
      noLink: true,
    };
    const parent = BrowserWindow.getFocusedWindow();
    if (parent) await showMessageBox(parent, options);
    else await showMessageBox(options);
  }

  /** The normal quit. If a page stays, the windows manager says so and this is called off. */
  restart(): void {
    if (this.status !== 'ready' || !this.allowed) return;
    updaterLog('info', 'Restart to Update');
    this.restarting = true;
    this.stayed = false;
    app.quit();
  }

  hold(): void {
    this.restarting = false;
    if (this.updater) this.updater.autoInstallOnAppQuit = false;
  }

  relaunchThroughUpdate(reason: string): boolean {
    const way = relaunchPath({ kind: this.kind, squirrelReady: this.readiness.squirrelReady });
    updaterLog('info', `relaunch for ${reason}: ${way === 'update' ? "through the update's relaunch" : 'app.relaunch()'}`);
    if (way !== 'update') return false;
    this.restarting = true;
    this.stayed = false;
    return true;
  }

  private quitPath(): QuitPath {
    return quitPath({ kind: this.kind, restarting: this.restarting && this.allowed, squirrelReady: this.readiness.squirrelReady, stayed: this.stayed });
  }

  handOffQuit(): boolean {
    if (this.handedOff) return false;
    const way = this.quitPath();
    updaterLog('info', `pages saved, quit: ${way}`);
    if (way !== 'squirrel') return false;
    this.handedOff = true;
    // Out of the quit's own handlers: Squirrel closes the windows, writes its request and ends the app.
    setImmediate(() => {
      updaterLog('info', 'handing the quit to Squirrel (quitAndInstall)');
      this.load().quitAndInstall(false, true);
    });
    return true;
  }

  openDownload(): void {
    openExternally(this.target ? `${RELEASES_URL}/tag/v${this.target}` : `${RELEASES_URL}/latest`);
  }

  async setChannel(channel: unknown): Promise<UpdateState> {
    if ((channel !== 'stable' && channel !== 'beta') || this.policy().channel !== undefined) return this.state();
    if (channel === this.channel) return this.state();
    const { state } = this.ctx;
    if (channel === 'beta') {
      const text = strings();
      // The page can't do this alone: an instance or a privileged plugin holds the same bridge.
      const parent = BrowserWindow.getFocusedWindow();
      const options = {
        type: 'question' as const,
        title: 'Bulwark',
        message: text.updateBetaTitle,
        detail: text.updateBetaDetail,
        buttons: [text.updateBetaConfirm, text.cancel],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      };
      const { response } = parent ? await showMessageBox(parent, options) : await showMessageBox(options);
      if (response !== 0) return this.state();
    }
    state.data.updateChannel = channel;
    state.save();
    // What's coming down or on disk came from the other channel.
    await this.abandonDownload();
    this.setStatus('idle');
    return this.check();
  }

  /** Beta to stable, by the user's own click and with the consequences spelled out. */
  async installOlder(): Promise<UpdateState> {
    if (this.status !== 'older-available' || !this.target || this.ability !== 'install' || !this.allowed) return this.state();
    const text = strings();
    const target = this.target;
    const options = {
      type: 'warning' as const,
      title: 'Bulwark',
      message: fill(text.updateOlderTitle, { version: target }),
      detail: fill(text.updateOlderDetail, { current: app.getVersion(), target }),
      buttons: [text.updateOlderConfirm, text.cancel],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
    const parent = BrowserWindow.getFocusedWindow();
    const { response } = parent ? await showMessageBox(parent, options) : await showMessageBox(options);
    // The answer took a while: is this still what's on offer?
    if (response !== 0 || this.status !== 'older-available' || this.target !== target || !this.allowed) return this.state();
    this.setStatus('downloading', target, 0);
    void this.download(this.load(), target, true);
    return this.state();
  }

  private schedule(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (!this.allowed || this.ability === 'none') return;
    this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS);
    this.timer.unref?.();
  }

  private async onPolicyChange(): Promise<void> {
    const moved = this.lastChannel !== null && this.lastChannel !== this.channel;
    if (!this.allowed || moved) {
      await this.abandonDownload();
      this.status = 'idle';
      this.target = undefined;
    }
    this.schedule();
    this.publish();
    if (this.allowed && moved) void this.check();
  }

  setup(): void {
    const { ctx } = this;
    // Where Windows and Linux apps keep it, by About; macOS has it in the app menu.
    ctx.menu.extend(process.platform === 'darwin' ? 'app' : 'help', () => this.menuItems());
    ctx.handle(CHANNEL.updatesState, () => this.state());
    ctx.handle(CHANNEL.updatesCheck, () => this.check());
    ctx.handle(CHANNEL.updatesSetChannel, (_event, _window, channel) => this.setChannel(channel));
    ctx.handle(CHANNEL.updatesInstallOlder, () => this.installOlder());
    ctx.on(CHANNEL.updatesRestart, () => this.restart());
    ctx.on(CHANNEL.updatesOpenDownload, () => this.openDownload());

    // What this copy was at its first run decides the channel until someone chooses. Asking
    // the running version each time would drop a beta user off beta at the first stable.
    if (!ctx.state.data.updateChannelInitial) {
      ctx.state.data.updateChannelInitial = isPrerelease(app.getVersion()) ? 'beta' : 'stable';
      ctx.state.touch();
    }

    active = this;

    // A page chose to stay: the install waits, and the update stays ready.
    ctx.windows.on('stayed', () => {
      this.stayed = true;
    });
    app.on('will-quit', () => {
      // Signed macOS never installs from here: Squirrel has the quit already, or installs at the exit by itself.
      if (this.handedOff || this.installing) return;
      const way = this.quitPath();
      if (this.readiness.squirrelReady) updaterLog('info', `quitting with ${this.readiness.downloaded} staged: Squirrel installs it, without a relaunch`);
      if (way !== 'install-at-will-quit' || this.status !== 'ready') return;
      this.installing = true;
      updaterLog('info', 'installing at will-quit');
      // Not silent: the app is gone and a person is waiting, so the installer's progress shows.
      this.load().quitAndInstall(false, true);
    });

    setUpdatePolicySource(() => updatePolicyFrom(policies.snapshot));
    onUpdatePolicyChange(() => void this.onPolicyChange());
    if (__BULWARK_UPDATER_TEST__) {
      const start = argValue('bulwark-test-update-policy');
      if (start) testPolicy = JSON.parse(start) as UpdatePolicy;
      (globalThis as unknown as { __bulwarkUpdaterTest: unknown }).__bulwarkUpdaterTest = {
        setPolicy: (policy: UpdatePolicy) => {
          testPolicy = policy;
          notifyUpdatePolicyChanged();
        },
      };
    }
    policies.on('changed', notifyUpdatePolicyChanged);
    this.schedule();
    powerMonitor.on('resume', () => {
      if (Date.now() - this.lastCheckAt > 3600_000) void this.check();
    });
    const delay = __BULWARK_UPDATER_TEST__ && this.testFeed ? 500 : FIRST_CHECK_MS;
    setTimeout(() => void this.check(), delay).unref?.();
    this.refreshMenu();
  }
}

export const updaterFeature: Feature = {
  name: 'updater',
  modes: ['standalone', 'instance'],
  setup: (ctx) => new Updater(ctx).setup(),
};
