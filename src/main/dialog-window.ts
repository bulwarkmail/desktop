/**
 * Short questions in a window of their own: a frameless, transparent child of the page's
 * window, modal to it, holding a card drawn like the app's in-page dialog. It feels like
 * an app window rather than a box inside the page, and still looks like Bulwark.
 *
 * Two kinds ask: a page through the bridge (dialogs.show), and the shell itself through
 * message-box.ts, which stands in for Electron's dialog.showMessageBox. A shell question
 * may have no window to hang on (the app starting, every window hidden): it is a window of
 * its own then, centred on the screen and in the taskbar.
 *
 * The window loads only the shell's own data: page (src/pages/dialog.html), with no node,
 * isolated and sandboxed, on a session of its own. It works without the webmail's server.
 * It gets its text through src/preload/dialog.ts and draws it with textContent. Its answer
 * goes to the call that asked and nowhere else. One dialog per asker at a time; the next
 * waits. A page that navigates away, or a window that closes, cancels its dialogs.
 *
 * macOS: `modal` would make it a sheet sliding out of the title bar, so there the parent
 * is held by hand instead (parent-hold.ts).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, ipcMain, screen, session as electronSession, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { CHANNEL, type DialogWindowAnswer } from '../shared/bridge';
import { DIALOG_CARD_WIDTH, DIALOG_SHADOW_MARGIN, dialogBounds, dialogZoom, readDialogAnswer, readDialogRequest, type DialogSpec } from './dialog-window-rules';
import { holdParent, parentHeldByHand } from './parent-hold';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIALOG_PRELOAD = path.join(HERE, 'dialog-preload.cjs');
const DIALOG_PAGE = path.join(HERE, 'pages', 'dialog.html');
const PARTITION = 'bulwark-dialog';
/** Waiting and showing, per page. Past this a loop of questions gets "closed" and no window. */
export const MAX_DIALOGS_PER_PAGE = 3;

interface Entry {
  id: string;
  spec: DialogSpec;
  /** Whose queue it is in: a page, or the shell for a window (or for none). */
  owner: string;
  /** The page that asked; none for the shell's own questions. */
  sender: WebContents | null;
  parent: BrowserWindow | null;
  resolve: (answer: DialogWindowAnswer) => void;
  window?: BrowserWindow;
  /** Lets go of the parent holdParent kept behind the question. */
  release?: () => void;
  settled: boolean;
}

let pageUrl: string | null = null;
function dialogPageUrl(): string {
  // A data: page: with the grantFileProtocolExtraPrivileges fuse off, a file: one doesn't run.
  pageUrl ??= `data:text/html;charset=utf-8;base64,${readFileSync(DIALOG_PAGE).toString('base64')}`;
  return pageUrl;
}

function dialogSession(): Electron.Session {
  const session = electronSession.fromPartition(PARTITION);
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  // Nothing in the page asks for anything over the network; this makes sure.
  session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith('data:') }));
  return session;
}

/** A window a dialog can hang on: there, and on screen. */
function usableParent(parent: BrowserWindow | null | undefined): BrowserWindow | null {
  return parent && !parent.isDestroyed() && parent.isVisible() && !parent.isMinimized() ? parent : null;
}

let shellCounter = 0;

export class DialogWindows {
  /** By asker: the showing dialog first, then those waiting. */
  private queues = new Map<string, Entry[]>();
  /** By the dialog window's webContents id. */
  private shown = new Map<number, Entry>();
  private watched = new WeakSet<WebContents>();
  private watchedParents = new WeakSet<BrowserWindow>();
  private session: Electron.Session | null = null;

  constructor() {
    ipcMain.handle(CHANNEL.dialogWindowSpec, (event) => this.fromDialog(event)?.spec ?? null);
    ipcMain.on(CHANNEL.dialogWindowReady, (event, size) => this.ready(event, size));
    ipcMain.on(CHANNEL.dialogWindowAnswer, (event, answer) => {
      const entry = this.fromDialog(event);
      if (!entry) return;
      const checked = readDialogAnswer(answer, entry.spec);
      if (checked !== undefined) this.settle(entry, checked);
    });
  }

