/**
 * Client certificates and the Windows sign-in, where a page can reach them.
 *
 * The rules are in client-auth.ts. This wires them to Electron: the event, the request and
 * response gates, the native picker, the state file, and what ends Chromium's memory of an
 * answer. The event is listened to from the top of main, before any window: left alone it
 * sends the first certificate in the store to whoever asks.
 */

import { createHash } from 'node:crypto';
import { app, BrowserWindow, type Certificate, type Session, type WebContents } from 'electron';
import { CHANNEL } from '../../shared/bridge';
import { certificateRuleMatchesUrl, type PolicySnapshot } from '../../shared/policy-schema';
import { setPinAgain } from '../app-session';
import {
  asksForWindowsSignIn,
  CertificateChooser,
  certificateRow,
  classifyRequest,
  cookieToSetBack,
  displayHost,
  hostOnSignInList,
  hostPortOf,
  narrowedList,
  NO_INTEGRATED_SIGN_IN,
  pickerPages,
  RequestLedger,
  signInListUrls,
  targetOrigin,
  type PickAnswer,
  type PickQuestion,
  type RememberedChoices,
} from '../client-auth';
import { requestGate, responseGate } from '../request-gate';
import type { StateFile } from '../state';
import { fill, strings } from '../strings';
import { wipeCovers } from '../wipe-scope';
import { addWipeStep } from './local-wipe';
import { policies } from './policies';
import type { Feature, FeatureContext } from '.';
import { showMessageBox } from '../message-box';

const AUTH_SERVER_SWITCH = 'auth-server-whitelist';
const AUTH_DELEGATE_SWITCH = 'auth-negotiate-delegate-whitelist';

const MAX_CHOICES = 64;
/** A sign-out still has requests under way: its token's revocation, for one. */
const NETWORK_RESET_DELAY_MS = 1500;
const NETWORK_BACK_MS = 5000;
/** A page's factories move over to the new service just after it's there. */
const FACTORIES_MOVE_MS = 300;
const COOKIE_BACK_MS = 3000;
/** However a restart goes, requests aren't refused for longer than this. */
const REFUSE_LIMIT_MS = 10_000;

function accountTag(account: string): string {
  return createHash('sha256').update(account).digest('base64url').slice(0, 16);
}

type StoredChoice = { fingerprint: string; account?: string; origin?: string };

/**
 * `origin`: the page the choices are made in, which `clear` takes alone; null takes every
 * page's. A choice from before choices named their page is `legacy`'s: the standalone page's,
 * or for a wipe the one server the profile ran (wipe-scope.ts `legacyOwner`).
 */
function storedChoices(state: StateFile, account: () => string | null, origin: string | null, legacy?: string): RememberedChoices {
  const keep = (entries: [string, StoredChoice][]) => {
    if (entries.length > 0) state.data.certificateChoices = Object.fromEntries(entries);
    else delete state.data.certificateChoices;
    state.save();
  };
  return {
    get: (hostPort) => state.data.certificateChoices?.[hostPort]?.fingerprint,
    set: (hostPort, fingerprint) => {
      const entries = Object.entries(state.data.certificateChoices ?? {}).filter(([host]) => host !== hostPort);
      const tag = account();
      const choice: StoredChoice = { fingerprint, ...(tag ? { account: tag } : {}), ...(origin ? { origin } : {}) };
      keep([...entries, [hostPort, choice] as [string, StoredChoice]].slice(-MAX_CHOICES));
    },
    clear: () => {
      const entries = Object.entries(state.data.certificateChoices ?? {});
      const left = entries.filter(([, choice]) => !wipeCovers(origin, choice.origin, legacy));
      if (left.length !== entries.length) keep(left);
    },
    clearAccount: (tag) => {
      const entries = Object.entries(state.data.certificateChoices ?? {});
      const left = entries.filter(([, choice]) => choice.account !== tag);
      if (left.length !== entries.length) keep(left);
    },
  };
}

/** The window behind the question. A hidden spare can't carry a dialog: the user wouldn't see it. */
function dialogParent(window: unknown, ctx: FeatureContext): BrowserWindow | null {
  const asked = window instanceof BrowserWindow && !window.isDestroyed() && window.isVisible() ? window : null;
  return asked ?? ctx.windows.focusedManaged()?.window ?? ctx.windows.mainWindow() ?? null;
}

