/**
 * Every bridge call passes through here. The preload only exposes the bridge on
 * the right origin, but the check that counts is this one: the sender must be a
 * main frame on the app's origin. A page the window navigated to gets nothing, and
 * neither does a frame's own window.
 *
 * What a frame can reach through `parent` is another matter, and depends on the frame:
 * - An untrusted plugin's frame is opaque (sandbox with allow-scripts, no allow-same-origin):
 *   the browser stops it at `parent`.
 * - A mail body's frame is NOT opaque. It has allow-same-origin and no allow-scripts
 *   (email-viewer.tsx in the webmail), so it's on the app's origin and nothing in it runs.
 *   The host needs the origin: it measures that document and wires its links, and cid: pictures
 *   are blob: URLs of this origin. Only the missing allow-scripts and the sanitizer keep a mail
 *   away from the bridge, the cookies and the store.
 * - A same-origin frame with scripts, such as a privileged plugin, can reach
 *   parent.bulwarkDesktop, and those calls arrive here from the main frame: this check can't
 *   tell them apart.
 *
 * So nothing on the bridge may do harm on a call alone: installing and approving ask the user
 * natively, what outlasts a run takes a real click (`clicked` in the preload), and windows only
 * open the app's own routes.
 */

import { BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebFrameMain } from 'electron';
import { CHANNEL, type ThemeColours, type WindowType } from '../shared/bridge';
import { openExternally } from './navigation';
import { isJmapProxyPath } from './navigation-rules';
import type { FeatureContext } from './features';
import { installPlugin, type PluginPolicyCheck } from './plugins';
import { windowTypeOf } from './windows';

export function senderAllowed(frame: WebFrameMain | null | undefined, origin: string): boolean {
  if (!frame || frame.parent) return false;
  try {
    const url = new URL(frame.url);
    // Plain http only when the origin is: an instance a policy allows that way.
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === origin;
  } catch {
    return false;
  }
}

export interface IpcOptions {
  origin: string;
  pluginPolicy?: PluginPolicyCheck;
}

export function createChannels(origin: string): Pick<FeatureContext, 'handle' | 'on'> {
  return {
    handle(channel, handler) {
      ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
        if (!senderAllowed(event.senderFrame, origin)) throw new Error('Not allowed');
        return handler(event, BrowserWindow.fromWebContents(event.sender), ...args);
      });
    },
    on(channel, handler) {
      ipcMain.on(channel, (event: IpcMainEvent, ...args: unknown[]) => {
        if (!senderAllowed(event.senderFrame, origin)) return;
        handler(event, BrowserWindow.fromWebContents(event.sender), ...args);
      });
    },
  };
}