  /** Only the dialog's own page, its main frame, on the data: page it was given. */
  private fromDialog(event: IpcMainEvent | IpcMainInvokeEvent): Entry | undefined {
    const entry = this.shown.get(event.sender.id);
    const frame = event.senderFrame;
    if (!entry || !frame || frame.parent || !frame.url.startsWith('data:')) return undefined;
    return entry.window?.webContents === event.sender ? entry : undefined;
  }

  /** A page asks in a window over `parent`. Resolves with the answer, or null when it went unanswered. */
  ask(sender: WebContents, parent: BrowserWindow | null, request: unknown): Promise<DialogWindowAnswer> {
    const spec = readDialogRequest(request);
    if (!spec) return Promise.reject(new Error('Not a question'));
    if (!parent || parent.isDestroyed() || sender.isDestroyed()) return Promise.resolve(null);
    const owner = `page:${sender.id}`;
    const queue = this.queues.get(owner) ?? [];
    if (queue.length >= MAX_DIALOGS_PER_PAGE) return Promise.resolve(null);
    // A second dialog with the same name would make cancel() ambiguous.
    if (queue.some((entry) => entry.id === spec.id)) return Promise.reject(new Error('Already asking'));
    this.watch(sender, owner);
    this.watchParent(parent, owner);
    // Over the page the same dialog closes on a click on its backdrop.
    return this.enqueue(owner, { ...spec, outsideCancels: true }, sender, parent);
  }

  /**
   * The shell asks (message-box.ts): over `parent` when it is on screen, else in a window
   * of its own. `signal` takes the question back.
   */
  askShell(parent: BrowserWindow | null, request: object, signal?: AbortSignal): Promise<DialogWindowAnswer> {
    shellCounter += 1;
    const spec = readDialogRequest({ ...request, id: `shell-${shellCounter}` }, { shell: true });
    if (!spec) return Promise.reject(new Error('Not a question'));
    if (signal?.aborted) return Promise.resolve(null);
    const hangOn = usableParent(parent);
    const owner = hangOn ? `shell:${hangOn.id}` : 'shell';
    if (hangOn) this.watchParent(hangOn, owner);
    const asked = this.enqueue(owner, spec, null, hangOn);
    signal?.addEventListener('abort', () => {
      const entry = this.queues.get(owner)?.find((candidate) => candidate.id === spec.id);
      if (entry) this.settle(entry, null);
    }, { once: true });
    return asked;
  }

  private enqueue(owner: string, spec: DialogSpec & { id: string }, sender: WebContents | null, parent: BrowserWindow | null): Promise<DialogWindowAnswer> {
    const queue = this.queues.get(owner) ?? [];
    return new Promise((resolve) => {
      const { id, ...rest } = spec;
      queue.push({ id, spec: rest, owner, sender, parent, resolve, settled: false });
      this.queues.set(owner, queue);
      if (queue.length === 1) this.show(queue[0]);
    });
  }

  /** The page took its question back (the in-page state it belonged to went). */
  cancel(sender: WebContents, id: unknown): void {
    const entry = this.queues.get(`page:${sender.id}`)?.find((candidate) => candidate.id === id);
    if (entry) this.settle(entry, null);
  }

  private cancelAll(owner: string): void {
    for (const entry of [...(this.queues.get(owner) ?? [])]) this.settle(entry, null);
  }