async function askInDialog(question: PickQuestion<Certificate>, window: unknown, ctx: FeatureContext, signal: AbortSignal): Promise<PickAnswer<Certificate>> {
  const text = strings();
  const host = displayHost(question.hostPort);
  const details = (issuer: string, date: string) => fill(text.certificateIssued, { issuer, date });
  const pages = pickerPages(question.certificates);
  for (let page = 0; ; page = (page + 1) % pages.length) {
    const shown = pages[page];
    const buttons = [...shown.map((certificate) => certificateRow(certificate, details, app.getLocale(), process.platform)), ...(pages.length > 1 ? [text.certificateMore] : []), text.certificateNone];
    const none = buttons.length - 1;
    const options = {
      type: 'question' as const,
      title: 'Bulwark',
      message: fill(text.certificateTitle, { host }),
      // The first line isn't a label: a page can reword the rest through shell.setLanguages.
      detail: `${fill(text.pickerServerLine, { host })}\n\n${text.certificateDetail}`,
      buttons,
      // Enter and Esc send nothing.
      defaultId: none,
      cancelId: none,
      // Windows draws the rows as command links, each with its name and a line below.
      noLink: false,
      signal,
      ...(question.rememberable ? { checkboxLabel: fill(text.certificateRemember, { host }), checkboxChecked: false } : {}),
    };
    const parent = dialogParent(window, ctx);
    const { response, checkboxChecked } = await (parent ? showMessageBox(parent, options) : showMessageBox(options));
    if (signal.aborted) return { certificate: null, remember: false };
    if (response < shown.length) return { certificate: shown[response], remember: checkboxChecked };
    if (response === none) return { certificate: null, remember: false };
  }
}

function isNetworkService(details: { type: string; serviceName?: string }): boolean {
  return details.type === 'Utility' && !!details.serviceName?.includes('network');
}

function networkServicePid(): number | undefined {
  return app.getAppMetrics().find((metric) => isNetworkService(metric))?.pid;
}

