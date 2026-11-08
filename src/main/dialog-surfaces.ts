/**
 * The page's own dialogs as windows of their own. The page opens an about:blank window
 * named `bulwark-dialog-…` and renders the dialog into it from its own document (React
 * portals into the window's document, the app's styles copied over). Main makes that
 * window a frameless, transparent child of the window that opened it, modal to it, not in
 * the taskbar, and shows it when the page says the dialog is drawn.
 *
 * The window has the size of the parent's page, and the card stands in its middle as it
 * does in the page; the rest is transparent. Media queries and vh then mean what they mean
 * in the page, so a dialog looks the same in its window as it did over the page. A window
 * the size of the card would have given dialogs their phone layouts.
 *
 * The window is a bare one: no preload, no bridge, sandboxed and isolated, about:blank
 * only. It can't navigate. Only the page that owns it may size it: the window that
 * opened it, or for a dialog opened from a dialog, the page that opened the first one.
 *
 * macOS: `modal` would make a sheet, so there the parent is held by hand (parent-hold.ts).
 */

import { BrowserWindow, type BrowserWindowConstructorOptions, type WebContents, type WebPreferences } from 'electron';
import { holdParent, parentHeldByHand } from './parent-hold';

export const DIALOG_FRAME_NAME = /^bulwark-dialog-[a-z0-9-]{1,60}$/;

interface Surface {
  window: BrowserWindow;
  parent: BrowserWindow;
  /** The app page whose script draws it. */
  owner: number;
  name: string;
}

/** By the dialog window's webContents id. */
const surfaces = new Map<number, Surface>();

export function isDialogFrameName(name: string | undefined, url: string): boolean {
  return (url === 'about:blank' || url === '') && typeof name === 'string' && DIALOG_FRAME_NAME.test(name);
}

/** The window options for a dialog window opened by `opener`. Null when there is no window to hang it on. */
export function dialogSurfaceOptions(opener: WebContents, preferences: WebPreferences): BrowserWindowConstructorOptions | null {
  const parent = BrowserWindow.fromWebContents(opener);
  if (!parent || parent.isDestroyed()) return null;
  const area = parent.getContentBounds();
  return {
    parent,
    modal: !parentHeldByHand(),
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    fullscreen: false,
    kiosk: false,
    alwaysOnTop: false,
    opacity: 1,
    skipTaskbar: true,
    autoHideMenuBar: true,
    title: 'Bulwark',
    // The parent's page, exactly (see above).
    x: area.x,
    y: area.y,
    width: area.width,
    height: area.height,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: true,
      devTools: preferences.devTools,
    },
  };
}

/** The app page a webContents belongs to: itself, or the page behind the dialog it is. */
function ownerOf(contents: WebContents): number {
  return surfaces.get(contents.id)?.owner ?? contents.id;
}

/** The dialog window just made: remember whose it is, keep it in place, clean up after it. */
export function adoptDialogSurface(child: BrowserWindow, opener: WebContents, name: string): void {
  const parent = child.getParentWindow();
  if (!parent) {
    child.destroy();
    return;
  }
  const id = child.webContents.id;
  surfaces.set(id, { window: child, parent, owner: ownerOf(opener), name });
  child.setMenu(null);
  // Exactly over the page behind: the size given at creation is rounded on the way in.
  child.setBounds(parent.getContentBounds());
  // about:blank and nothing else: the page writes into it, nobody loads anything.
  child.webContents.on('will-navigate', (event) => event.preventDefault());
  child.webContents.on('will-redirect', (event) => event.preventDefault());
  const release = parentHeldByHand() ? holdParent(parent, child) : null;
  child.once('closed', () => {
    surfaces.delete(id);
    release?.();
    if (parent.isDestroyed()) return;
    // The focus goes back to the window behind, and the page puts it on the opener.
    parent.focus();
  });
}

/**
 * The page has drawn its dialog into the window: show it. Only the page that owns it.
 * False when there is no such window.
 */
export function showDialogSurface(sender: WebContents, name: unknown): boolean {
  if (typeof name !== 'string' || !DIALOG_FRAME_NAME.test(name)) return false;
  const surface = [...surfaces.values()].find((s) => s.name === name && s.owner === sender.id);
  if (!surface || surface.window.isDestroyed() || surface.parent.isDestroyed()) return false;
  if (!surface.window.isVisible()) {
    surface.window.show();
    surface.window.focus();
  }
  return true;
}

/** Tests and diagnostics: the dialog windows there are. */
export function dialogSurfaceCount(): number {
  return surfaces.size;
}
