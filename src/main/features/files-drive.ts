/**
 * The Files drive on Windows (files/drive-controller.ts), wired to the bridge's `files.drive`
 * channels, the policies and the wipe.
 *
 * Only the main window's page may use these: a same-origin plugin frame reaches the bridge
 * through `parent`, and so do pop-outs, and none of them runs the sync engine. Turning the
 * drive on for the first time and choosing a letter take a real click, as main saw it. A click
 * isn't a yes, so the first time for a server and account main also asks, in its own question
 * window with no as the default, naming the server and the folder. The yes is kept per server
 * and account in the shell's state, and a letter is only ever set for a server with one.
 *
 * The folders live in `%USERPROFILE%\Bulwark Files\<address>`, where people look for them and
 * where OneDrive keeps its own. Not in the profile's AppData: Explorer's search and backup
 * tools skip that.
 */

import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { homedir, release } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app, BrowserWindow, shell, type WebContents } from 'electron';
import { CHANNEL, type FilesDriveState, type FilesFetchRequest, type OsCommand } from '../../shared/bridge';
import { appLockGate } from '../app-lock-gate';
import { DriveController, type DriveConsent, type DrivePolicy, type StoredDrive } from '../files/drive-controller';
import { helperLetters } from '../files/drive-letter';
import { registryLetterLabels } from '../files/drive-letter-label';
import { driveBase, driveProvider } from '../files/drive-places';
import { driveNotice, driveSummaryChanged, setDriveHooks } from '../files/drive-hooks';
import type { Rescued } from '../files/drive-rescue';
import { filesRegistry } from '../files/registry';
import { native } from '../native';
import { StateFile } from '../state';
import type { DrivePlaces } from '../uninstall-cleanup';
import { takeUserGesture, watchUserGestures } from '../user-gesture';
import { forgetRootState } from './files-folders';
import { addWipeStep } from './local-wipe';
import { appIconResource, taskIconsDir } from './os-tasks';
import { policies } from './policies';
import { showMessageBox } from '../message-box';
import { strings } from '../strings';
import type { Feature, FeatureContext } from '.';

// Set by build.mjs.
declare const __BULWARK_TEST_BUILD__: boolean;

/** Where a build from source has the task icons and the app's (build.mjs): main.mjs is in dist/. */
const BUILD_ICONS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'os-icons');

/** Windows 10 1809: where StorageProviderSyncRootManager and the placeholder calls are complete. */
const FIRST_BUILD = 17763;
/** How long the policy turning the drive off waits for the page to upload what waits. */
const FLUSH_MS = 120_000;
/** ...and for it to say it's on it: an older page, or none that listens, isn't waited for longer. */
const FLUSH_ANSWER_MS = 5_000;

