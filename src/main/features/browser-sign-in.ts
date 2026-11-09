/**
 * "Sign in with your browser", in both modes. The rules are in ../browser-sign-in.ts; this
 * plugs them into the bridge, the window manager and the policies.
 *
 * Every call comes through `ctx.handle`, so only a main frame on the app's origin gets
 * here. A deep link never starts a flow: all it can do is finish one the user started, and
 * only with that flow's state.
 */

import { app, BrowserWindow, shell, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { CHANNEL, type BrowserSignInBegin, type PasswordSignInAnswer } from '../../shared/bridge';
import { effectivePolicyValue } from '../../shared/policy-schema';
import { LoopbackSignIn } from '../browser-sign-in';
import { openSignInWindow } from '../navigation';
import { isPluginSignIn, parse } from '../navigation-rules';
import { serverOrigin } from '../server-address';
import { uiLanguageNow } from '../strings';
import { addWipeStep } from './local-wipe';
import { policies } from './policies';
import type { Feature, FeatureContext } from '.';

// Set by build.mjs. Tests don't wait ten minutes for a flow to run out.
declare const __BULWARK_TEST_BUILD__: boolean;

function testTimeoutMs(): number | undefined {
  if (!__BULWARK_TEST_BUILD__) return undefined;
  const value = process.argv.find((arg) => arg.startsWith('--bulwark-test-sign-in-timeout='))?.split('=')[1];
  return value ? Number(value) : undefined;
}

let active: LoopbackSignIn | null = null;

/** A `bulwark://sign-in/callback` link came in. False when no flow was waiting for it. */
export function deliverSignInLink(code: string, state: string): boolean {
  return active?.deliverLink(code, state) ?? false;
}

function allowedByPolicy(): boolean {
  return effectivePolicyValue(policies.snapshot.BrowserSignIn, undefined);
}

function bringForward(ctx: FeatureContext, owner: number): void {
  const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed() && candidate.webContents.id === owner) ?? ctx.windows.mainWindow();
  if (!window) return;
  ctx.windows.focusWindow(window);
  if (process.platform === 'darwin') app.focus({ steal: true });
  // Windows may refuse the focus while the browser holds the foreground. Then the taskbar
  // button flashes, and this at least puts the window above the browser.
  else window.moveTop();
}

const watched = new WeakSet<WebContents>();

function watchOwner(signIn: LoopbackSignIn, contents: WebContents): void {
  if (watched.has(contents)) return;
  watched.add(contents);
  const end = () => signIn.cancelFor(contents.id);
  contents.on('destroyed', end);
  // A new document has no verifier. A route change inside the page keeps it.
  contents.on('did-navigate', end);
}

export function setupBrowserSignIn(ctx: FeatureContext): LoopbackSignIn {
  const remembered = new Map<string, number>(Object.entries(ctx.state.data.signInPorts ?? {}));
  const signIn = new LoopbackSignIn({
    open: (url) => shell.openExternal(url),
    bringForward: (owner) => bringForward(ctx, owner),
    language: uiLanguageNow,
    instanceOrigin: ctx.mode === 'instance' ? ctx.origin : undefined,
    timeoutMs: testTimeoutMs(),
    ports: remembered,
    portsChanged: () => {
      ctx.state.data.signInPorts = Object.fromEntries(remembered);
      ctx.state.touch();
    },
  });
  active = signIn;
  addWipeStep(async () => remembered.clear());

  ctx.handle(CHANNEL.authBegin, async (event: IpcMainInvokeEvent, window, request): Promise<BrowserSignInBegin> => {
    if (!allowedByPolicy()) return { ok: false, error: 'policy' };
    const { kind, serverUrl } = (request ?? {}) as { kind?: unknown; serverUrl?: unknown };
    if (ctx.mode === 'instance') {
      if (kind !== 'instance') return { ok: false, error: 'invalid' };
      const begun = await signIn.begin(event.sender.id, 'instance', null);
      if (begun.ok) watchOwner(signIn, event.sender);
      return begun;
    }
    if (kind !== 'oauth' || !ctx.servers) return { ok: false, error: 'invalid' };
    // Policy, and the native question for a LAN or plain http server, before anything else.
    const prepared = await ctx.servers.prepare(serverUrl, window);
    if (!prepared.ok) return { ok: false, error: prepared.reason };
    const begun = await signIn.begin(event.sender.id, 'oauth', serverOrigin(serverUrl));
    if (begun.ok) watchOwner(signIn, event.sender);
    return begun;
  });
  // A plugin's OAuth: in the system browser its callback page would park the code in that
  // browser's storage, out of the page's reach. Only through the bridge, so a link in a
  // message with the same address still goes to the browser.
  ctx.handle(CHANNEL.authPluginSignIn, (_event, window, url) => {
    if (ctx.mode !== 'instance' || typeof url !== 'string') return false;
    const parsed = parse(url);
    if (!parsed || !isPluginSignIn(parsed, ctx.origin)) return false;
    openSignInWindow(parsed.toString(), window, { mode: ctx.mode, origin: ctx.origin, windows: () => ctx.windows });
    return true;
  });
  ctx.handle(CHANNEL.authComplete, (event, _window, flowId, url) => signIn.complete(flowId, url, event.sender.id));
  ctx.handle(CHANNEL.authUseScheme, (event, _window, flowId) => signIn.useScheme(flowId, event.sender.id));
  ctx.on(CHANNEL.authCancel, (event, _window, flowId) => signIn.cancel(flowId, event.sender.id));
  ctx.handle(CHANNEL.authPasswordBegin, (event, _window, flowId) => signIn.beginPassword(flowId, event.sender.id));
  ctx.handle(CHANNEL.authPasswordNext, (event, _window, flowId) => signIn.nextPassword(flowId, event.sender.id));
  ctx.handle(CHANNEL.authPasswordOutcome, (event, _window, flowId) => signIn.outcome(flowId, event.sender.id));
  ctx.on(CHANNEL.authPasswordAnswer, (event, _window, flowId, answer) => {
    const { ok, error } = (answer ?? {}) as { ok?: unknown; error?: unknown };
    const clean: PasswordSignInAnswer = ok === true
      ? { ok: true }
      : { ok: false, error: error === 'invalid_credentials' || error === 'totp_required' ? error : 'other' };
    signIn.answerPassword(flowId, event.sender.id, clean);
  });

  policies.on('changed', () => {
    if (!allowedByPolicy()) signIn.closeAll();
  });
  app.on('before-quit', () => signIn.closeAll());
  return signIn;
}

export const browserSignInFeature: Feature = {
  name: 'browser-sign-in',
  modes: ['standalone', 'instance'],
  setup: (ctx) => {
    setupBrowserSignIn(ctx);
  },
};
