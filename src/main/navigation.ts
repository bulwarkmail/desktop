/**
 * Where a window may go.
 *
 * The app stays on its origin. Anything else opens in the system browser. The
 * exceptions are the ones the webmail depends on: about:blank and blob: pop-ups
 * for print and previews (print calls document.write on the pop-up), and in
 * instance mode the SSO redirect chain, which has to run in the window so the
 * instance's own cookies come back with it. A plugin's sign-in, which the webmail
 * asks for through the bridge, runs in a window of its own on the same session for the
 * same reason (openSignInWindow).
 */

import { BrowserWindow, screen, shell, type BrowserWindowConstructorOptions, type WebContents, type WebPreferences } from 'electron';
import type { Mode } from '../shared/bridge';
import { FORCED_SSO_LIMIT_MS, SsoChain, isJmapProxyPath, isSsoStart, looksLikeProviderLogout, parse, sameOrigin } from './navigation-rules';
import { adoptDialogSurface, dialogSurfaceOptions, isDialogFrameName } from './dialog-surfaces';
import { printPreviews } from './features/print';
import { isPrintFrameName } from './print-rules';
import { fitInto } from './window-placement';
import { windowTypeOf, type WindowManager } from './windows';

// What links in mail and contacts use. The OS has the handler, or nothing happens.
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:', 'sms:', 'xmpp:', 'webcal:']);

/** The schemes listed above, for an address the OS can open. Nothing else leaves the app. */
export function openExternally(url: string): boolean {
  const parsed = parse(url);
  if (!parsed || !EXTERNAL_PROTOCOLS.has(parsed.protocol)) return false;
  if (parsed.username || parsed.password) return false;
  void shell.openExternal(parsed.toString()).catch(() => {});
  return true;
}

export interface GuardOptions {
  mode: Mode;
  origin: string;
  windows: () => WindowManager;
  /** The server is forced: a sign-in chain gets a time limit. */
  forced?: () => boolean;
}

/**
 * window.open's features string sets window options wherever the handler doesn't name them, and
 * anything with a pop-up writes it: a cross-origin frame with allow-popups could put a fake prompt
 * on top of every app. `fullscreen: false` alone would take away macOS's full screen button, so
 * `fullscreenable` puts that back.
 */
const NOT_FROM_FEATURES: BrowserWindowConstructorOptions = {
  alwaysOnTop: false,
  opacity: 1,
  frame: true,
  kiosk: false,
  fullscreen: false,
  fullscreenable: true,
  skipTaskbar: false,
  transparent: false,
  title: 'Bulwark',
};

/** A pop-up without the bridge: print pages and blob previews. */
function bareWindowOptions(preferences: WebPreferences): BrowserWindowConstructorOptions {
  return {
    ...NOT_FROM_FEATURES,
    autoHideMenuBar: true,
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      devTools: preferences.devTools,
    },
  };
}

function handleWindowOpen(contents: WebContents, options: GuardOptions) {
  contents.setWindowOpenHandler(({ url, frameName }) => {
    const windows = options.windows();
    // One of the page's dialogs, drawn into a window of its own (dialog-surfaces.ts).
    if (isDialogFrameName(frameName, url)) {
      const dialog = dialogSurfaceOptions(contents, windows.webPreferences());
      return dialog ? { action: 'allow', overrideBrowserWindowOptions: dialog } : { action: 'deny' };
    }
    if (url === 'about:blank' || url === '') {
      // A print window: it stays hidden, and the print preview shows what's in it (print-preview.ts).
      const print = isPrintFrameName(frameName) && printPreviews() ? { show: false, skipTaskbar: true } : {};
      return { action: 'allow', overrideBrowserWindowOptions: { ...bareWindowOptions(windows.webPreferences()), ...print } };
    }
    const parsed = parse(url);
    if (!parsed) return { action: 'deny' };
    if (parsed.protocol === 'blob:') {
      // blob:https://app... carries the origin in its URL, and URL.origin knows.
      if (parsed.origin !== options.origin) return { action: 'deny' };
      return { action: 'allow', overrideBrowserWindowOptions: bareWindowOptions(windows.webPreferences()) };
    }
    if (sameOrigin(parsed, options.origin)) {
      if (parsed.pathname.startsWith('/api/') || isJmapProxyPath(parsed.pathname)) return { action: 'deny' };
      const type = windowTypeOf(parsed.pathname);
      const key = frameName && frameName !== '_blank' ? frameName : url;
      if (windows.findByKey(key)) {
        windows.open({ type, key, url });
        return { action: 'deny' };
      }
      if (type === 'message' || type === 'composer') {
        // Keeps window.opener and the handle for a page without the bridge. did-create-window
        // below registers it with the manager.
        // Its place comes from us: a page's features string can ask for any size or spot.
        return { action: 'allow', overrideBrowserWindowOptions: { ...NOT_FROM_FEATURES, ...windows.windowOptions(type), ...windows.placeFor(type) } };
      }
      windows.open({ type, key, url });
      return { action: 'deny' };
    }
    openExternally(url);
    return { action: 'deny' };
  });

  contents.on('did-create-window', (child, details) => {
    if (isDialogFrameName(details.frameName, details.url)) {
      adoptDialogSurface(child, contents, details.frameName);
      // A dialog may open one of its own, which hangs on it.
      handleWindowOpen(child.webContents, options);
      return;
    }
    const parsed = parse(details.url);
    const windows = options.windows();
    // A blob's URL.origin is the app's too, but it's no window of the app's: it has none of its styles,
    // so the frame check would take it for an older instance's page and rebuild it.
    if (parsed?.protocol !== 'blob:' && sameOrigin(parsed, options.origin)) {
      const key = details.frameName && details.frameName !== '_blank' ? details.frameName : details.url;
      windows.adopt(child, windowTypeOf(parsed!.pathname), key, details.url);
      return;
    }
    const previews = printPreviews();
    if (previews && isPrintFrameName(details.frameName) && (details.url === 'about:blank' || details.url === '')) {
      previews.adoptPopup(child, contents, details.frameName);
      guardContents(child.webContents, options);
      return;
    }
    // about:blank and blob: stay outside the manager, under the same guards, and on a screen.
    child.setBounds(fitInto(child.getBounds(), screen.getDisplayMatching(child.getBounds()).workArea));
    guardContents(child.webContents, options);
  });
}

