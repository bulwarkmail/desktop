/**
 * The bridge the webmail sees as window.bulwarkDesktop.
 *
 * Runs in a sandboxed renderer, so only electron's contextBridge and ipcRenderer
 * are here. It exposes nothing unless the page is on the one origin this window
 * was opened for. An external page, about:blank, a blob: preview or a frame gets
 * no bridge. Main checks the sender's origin again on every call, so this check
 * is a courtesy, not the lock.
 *
 * New features add a member here and a handler in src/main/features/.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { editFileName } from '../shared/edit-rules';
import {
  type EditBeginResult,
  type EditClearResult,
  type EditFile,
  type EditOpenResult,
  type EditReadResult,
  type EditSession,
  BRIDGE_VERSION,
  type AppLockStatus,
  type LocalWipeRequest,
  type PinStepAnswer,
  type OsUnlockAnswer,
  type HelloAnswer,
  CHANNEL,
  PRELOAD_ARG,
  type BrowserSignInControls,
  type BrowserSignInRequest,
  type ConfirmOptions,
  type DialogWindowAnswer,
  type DialogWindowRequest,
  type PrintPreviewOutcome,
  type PrintPreviewRequest,
  type FlushAnswer,
  type LanguagesUpdate,
  type MenuBarEntry,
  type MenuBarEvent,
  type MenuBarMenu,
  type MenuBarReport,
  type KeystoreDecryptScheme,
  type KeystoreAccessState,
  type KeystoreCertificate,
  type KeystoreResult,
  type KeystoreSignScheme,
  type KeystoreUseOptions,
  type LocalImportGrantResult,
  type LocalImportResumeResult,
  type LocalImportScanResult,
  type MenuState,
  type OsCommand,
  type OsCommandOptions,
  type PasswordSignInAnswer,
  type OsDefaultAppStatus,
  type OsFile,
  type OsNotification,
  type OsNotifyResult,
  type OsPowerEvent,
  type OsSettings,
  type OsStatus,
  type OsSummary,
  type NativeMenuItem,
  type PrivacyState,
  type RecentFileAttachResult,
  type RecentFilesResult,
  type SaveAsBegin,
  type SaveAsRequest,
  type SaveAsResult,
  type DevToolsState,
  type FilesChangeEvent,
  type FilesControls,
  type FilesDriveControls,
  type FilesDriveState,
  type FilesDriveStatus,
  type FilesExpect,
  type FilesFetchRequest,
  type FilesPlaceholder,
  type SessionUrls,
  type SystemTheme,
  type ThemeColours,
  type UpdateChannel,
  type UpdateState,
  type WindowInfo,
} from '../shared/bridge';
import { DEFAULT_POLICY_SNAPSHOT, type PolicySnapshot } from '../shared/policy-schema';

let appLockClaimed = false;
let filesClaimed = false;

/**
 * A real click or key press in the last few seconds. Read here, in the preload's own world, so a
 * page can't replace the answer, and no script can make one. A same-origin frame reaches these
 * calls through `parent` and main can't tell (ipc.ts), so this is what separates "the user just
 * did something" from a call alone. It doesn't say what was clicked.
 */
function clicked(): boolean {
  return navigator.userActivation?.isActive === true;
}