async function networkServiceBack(gone: number): Promise<void> {
  const deadline = Date.now() + NETWORK_BACK_MS;
  while (Date.now() < deadline) {
    const pid = networkServicePid();
    if (pid && pid !== gone) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * The only thing that ends what Chromium keeps for a host: its certificate, its "none" and its
 * TLS sessions. No session call does it, and a restart of the app would take the windows away.
 * Chromium starts a new one by itself. What doesn't survive comes back here: session cookies,
 * which only ever lived in that process, and the pin. Until then requests fail, so none goes out
 * without them. After a wipe this comes later than its delete, so what it deleted stays deleted.
 */
async function restartNetworkService(session: Session): Promise<boolean> {
  const gate = requestGate(session);
  const cookies = (await session.cookies.get({})).filter((cookie) => cookie.session);
  await session.cookies.flushStore().catch(() => {});
  const pid = networkServicePid();
  if (!pid) return false;
  // A page on its way in would stop for good. An image stuck in a frame is no reason to take away a window with work in it.
  const loading = BrowserWindow.getAllWindows().filter((window) => window.webContents.session === session && window.webContents.isLoadingMainFrame());
  let finished = () => {};
  gate.refuseUntil(Promise.race([new Promise<void>((resolve) => { finished = resolve; }), new Promise((resolve) => setTimeout(resolve, REFUSE_LIMIT_MS))]));
  try {
    process.kill(pid);
    await networkServiceBack(pid);
    setPinAgain(session);
    for (const cookie of cookies) {
      const back = session.cookies.set(cookieToSetBack(cookie)).catch((error) => console.warn(`Cookie ${cookie.name} did not come back:`, error));
      await Promise.race([back, new Promise((resolve) => setTimeout(resolve, COOKIE_BACK_MS))]);
    }
    await new Promise((resolve) => setTimeout(resolve, FACTORIES_MOVE_MS));
  } catch (error) {
    console.warn('The network service did not stop:', error);
    return false;
  } finally {
    finished();
  }
  for (const window of loading) if (!window.isDestroyed()) window.webContents.reload();
  return true;
}

class ClientAuth {
  private state: StateFile | null = null;
  private answer: ((contents: WebContents | null, hostPort: string, list: Certificate[], callback: (certificate?: Certificate) => void) => void) | null = null;
  private clearAll: (() => void) | null = null;
  private pageFetchAllowed: ((url: string) => boolean) | null = null;

  /** From the top of main. A wipe at the start comes before any feature is set up. */
  start(state: StateFile): void {
    this.state = state;
    app.on('select-client-certificate', (event, contents, hostPort, list, callback) => {
      event.preventDefault();
      if (this.answer) this.answer(contents, hostPort, list, callback);
      else callback();
    });
    // This run's answers are its own server's; the stored choices go by whose they are.
    addWipeStep(async ({ origin, legacy }) => {
      if (this.state) storedChoices(this.state, () => null, origin, legacy).clear();
      this.clearAll?.();
    });
  }

  /**
   * Save image: the address is mail's to pick, and a download is out of reach of the request gates,
   * so to the network it's the window asking. So not to a host that would get a credential.
   */
  mayFetchForPage(url: string): boolean {
    return this.pageFetchAllowed?.(url) ?? true;
  }

  setup(ctx: FeatureContext): void {
    const { session, origin } = ctx;
    let account: string | null = null;
    const ledger = new RequestLedger();
    const isUserServer = (target: string | null) => !!target && !!ctx.servers?.isKnown(target);
    const chooser = new CertificateChooser<Certificate>({
      rules: () => policies.snapshot.AutoSelectCertificateForUrls.value,
      choices: storedChoices(ctx.state, () => account, origin),
      ask: (question, window, signal) => askInDialog(question, window, ctx, signal),
      isUserServer: (hostPort) => isUserServer(targetOrigin(`https://${hostPort}`)),
    });
    const isListedServer = (target: string) => isUserServer(target) || policies.snapshot.AutoSelectCertificateForUrls.value.some((rule) => certificateRuleMatchesUrl(rule, target));

    // Hosts that had this user's Windows sign-in this run: such a connection stays signed in.
    const signedIn = new Set<string>();
    const inBareWindow = (contents: WebContents | undefined) => {
      if (!contents) return false;
      const window = BrowserWindow.fromWebContents(contents);
      return !window || !ctx.windows.managedFor(window);
    };

    const gate = requestGate(session);
    gate.add((url, details) => {
      const hostPort = hostPortOf(url);
      if (!hostPort) return false;
      const standing = classifyRequest(details, origin, isListedServer, () => inBareWindow(details.webContents));
      const trusted = standing === 'first-party' || standing === 'listed-server';
      if (!trusted && chooser.holds(hostPort)) return true;
      if (standing !== 'first-party' && signedIn.has(hostPort)) return true;
      ledger.note(details.id, hostPort, standing);
      return false;
    });
    gate.onEnded((id) => ledger.finish(id));

    this.answer = (contents, hostPort, list, callback) => {
      const ours = !contents || contents.session === session;
      const standing = ours ? ledger.claim(hostPort) : null;
      const window = contents && !contents.isDestroyed() ? BrowserWindow.fromWebContents(contents) : null;
      void chooser
        .decide(hostPort, standing, list, window)
        .then((decision) => {
          if (decision.kind === 'send') callback(decision.certificate);
          else if (decision.kind === 'none') callback();
          // 'leave': dropped. The request fails when this callback is collected.
        })
        .catch((error) => {
          console.error(error);
          callback();
        });
    };

    /**
     * A request under way when its connection goes never settles: Electron's request proxy doesn't
     * pass that on. A page can only give up on them if it's told.
     */
    const tellPages = () => ctx.windows.broadcast(CHANNEL.certificatesConnectionsReset, null);

    const closeSignedInConnections = async () => {
      if (signedIn.size === 0) return;
      tellPages();
      await session.closeAllConnections().catch(() => {});
      await session.clearAuthCache().catch(() => {});
      signedIn.clear();
    };

    const respond = responseGate(session);
    let serverList = app.commandLine.getSwitchValue(AUTH_SERVER_SWITCH);
    let delegateList = app.commandLine.getSwitchValue(AUTH_DELEGATE_SWITCH);
    const inForce = () => (serverList === NO_INTEGRATED_SIGN_IN ? null : serverList || null);
    const watchResponses = () => {
      const urls = signInListUrls(inForce());
      // Either all can be watched, or everything is.
      respond.set('windows-sign-in', urls.every((url) => respond.accepts(url)) ? urls : ['*://*/*', 'ws://*/*', 'wss://*/*'], (details) => {
        if (!asksForWindowsSignIn(details.statusCode, details.responseHeaders)) return null;
        if (ledger.standingOf(details.id) !== 'first-party') return { cancel: true };
        const hostPort = hostPortOf(details.url);
        if (hostPort) signedIn.add(hostPort);
        return null;
      });
    };
    if (inForce()) watchResponses();

    this.pageFetchAllowed = (url) => {
      if (targetOrigin(url) === origin) return true;
      const hostPort = hostPortOf(url);
      if (!hostPort) return true;
      return !chooser.holds(hostPort) && !signedIn.has(hostPort) && !hostOnSignInList(inForce(), hostPort.replace(/:\d+$/, ''));
    };

    // Taking a server off the list counts at once. A new one waits for the restart the app asks for.
    const narrow = (snapshot: PolicySnapshot, previous: PolicySnapshot) => {
      const servers = snapshot.AuthServerAllowlist.value;
      const delegates = snapshot.AuthNegotiateDelegateAllowlist.value;
      if (servers === previous.AuthServerAllowlist.value && delegates === previous.AuthNegotiateDelegateAllowlist.value) return;
      serverList = narrowedList(inForce(), servers) ?? NO_INTEGRATED_SIGN_IN;
      delegateList = narrowedList(delegateList || null, delegates) ?? '';
      // Also for a network service that starts later: it reads these.
      app.commandLine.appendSwitch(AUTH_SERVER_SWITCH, serverList);
      if (delegateList) app.commandLine.appendSwitch(AUTH_DELEGATE_SWITCH, delegateList);
      else app.commandLine.removeSwitch(AUTH_DELEGATE_SWITCH);
      // Global in spite of its place on Session. It also empties the delegation list until the restart.
      session.allowNTLMCredentialsForDomains(serverList);
      void closeSignedInConnections();
      watchResponses();
    };
    policies.on('changed', narrow);

    let resetting: Promise<void> | null = null;
    /**
     * What's under way gets a moment to finish, and a sign-out's own last requests still have to go
     * out. In that moment the window's requests still use what's about to end. Frames don't: they
     * stay kept away until it has. Nobody can sign in again that fast.
     */
    const resetNetwork = () => {
      if (resetting) return;
      resetting = (async () => {
        await new Promise((resolve) => setTimeout(resolve, NETWORK_RESET_DELAY_MS));
        await closeSignedInConnections();
        if (!chooser.holdsAnswers()) return;
        if (!(await restartNetworkService(session))) console.warn('A client certificate stays in use until the app restarts.');
      })()
        .catch((error) => console.error(error))
        .finally(() => {
          resetting = null;
        });
    };

    // Also a crash of it: nothing Chromium held is left, and pages have requests stuck.
    app.on('child-process-gone', (_event, details) => {
      if (!isNetworkService(details)) return;
      tellPages();
      chooser.networkEmptied();
      signedIn.clear();
    });

    // A rule that's gone mustn't go on working through what Chromium was given under it.
    policies.on('changed', (snapshot, previous) => {
      const rules = (policy: PolicySnapshot) => JSON.stringify(policy.AutoSelectCertificateForUrls.value);
      if (rules(snapshot) !== rules(previous) && chooser.holdsAnswers()) resetNetwork();
    });

    this.clearAll = () => {
      if (chooser.forget() || signedIn.size > 0) resetNetwork();
    };

    // Only narrows, so any page may. One account's sign-out leaves the network alone: others are
    // using it, and an account switch or a global search must not sign anyone out or ask again.
    ctx.handle(CHANNEL.certificatesClearChoices, (_event, _window, scope) => {
      const { account: gone, last } = (scope ?? {}) as { account?: unknown; last?: unknown };
      if (last === true) this.clearAll?.();
      else if (typeof gone === 'string') chooser.forgetAccount(accountTag(gone));
    });
    ctx.handle(CHANNEL.certificatesSetAccount, (_event, _window, active) => {
      account = typeof active === 'string' ? accountTag(active) : null;
    });
  }
}

export const clientAuth = new ClientAuth();

export const clientCertificatesFeature: Feature = {
  name: 'client-certificates',
  modes: ['standalone', 'instance'],
  setup: (ctx) => clientAuth.setup(ctx),
};