/** A same-origin URL, resolved against the app. Null for anything else. */
function resolveAppUrl(url: unknown, origin: string): URL | null {
  if (typeof url !== 'string' || !url) return null;
  try {
    const parsed = new URL(url, origin);
    if (parsed.origin !== origin || isJmapProxyPath(parsed.pathname)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;
}

export function registerBridge(ctx: FeatureContext, options: IpcOptions): void {
  const { windows, theme, origin } = ctx;

  const openAppWindow = (url: unknown, key: unknown, size?: { width: unknown; height: unknown }, type?: WindowType, quick = false) => {
    const target = resolveAppUrl(url, origin);
    if (!target || target.pathname.startsWith('/api/')) return;
    const width = positive(size?.width);
    const height = positive(size?.height);
    windows.open({
      type: type ?? windowTypeOf(target.pathname),
      url: target.toString(),
      key: typeof key === 'string' && key ? key : target.toString(),
      size: width && height ? { width, height } : undefined,
      // A new message from outside the main window: quick compose's size and place.
      ...(quick && windowTypeOf(target.pathname) === 'composer' ? { boundsKey: 'quickComposer' as const, size: undefined } : {}),
    });
  };

  ctx.on(CHANNEL.windowsOpen, (_event, _window, url, opts) => {
    const o = (opts ?? {}) as { name?: unknown; width?: unknown; height?: unknown; quick?: unknown };
    openAppWindow(url, o.name, { width: o.width, height: o.height }, undefined, o.quick === true);
  });
  ctx.on(CHANNEL.windowsOpenMessage, (_event, _window, target) => {
    const t = (target ?? {}) as { url?: unknown; emailId?: unknown };
    if (typeof t.emailId !== 'string' || !t.emailId) return;
    openAppWindow(t.url, `message:${t.emailId}`, undefined, 'message');
  });
  ctx.on(CHANNEL.windowsOpenComposer, (_event, _window, target) => {
    const t = (target ?? {}) as { url?: unknown; name?: unknown };
    openAppWindow(t.url, t.name, undefined, 'composer');
  });
  ctx.on(CHANNEL.windowsFocus, (_event, _window, id) => {
    windows.focus(typeof id === 'number' ? id : undefined);
  });
  ctx.on(CHANNEL.windowsCloseSelf, (_event, window) => {
    if (window) windows.closeSelf(window);
  });
  ctx.on(CHANNEL.windowsSetRestore, (_event, window, urls) => {
    if (!window || !Array.isArray(urls)) return;
    // Only composers come back this way, and only on this origin.
    const valid = urls.slice(0, 20).flatMap((url) => {
      const target = resolveAppUrl(url, origin);
      return target && windowTypeOf(target.pathname) === 'composer' ? [target.toString()] : [];
    });
    windows.setRestoreUrls(window, valid);
  });
  ctx.on(CHANNEL.windowsSetRestoreEnabled, (_event, _window, enabled) => {
    if (typeof enabled === 'boolean') windows.setRestoreEnabled(enabled);
  });
  ctx.on(CHANNEL.windowsSetMenuName, (_event, window, name) => {
    if (window && typeof name === 'string') windows.setMenuName(window, name);
  });
  ctx.on(CHANNEL.windowsSessionReady, () => windows.emit('sessionReady'));
  ctx.on(CHANNEL.windowsSessionEnded, () => windows.emit('sessionEnded'));
  ctx.on(CHANNEL.windowsSpareReady, (_event, window) => {
    if (window) windows.spareReady(window);
  });
  ctx.handle(CHANNEL.windowsList, () => windows.list());

  ctx.handle(CHANNEL.themeGetSystem, () => theme.system());
  ctx.on(CHANNEL.themeSet, (_event, _window, value) => {
    theme.set((value ?? {}) as ThemeColours);
  });

  ctx.on(CHANNEL.menuSetState, (_event, window, state) => {
    if (window && state && typeof state === 'object') ctx.menu.setCommandState(window, state as never);
  });
  // The page asked first (its own question window). False where a policy forces the connection.
  // 'org': its "Use my organisation's Bulwark instead", which opens on the web address step.
  // Older pages send nothing, and anything else counts as nothing.
  ctx.handle(CHANNEL.menuChangeConnection, (_event, _window, page) => ctx.menu.changeConnection(page === 'org' ? 'org' : undefined));

  // Its window's click decides, as for a link: main takes the gesture (openExternally). The limit
  // without a click is the app's, shared by every window of this origin.
  ctx.on(CHANNEL.shellOpenExternal, (event, _window, url) => {
    if (typeof url === 'string') openExternally(url, event.sender, ctx.origin);
  });

  ctx.on(CHANNEL.lifecycleRegister, (_event, window, wants) => {
    if (window) windows.setFlushable(window, wants === true);
  });
  ctx.on(CHANNEL.lifecycleFlushed, (_event, _window, id, answers) => {
    if (typeof id === 'number') windows.flushDone(id, answers);
  });

  if (ctx.mode !== 'standalone') return;

  ctx.handle(CHANNEL.serversPrepare, (_event, window, serverUrl) => ctx.servers!.prepare(serverUrl, window));
  ctx.on(CHANNEL.serversNoteSession, (_event, window, serverUrl, urls) => {
    void ctx.servers!.noteSession(serverUrl, urls as never, window);
  });
  ctx.on(CHANNEL.serversForget, (_event, _window, serverUrl, reason) => {
    ctx.servers!.forget(serverUrl, reason);
  });

  ctx.handle(CHANNEL.pluginsInstall, (_event, window, slug, version) =>
    installPlugin(ctx.localAdmin!, slug, version, window, options.pluginPolicy),
  );
}

