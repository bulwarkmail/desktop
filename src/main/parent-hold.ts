/**
 * Keeping a window behind a question (a dialog window, the print preview) out of use.
 *
 * Windows and Linux: the question window is `modal`, and the OS does it.
 *
 * macOS: `modal` would make a sheet sliding out of the title bar. Disabling the parent
 * isn't an option either: Electron does that by hanging a half-clear sheet over it, which
 * greys the whole window, pins it in place and, on macOS 27, leaves the question above it
 * unanswerable. So there the parent stays enabled, and whenever it gets the focus (a click
 * on it, the app coming back to the front) the question takes the focus back. A click on
 * a window that isn't focused only focuses it, so nothing in the page behind gets the click.
 */

import type { BrowserWindow } from 'electron';

declare const __BULWARK_TEST_BUILD__: boolean;

/** macOS, or a test build told to behave like it (a test on Windows or Linux). */
export function parentHeldByHand(): boolean {
  return process.platform === 'darwin' || (__BULWARK_TEST_BUILD__ && (globalThis as { __bulwarkMacDialogs?: boolean }).__bulwarkMacDialogs === true);
}

/** Sends the focus from `parent` back to `child` while `child` shows. Returns the release. */
export function holdParent(parent: BrowserWindow, child: BrowserWindow): () => void {
  const back = () => {
    if (!child.isDestroyed() && child.isVisible()) child.focus();
  };
  parent.on('focus', back);
  return () => {
    if (!parent.isDestroyed()) parent.removeListener('focus', back);
  };
}
