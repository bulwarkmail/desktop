/**
 * Print, everywhere in the app, through the shell's print preview (print-preview.ts).
 *
 * - The page asks with `print.preview`: itself (the calendar's and contacts' print copies),
 *   a print window it opened as `bulwark-print-…` (one message, a plugin's page), or a PDF.
 * - File > Print and Ctrl+P: a page that listens (`print.onRequest`) runs its own Print, so
 *   the preview gets its look and what it would print; a window that is a PDF shows the PDF;
 *   any other window is previewed as its print CSS lays it out.
 * - The print button of Chromium's PDF viewer in a window that is a PDF (pdf-viewer-print.ts).
 *
 * The page's menu state is the device policy here, as for the menu items: `file.print` off
 * takes the printers away, `file.savePdf` off takes Save as PDF away, both off and nothing
 * opens.
 */

import { app, BrowserWindow, webContents, type WebContents, type WebFrameMain } from 'electron';
import { CHANNEL, type MenuState, type PrintPreviewOutcome } from '../../shared/bridge';
import { framePdf, isWindowPdfViewer, printInViewer, watchPdfViewers, windowPdfViewer } from '../pdf-viewer-print';
import { PrintPreviews } from '../print-preview';
import { readPreviewRequest } from '../print-rules';
import type { Feature } from './index';

let previews: PrintPreviews | null = null;
const listening = new WeakSet<WebContents>();

function enabled(state: MenuState | undefined, id: 'file.print' | 'file.savePdf'): boolean {
  const entry = state?.[id];
  return (typeof entry === 'boolean' ? entry : entry?.enabled) !== false;
}

function allowedBy(state: MenuState | undefined): { print: boolean; pdf: boolean } {
  return { print: enabled(state, 'file.print'), pdf: enabled(state, 'file.savePdf') };
}

/** The print preview's windows, once the feature is set up. */
export function printPreviews(): PrintPreviews | null {
  return previews;
}

/** A window that is a PDF, as it is, in the preview. */
function previewPdfWindow(window: BrowserWindow, allowed: { print: boolean; pdf: boolean }): void {
  if (!previews || window.isDestroyed()) return;
  void previews.open({ parent: window, source: { kind: 'pdfWindow', contents: window.webContents }, title: window.getTitle(), allowed });
}

/** The PDF in a frame of `window`'s page (the file preview's), from its bytes. */
async function printFramePdf(window: BrowserWindow, viewer: WebFrameMain, allowed: { print: boolean; pdf: boolean }): Promise<void> {
  const pdf = await framePdf(window.webContents, viewer);
  if (!previews || window.isDestroyed()) return;
  if (!pdf) {
    printInViewer(viewer);
    return;
  }
  void previews.open({ parent: window, source: { kind: 'pdf', data: pdf.data }, title: pdf.title || window.getTitle(), allowed });
}

/**
 * File > Print and Ctrl+P on `window`. False when the preview isn't there to take it
 * (the caller prints the old way).
 */
export function printFromMenu(window: BrowserWindow, state: MenuState | undefined): boolean {
  if (!previews) return false;
  // The preview itself, or a question over the page: nothing to print there.
  if (previews.isPreviewWindow(window) || window.webContents.getURL().startsWith('data:')) return true;
  const allowed = allowedBy(state);
  if (!allowed.print && !allowed.pdf) return true;
  const contents = window.webContents;
  if (listening.has(contents)) {
    contents.send(CHANNEL.printRequested);
    return true;
  }
  if (windowPdfViewer(contents)) {
    previewPdfWindow(window, allowed);
    return true;
  }
  void previews.open({ parent: window, source: { kind: 'page', contents }, title: window.getTitle(), allowed });
  return true;
}

export const printFeature: Feature = {
  name: 'print',
  modes: ['standalone', 'instance'],
  setup(ctx) {
    previews = new PrintPreviews(ctx.state, () => {
      const colours = ctx.theme.colours();
      return { dark: colours.dark, background: colours.background, foreground: colours.symbol };
    });
    const own = previews;

    // The app's windows only: the preview's own viewer is on sessions of its own.
    const watchContents = (contents: WebContents) => {
      if (contents.session !== ctx.session) return;
      watchPdfViewers(contents, (viewer) => {
        const window = BrowserWindow.fromWebContents(contents);
        if (!window) return;
        const allowed = allowedBy(ctx.menu.commandState(window));
        if (isWindowPdfViewer(viewer)) previewPdfWindow(window, allowed);
        else void printFramePdf(window, viewer, allowed);
      });
    };
    app.on('web-contents-created', (_event, contents) => watchContents(contents));
    for (const contents of webContents.getAllWebContents()) watchContents(contents);

    ctx.handle(CHANNEL.printPreview, async (event, window, raw): Promise<PrintPreviewOutcome> => {
      const request = readPreviewRequest(raw);
      if (!window || !request) return 'refused';
      const allowed = allowedBy(ctx.menu.commandState(window));
      const title = request.title || window.getTitle();
      if (request.source === 'window') {
        const popup = own.takePopup(event.sender, request.name);
        if (!popup) return 'refused';
        return own.open({ parent: window, source: { kind: 'window', window: popup }, title, theme: request.theme, allowed });
      }
      if (request.source === 'pdf') return own.open({ parent: window, source: { kind: 'pdf', data: request.data }, title, theme: request.theme, allowed });
      return own.open({ parent: window, source: { kind: 'page', contents: event.sender }, title, theme: request.theme, allowed });
    });

    ctx.on(CHANNEL.printListen, (event) => {
      const contents = event.sender;
      if (listening.has(contents)) return;
      listening.add(contents);
      // A new document hasn't said it listens.
      const forget = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
        if (!details.isMainFrame || details.isSameDocument) return;
        listening.delete(contents);
        contents.off('did-start-navigation', forget);
      };
      contents.on('did-start-navigation', forget);
    });
  },
};