function testArgument(name: string): string | null {
  if (!__BULWARK_TEST_BUILD__) return null;
  const prefix = `--bulwark-test-files-${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? null;
}

/**
 * The app's icon as a PNG Explorer can read, next to the drive's state. Explorer can't read
 * inside app.asar, so it's written to the profile once per start.
 */
async function statusIcon(): Promise<string | null> {
  try {
    const image = await app.getFileIcon(process.execPath, { size: 'large' });
    if (image.isEmpty()) return null;
    const file = path.join(app.getPath('userData'), 'files-drive-status.png');
    writeFileSync(file, image.toPNG());
    return pathToFileURL(file).href;
  } catch {
    return null;
  }
}

/** HKCU, or a test's own key in its place (as os-default-app.ts). A real build has no way to move it. */
function registryRoot(): string {
  if (!__BULWARK_TEST_BUILD__) return 'HKCU';
  const prefix = '--bulwark-test-registry-root=';
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) || 'HKCU';
}

function windowsBuild(): number {
  return Number(release().split('.')[2] ?? 0);
}

export function drivePolicy(): DrivePolicy {
  const { FilesDriveEnabled, FilesDriveLetter } = policies.snapshot;
  return { forcedOff: FilesDriveEnabled.value === false, letter: FilesDriveLetter.locked ? FilesDriveLetter.value ?? 'none' : null };
}

let controller: DriveController | null = null;
/** The last folder files that weren't uploaded went to, for the page's "Open folder". */
let lastRescue: Rescued | null = null;
const flushWaiters = new Map<string, { done: () => void; working: () => void }>();

function rescuedNotice(rescued: Rescued, reason: string): void {
  lastRescue = rescued;
  // Turned off on the settings page: the page says it there.
  if (reason === 'user') return;
  const text = strings();
  driveNotice()?.(text.filesRescuedTitle, text.filesRescuedBody(rescued.count, rescued.folder), () => {
    void shell.openPath(rescued.folder);
  });
}

/**
 * The user's yes per server and account, in the shell's state, and main's question for it. Its
 * words are the shell's own (strings.ts): no label the page sent reaches them.
 */
function driveConsent(ctx: Pick<FeatureContext, 'state' | 'windows' | 'origin' | 'mode'>): DriveConsent {
  const { state, origin } = ctx;
  const stored = () => state.data.filesDriveConsent ?? [];
  const keep = (next: { origin: string; account: string }[]) => {
    state.data.filesDriveConsent = next;
    state.save();
  };
  return {
    origin,
    has: (account) => stored().some((entry) => entry.origin === origin && (account === undefined || entry.account === account)),
    add: (account) => keep([...stored().filter((entry) => !(entry.origin === origin && entry.account === account)), { origin, account }]),
    remove: (account) => keep(stored().filter((entry) => !(entry.origin === origin && entry.account === account))),
    clear: () => keep([]),
    ask: async (_account, _label, folder) => {
      const text = strings();
      const options = {
        type: 'question' as const,
        message: ctx.mode === 'instance' ? text.driveAskTitle(new URL(origin).host) : text.driveAskTitleApp,
        detail: text.driveAskDetail(folder),
        buttons: [text.driveAskAllow, text.driveAskDeny],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
      };
      const parent = ctx.windows.mainWindow();
      const { response } = await (parent && !parent.isDestroyed() ? showMessageBox(parent, options) : showMessageBox(options));
      return response === 0;
    },
  };
}

/** The drive's controller, made once: the wipe can come before the feature starts. */
function driveController(ctx?: Pick<FeatureContext, 'state' | 'windows' | 'showMain' | 'origin' | 'mode'>): DriveController | null {
  if (process.platform !== 'win32') return null;
  if (controller) return controller;
  const helper = native().files;
  const state = ctx?.state;
  let detached: StoredDrive = {};
  const mainContents = (): WebContents | null => {
    const window = ctx?.windows.mainWindow();
    return window && !window.isDestroyed() ? window.webContents : null;
  };
  controller = new DriveController({
    native: helper,
    supported: windowsBuild() >= FIRST_BUILD,
    // A test build has a provider of its own even when a run doesn't name one.
    provider: driveProvider({ chosen: testArgument('provider'), testBuild: __BULWARK_TEST_BUILD__ }),
    base: driveBase({ chosen: testArgument('drive-dir'), testBuild: __BULWARK_TEST_BUILD__, profile: app.getPath('userData'), home: homedir() }),
    profile: app.getPath('userData'),
    // Explorer shows it beside the drive. A root registered with another (the exe's, before)
    // gets it at the next start.
    icon: appIconResource(taskIconsDir(app.isPackaged, process.resourcesPath, BUILD_ICONS)),
    version: app.getVersion(),
    store: {
      read: () => (state ? state.data.filesDrive ?? {} : detached),
      write: (next) => {
        if (!state) {
          detached = next;
          return;
        }
        state.data.filesDrive = next;
        state.save();
      },
    },
    policy: drivePolicy,
    page: {
      fetch: (request: FilesFetchRequest) => {
        // A locked app hands out nothing, not even to Explorer.
        if (appLockGate.locked) return 'denied';
        const contents = mainContents();
        if (!contents || contents.isLoading() || contents.isCrashed()) return 'not-running';
        contents.send(CHANNEL.filesDriveFetch, request);
        return true;
      },
      fetchCancelled: (fetchId) => mainContents()?.send(CHANNEL.filesDriveFetchCancel, fetchId),
      stateChanged: (next: FilesDriveState) => mainContents()?.send(CHANNEL.filesDriveStateChanged, next),
      // The page uploads what waits, then answers; no page or no answer in time: on without it.
      flush: (accounts) => new Promise<void>((resolve) => {
        const contents = mainContents();
        if (!contents || contents.isLoading() || contents.isCrashed()) {
          resolve();
          return;
        }
        const requestId = randomUUID();
        const done = () => {
          clearTimeout(timer);
          flushWaiters.delete(requestId);
          resolve();
        };
        let timer = setTimeout(done, FLUSH_ANSWER_MS);
        const working = () => {
          clearTimeout(timer);
          timer = setTimeout(done, Number(testArgument('flush-timeout')) || FLUSH_MS);
        };
        flushWaiters.set(requestId, { done, working });
        contents.send(CHANNEL.filesDriveFlush, { requestId, accounts });
      }),
    },
    documents: testArgument('documents-dir') ?? app.getPath('documents'),
    summaryChanged: driveSummaryChanged,
    rescued: rescuedNotice,
    status: {
      icon: statusIcon,
      // The status line in Explorer: Settings > Files on this computer, in the main window.
      opened: () => {
        ctx?.showMain();
        const command: OsCommand = { type: 'navigate', target: 'settings/files_sync' };
        mainContents()?.send(CHANNEL.osCommand, command);
      },
    },
    registry: filesRegistry,
    forgetState: forgetRootState,
    letters: helper && testArgument('letters') !== 'off' ? helperLetters(native().system.driveLetters, () => helper.filesUsedDriveLetters()) : null,
    letterLabels: helper && testArgument('letters') !== 'off' ? registryLetterLabels(registryRoot(), native().system.registry, (letter) => helper.filesDriveLetterChanged(letter)) : null,
    setPin: native().system.setPin,
    ...(testArgument('fetch-timeout') ? { fetchFirstAnswerMs: Number(testArgument('fetch-timeout')), fetchIdleMs: Number(testArgument('fetch-timeout')) } : {}),
    // A wipe before the feature started has no page and nobody to ask: the setup clears the yes.
    ...(ctx ? { consent: driveConsent(ctx) } : {}),
  });
  return controller;
}

/**
 * The drive of the profile in `profile`, for `--uninstall-cleanup` (uninstall-cleanup.ts): the
 * same provider, folder and documents the running app uses, and what the profile kept about it.
 */
export function uninstallDrivePlaces(profile: string): DrivePlaces {
  const state = new StateFile(path.join(profile, 'shell-state.json'));
  return {
    profile,
    provider: driveProvider({ chosen: testArgument('provider'), testBuild: __BULWARK_TEST_BUILD__ }),
    base: driveBase({ chosen: testArgument('drive-dir'), testBuild: __BULWARK_TEST_BUILD__, profile, home: homedir() }),
    documents: testArgument('documents-dir') ?? app.getPath('documents'),
    stored: state.data.filesDrive ?? {},
    supported: process.platform === 'win32' && windowsBuild() >= FIRST_BUILD,
    version: app.getVersion(),
  };
}

/** A wipe before the feature started had no profile to clear the wishes from. */
let wipedEarly = false;

// Whatever the mode, and before the feature's setup: a wipe at the start comes first. A server's
// wipe takes the accounts turned on from its page (DriveController.wipe).
addWipeStep(async ({ origin, legacy }) => {
  if (!controller && origin === null) wipedEarly = true;
  await driveController()?.wipe(origin, legacy);
});

/** For the folders feature: where the drive keeps its folders, which no folder pair may touch. */
export function driveParentFolders(): string[] {
  return driveController()?.parentFolders() ?? [];
}

/** For the folders feature: `removeRoot` on a drive root. */
export async function driveRemoveRoot(root: { account: string }): Promise<void> {
  await driveController()?.disable(root.account, 'user');
}

export const filesDriveFeature: Feature = {
  name: 'files-drive',
  modes: ['standalone', 'instance'],
  setup(ctx) {
    if (process.platform !== 'win32') return;
    // Made before any wipe step ran with no state: from here on it writes the profile's.
    controller = null;
    if (wipedEarly) {
      delete ctx.state.data.filesDrive;
      delete ctx.state.data.filesDriveConsent;
      ctx.state.save();
    }
    const drive = driveController(ctx)!;
    setDriveHooks({ removeRoot: driveRemoveRoot, parentFolders: driveParentFolders, running: () => drive.running, traySummary: () => drive.traySummary() });
    // Set after the tray was built: it may have drawn its menu without the drive.
    driveSummaryChanged();

    const isMain = (window: BrowserWindow | null): boolean => !!window && window === ctx.windows.mainWindow();
    const fromMain = (window: BrowserWindow | null): void => {
      if (!isMain(window)) throw new Error('Not allowed');
    };
    const clickedNow = (contents: WebContents, clicked: unknown) => () => clicked === true && takeUserGesture(contents);

    app.on('browser-window-created', (_event, window) => watchUserGestures(window.webContents));
    for (const window of BrowserWindow.getAllWindows()) watchUserGestures(window.webContents);

    ctx.handle(CHANNEL.filesDriveState, (_event, window) => {
      fromMain(window);
      return drive.state();
    });
    ctx.handle(CHANNEL.filesDriveEnable, (event, window, account, label, clicked) => {
      fromMain(window);
      return drive.enable(account, label, clickedNow(event.sender, clicked));
    });
    ctx.handle(CHANNEL.filesDriveDisable, (_event, window, account, reason) => {
      fromMain(window);
      return drive.disable(account, reason);
    });
    ctx.handle(CHANNEL.filesDrivePlace, (_event, window, rootId, entries) => {
      fromMain(window);
      return drive.place(rootId, entries);
    });
    ctx.handle(CHANNEL.filesDriveUpdate, (_event, window, rootId, relative, meta, expect) => {
      fromMain(window);
      return drive.update(rootId, relative, meta, expect);
    });
    ctx.handle(CHANNEL.filesDriveMarkInSync, (_event, window, rootId, relative, identity, expect) => {
      fromMain(window);
      return drive.markInSync(rootId, relative, identity, expect);
    });
    ctx.handle(CHANNEL.filesDriveSupply, (_event, window, fetchId, offset, data) => {
      fromMain(window);
      return drive.supply(fetchId, offset, data);
    });
    ctx.on(CHANNEL.filesDriveFail, (_event, window, fetchId, error) => {
      if (isMain(window)) drive.failFetch(fetchId, error);
    });
    ctx.handle(CHANNEL.filesDriveSetLetter, (event, window, letter, clicked) => {
      fromMain(window);
      return drive.setLetter(letter, clickedNow(event.sender, clicked));
    });
    ctx.on(CHANNEL.filesDriveStatus, (_event, window, account, status) => {
      if (isMain(window)) drive.setStatus(account, status);
    });
    ctx.on(CHANNEL.filesDriveFlushed, (_event, window, requestId, phase) => {
      if (!isMain(window) || typeof requestId !== 'string') return;
      const waiter = flushWaiters.get(requestId);
      if (phase === 'working') waiter?.working();
      else waiter?.done();
    });
    ctx.handle(CHANNEL.filesDriveSetPin, (_event, window, rootId, relative, pin) => {
      fromMain(window);
      return drive.setPin(rootId, relative, pin);
    });
    // Only the folder main itself made: the page can't name one.
    ctx.handle(CHANNEL.filesDriveOpenRescue, async (_event, window) => {
      fromMain(window);
      if (!lastRescue?.folder) return false;
      return (await shell.openPath(lastRescue.folder)) === '';
    });

    let before = drivePolicy();
    policies.on('changed', () => {
      const now = drivePolicy();
      if (now.forcedOff === before.forcedOff && now.letter === before.letter) return;
      before = now;
      void drive.policyChanged();
    });
    app.on('will-quit', () => drive.shutdown());
    void drive.startUp();

    if (__BULWARK_TEST_BUILD__) (globalThis as unknown as { __bulwarkFilesDrive: DriveController }).__bulwarkFilesDrive = drive;
  },
};