/**
 * Instance mode: inside the redirect chain any https page may show. A sign-in window starts
 * inside it, and always with the time limit.
 */
function guardNavigation(contents: WebContents, options: GuardOptions, signIn = false): void {
  const { origin, mode } = options;
  const chain = new SsoChain(() => (signIn || options.forced?.() ? FORCED_SSO_LIMIT_MS : null));
  if (signIn) chain.start();

  const allowed = (target: URL): boolean => {
    if (target.protocol === 'about:' && target.href === 'about:blank') return true;
    if (sameOrigin(target, origin)) return !isJmapProxyPath(target.pathname);
    if (mode !== 'instance' || target.protocol !== 'https:') return false;
    if (chain.active()) return true;
    if (isSsoStart(target, origin)) {
      chain.start();
      return true;
    }
    return false;
  };

  const guard = (event: Electron.Event, url: string, isMainFrame: boolean) => {
    if (!isMainFrame) return;
    const target = parse(url);
    if (target && allowed(target)) return;
    event.preventDefault();
    if (!target || (sameOrigin(target, origin) && isJmapProxyPath(target.pathname))) return;
    openExternally(url);
    // The webmail set a flag before leaving for the provider's logout page, so
    // its own login redirect would do nothing and the window would stay stuck.
    if (looksLikeProviderLogout(target)) void contents.loadURL(`${origin}/`).catch(() => {});
  };

  contents.on('will-navigate', (event) => guard(event, event.url, event.isMainFrame));
  contents.on('will-redirect', (event) => guard(event, event.url, event.isMainFrame));
  contents.on('did-navigate', (_event, url) => {
    if (sameOrigin(parse(url), origin)) chain.end();
  });
  contents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    // -3 is a load we replaced ourselves, which isn't the chain failing.
    if (isMainFrame && code !== -3) chain.end();
  });
}

function guardContents(contents: WebContents, options: GuardOptions, signIn = false): void {
  handleWindowOpen(contents, options);
  guardNavigation(contents, options, signIn);
}

/** The plugin callback page parks its payload here first (webmail lib/plugin-oauth.ts). */
const PLUGIN_CALLBACK_KEY = 'plugin-oauth-callback';
const HANDOVER_POLL_MS = 250;
const HANDOVER_WAIT_MS = 15_000;

/** Back on the instance, the callback page writes the payload; then the window has done its job. */
function closeOnceHandedOver(window: BrowserWindow, origin: string): void {
  let polling = false;
  window.webContents.on('did-navigate', (_event, url) => {
    if (polling || parse(url)?.origin !== origin) return;
    polling = true;
    const until = Date.now() + HANDOVER_WAIT_MS;
    const look = async () => {
      if (window.isDestroyed()) return;
      const parked = await window.webContents.executeJavaScript(`sessionStorage.getItem(${JSON.stringify(PLUGIN_CALLBACK_KEY)}) !== null`).catch(() => false);
      if (parked === true) window.close();
      else if (Date.now() < until) setTimeout(look, HANDOVER_POLL_MS);
    };
    void look();
  });
}

/**
 * A plugin's sign-in (isPluginSignIn, checked by the caller): a window on the app's session
 * without the bridge, so the callback page reaches the storage of the page that started it.
 * It closes once the page has handed over.
 */
export function openSignInWindow(url: string, parent: BrowserWindow | null, options: GuardOptions): BrowserWindow {
  const preferences = options.windows().webPreferences();
  const bare = bareWindowOptions(preferences);
  const window = new BrowserWindow({ ...bare, width: 520, height: 720, ...(parent ? { parent } : {}), webPreferences: { ...bare.webPreferences, session: preferences.session } });
  window.setBounds(fitInto(window.getBounds(), screen.getDisplayMatching(parent?.getBounds() ?? window.getBounds()).workArea));
  guardContents(window.webContents, options, true);
  closeOnceHandedOver(window, options.origin);
  void window.loadURL(url).catch(() => {});
  return window;
}

export function attachWindowGuards(window: BrowserWindow, options: GuardOptions): void {
  guardContents(window.webContents, options);
}
