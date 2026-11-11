/**
 * Print preview in a window of the app's own, as Chrome has one and Electron doesn't: the
 * OS's print dialog in Electron shows no pages ("This app doesn't support print preview"
 * on Windows), and macOS and Linux get the same bare dialog. So every Print in the app
 * comes here first: settings on the left, the pages as they will come out on the right.
 *
 * What it shows (a source): a print window the page opened hidden (one message, a plugin's
 * page, and in a current webmail the print copies of mail, calendar and contacts), a PDF
 * (the file viewer, a plugin's PDF), a window that is a PDF (an attachment opened in a window
 * of its own, pdf-viewer-print.ts), or a page of the app as its print CSS lays it out (File >
 * Print on a page that doesn't take it itself, an older webmail). Laying out a page that is
 * on screen moves it: at the sheet's width its width breakpoints match for a moment, and the
 * mail sidebar folded and unfolded at every change in the preview. So the webmail hands over
 * copies in hidden windows, and a page is the fallback only. The preview is
 * webContents.printToPDF of that source with the chosen options, shown in Chromium's own
 * PDF viewer inside the window's page. Print is webContents.print of the same source, silent,
 * with the same options; Save as PDF writes the PDF; "Print using system dialog…" is the
 * OS's dialog as before.
 *
 * The window is the shell's: a frameless, transparent child of the window it prints from,
 * modal to it, holding a card drawn like the app's dialogs (dialog-window.ts does the same
 * for questions). Its page (src/pages/print.html) has no node, is isolated and sandboxed,
 * on a session of its own that loads nothing from the network. The PDF it shows is a blob
 * of that page, so it runs in Chromium's PDF viewer with none of the page's privileges, and
 * the page's preload is only in its main frame. A PDF source loads in a hidden window on a
 * session of its own too.
 *
 * A printer must be one the OS listed. The choices are remembered per destination
 * (state.print). The device policy decides through the page's menu state: under "No
 * printing" neither printers nor Save as PDF are offered, and no window opens.
 */

import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, screen, session as electronSession, type IpcMainEvent, type IpcMainInvokeEvent, type Session, type WebContents } from 'electron';
import { CHANNEL, type PrintPreviewOutcome } from '../shared/bridge';
import { readLook, type DialogLook } from './dialog-window-rules';
import { holdParent, parentHeldByHand } from './parent-hold';
// Chromium's PDF viewer, the one extension the preview's sessions may load.
import { PDF_VIEWER } from './pdf-viewer-print';
import { pdfFileName } from './menu-text';
import { showMessageBox } from './message-box';
import { native } from './native';
import {
  countPdfPages,
  defaultChoices,
  devicePrintOptions,
  initialDestination,
  isEveryPage,
  localPaper,
  pageCount,
  parsePageRanges,
  pdfOptions,
  pdfPageRanges,
  previewBounds,
  printerPaper,
  readPrintChoices,
  remember,
  rememberedFor,
  sortPrinters,
  switchDestination,
  windowsDefaultPrinter,
  type DevicePrintOptions,
  type Destination,
  type PaperSize,
  type PrintChoices,
  type PrinterEntry,
} from './print-rules';
import { readString } from './registry-values';
import type { StateFile } from './state';
import { strings, uiLanguageNow } from './strings';

declare const __BULWARK_TEST_BUILD__: boolean;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRINT_PRELOAD = path.join(HERE, 'print-preload.cjs');
const PRINT_PAGE = path.join(HERE, 'pages', 'print.html');
const PREVIEW_PARTITION = 'bulwark-print';
const PDF_PARTITION = 'bulwark-print-pdf';
/** Where a PDF source is served from, inside its own session only. */
const PDF_URL = 'https://print.bulwark.invalid/document.pdf';
const MAX_PDF_BYTES = 200 * 1024 * 1024;
/** How long a print window may wait hidden for its page to ask for the preview. */
const POPUP_WAIT_MS = 60_000;
/** How long the source's pictures get to load before the first preview. */
const LOAD_WAIT_MS = 8_000;
const RTL = new Set(['ar', 'fa', 'he']);