  private watch(sender: WebContents, owner: string): void {
    if (this.watched.has(sender)) return;
    this.watched.add(sender);
    // A new document: whatever asked is gone. A route change inside the app isn't one.
    sender.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) this.cancelAll(owner);
    });
    sender.on('render-process-gone', () => this.cancelAll(owner));
    sender.once('destroyed', () => this.cancelAll(owner));
  }

  /** A window that closes takes every question hanging on it with it, whoever asked. */
  private watchParent(parent: BrowserWindow, owner: string): void {
    if (this.watchedParents.has(parent)) return;
    this.watchedParents.add(parent);
    parent.once('closed', () => {
      this.cancelAll(owner);
      for (const queue of [...this.queues.values()]) {
        for (const entry of [...queue]) if (entry.parent === parent) this.settle(entry, null);
      }
    });
  }

  private show(entry: Entry): void {
    const { parent } = entry;
    if (entry.settled) return;
    if (parent?.isDestroyed()) {
      this.settle(entry, null);
      return;
    }
    // A page's window still on its way up: the question comes with it, not on its own before it.
    if (parent && entry.sender && !parent.isVisible()) {
      parent.once('show', () => this.show(entry));
      return;
    }
    this.session ??= dialogSession();
    // The page's zoom goes to the card as CSS zoom, so it is there before the card is
    // measured; Chromium's own zoom would come later. The window itself stays at 100%.
    const zoom = entry.sender && !entry.sender.isDestroyed() ? dialogZoom(entry.sender.getZoomFactor()) : 1;
    entry.spec = { ...entry.spec, zoom };
    const workArea = (parent ? screen.getDisplayMatching(parent.getBounds()) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())).workArea;
    const byHand = parentHeldByHand();
    const window = new BrowserWindow({
      ...(parent ? { parent, modal: !byHand } : {}),
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      // Without a window behind it, it is one the user has to be able to find.
      skipTaskbar: !!parent,
      title: entry.spec.title,
      width: Math.ceil((DIALOG_CARD_WIDTH + 2 * DIALOG_SHADOW_MARGIN) * zoom),
      height: Math.min(workArea.height, 900),
      webPreferences: {
        preload: DIALOG_PRELOAD,
        session: this.session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        spellcheck: false,
        devTools: false,
        zoomFactor: 1,
      },
    });
    window.setMenu(null);
    entry.window = window;
    const contentsId = window.webContents.id;
    this.shown.set(contentsId, entry);
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.on('will-redirect', (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    // Alt+F4, Cmd+W, the OS closing it: no answer.
    window.on('closed', () => {
      this.shown.delete(contentsId);
      this.settle(entry, null);
    });
    if (byHand && parent) entry.release = holdParent(parent, window);
    void window.loadURL(dialogPageUrl());
  }

  /** The page measured its card: size the window to it, centre it on the parent (or the screen), show it. */
  private ready(event: IpcMainEvent, size: unknown): void {
    const entry = this.fromDialog(event);
    const window = entry?.window;
    if (!entry || !window || window.isDestroyed()) return;
    // The card and its margin as drawn, zoom included: at 100% its CSS pixels are the window's.
    const content = (size && typeof size === 'object' ? size : {}) as { width?: unknown; height?: unknown };
    const width = typeof content.width === 'number' && content.width > 0 ? Math.min(content.width, 6000) : DIALOG_CARD_WIDTH + 2 * DIALOG_SHADOW_MARGIN;
    const height = typeof content.height === 'number' && content.height > 0 ? Math.min(content.height, 6000) : 300;
    const parent = entry.parent && !entry.parent.isDestroyed() ? entry.parent : null;
    const display = parent ? screen.getDisplayMatching(parent.getBounds()) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    window.setBounds(dialogBounds({ width, height }, parent ? parent.getBounds() : display.workArea, display.workArea));
    if (window.isVisible()) return;
    window.show();
    window.focus();
  }

  private settle(entry: Entry, answer: DialogWindowAnswer): void {
    if (entry.settled) return;
    entry.settled = true;
    const queue = this.queues.get(entry.owner) ?? [];
    const index = queue.indexOf(entry);
    const wasShowing = index === 0;
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) this.queues.delete(entry.owner);
    const { window, parent } = entry;
    if (window) {
      for (const [id, shown] of this.shown) if (shown === entry) this.shown.delete(id);
      entry.release?.();
      if (!window.isDestroyed()) window.destroy();
      // The focus goes back to the window behind, where it was before.
      if (parent && !parent.isDestroyed()) {
        parent.focus();
        if (entry.sender && !entry.sender.isDestroyed()) entry.sender.focus();
      }
    }
    entry.resolve(answer);
    if (wasShowing && queue.length > 0) this.show(queue[0]);
  }
}

let instance: DialogWindows | null = null;

/** The one set of dialog windows: its IPC handlers exist once. */
export function dialogWindows(): DialogWindows {
  instance ??= new DialogWindows();
  return instance;
}
