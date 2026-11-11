/**
 * "Open again after a restart": what the shell keeps of the main window's page when the
 * computer restarts or the user signs out, and where the main window opens with it next time.
 * Pure, for test/resume-unit.spec.ts. features/os-restart.ts writes it, index.ts reads it.
 */

import type { Mode } from '../shared/bridge';

export interface ResumeMark {
  /**
   * The page's path, query and fragment. Without the origin: the local server's port can be
   * another one next time.
   */
  path: string;
  mode: Mode;
  /** In instance mode, the server it was on: a page of one server means nothing on another. */
  origin?: string;
  at: number;
  /** Start at login was off: the entry was made for this one start, and goes again after it. */
  loginItem: boolean;
}

/** A restart nobody followed with a start within this long has nothing left to come back to. */
export const RESUME_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_PATH = 2048;

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * A page the main window can open at: not a pop-out's, nor a sign-in step that ran once. A
 * server can sit under a path of its own, so any segment counts. A folder that happens to be
 * called that only means the app opens on its first page.
 */
function mainPagePath(path: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//') || path.length > MAX_PATH || CONTROL.test(path) || path.includes('\\')) return false;
  const segments = path.replace(/[?#].*$/, '').split('/');
  return !segments.some((segment) => segment === 'popout' || segment === 'login' || segment === 'auth');
}

/** What to keep of the main window's address. Null for anything off this origin or not a main page. */
export function resumeMarkFor(url: string, options: { mode: Mode; origin: string; now: number; startAtLogin: boolean }): ResumeMark | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.origin !== options.origin || parsed.username || parsed.password) return null;
  const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  if (!mainPagePath(path)) return null;
  return {
    path,
    mode: options.mode,
    ...(options.mode === 'instance' ? { origin: options.origin } : {}),
    at: options.now,
    loginItem: !options.startAtLogin,
  };
}

/**
 * Where the main window opens on this start. Null: the usual first page. The state file is
 * plain JSON anyone with the profile could edit, so nothing in it is taken on trust.
 */
export function resumeUrlFrom(mark: unknown, options: { mode: Mode; origin: string; now: number }): string | null {
  if (!mark || typeof mark !== 'object') return null;
  const { path, mode, origin, at } = mark as Partial<ResumeMark>;
  if (typeof path !== 'string' || !mainPagePath(path)) return null;
  if (mode !== options.mode) return null;
  if (mode === 'instance' && origin !== options.origin) return null;
  if (typeof at !== 'number' || at > options.now || options.now - at > RESUME_MAX_AGE_MS) return null;
  const url = new URL(path, options.origin);
  return url.origin === options.origin ? url.href : null;
}

/** The part of the state file this needs. */
export interface ResumeState {
  data: { resumeAfterRestart?: ResumeMark };
  save(): void;
}

/**
 * At a start: a login entry made for the restart alone has done its job, and goes back to
 * what the user has. True when there was one, so this start is likely the one it made.
 */
export function settleRestartLoginEntry(state: ResumeState, startAtLogin: boolean, applyLoginItem: (openAtLogin: boolean) => void): boolean {
  const mark = state.data.resumeAfterRestart;
  if (!mark || typeof mark !== 'object' || mark.loginItem !== true) return false;
  applyLoginItem(startAtLogin);
  state.data.resumeAfterRestart = { ...mark, loginItem: false };
  state.save();
  return true;
}

/** The session ends with the setting on: keep the page, and make sure the app starts at the next sign-in. */
export function keepForRestart(
  state: ResumeState,
  page: { url: string; mode: Mode; origin: string; now: number; startAtLogin: boolean },
  applyLoginItem: (openAtLogin: boolean) => void,
): boolean {
  const mark = resumeMarkFor(page.url, page);
  if (!mark) return false;
  if (mark.loginItem) applyLoginItem(true);
  state.data.resumeAfterRestart = mark;
  state.save();
  return true;
}

/** Where the main window opens on this start: the page from before a restart, once. Null: the usual one. */
export function takeResumeUrl(state: ResumeState, mode: Mode, origin: string, now: number): string | null {
  const mark = state.data.resumeAfterRestart;
  if (mark === undefined) return null;
  delete state.data.resumeAfterRestart;
  state.save();
  return resumeUrlFrom(mark, { mode, origin, now });
}