/**
 * Test builds only: printers to list instead of the OS's, and print jobs recorded instead of
 * sent. A test sets it with app.evaluate before it opens a preview; nothing reaches a printer.
 */
interface FakePrinting {
  printers: { name: string; displayName?: string; options?: Record<string, string> }[];
  defaultPrinter?: string;
  jobs: { kind: 'printer' | 'system'; options: unknown }[];
  /** A job fails with this reason. */
  failWith?: string;
  /** Each PDF the preview showed, base64: the page's CSP keeps a test from reading its blob. */
  renders?: string[];
}

function fakePrinting(): FakePrinting | null {
  return __BULWARK_TEST_BUILD__ ? (globalThis as { __bulwarkFakePrinting?: FakePrinting }).__bulwarkFakePrinting ?? null : null;
}

type ShellLook = () => { dark: boolean; background?: string; foreground?: string };

export interface PrintSourceRequest {
  /** The window the preview hangs on. */
  parent: BrowserWindow;
  source:
    | { kind: 'page'; contents: WebContents }
    | { kind: 'window'; window: BrowserWindow }
    | { kind: 'pdf'; data: Uint8Array }
    /** A window of the app that is a PDF in Chromium's viewer: printed as it is, and left open. */
    | { kind: 'pdfWindow'; contents: WebContents };
  title: string;
  /** The page's look (DialogWindowTheme), unchecked. */
  theme?: unknown;
  allowed: { print: boolean; pdf: boolean };
}

interface Source {
  contents: WebContents;
  kind: 'html' | 'pdf';
  /** Ours to close when the preview is done: a print window, a PDF's window. */
  close?: () => void;
}

interface Preview {
  window: BrowserWindow;
  parent: BrowserWindow;
  source: Source;
  title: string;
  printers: PrinterEntry[];
  printerOptions: Map<string, Record<string, string>>;
  allowed: { print: boolean; pdf: boolean };
  look: DialogLook;
  lang: string;
  paper: PaperSize;
  initial: PrintChoices;
  cache: { key: string; data: Buffer; total: number } | null;
  /** One printToPDF at a time on a source. */
  queue: Promise<unknown>;
  resolve: (outcome: PrintPreviewOutcome) => void;
  settled: boolean;
  /** Printing or saving: the window is going, the source stays until it's done. */
  running: boolean;
  /** macOS: lets go of the parent kept behind the preview (parent-hold.ts). */
  release: (() => void) | null;
}

interface Popup {
  window: BrowserWindow;
  owner: number;
  timer: NodeJS.Timeout;
}

let pageUrl: string | null = null;
function printPageUrl(): string {
  // A data: page, as the dialog window's: with the grantFileProtocolExtraPrivileges fuse off a file: one doesn't run.
  pageUrl ??= `data:text/html;charset=utf-8;base64,${readFileSync(PRINT_PAGE).toString('base64')}`;
  return pageUrl;
}

function lockDown(session: Session, allow: (url: string) => boolean): Session {
  session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
  session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !allow(details.url) }));
  return session;
}

/** The PDF viewer: the extension and the browser's own scripts and styles it is built from. */
function viewerPart(url: string): boolean {
  return url.startsWith(PDF_VIEWER) || url.startsWith('chrome://resources/');
}

let previewSession: Session | null = null;
function previewPartition(): Session {
  // The page, the PDF blob it makes and the PDF viewer. Nothing over the network.
  previewSession ??= lockDown(electronSession.fromPartition(PREVIEW_PARTITION), (url) => url.startsWith('data:') || url.startsWith('blob:') || viewerPart(url));
  return previewSession;
}

