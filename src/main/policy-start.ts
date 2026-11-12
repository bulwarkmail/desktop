/**
 * What the app opens with, given the policies and what the user chose before. Pure,
 * so tests can load it. The order is the policy order: anything forced, then the
 * user's choice, then a recommended server, then asking.
 */

import type { Mode } from '../shared/bridge';
import { jmapServerAllowed, parseInstanceUrl, type PolicySnapshot } from '../shared/policy-schema';

export interface StartChoice {
  mode?: Mode;
  instanceUrl?: string;
  /** "Change Connection" was chosen: show the choice once, also over a recommended server. */
  askConnection?: boolean;
  /** The step that choice opens on: "Use my organisation's Bulwark instead" wants the web address one. */
  askPage?: WelcomePage;
  /** Development switches. They come after anything forced, like any other choice. */
  devInstance?: string | null;
  devStandalone?: boolean;
}

/** A first step of the welcome page other than the default: the organisation's web address. */
export type WelcomePage = 'org';

export type StartDecision =
  | { kind: 'instance'; url: string; forced: boolean; canSwitch: boolean }
  | { kind: 'standalone'; canSwitch: boolean }
  | { kind: 'welcome'; allowStandalone: boolean; instanceUrl: string | null; urlLocked: boolean; canSwitch: false; page?: WelcomePage }
  | { kind: 'policy-error'; policy: string; reason: string; raw?: string; canSwitch: false };

/** Direct connections are on unless a policy says otherwise; a forced server turns them off by itself. */
export function standaloneAllowed(snapshot: PolicySnapshot): boolean {
  const { AllowStandalone, InstanceUrl } = snapshot;
  if (AllowStandalone.locked) return AllowStandalone.value;
  return !(InstanceUrl.locked && InstanceUrl.value);
}

/** A problem with the policy source itself, such as an unsafe policy file. */
export interface PolicySourceProblem {
  policy: string;
  reason: string;
}

/** A server's address as the app would use it, if a server nobody forced may be used at all. */
function usableServer(snapshot: PolicySnapshot, url: unknown): string | null {
  const parsed = parseInstanceUrl(url, snapshot.AllowInsecureInstance.value);
  return parsed.ok && jmapServerAllowed(snapshot.AllowedJmapServers.value, parsed.value) ? parsed.value : null;
}

export function decideStart(snapshot: PolicySnapshot, problem: PolicySourceProblem | null, choice: StartChoice): StartDecision {
  if (problem) return { kind: 'policy-error', policy: problem.policy, reason: problem.reason, canSwitch: false };
  const { InstanceUrl, AllowedJmapServers } = snapshot;
  if (InstanceUrl.locked && InstanceUrl.invalid) {
    return { kind: 'policy-error', policy: 'InstanceUrl', reason: InstanceUrl.invalid, raw: InstanceUrl.raw, canSwitch: false };
  }

  const allowStandalone = standaloneAllowed(snapshot);
  const forcedUrl = InstanceUrl.locked ? InstanceUrl.value : null;

  // A list nobody can read allows nothing, so without a forced server there's nowhere to
  // go. An empty welcome page would explain nothing: this says which value is the problem.
  if (!forcedUrl && AllowedJmapServers.locked && AllowedJmapServers.value?.length === 0 && (AllowedJmapServers.invalid || AllowedJmapServers.dropped)) {
    return {
      kind: 'policy-error',
      policy: 'AllowedJmapServers',
      reason: AllowedJmapServers.invalid ?? 'no_usable_entries',
      ...(AllowedJmapServers.raw ? { raw: AllowedJmapServers.raw } : {}),
      canSwitch: false,
    };
  }

  if (forcedUrl) {
    if (allowStandalone) {
      if (choice.devStandalone || choice.mode === 'standalone') return { kind: 'standalone', canSwitch: true };
      if (choice.askConnection) return { kind: 'welcome', allowStandalone: true, instanceUrl: forcedUrl, urlLocked: true, canSwitch: false, ...askedPage(choice) };
    }
    return { kind: 'instance', url: forcedUrl, forced: true, canSwitch: allowStandalone };
  }

  // A server anyone chose has to be on the list. A forced one is the admin's own word.
  const valid = (url: unknown) => usableServer(snapshot, url);
  const devUrl = choice.devInstance ? valid(choice.devInstance) : null;
  if (devUrl) return { kind: 'instance', url: devUrl, forced: false, canSwitch: true };
  if (allowStandalone && (choice.devStandalone || choice.mode === 'standalone')) return { kind: 'standalone', canSwitch: true };
  if (choice.mode === 'instance') {
    const url = valid(choice.instanceUrl);
    if (url) return { kind: 'instance', url, forced: false, canSwitch: true };
  }
  const recommended = valid(InstanceUrl.value);
  if (recommended && !choice.askConnection) return { kind: 'instance', url: recommended, forced: false, canSwitch: true };
  return { kind: 'welcome', allowStandalone, instanceUrl: recommended, urlLocked: false, canSwitch: false, ...askedPage(choice) };
}

/** Only the question the user asked for opens on another step; a first run starts at the top. */
function askedPage(choice: StartChoice): { page?: WelcomePage } {
  return choice.askConnection && choice.askPage === 'org' ? { page: 'org' } : {};
}

/**
 * The app is somewhere a forced value no longer lets it be, so "Later" can't be the end of
 * it: a new forced server, a bad forced value, direct connections taken away, or a server
 * that's now off the list or, with AllowInsecureInstance gone, on plain http. What a policy
 * no longer asks for can wait for as long as the user likes.
 */
export function connectionMustChange(booted: StartDecision, next: StartDecision, snapshot: PolicySnapshot): boolean {
  if (next.kind === 'policy-error') return booted.kind !== 'policy-error';
  if (next.kind === 'instance' && next.forced) return booted.kind !== 'instance' || booted.url !== next.url;
  if (booted.kind === 'instance') return usableServer(snapshot, booted.url) === null;
  return booted.kind === 'standalone' && next.kind !== 'standalone';
}

/** What makes a restart worth asking for: where the app is, and what Chromium only reads at start. */
export function restartKey(decision: StartDecision, snapshot: PolicySnapshot): string {
  return JSON.stringify([
    decision.kind,
    decision.kind === 'instance' ? decision.url : null,
    decision.kind === 'policy-error' ? [decision.policy, decision.reason] : null,
    decision.canSwitch,
    decision.kind === 'welcome' ? decision.allowStandalone : null,
    snapshot.AuthServerAllowlist.value,
    snapshot.AuthNegotiateDelegateAllowlist.value,
  ]);
}
