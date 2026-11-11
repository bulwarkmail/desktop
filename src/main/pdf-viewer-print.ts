/**
 * Print from Chromium's PDF viewer through the app's print (Windows' dialog with the pages, or
 * the app's preview). The viewer's print button goes straight to the OS's dialog, which shows
 * no pages under Electron, and Electron has no event for it. So the shell swaps the viewer's
 * print, inside the viewer's own frame, for an answer to a call it keeps waiting.
 *
 * Two viewers are taken: a window of the app that is a PDF (a mail attachment opened in a
 * window of its own), printed as the window is, and a PDF in a frame of a page whose address
 * is a blob: (the webmail's file preview), printed from the blob's bytes, which the page that
 * made the blob reads. Any other PDF in a page is left alone.
 *
 * The viewer prints its own way when the user drew or typed on the PDF: the OS's dialog
 * prints those edits for sure. Ctrl+P isn't the viewer's: it reaches File > Print, which
 * comes here for a window that is a PDF.
 */

import type { WebContents, WebFrameMain } from 'electron';
import { webFrameMain } from 'electron';
import { BLOB_READ_WORLD } from '../shared/bridge';

/** Chromium's PDF viewer. */
export const PDF_VIEWER = 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/';

/**
 * Runs in the viewer's frame. The first time it puts its own onPrint_ on the viewer (the
 * toolbar's button calls that), then it waits for the next print. Resolves 'print', or
 * 'none' when this isn't a viewer it knows.
 */
const HOOK = `(() => {
  const viewer = document.querySelector('pdf-viewer');
  if (!viewer || typeof viewer.onPrint_ !== 'function') return 'none';
  if (!Object.prototype.hasOwnProperty.call(viewer, 'onPrint_')) {
    const own = Object.getPrototypeOf(viewer).onPrint_;
    viewer.onPrint_ = function () {
      const ink = this.hasCommittedInk2Edits_;
      const edited = this.hasEdits_ === true || (typeof ink === 'function' ? ink.call(this) === true : ink === true);
      const ask = this.__bulwarkPrint;
      if (edited || typeof ask !== 'function') return own.call(this);
      this.__bulwarkPrint = null;
      ask('print');
    };
    // The toolbar's listener is the method as it was drawn: draw it again.
    if (typeof viewer.requestUpdate === 'function') viewer.requestUpdate();
  }
  return new Promise((resolve) => { viewer.__bulwarkPrint = resolve; });
})()`;

/** The viewer of a window that is a PDF: the main frame's own child, not a PDF inside a page. */
export function isWindowPdfViewer(frame: WebFrameMain | null | undefined): frame is WebFrameMain {
  return Boolean(frame && !frame.detached && frame.url.startsWith(PDF_VIEWER) && frame.parent && !frame.parent.parent);
}

/** The viewer of a blob: PDF in a frame of a page: the file preview's. */
export function isFramePdfViewer(frame: WebFrameMain | null | undefined): frame is WebFrameMain {
  return Boolean(frame && !frame.detached && frame.url.startsWith(PDF_VIEWER) && frame.parent?.url.startsWith('blob:') && frame.parent.parent);
}

/**
 * The PDF a frame viewer of `contents` shows, read by the page that holds the frame (a blob:
 * URL can only be read where it was made, and the viewer's own copy never comes out), in a
 * world of the page's own whose CSP lets blob: in (BLOB_READ_WORLD, which the app's preload
 * sets up). The window's page only. Null when it can't.
 */
export async function framePdf(contents: WebContents, viewer: WebFrameMain): Promise<{ data: Buffer; title: string } | null> {
  const frame = viewer.parent;
  const page = frame?.parent;
  if (!frame || !page || page.detached || page !== contents.mainFrame || !frame.url.startsWith('blob:')) return null;
  const read = `(async (url) => {
    const blob = await (await fetch(url)).blob();
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    const element = Array.from(document.querySelectorAll('iframe, embed, object')).find((e) => (e.src || e.data) === url);
    return { data, title: element?.title || '' };
  })(${JSON.stringify(frame.url)})`;
  try {
    if (contents.isDestroyed()) return null;
    const answer = (await contents.executeJavaScriptInIsolatedWorld(BLOB_READ_WORLD, [{ code: read }])) as { data?: unknown; title?: unknown } | null;
    if (typeof answer?.data !== 'string') return null;
    const comma = answer.data.indexOf(',');
    if (comma < 0 || !answer.data.slice(0, comma).endsWith(';base64')) return null;
    const data = Buffer.from(answer.data.slice(comma + 1), 'base64');
    // Not a PDF after all: the viewer shows what Chromium took for one.
    if (data.subarray(0, 1024).indexOf('%PDF-') < 0) return null;
    return { data, title: typeof answer.title === 'string' ? answer.title.slice(0, 256) : '' };
  } catch {
    return null;
  }
}

/** The viewer's own print, the OS's dialog: where the app's can't take the PDF. */
export function printInViewer(viewer: WebFrameMain): void {
  if (viewer.detached) return;
  void viewer
    .executeJavaScript(`(() => { const viewer = document.querySelector('pdf-viewer'); Object.getPrototypeOf(viewer).onPrint_.call(viewer); })()`, true)
    .catch(() => {});
}

export function windowPdfViewer(contents: WebContents): WebFrameMain | null {
  if (contents.isDestroyed()) return null;
  return contents.mainFrame.frames.find((frame) => isWindowPdfViewer(frame)) ?? null;
}

/** Calls `onPrint` each time a PDF viewer of `contents` the app prints from is asked to print. */
export function watchPdfViewers(contents: WebContents, onPrint: (viewer: WebFrameMain) => void): void {
  const watched = new Set<string>();
  const watch = async (viewer: WebFrameMain) => {
    // A new document in the frame is a new viewer.
    const key = `${viewer.processId}:${viewer.routingId}:${viewer.url}`;
    if (watched.has(key)) return;
    watched.add(key);
    try {
      for (;;) {
        let asked: unknown;
        try {
          asked = await viewer.executeJavaScript(HOOK);
        } catch {
          return;
        }
        if (asked !== 'print' || viewer.detached || contents.isDestroyed()) return;
        onPrint(viewer);
      }
    } finally {
      watched.delete(key);
    }
  };
  contents.on('did-frame-finish-load', (_event, _isMainFrame, processId, routingId) => {
    const frame = webFrameMain.fromId(processId, routingId);
    if (isWindowPdfViewer(frame) || isFramePdfViewer(frame)) void watch(frame);
  });
  // A window from before.
  if (contents.isDestroyed() || contents.isLoading()) return;
  for (const frame of contents.mainFrame.framesInSubtree) {
    if (isWindowPdfViewer(frame) || isFramePdfViewer(frame)) void watch(frame);
  }
}