let pdfSession: Session | null = null;
const pdfBytes = new Map<number, Uint8Array>();
function pdfPartition(): Session {
  if (pdfSession) return pdfSession;
  const session = lockDown(electronSession.fromPartition(PDF_PARTITION), (url) => url.startsWith(`${PDF_URL}?`) || viewerPart(url) || url.startsWith('blob:') || url.startsWith('data:'));
  // A PDF of any size: a data: URL stops at 2 MB. Each window gets its own bytes.
  session.protocol.handle('https', (request) => {
    const contentsId = Number(new URL(request.url).searchParams.get('w'));
    const bytes = request.url.startsWith(PDF_URL) ? pdfBytes.get(contentsId) : undefined;
    if (!bytes) return new Response(null, { status: 404 });
    return new Response(Buffer.from(bytes), { headers: { 'content-type': 'application/pdf', 'cache-control': 'no-store' } });
  });
  pdfSession = session;
  return session;
}

/** The PDF in a hidden window, where printToPDF and print go through Chromium's PDF viewer. */
async function pdfSource(data: Uint8Array): Promise<Source> {
  const window = new BrowserWindow({
    show: false,
    width: 800,
    height: 1000,
    webPreferences: { session: pdfPartition(), sandbox: true, contextIsolation: true, nodeIntegration: false, plugins: true, spellcheck: false, devTools: false },
  });
  const id = window.webContents.id;
  pdfBytes.set(id, data);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  const close = () => {
    pdfBytes.delete(id);
    if (!window.isDestroyed()) window.destroy();
  };
  window.once('closed', () => pdfBytes.delete(id));
  await window.loadURL(`${PDF_URL}?w=${id}`);
  // The viewer lays the pages out after the load.
  await new Promise((resolve) => setTimeout(resolve, 600));
  return { contents: window.webContents, kind: 'pdf', close };
}

/** Until the source's pictures are in, as far as Chromium knows, or a few seconds. */
function loaded(contents: WebContents): Promise<void> {
  if (contents.isDestroyed() || !contents.isLoading()) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, LOAD_WAIT_MS);
    function done() {
      clearTimeout(timer);
      if (!contents.isDestroyed()) contents.off('did-stop-loading', done);
      resolve();
    }
    contents.once('did-stop-loading', done);
  });
}

