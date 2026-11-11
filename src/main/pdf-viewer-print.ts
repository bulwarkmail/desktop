/**
 * Print from Chromium's PDF viewer in a window of the app that is a PDF (a mail attachment
 * opened in a window of its own) through the app's print preview. The viewer's print button
 * goes straight to the OS's dialog, which shows no pages under Electron, and Electron has no
 * event for it. So the shell swaps the viewer's print, inside the viewer's own frame, for an
 * answer to a call it keeps waiting, and the preview prints the window as it is.
 *
 * The viewer prints its own way when the user drew or typed on the PDF: the OS's dialog
 * prints those edits for sure. A PDF inside a page (the file preview's frame) is left alone:
 * the preview can only print whole windows, and the page has a Print button of its own.
 * Ctrl+P isn't the viewer's: it reaches File > Print, which comes here for a window that is
 * a PDF.
 */

import type { WebContents, WebFrameMain } from 'electron';
import { webFrameMain } from 'electron';

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

export function windowPdfViewer(contents: WebContents): WebFrameMain | null {
  if (contents.isDestroyed()) return null;
  return contents.mainFrame.frames.find((frame) => isWindowPdfViewer(frame)) ?? null;
}

/** Calls `onPrint` each time the PDF viewer of `contents` is asked to print. */
export function watchPdfViewers(contents: WebContents, onPrint: () => void): void {
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
        onPrint();
      }
    } finally {
      watched.delete(key);
    }
  };
  contents.on('did-frame-finish-load', (_event, _isMainFrame, processId, routingId) => {
    const frame = webFrameMain.fromId(processId, routingId);
    if (isWindowPdfViewer(frame)) void watch(frame);
  });
  // A window from before.
  const viewer = contents.isLoading() ? null : windowPdfViewer(contents);
  if (viewer) void watch(viewer);
}