function argument(prefix: string): string | null {
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const wrapped = (_event: unknown, value: T) => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

/** Only the code gets through contextBridge, which is all a plugin's frame can see anyway. */
async function keystoreAnswer<T>(call: Promise<KeystoreResult<T>>): Promise<T> {
  const result = await call;
  if (!result.ok) throw new Error(result.code);
  return result.value;
}

/**
 * Where the page was going when its unsaved-changes question stopped it (windows.ts). The
 * question is a window of the shell's own, so Chromium's navigation is called off while it
 * asks, and a Leave starts it again from here. Chromium fires the Navigation API's navigate
 * event just before beforeunload, in the same task, for a navigation the page starts; one
 * the shell starts (a reload) has none, and a step in the history is main's to repeat.
 * A form's POST can't be sent again from here: it reloads, as a reload does.
 */
interface NavigateEventLike extends Event {
  navigationType: string;
  destination: { url: string; sameDocument: boolean };
  formData: FormData | null;
  downloadRequest: string | null;
}
type LeaveTarget = { url: string; replace: boolean };
let navigating: LeaveTarget | null = null;
let stopped: LeaveTarget | null = null;
(window as unknown as { navigation?: EventTarget }).navigation?.addEventListener('navigate', (event) => {
  const { navigationType, destination, formData, downloadRequest } = event as NavigateEventLike;
  if (destination.sameDocument || formData || downloadRequest !== null) return;
  if (navigationType !== 'push' && navigationType !== 'replace') return;
  navigating = { url: destination.url, replace: navigationType === 'replace' };
  setTimeout(() => (navigating = null), 0);
});
window.addEventListener('beforeunload', () => {
  stopped = navigating;
  navigating = null;
});
ipcRenderer.on(CHANNEL.windowsLeave, () => {
  const target = stopped;
  stopped = null;
  if (!target) window.location.reload();
  else if (target.replace) window.location.replace(target.url);
  else window.location.assign(target.url);
});

const allowedOrigin = argument(PRELOAD_ARG.allowedOrigin);
const mode = argument(PRELOAD_ARG.mode);

// Plain http only when the allowed origin is: an instance a policy allows that way.
if (allowedOrigin && /^https?:$/.test(window.location.protocol) && window.location.origin === allowedOrigin) {
  const platform = process.platform as 'win32' | 'darwin' | 'linux';
  const flushHandlers = new Set<() => Promise<unknown>>();
  ipcRenderer.on(CHANNEL.lifecycleFlush, (_event, id: number) => {
    void Promise.allSettled([...flushHandlers].map((handler) => handler())).then((settled) => {
      const answers: FlushAnswer[] = settled.map((result) => {
        if (result.status === 'rejected') return { failed: 1 };
        const { failed, timedOut, unsent } = (result.value ?? {}) as FlushAnswer;
        return { failed, timedOut, unsent };
      });
      ipcRenderer.send(CHANNEL.lifecycleFlushed, id, answers);
    });
  });
  let policySnapshot: PolicySnapshot = (ipcRenderer.sendSync(CHANNEL.policyGet) as PolicySnapshot | null) ?? DEFAULT_POLICY_SNAPSHOT;
  ipcRenderer.on(CHANNEL.policyChanged, (_event, snapshot: PolicySnapshot) => {
    policySnapshot = snapshot;
  });
  /**
   * A same-origin frame reaches this object through `parent`, and main can't tell. So the
   * page takes these once, in its first render, before any frame exists, and a flow only
   * starts from a real click on it.
   */
  let signInClaimed = false;
  const signInControls: BrowserSignInControls = {
    begin: (request: BrowserSignInRequest) => {
      if (!clicked()) return Promise.resolve({ ok: false, error: 'no_gesture' });
      return ipcRenderer.invoke(CHANNEL.authBegin, request);
    },
    complete: (flowId: string, url: string) => ipcRenderer.invoke(CHANNEL.authComplete, flowId, url),
    useScheme: (flowId: string) => ipcRenderer.invoke(CHANNEL.authUseScheme, flowId),
    cancel: (flowId: string) => ipcRenderer.send(CHANNEL.authCancel, flowId),
    beginPassword: (flowId: string) => ipcRenderer.invoke(CHANNEL.authPasswordBegin, flowId),
    nextPassword: (flowId: string) => ipcRenderer.invoke(CHANNEL.authPasswordNext, flowId),
    answerPassword: (flowId: string, answer: PasswordSignInAnswer) => ipcRenderer.send(CHANNEL.authPasswordAnswer, flowId, answer),
    outcome: (flowId: string) => ipcRenderer.invoke(CHANNEL.authPasswordOutcome, flowId),
    pluginSignIn: (url: string) => {
      if (!clicked() || mode !== 'instance') return Promise.resolve(false);
      return ipcRenderer.invoke(CHANNEL.authPluginSignIn, url);
    },
  };
  const common = {
    version: BRIDGE_VERSION,
    platform,
    mode,
    auth: {
      claim: (): BrowserSignInControls | null => {
        if (signInClaimed) return null;
        signInClaimed = true;
        return signInControls;
      },
    },
    certificates: {
      clearChoices: (scope: { account?: string; last?: boolean }): Promise<void> => ipcRenderer.invoke(CHANNEL.certificatesClearChoices, scope),
      setAccount: (account: string | null): Promise<void> => ipcRenderer.invoke(CHANNEL.certificatesSetAccount, account),
      onConnectionsReset: (listener: () => void) => subscribe(CHANNEL.certificatesConnectionsReset, listener),
    },
    windows: {
      open: (url: string, options: { name: string; width: number; height: number; quick?: boolean }) =>
        ipcRenderer.send(CHANNEL.windowsOpen, url, options),
      openMessage: (target: { url: string; emailId: string }) => ipcRenderer.send(CHANNEL.windowsOpenMessage, target),
      openComposer: (target: { url: string; name?: string }) => ipcRenderer.send(CHANNEL.windowsOpenComposer, target),
      focus: (id?: number) => ipcRenderer.send(CHANNEL.windowsFocus, id),
      list: (): Promise<WindowInfo[]> => ipcRenderer.invoke(CHANNEL.windowsList),
      onChanged: (listener: (windows: WindowInfo[]) => void) => subscribe(CHANNEL.windowsChanged, listener),
      closeSelf: () => ipcRenderer.send(CHANNEL.windowsCloseSelf),
      setRestore: (urls: string[]) => ipcRenderer.send(CHANNEL.windowsSetRestore, urls),
      setRestoreEnabled: (enabled: boolean) => ipcRenderer.send(CHANNEL.windowsSetRestoreEnabled, enabled),
      setMenuName: (name: string) => ipcRenderer.send(CHANNEL.windowsSetMenuName, name),
      sessionReady: () => ipcRenderer.send(CHANNEL.windowsSessionReady),
      sessionEnded: () => ipcRenderer.send(CHANNEL.windowsSessionEnded),
      spare: {
        ready: () => ipcRenderer.send(CHANNEL.windowsSpareReady),
        taken: () => ipcRenderer.send(CHANNEL.windowsSpareTaken),
        onActivate: (listener: (url: string) => void) => subscribe(CHANNEL.windowsSpareActivate, listener),
      },
    },
    theme: {
      set: (theme: ThemeColours) => ipcRenderer.send(CHANNEL.themeSet, theme),
      onSystemChange: (listener: (system: SystemTheme) => void) => subscribe(CHANNEL.themeSystem, listener),
      system: (): Promise<SystemTheme> => ipcRenderer.invoke(CHANNEL.themeGetSystem),
    },
    menu: {
      setState: (state: MenuState) => ipcRenderer.send(CHANNEL.menuSetState, state),
      // File > Change connection…, after the page asked: restarts on the first screen.
      changeConnection: (): Promise<boolean> => ipcRenderer.invoke(CHANNEL.menuChangeConnection),
      onCommand: (listener: (id: string) => void) => subscribe(CHANNEL.menuCommand, listener),
      popup: (items: NativeMenuItem[], at: { x: number; y: number }): Promise<string | null> =>
        ipcRenderer.invoke(CHANNEL.menuPopup, items, at),
      bar: {
        entries: (): Promise<MenuBarEntry[]> => ipcRenderer.invoke(CHANNEL.menuBarEntries),
        open: (id: string, at: { x: number; y: number }) => ipcRenderer.send(CHANNEL.menuBarOpen, id, at),
        onEvent: (listener: (event: MenuBarEvent) => void) => subscribe(CHANNEL.menuBarEvent, listener),
        menus: (): Promise<MenuBarMenu[]> => ipcRenderer.invoke(CHANNEL.menuBarMenus),
        run: (key: string, label: string) => ipcRenderer.send(CHANNEL.menuBarRun, key, label),
        report: (report: MenuBarReport) => ipcRenderer.send(CHANNEL.menuBarReport, report),
        setPinned: (pinned: boolean) => ipcRenderer.send(CHANNEL.menuBarSetPinned, pinned),
      },
    },
    appLock: {
      status: (): Promise<AppLockStatus> => ipcRenderer.invoke(CHANNEL.appLockStatus),
      // A same-origin frame reaches this object through `parent`, and main can't tell its calls
      // from the page's (ipc.ts). So these go to whoever asks first, and the page asks in its
      // first render, before any frame exists. This is per document: the preload runs again.
      // Unwrapping is here because a frame could take the OS's layer off the PIN record and
      // guess at it elsewhere, and a PIN step because every guess has to be counted.
      claim: () => {
        if (appLockClaimed) return null;
        appLockClaimed = true;
        return {
          lock: () => ipcRenderer.send(CHANNEL.appLockLock),
          osUnlock: (): Promise<OsUnlockAnswer> => ipcRenderer.invoke(CHANNEL.appLockOsUnlock),
          // Windows Hello's signature is a way to the lock key, so only the page asks for it.
          helloEnroll: (proof: Uint8Array, salt: Uint8Array): Promise<HelloAnswer> => ipcRenderer.invoke(CHANNEL.appLockHelloEnroll, proof, salt),
          helloSign: (salt: Uint8Array, proof?: Uint8Array): Promise<HelloAnswer> => ipcRenderer.invoke(CHANNEL.appLockHelloSign, salt, proof),
          helloCancel: () => ipcRenderer.send(CHANNEL.appLockHelloCancel),
          helloRemove: (): Promise<void> => ipcRenderer.invoke(CHANNEL.appLockHelloRemove),
          wrap: (data: Uint8Array): Promise<Uint8Array | null> => ipcRenderer.invoke(CHANNEL.appLockWrap, data),
          unwrap: (data: Uint8Array): Promise<Uint8Array | null> => ipcRenderer.invoke(CHANNEL.appLockUnwrap, data),
          pinStep: (data: Uint8Array): Promise<PinStepAnswer> => ipcRenderer.invoke(CHANNEL.appLockPinStep, data),
          replaceRenderer: () => ipcRenderer.send(CHANNEL.appLockReplaceRenderer),
          // Turning it off makes the app less locked, so a frame can't.
          setScreenLock: (on: boolean): Promise<boolean> => ipcRenderer.invoke(CHANNEL.appLockScreenLock, on),
          // Here too: a frame could delete what the page can, but not everything else as well.
          localWipe: (request: LocalWipeRequest): Promise<{ failed: string[] }> => ipcRenderer.invoke(CHANNEL.localWipeRun, request),
          finishLocalWipe: (options: { keepLocalStorage: boolean }): Promise<void> => ipcRenderer.invoke(CHANNEL.localWipeFinish, options),
        };
      },
      enroll: (proof: Uint8Array): Promise<boolean> => ipcRenderer.invoke(CHANNEL.appLockEnroll, proof, clicked()),
      prove: (proof: Uint8Array): Promise<boolean> => ipcRenderer.invoke(CHANNEL.appLockProve, proof),
      disable: (proof: Uint8Array): Promise<boolean> => ipcRenderer.invoke(CHANNEL.appLockDisable, proof),
      forget: (proof?: Uint8Array): Promise<boolean> => ipcRenderer.invoke(CHANNEL.appLockForget, proof),
      clearOrphan: (): Promise<boolean> => ipcRenderer.invoke(CHANNEL.appLockClearOrphan),
      osEnroll: (proof: Uint8Array, lockKey: Uint8Array): Promise<boolean> => ipcRenderer.invoke(CHANNEL.appLockOsEnroll, proof, lockKey),
      osRemove: (): Promise<void> => ipcRenderer.invoke(CHANNEL.appLockOsRemove),
      onLockRequest: (listener: () => void) => subscribe(CHANNEL.appLockRequest, listener),
    },
    httpCache: {
      /** Nobody is signed in any more. Only ever deletes, so anyone may ask. */
      clear: (): Promise<void> => ipcRenderer.invoke(CHANNEL.httpCacheClear),
    },
    shell: {
      openExternal: (url: string) => ipcRenderer.send(CHANNEL.shellOpenExternal, url),
      setLanguages: (languages: LanguagesUpdate) => ipcRenderer.send(CHANNEL.shellSetLanguages, languages),
    },
    spellcheck: {
      /** Languages with neither an OS checker nor a dictionary here. */
      missing: (): Promise<string[]> => ipcRenderer.invoke(CHANNEL.spellListMissing),
      onMissing: (listener: (language: string) => void) => subscribe(CHANNEL.spellMissing, listener),
      /** The user said yes: dictionaries may come from Google. Never with no-third-party mode on. */
      allowDownload: () => ipcRenderer.send(CHANNEL.spellAllowDownload),
    },
    dialogs: {
      /** A native question. Answers with the index of the button chosen. */
      confirm: (options: ConfirmOptions): Promise<number> => ipcRenderer.invoke(CHANNEL.dialogsConfirm, options),
      /**
       * A short question in a window of the app's own, modal to this one and drawn like the
       * page's dialogs. One at a time per page; the next waits. Null: closed unanswered.
       */
      show: (request: DialogWindowRequest): Promise<DialogWindowAnswer> => ipcRenderer.invoke(CHANNEL.dialogsShow, request),
      /** Takes back a question asked with `show`, showing or waiting. */
      cancel: (id: string) => ipcRenderer.send(CHANNEL.dialogsCancel, id),
      /**
       * Shows the dialog window this page opened as `window.open('', name)` (a name
       * `bulwark-dialog-…`; main made it a frameless modal child the size of this page)
       * once the page has drawn its dialog into it. False when there is no such window.
       */
      showWindow: (name: string): Promise<boolean> => ipcRenderer.invoke(CHANNEL.dialogsShowWindow, name),
    },
    print: {
      /**
       * The shell's print preview over this window: this page, a print window it opened as
       * `window.open('', 'bulwark-print-…')` (hidden by main), or a PDF. Resolves when it closes.
       */
      preview: (request: PrintPreviewRequest): Promise<PrintPreviewOutcome> => ipcRenderer.invoke(CHANNEL.printPreview, request),
      /** File > Print and Ctrl+P ask the page to run its own Print, instead of printing it as it stands. */
      onRequest: (listener: () => void) => {
        ipcRenderer.send(CHANNEL.printListen);
        return subscribe(CHANNEL.printRequested, listener);
      },
    },
    clipboard: {
      /** Puts a file on the clipboard, for pasting into a folder. False when that didn't work. */
      copyFile: (name: string, data: ArrayBuffer): Promise<boolean> => ipcRenderer.invoke(CHANNEL.clipboardCopyFile, name, data),
      /** Signed out: nothing copied from that account stays on disk. */
      clearFiles: () => ipcRenderer.send(CHANNEL.clipboardClearFiles),
    },
    updates: {
      state: (): Promise<UpdateState> => ipcRenderer.invoke(CHANNEL.updatesState),
      check: (): Promise<UpdateState> => ipcRenderer.invoke(CHANNEL.updatesCheck),
      setChannel: (channel: UpdateChannel): Promise<UpdateState> => ipcRenderer.invoke(CHANNEL.updatesSetChannel, channel),
      installOlder: (): Promise<UpdateState> => ipcRenderer.invoke(CHANNEL.updatesInstallOlder),
      restart: () => ipcRenderer.send(CHANNEL.updatesRestart),
      openDownload: () => ipcRenderer.send(CHANNEL.updatesOpenDownload),
      onChanged: (listener: (state: UpdateState) => void) => subscribe(CHANNEL.updatesChanged, listener),
    },
    localImport: {
      /** Asks the user natively before it looks. See src/main/features/import.ts. */
      scan: (): Promise<LocalImportScanResult> => ipcRenderer.invoke(CHANNEL.localImportScan),
      grant: (handles: string[]): Promise<LocalImportGrantResult> => ipcRenderer.invoke(CHANNEL.localImportGrant, handles),
      resume: (jobId: string): Promise<LocalImportResumeResult> => ipcRenderer.invoke(CHANNEL.localImportResume, jobId),
      release: (jobId: string): Promise<void> => ipcRenderer.invoke(CHANNEL.localImportRelease, jobId),
      releaseAll: (): Promise<void> => ipcRenderer.invoke(CHANNEL.localImportReleaseAll),
    },
    policy: {
      get: () => policySnapshot,
      onChange: (listener: (snapshot: PolicySnapshot) => void) => subscribe(CHANNEL.policyChanged, listener),
    },
    privacy: {
      get: () => ipcRenderer.invoke(CHANNEL.privacyGet),
      setTelemetry: (on: boolean) => ipcRenderer.invoke(CHANNEL.privacySetTelemetry, on),
      setCrashReports: (on: boolean) => ipcRenderer.invoke(CHANNEL.privacySetCrashReports, on),
      setCrashUploadUrl: (url: string) => ipcRenderer.invoke(CHANNEL.privacySetCrashUploadUrl, url, clicked()),
      listCrashes: () => ipcRenderer.invoke(CHANNEL.privacyListCrashes),
      sendCrash: (id: string) => ipcRenderer.invoke(CHANNEL.privacySendCrash, id),
      deleteCrashes: () => ipcRenderer.invoke(CHANNEL.privacyDeleteCrashes),
      onChange: (listener: (state: PrivacyState) => void) => subscribe(CHANNEL.privacyChanged, listener),
    },
    devTools: {
      get: (): Promise<DevToolsState> => ipcRenderer.invoke(CHANNEL.devToolsGet),
      // Main also needs its own record of a click to turn them on, and asks natively.
      set: (on: boolean): Promise<DevToolsState> => ipcRenderer.invoke(CHANNEL.devToolsSet, on),
      onChange: (listener: (state: DevToolsState) => void) => subscribe(CHANNEL.devToolsChanged, listener),
    },
    os: {
      /**
       * What the OS asks for: tray, jump list, toast buttons, opened files. Main holds
       * these until the main window's page subscribes, so a cold start loses nothing.
       * `messageFileWindows`: the page opens an .eml in a window of its own.
       */
      onCommand: (listener: (command: OsCommand) => void, options?: OsCommandOptions) => {
        const stop = subscribe(CHANNEL.osCommand, listener);
        ipcRenderer.send(CHANNEL.osSubscribe, { messageFileWindows: options?.messageFileWindows === true });
        return stop;
      },
      getStatus: (): Promise<OsStatus> => ipcRenderer.invoke(CHANNEL.osGetStatus),
      setSettings: (patch: Partial<OsSettings>): Promise<OsStatus> => ipcRenderer.invoke(CHANNEL.osSetSettings, patch, clicked()),
      setPaused: (until: number | null) => ipcRenderer.send(CHANNEL.osSetPaused, until),
      onStatusChange: (listener: (status: OsStatus) => void) => subscribe(CHANNEL.osStatusChanged, listener),
      setBadge: (count: number) => ipcRenderer.send(CHANNEL.osSetBadge, count),
      setSummary: (summary: OsSummary) => ipcRenderer.send(CHANNEL.osSetSummary, summary),
      setProgress: (progress: number | null, mode?: 'normal' | 'indeterminate' | 'paused' | 'error') =>
        ipcRenderer.send(CHANNEL.osSetProgress, progress, mode),
      setLocked: (locked: boolean) => ipcRenderer.send(CHANNEL.osSetLocked, locked),
      clearSurfaces: () => ipcRenderer.send(CHANNEL.osClearSurfaces),
      notify: (notification: OsNotification): Promise<OsNotifyResult> => ipcRenderer.invoke(CHANNEL.osNotify, notification),
      onPower: (listener: (event: OsPowerEvent) => void) => subscribe(CHANNEL.osPower, listener),
      startDrag: (files: OsFile[]): Promise<boolean> => ipcRenderer.invoke(CHANNEL.osStartDrag, files),
      copyFiles: (files: OsFile[]): Promise<boolean> => ipcRenderer.invoke(CHANNEL.osCopyFiles, files),
      defaultAppStatus: (): Promise<OsDefaultAppStatus> => ipcRenderer.invoke(CHANNEL.osDefaultAppStatus),
      openDefaultAppSettings: (): Promise<OsDefaultAppStatus> => ipcRenderer.invoke(CHANNEL.osDefaultAppOpen),
    },
    edit: {
      /** Whether this file may go through Edit at all: the same rule main enforces. */
      canEdit: (name: string) => editFileName(name, process.platform) !== null,
      begin: (key: string): Promise<EditBeginResult> => ipcRenderer.invoke(CHANNEL.editBegin, key),
      open: (ticket: string, file: EditFile): Promise<EditOpenResult> => ipcRenderer.invoke(CHANNEL.editOpen, ticket, file),
      reopen: (ticket: string, id: string): Promise<EditOpenResult> => ipcRenderer.invoke(CHANNEL.editReopen, ticket, id),
      list: (): Promise<EditSession[]> => ipcRenderer.invoke(CHANNEL.editList),
      /** The list after looking at each file now, for a decision that can't wait for the watcher. */
      settle: (): Promise<EditSession[]> => ipcRenderer.invoke(CHANNEL.editSettle),
      read: (id: string): Promise<EditReadResult> => ipcRenderer.invoke(CHANNEL.editRead, id),
      taken: (id: string, hash: string): Promise<void> => ipcRenderer.invoke(CHANNEL.editTaken, id, hash),
      /** The draft it was on has gone: deleted, unless it holds a save nobody took. */
      release: (id: string, source: string): Promise<void> => ipcRenderer.invoke(CHANNEL.editRelease, id, source),
      /** Asks natively if it holds edits. */
      discard: (id: string): Promise<EditClearResult> => ipcRenderer.invoke(CHANNEL.editDiscard, id),
      /** The organisation said no: no question. */
      forceDiscard: (id: string): Promise<EditClearResult> => ipcRenderer.invoke(CHANNEL.editForceDiscard, id),
      /** The question before a sign-out. A yes covers the `clear` that follows. */
      askClear: (account: string): Promise<boolean> => ipcRenderer.invoke(CHANNEL.editAskClear, account),
      clear: (account: string | null): Promise<EditClearResult> => ipcRenderer.invoke(CHANNEL.editClear, account),
      /** A wipe: no question. */
      wipe: (account: string | null): Promise<EditClearResult> => ipcRenderer.invoke(CHANNEL.editWipe, account),
      /** The page has shown a last offer. */
      shown: (id: string) => ipcRenderer.send(CHANNEL.editShown, id),
      setSource: (id: string, source: string) => ipcRenderer.send(CHANNEL.editSetSource, id, source),
      claim: (id: string, on: boolean) => ipcRenderer.send(CHANNEL.editClaim, id, on),
      onChange: (listener: (sessions: EditSession[]) => void) => subscribe(CHANNEL.editChanged, listener),
    },
    saveAs: {
      /**
       * File > Save as… and the message's "Save as…": asks where, natively, starting in the folder
       * used last. Main wants a click or menu pick of its own just before, and says no under the
       * organisation's "no exporting mail" and the app lock.
       */
      begin: (request: SaveAsRequest): Promise<SaveAsBegin> => ipcRenderer.invoke(CHANNEL.saveAsBegin, request, clicked()),
      /** The bytes of file `index` of the request. False when it couldn't be written. */
      write: (id: string, index: number, data: Uint8Array): Promise<boolean> => ipcRenderer.invoke(CHANNEL.saveAsWrite, id, index, data),
      end: (id: string): Promise<SaveAsResult> => ipcRenderer.invoke(CHANNEL.saveAsEnd, id),
    },
    recentFiles: {
      /** Main wants a click or key press of its own for each: a script alone gets `gesture`. */
      list: (): Promise<RecentFilesResult> => ipcRenderer.invoke(CHANNEL.recentFilesList),
      attach: (id: string): Promise<RecentFileAttachResult> => ipcRenderer.invoke(CHANNEL.recentFilesAttach, id),
    },
    lifecycle: {
      /**
       * Before a window closes or the app quits, main asks the page to save what it
       * has and waits a few seconds. A window with no handler closes at once.
       */
      onFlushRequest: (handler: () => Promise<unknown>) => {
        flushHandlers.add(handler);
        ipcRenderer.send(CHANNEL.lifecycleRegister, flushHandlers.size > 0);
        return () => {
          flushHandlers.delete(handler);
          ipcRenderer.send(CHANNEL.lifecycleRegister, flushHandlers.size > 0);
        };
      },
    },
  };

  // The page's sync engine takes these once, in its first render: see FilesControls.
  // Main takes them only from the main window, and checks every path against its root.
  const filesDrive: FilesDriveControls | undefined = platform === 'win32'
    ? {
        state: (): Promise<FilesDriveState> => ipcRenderer.invoke(CHANNEL.filesDriveState),
        onStateChange: (listener: (state: FilesDriveState) => void) => subscribe(CHANNEL.filesDriveStateChanged, listener),
        enable: (account: string, label: string) => ipcRenderer.invoke(CHANNEL.filesDriveEnable, account, label, clicked()),
        disable: (account: string, reason: 'user' | 'signed-out' | 'suspended' | 'wipe' | 'refused') => ipcRenderer.invoke(CHANNEL.filesDriveDisable, account, reason),
        onFlush: (listener: (request: { requestId: string; accounts: string[] }) => void) => subscribe(CHANNEL.filesDriveFlush, listener),
        flushed: (requestId: string, phase?: 'working') => ipcRenderer.send(CHANNEL.filesDriveFlushed, requestId, phase),
        openRescue: () => ipcRenderer.invoke(CHANNEL.filesDriveOpenRescue),
        setPin: (rootId: string, path: string, pin: 'pinned' | 'unpinned') => ipcRenderer.invoke(CHANNEL.filesDriveSetPin, rootId, path, pin),
        place: (rootId: string, entries: FilesPlaceholder[]) => ipcRenderer.invoke(CHANNEL.filesDrivePlace, rootId, entries),
        update: (rootId: string, path: string, meta: { size: number; mtimeMs: number; identity: string; dehydrate: boolean }, expect: FilesExpect | null) =>
          ipcRenderer.invoke(CHANNEL.filesDriveUpdate, rootId, path, meta, expect),
        markInSync: (rootId: string, path: string, identity: string, expect: FilesExpect) => ipcRenderer.invoke(CHANNEL.filesDriveMarkInSync, rootId, path, identity, expect),
        onFetch: (listener: (request: FilesFetchRequest) => void) => subscribe(CHANNEL.filesDriveFetch, listener),
        onFetchCancel: (listener: (fetchId: string) => void) => subscribe(CHANNEL.filesDriveFetchCancel, listener),
        supply: (fetchId: string, offset: number, data: Uint8Array) => ipcRenderer.invoke(CHANNEL.filesDriveSupply, fetchId, offset, data),
        fail: (fetchId: string, error: 'offline' | 'missing' | 'failed') => ipcRenderer.send(CHANNEL.filesDriveFail, fetchId, error),
        setLetter: (letter: string | null) => ipcRenderer.invoke(CHANNEL.filesDriveSetLetter, letter, clicked()),
        status: (account: string, status: FilesDriveStatus) => ipcRenderer.send(CHANNEL.filesDriveStatus, account, status),
      }
    : undefined;
  const filesControls: FilesControls = {
    roots: () => ipcRenderer.invoke(CHANNEL.filesRoots),
    addFolder: (request: { account: string; remoteId: string | null; remoteLabel: string; chosen?: string }) => ipcRenderer.invoke(CHANNEL.filesAddFolder, request, clicked()),
    chooseFolder: () => ipcRenderer.invoke(CHANNEL.filesChooseFolder, clicked()),
    removeRoot: (rootId: string) => ipcRenderer.invoke(CHANNEL.filesRemoveRoot, rootId),
    setPaused: (rootId: string, paused: boolean) => ipcRenderer.invoke(CHANNEL.filesSetPaused, rootId, paused),
    scan: (rootId: string, under?: string) => ipcRenderer.invoke(CHANNEL.filesScan, rootId, under),
    stat: (rootId: string, path: string) => ipcRenderer.invoke(CHANNEL.filesStat, rootId, path),
    openRead: (rootId: string, path: string) => ipcRenderer.invoke(CHANNEL.filesOpenRead, rootId, path),
    beginWrite: (rootId: string, path: string, options: { expect: FilesExpect | null; mtimeMs: number; size: number }) =>
      ipcRenderer.invoke(CHANNEL.filesBeginWrite, rootId, path, options),
    writeChunk: (writeId: string, data: Uint8Array) => ipcRenderer.invoke(CHANNEL.filesWriteChunk, writeId, data),
    commitWrite: (writeId: string) => ipcRenderer.invoke(CHANNEL.filesCommitWrite, writeId),
    abortWrite: (writeId: string) => ipcRenderer.invoke(CHANNEL.filesAbortWrite, writeId),
    mkdir: (rootId: string, path: string) => ipcRenderer.invoke(CHANNEL.filesMkdir, rootId, path),
    move: (rootId: string, from: string, to: string, expect: FilesExpect | null) => ipcRenderer.invoke(CHANNEL.filesMove, rootId, from, to, expect),
    remove: (rootId: string, path: string, expect: FilesExpect | null) => ipcRenderer.invoke(CHANNEL.filesRemove, rootId, path, expect),
    onChange: (listener: (event: FilesChangeEvent) => void) => subscribe(CHANNEL.filesChanged, listener),
    loadState: (rootId: string) => ipcRenderer.invoke(CHANNEL.filesLoadState, rootId),
    saveState: (rootId: string, state: string) => ipcRenderer.invoke(CHANNEL.filesSaveState, rootId, state),
    showInFolder: (rootId: string, path: string) => ipcRenderer.invoke(CHANNEL.filesShowInFolder, rootId, path),
    ...(filesDrive ? { drive: filesDrive } : {}),
  };
  const files = {
    files: {
      claim: (): FilesControls | null => {
        if (filesClaimed) return null;
        filesClaimed = true;
        return filesControls;
      },
    },
  };

  const standalone = mode === 'standalone'
    ? {
        servers: {
          prepare: (serverUrl: string) => ipcRenderer.invoke(CHANNEL.serversPrepare, serverUrl),
          noteSession: (serverUrl: string, urls: SessionUrls) => ipcRenderer.send(CHANNEL.serversNoteSession, serverUrl, urls),
          forget: (serverUrl: string, reason: 'failed' | 'signed-out') => ipcRenderer.send(CHANNEL.serversForget, serverUrl, reason),
        },
        plugins: {
          install: (slug: string, version?: string) => ipcRenderer.invoke(CHANNEL.pluginsInstall, slug, version),
        },
      }
    : {};

  // Only where the helper loaded and the OS has a keystore. Stays this narrow: see
  // src/main/features/keystore.ts.
  const keystore = argument(PRELOAD_ARG.keystore) === '1'
    ? {
        keystore: {
          list: (options?: KeystoreUseOptions) => keystoreAnswer<KeystoreCertificate[]>(ipcRenderer.invoke(CHANNEL.keystoreList, options)),
          sign: (id: string, signedAttributes: Uint8Array, scheme: KeystoreSignScheme) =>
            keystoreAnswer<Uint8Array>(ipcRenderer.invoke(CHANNEL.keystoreSign, id, signedAttributes, scheme)),
          decrypt: (id: string, data: Uint8Array, scheme: KeystoreDecryptScheme, options?: KeystoreUseOptions) =>
            keystoreAnswer<Uint8Array>(ipcRenderer.invoke(CHANNEL.keystoreDecrypt, id, data, scheme, options)),
          agree: (id: string, peerPublicKey: Uint8Array, options?: KeystoreUseOptions) =>
            keystoreAnswer<Uint8Array>(ipcRenderer.invoke(CHANNEL.keystoreAgree, id, peerPublicKey, options)),
          accessState: (): Promise<KeystoreAccessState> => ipcRenderer.invoke(CHANNEL.keystoreAccess),
          revokeAccess: (): Promise<void> => ipcRenderer.invoke(CHANNEL.keystoreRevoke),
          clearGrants: (): Promise<void> => ipcRenderer.invoke(CHANNEL.keystoreClearGrants),
        },
      }
    : {};

  contextBridge.exposeInMainWorld('bulwarkDesktop', { ...common, ...files, ...standalone, ...keystore });
}