async function listPrinters(contents: WebContents): Promise<{ printers: PrinterEntry[]; options: Map<string, Record<string, string>> }> {
  const fake = fakePrinting();
  let list: { name: string; displayName?: string; options?: Record<string, string> }[] = [];
  let defaultName: string | null = null;
  if (fake) {
    list = fake.printers;
    defaultName = fake.defaultPrinter ?? null;
  } else {
    try {
      list = (await contents.getPrintersAsync()) as unknown as typeof list;
    } catch {
      list = [];
    }
    // Electron doesn't say which is the default any more. Windows keeps it here; CUPS says it in the options.
    if (process.platform === 'win32') {
      defaultName = windowsDefaultPrinter(readString(native().system.registry, 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\Windows', 'Device'));
    }
  }
  const printers = sortPrinters(list, defaultName);
  const options = new Map<string, Record<string, string>>();
  for (const printer of list) if (printer.options && typeof printer.options === 'object') options.set(printer.name, printer.options);
  return { printers, options };
}

/** The shell's text for the preview's page: the `print…` strings, in the app's language. */
function printStrings(): Record<string, string> {
  const all = strings() as unknown as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(all)) if (key.startsWith('print') && typeof value === 'string') out[key] = value;
  return out;
}

export class PrintPreviews {
  /** By the preview window's webContents id. */
  private previews = new Map<number, Preview>();
  /** Print windows a page opened, waiting for it to ask for their preview. By name. */
  private popups = new Map<string, Popup>();
  private lastTheme: unknown;

  constructor(private readonly state: StateFile, private readonly shellLook: ShellLook) {
    ipcMain.handle(CHANNEL.printWindowSpec, (event) => {
      const preview = this.fromPage(event);
      return preview ? this.spec(preview) : null;
    });
    ipcMain.handle(CHANNEL.printWindowChoices, (event, destination, current) => {
      const preview = this.fromPage(event);
      return preview ? this.choicesFor(preview, destination, current) : null;
    });
    ipcMain.handle(CHANNEL.printWindowRender, (event, choices) => {
      const preview = this.fromPage(event);
      return preview ? this.render(preview, choices) : { ok: false, error: 'failed' };
    });
    ipcMain.on(CHANNEL.printWindowReady, (event) => {
      const preview = this.fromPage(event);
      if (preview && !preview.window.isVisible()) {
        preview.window.show();
        preview.window.focus();
      }
    });
    ipcMain.handle(CHANNEL.printWindowRun, (event, action, choices) => {
      const preview = this.fromPage(event);
      return preview ? this.run(preview, action, choices) : false;
    });
  }

  /** Only the preview's own page, its main frame, on the data: page it was given. */
  private fromPage(event: IpcMainEvent | IpcMainInvokeEvent): Preview | undefined {
    const preview = this.previews.get(event.sender.id);
    const frame = event.senderFrame;
    if (!preview || !frame || frame.parent || !frame.url.startsWith('data:') || preview.running) return undefined;
    return preview.window.webContents === event.sender ? preview : undefined;
  }

  /** A window the page opened as `bulwark-print-…`: hidden, and kept for its preview a while. */
  adoptPopup(child: BrowserWindow, opener: WebContents, name: string): void {
    this.popups.get(name)?.window.destroy();
    child.setMenu(null);
    child.setSkipTaskbar(true);
    // A page's focus() on it would bring it up: it is never meant to be seen.
    child.on('show', () => child.hide());
    const timer = setTimeout(() => this.dropPopup(name, child), POPUP_WAIT_MS);
    timer.unref?.();
    this.popups.set(name, { window: child, owner: opener.id, timer });
    child.once('closed', () => {
      if (this.popups.get(name)?.window === child) this.popups.delete(name);
    });
    opener.once('destroyed', () => this.dropPopup(name, child));
  }

  private dropPopup(name: string, window: BrowserWindow): void {
    const popup = this.popups.get(name);
    if (popup?.window !== window) return;
    clearTimeout(popup.timer);
    this.popups.delete(name);
    if (!window.isDestroyed()) window.destroy();
  }

  /** The print window `name`, if `owner` opened it. Taken: the preview owns it from here. */
  takePopup(owner: WebContents, name: unknown): BrowserWindow | null {
    if (typeof name !== 'string') return null;
    const popup = this.popups.get(name);
    if (!popup || popup.owner !== owner.id || popup.window.isDestroyed()) return null;
    clearTimeout(popup.timer);
    this.popups.delete(name);
    return popup.window;
  }

  /** The preview window over `parent`, or `window` itself being one. */
  isPreviewWindow(window: BrowserWindow): boolean {
    return [...this.previews.values()].some((preview) => preview.window === window);
  }

  private openOver(parent: BrowserWindow): Preview | undefined {
    return [...this.previews.values()].find((preview) => preview.parent === parent && !preview.settled);
  }

  /** Opens the preview. Resolves when it is done: printed, saved, handed to the OS's dialog, or closed. */
  async open(request: PrintSourceRequest): Promise<PrintPreviewOutcome> {
    const { parent, allowed } = request;
    const dropSource = () => {
      if (request.source.kind === 'window' && !request.source.window.isDestroyed()) request.source.window.destroy();
    };
    if (parent.isDestroyed() || (!allowed.print && !allowed.pdf)) {
      dropSource();
      return 'refused';
    }
    const open = this.openOver(parent);
    if (open) {
      open.window.focus();
      dropSource();
      return 'busy';
    }
    if (request.theme !== undefined) this.lastTheme = request.theme;

    let source: Source;
    if (request.source.kind === 'page') {
      source = { contents: request.source.contents, kind: 'html' };
    } else if (request.source.kind === 'pdfWindow') {
      source = { contents: request.source.contents, kind: 'pdf' };
    } else if (request.source.kind === 'window') {
      const popup = request.source.window;
      source = { contents: popup.webContents, kind: 'html', close: () => { if (!popup.isDestroyed()) popup.destroy(); } };
      await loaded(popup.webContents);
    } else {
      if (request.source.data.byteLength === 0 || request.source.data.byteLength > MAX_PDF_BYTES) return 'refused';
      source = await pdfSource(request.source.data);
    }
    if (source.contents.isDestroyed() || parent.isDestroyed()) {
      source.close?.();
      return 'failed';
    }

    const { printers, options } = allowed.print ? await listPrinters(source.contents) : { printers: [], options: new Map() };
    const memory = this.state.data.print;
    const destination = initialDestination(printers, memory, { print: allowed.print && printers.length > 0, pdf: allowed.pdf });
    if (!destination) {
      source.close?.();
      return 'refused';
    }
    const language = uiLanguageNow();
    const paper = localPaper(app.getLocaleCountryCode?.() || undefined);
    const shell = this.shellLook();
    const theme = request.theme ?? this.lastTheme ?? { dark: shell.dark, colours: { ...(shell.background ? { background: shell.background } : {}), ...(shell.foreground ? { foreground: shell.foreground } : {}) } };

    return new Promise<PrintPreviewOutcome>((resolve) => {
      const byHand = parentHeldByHand();
      const display = screen.getDisplayMatching(parent.getBounds());
      const window = new BrowserWindow({
        parent,
        modal: !byHand,
        show: false,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        hasShadow: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        title: strings().printTitle,
        ...previewBounds(parent.getBounds(), display.workArea),
        webPreferences: {
          preload: PRINT_PRELOAD,
          session: previewPartition(),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
          // Chromium's PDF viewer, for the pages.
          plugins: true,
          spellcheck: false,
          devTools: false,
          zoomFactor: 1,
        },
      });
      window.setMenu(null);
      const preview: Preview = {
        window,
        parent,
        source,
        title: request.title,
        printers,
        printerOptions: options,
        allowed: { print: allowed.print && printers.length > 0, pdf: allowed.pdf },
        look: readLook(theme),
        lang: language,
        paper,
        initial: defaultChoices(destination, rememberedFor(memory, destination), this.paperFor({ printerOptions: options, paper }, destination)),
        cache: null,
        queue: Promise.resolve(),
        resolve,
        settled: false,
        running: false,
        release: null,
      };
      const contentsId = window.webContents.id;
      this.previews.set(contentsId, preview);
      window.webContents.on('will-navigate', (event) => event.preventDefault());
      window.webContents.on('will-redirect', (event) => event.preventDefault());
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.on('closed', () => {
        this.previews.delete(contentsId);
        preview.release?.();
        if (!preview.running) this.settle(preview, 'cancelled');
      });
      // The page the source belongs to went: nothing left to print.
      const gone = () => this.close(preview, 'cancelled');
      source.contents.once('destroyed', gone);
      parent.once('closed', gone);
      if (byHand) preview.release = holdParent(parent, window);
      void window.loadURL(printPageUrl());
    });
  }

  private paperFor(preview: Pick<Preview, 'printerOptions' | 'paper'>, destination: Destination): PaperSize {
    return destination.kind === 'printer' ? printerPaper(preview.printerOptions.get(destination.name)) ?? preview.paper : preview.paper;
  }

  private spec(preview: Preview) {
    const lang = preview.lang;
    return {
      lang,
      dir: RTL.has(lang.split('-')[0]) ? 'rtl' : 'ltr',
      theme: preview.look,
      text: printStrings(),
      kind: preview.source.kind,
      printers: preview.allowed.print ? preview.printers.map(({ name, displayName, isDefault }) => ({ name, displayName, isDefault })) : [],
      pdf: preview.allowed.pdf,
      choices: preview.initial,
    };
  }

  /** The choices when another destination is picked: what was used there last, else what is chosen now. */
  private choicesFor(preview: Preview, raw: unknown, current: unknown): PrintChoices | null {
    const value = (raw && typeof raw === 'object' ? raw : {}) as { kind?: unknown; name?: unknown };
    let destination: Destination | null = null;
    if (value.kind === 'pdf' && preview.allowed.pdf) destination = { kind: 'pdf' };
    else if (value.kind === 'printer' && preview.allowed.print && preview.printers.some((printer) => printer.name === value.name)) destination = { kind: 'printer', name: value.name as string };
    if (!destination) return null;
    const paper = this.paperFor(preview, destination);
    const now = this.readChoices(preview, current) ?? defaultChoices(destination, undefined, paper);
    return switchDestination(now, destination, rememberedFor(this.state.data.print, destination), paper);
  }

  private readChoices(preview: Preview, raw: unknown): PrintChoices | null {
    return readPrintChoices(raw, { printers: preview.printers, allowed: preview.allowed });
  }

  private pdfOptionsFor(preview: Preview, choices: PrintChoices) {
    return pdfOptions(choices, {
      paper: this.paperFor(preview, choices.destination),
      title: preview.title,
      date: new Date().toLocaleDateString(preview.lang),
      source: preview.source.kind,
    });
  }

  /** printToPDF, one at a time per source. */
  private printToPdf(preview: Preview, options: Electron.PrintToPDFOptions): Promise<Buffer> {
    const run = preview.queue.then(() => {
      if (preview.source.contents.isDestroyed()) throw new Error('gone');
      return preview.source.contents.printToPDF(options);
    });
    preview.queue = run.catch(() => undefined);
    return run;
  }

  /** The whole document with these options, kept while they stay the same: page ranges are cut from it. */
  private async whole(preview: Preview, choices: PrintChoices): Promise<{ key: string; data: Buffer; total: number; options: Electron.PrintToPDFOptions }> {
    const options = this.pdfOptionsFor(preview, choices) as Electron.PrintToPDFOptions;
    // The date in the header changes nothing worth a new render.
    const key = JSON.stringify({ ...options, headerTemplate: options.headerTemplate ? preview.title : undefined });
    if (preview.cache?.key !== key) {
      const data = await this.printToPdf(preview, options);
      preview.cache = { key, data, total: countPdfPages(data) };
    }
    return { ...preview.cache, options };
  }

  private async pdfFor(preview: Preview, choices: PrintChoices): Promise<{ ok: true; data: Buffer; pages: number; total: number } | { ok: false; error: 'pages'; total: number }> {
    const whole = await this.whole(preview, choices);
    const ranges = parsePageRanges(choices.pages, whole.total);
    if (!ranges) return { ok: false, error: 'pages', total: whole.total };
    if (isEveryPage(ranges, whole.total)) return { ok: true, data: whole.data, pages: whole.total, total: whole.total };
    const data = await this.printToPdf(preview, { ...whole.options, pageRanges: pdfPageRanges(ranges) });
    return { ok: true, data, pages: pageCount(ranges), total: whole.total };
  }

  private async render(preview: Preview, raw: unknown) {
    const choices = this.readChoices(preview, raw);
    if (!choices) return { ok: false, error: 'failed' };
    try {
      const result = await this.pdfFor(preview, choices);
      if (!result.ok) return result;
      fakePrinting()?.renders?.push(result.data.toString('base64'));
      return { ok: true, data: new Uint8Array(result.data), pages: result.pages, total: result.total };
    } catch {
      return { ok: false, error: 'failed' };
    }
  }

  private remember(choices: PrintChoices): void {
    this.state.data.print = remember(this.state.data.print, choices);
    this.state.touch();
  }

  /** The page's buttons. False keeps the window open: the save dialog was closed, the pages don't exist. */
  private async run(preview: Preview, action: unknown, raw: unknown): Promise<boolean> {
    if (action === 'cancel') {
      this.close(preview, 'cancelled');
      return true;
    }
    if (action === 'system') {
      this.hide(preview);
      const outcome = await this.systemDialog(preview);
      this.close(preview, outcome);
      return true;
    }
    const choices = this.readChoices(preview, raw);
    if (!choices) return false;
    if (action === 'print' && choices.destination.kind === 'printer') {
      let whole;
      try {
        whole = await this.whole(preview, choices);
      } catch {
        return false;
      }
      const ranges = parsePageRanges(choices.pages, whole.total);
      const options = ranges ? devicePrintOptions(choices, ranges, whole.total, preview.title) : null;
      if (!options) return false;
      this.remember(choices);
      this.hide(preview);
      const outcome = await this.print(preview, options);
      this.close(preview, outcome);
      return true;
    }
    if (action === 'save' && choices.destination.kind === 'pdf') {
      let result;
      try {
        result = await this.pdfFor(preview, choices);
      } catch {
        return false;
      }
      if (!result.ok) return false;
      const answer = await dialog.showSaveDialog(preview.window, {
        defaultPath: pdfFileName(preview.title),
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (answer.canceled || !answer.filePath || preview.settled) return false;
      this.remember(choices);
      this.hide(preview);
      try {
        await writeFile(answer.filePath, result.data);
      } catch {
        this.close(preview, 'failed');
        return true;
      }
      this.close(preview, 'saved');
      return true;
    }
    return false;
  }

  private print(preview: Preview, options: DevicePrintOptions): Promise<PrintPreviewOutcome> {
    const contents = preview.source.contents;
    const fake = fakePrinting();
    if (fake) {
      fake.jobs.push({ kind: 'printer', options });
      return Promise.resolve(fake.failWith ? this.failed(preview, fake.failWith) : 'printed');
    }
    if (contents.isDestroyed()) return Promise.resolve('failed');
    return new Promise((resolve) => {
      contents.print(options, (success, reason) => {
        resolve(success ? 'printed' : this.failed(preview, reason));
      });
    });
  }

  /** Says so, unless the user cancelled it in the OS's own queue. */
  private failed(preview: Preview, reason: string): PrintPreviewOutcome {
    if (/cancel/i.test(reason)) return 'cancelled';
    const text = strings();
    const parent = preview.parent.isDestroyed() ? null : preview.parent;
    void showMessageBox(parent, { type: 'warning', message: text.printFailedTitle, detail: text.printFailedDetail, buttons: [text.ok] });
    return 'failed';
  }

  /** The OS's own print dialog, as before the preview. */
  private systemDialog(preview: Preview): Promise<PrintPreviewOutcome> {
    const contents = preview.source.contents;
    const fake = fakePrinting();
    if (fake) {
      fake.jobs.push({ kind: 'system', options: { silent: false, printBackground: true } });
      return Promise.resolve('system');
    }
    if (contents.isDestroyed()) return Promise.resolve('failed');
    return new Promise((resolve) => {
      contents.print({ silent: false, printBackground: true }, (success) => resolve(success ? 'system' : 'cancelled'));
    });
  }

  /** The window goes; the source stays until the job is out. */
  private hide(preview: Preview): void {
    preview.running = true;
    if (!preview.window.isDestroyed()) preview.window.destroy();
    this.refocus(preview);
  }

  private refocus(preview: Preview): void {
    preview.release?.();
    if (preview.parent.isDestroyed()) return;
    preview.parent.focus();
  }

  private close(preview: Preview, outcome: PrintPreviewOutcome): void {
    if (!preview.window.isDestroyed()) preview.window.destroy();
    this.refocus(preview);
    this.settle(preview, outcome);
  }

  private settle(preview: Preview, outcome: PrintPreviewOutcome): void {
    if (preview.settled) return;
    preview.settled = true;
    for (const [id, entry] of this.previews) if (entry === preview) this.previews.delete(id);
    preview.source.close?.();
    preview.resolve(outcome);
  }
}

