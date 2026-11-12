/**
 * Recent files in the composer's Attach menu, as Outlook has them: the files the OS says
 * the user opened last, newest first, one click to attach one.
 *
 * Where the list comes from: on Windows the shortcuts in the Recent folder, by the time each
 * was written; on macOS Spotlight's last-used date; on Linux GTK's recently-used.xbel.
 *
 * The list is read when the menu opens, from a click or key press main saw itself, and kept
 * in memory for the window that asked until it asks again. A click only says the user did
 * something, so the first list for a server also asks, in the shell's own question window
 * with no as the default, whether that server may see these files (RecentConsent). A yes is
 * kept per origin in the shell's state until it's taken back or the app is wiped; a no holds
 * for a while. The page gets what the menu shows: name, folder, path, when, an icon, and an
 * id. Attaching takes the id, never a path, so the page can only ever have main read a file
 * it was listed after a yes, and only with another click. Then the bytes go the way a file
 * from "Open with" does, to the composer's own checks.
 *
 * Every file system call goes through recent-files-worker.ts, in a process main can stop
 * waiting for: a share that's offline must not hold up the menu, or main. Whatever doesn't
 * answer in time is left out, and the rest shows. Nothing here is logged.
 *
 * The RecentFilesInAttach policy turns it off: the page hides the list, and main refuses.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, shell, utilityProcess, type IpcMainInvokeEvent, type UtilityProcess, type WebContents } from 'electron';
import { CHANNEL, type RecentFile, type RecentFileAttachResult, type RecentFilesResult } from '../../shared/bridge';
import { effectivePolicyValue } from '../../shared/policy-schema';
import { showMessageBox } from '../message-box';
import { strings } from '../strings';
import { takeUserGesture, watchUserGestures } from '../user-gesture';
import type { RecentWorkerMessage, RecentWorkerRequest } from '../recent-files-worker';
import { addWipeStep } from './local-wipe';
import type { OsHub } from './os-hub';
import { policies } from './policies';
import { MAX_LAUNCH_FILE_BYTES } from './os-rules';
import {
  displayFolder,
  displayName,
  MDFIND_ATTRIBUTE,
  MDFIND_QUERY,
  newestCandidates,
  newestShortcuts,
  parseMdfind,
  parseXbel,
  RecentConsent,
  RECENT_FILES_MAX,
  shownCandidates,
  usableShortcutTarget,
  type RecentCandidate,
  type RecentCheck,
} from './recent-rules';

declare const __BULWARK_TEST_BUILD__: boolean;

// Bundled into dist/main.mjs, so this is dist/.
const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'recent-files-worker.cjs');

/** How long one file may take to say it's there. An offline share takes far longer to fail. */
export const RECENT_CHECK_TIMEOUT_MS = 1_500;
/** The list itself: the Recent folder can be redirected to a server. */
const SOURCE_TIMEOUT_MS = 3_000;
const ICON_TIMEOUT_MS = 1_000;
/** A picked file on a slow share: long enough for 100 MB, and then it's given up on. */
const READ_TIMEOUT_MS = 120_000;
/** Shortcuts read for 20 files: some are folders, gone, or the same file twice. */
const SHORTCUTS_READ_MAX = 80;
const XBEL_MAX_BYTES = 16 * 1024 * 1024;

/** Only in a test build: a folder of shortcuts in place of the user's Recent folder. */
function testRecentDir(): string | undefined {
  if (!__BULWARK_TEST_BUILD__) return undefined;
  const prefix = '--bulwark-test-recent-dir=';
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) || undefined;
}

/** What the worker needs from the environment, and threads enough to wait on every path at once. */
function workerEnv(): Record<string, string> {
  const env: Record<string, string> = { UV_THREADPOOL_SIZE: '64' };
  for (const name of ['PATH', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'HOME', 'USERPROFILE']) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

type Request = RecentWorkerRequest extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

/** One worker for one list or one read. `stop` kills it, whatever it's still waiting for. */
class WorkerSession {
  private readonly child: UtilityProcess;
  private readonly ready: Promise<void>;
  private readonly waiting = new Map<number, (message: RecentWorkerMessage | null) => void>();
  private next = 1;
  private gone = false;

  constructor() {
    this.child = utilityProcess.fork(WORKER, [], { serviceName: 'Bulwark recent files', env: workerEnv(), stdio: 'ignore' });
    this.ready = new Promise((resolve) => {
      this.child.once('spawn', () => resolve());
      this.child.once('exit', () => resolve());
    });
    this.child.on('message', (message: RecentWorkerMessage) => this.waiting.get(message.id)?.(message));
    this.child.once('exit', () => {
      this.gone = true;
      for (const answer of [...this.waiting.values()]) answer(null);
    });
  }

  /** Hands each answer to `take` until it says that's enough, or the time is up. Never throws. */
  async ask(request: Request, timeoutMs: number, take: (message: RecentWorkerMessage) => boolean): Promise<void> {
    await this.ready;
    if (this.gone) return;
    const id = this.next++;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.waiting.delete(id);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      this.waiting.set(id, (message) => {
        if (message === null || take(message)) finish();
      });
      this.child.postMessage({ ...request, id });
    });
  }

  stop(): void {
    if (!this.gone) this.child.kill();
  }
}

async function shortcutCandidates(session: WorkerSession, dir: string): Promise<RecentCandidate[]> {
  let entries: { file: string; mtimeMs: number }[] | null = null;
  await session.ask({ op: 'dir', dir }, SOURCE_TIMEOUT_MS, (message) => {
    if (message.type !== 'dir') return false;
    entries = message.entries;
    return true;
  });
  if (!entries) return [];
  const out: RecentCandidate[] = [];
  for (const { file, mtimeMs } of newestShortcuts(entries, SHORTCUTS_READ_MAX)) {
    let target: string | null = null;
    try {
      // Reads the shortcut only: Windows doesn't go looking for the target here.
      target = usableShortcutTarget(shell.readShortcutLink(file).target);
    } catch {
      // Not a shortcut to a file, or unreadable: one fewer.
    }
    if (target) out.push({ path: target, usedAt: mtimeMs });
  }
  return out;
}

function spotlightCandidates(): Promise<RecentCandidate[]> {
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/mdfind',
      ['-attr', MDFIND_ATTRIBUTE, MDFIND_QUERY],
      { timeout: SOURCE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout) => resolve(error && !stdout ? [] : parseMdfind(stdout)),
    );
  });
}

async function xbelCandidates(session: WorkerSession): Promise<RecentCandidate[]> {
  const base = process.env.XDG_DATA_HOME && path.isAbsolute(process.env.XDG_DATA_HOME) ? process.env.XDG_DATA_HOME : path.join(homedir(), '.local', 'share');
  let text = '';
  await session.ask({ op: 'read', path: path.join(base, 'recently-used.xbel'), max: XBEL_MAX_BYTES }, SOURCE_TIMEOUT_MS, (message) => {
    if (message.type !== 'read') return false;
    if (message.ok) text = Buffer.from(message.data).toString('utf8');
    return true;
  });
  return parseXbel(text);
}

function candidates(session: WorkerSession): Promise<RecentCandidate[]> {
  const testDir = testRecentDir();
  if (testDir) return shortcutCandidates(session, testDir);
  if (process.platform === 'win32') {
    const roaming = process.env.APPDATA || path.join(homedir(), 'AppData', 'Roaming');
    return shortcutCandidates(session, path.join(roaming, 'Microsoft', 'Windows', 'Recent'));
  }
  if (process.platform === 'darwin') return spotlightCandidates();
  return xbelCandidates(session);
}

/** Whether the first 20 files, in order, are known: then the rest needn't be waited for. */
function enoughKnown(count: number, checks: ReadonlyMap<number, RecentCheck>): boolean {
  let files = 0;
  for (let index = 0; index < count; index += 1) {
    const kind = checks.get(index);
    if (kind === undefined) return false;
    if (kind === 'file' && ++files >= RECENT_FILES_MAX) return true;
  }
  return true;
}

async function iconOf(file: string): Promise<string | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ICON_TIMEOUT_MS);
  });
  const icon = app.getFileIcon(file, { size: 'normal' }).then(
    (image) => (image.isEmpty() ? undefined : image.toDataURL()),
    () => undefined,
  );
  const answer = await Promise.race([icon, late]);
  clearTimeout(timer);
  return answer;
}

export interface RecentHandle {
  list: (sender: WebContents, origin: string) => Promise<RecentFilesResult>;
  attach: (sender: WebContents, origin: string, id: unknown) => Promise<RecentFileAttachResult>;
  /** Takes back a server's yes, or every one: its lists go, and the next list asks again. */
  forget: (origin?: string) => void;
}

export function recentFilesAllowed(): boolean {
  return effectivePolicyValue(policies.snapshot.RecentFilesInAttach, undefined) !== false;
}

/** The page that called: a main frame on the app's origin, as the channel checked. */
function originOf(event: IpcMainInvokeEvent): string {
  try {
    return new URL(event.senderFrame?.url ?? '').origin;
  } catch {
    return 'null';
  }
}

export function setupRecentFiles(hub: OsHub): RecentHandle {
  /** Per window: the ids of its last list, and the path behind each. */
  const listed = new Map<number, Map<string, string>>();
  hub.ctx.windows.on('created', ({ window }) => watchUserGestures(window.webContents));
  hub.on('locked', (locked) => {
    if (locked) listed.clear();
  });
  hub.on('cleared', () => listed.clear());
  policies.on('changed', () => {
    if (!recentFilesAllowed()) listed.clear();
  });

  const state = hub.ctx.state;
  const stored = () => state.data.recentFilesOrigins ?? [];
  const keep = (origins: string[]) => {
    state.data.recentFilesOrigins = origins;
    state.save();
  };
  /** Its text is the shell's own: no label the page sent reaches it (strings.ts). */
  const ask = async (origin: string, window: unknown): Promise<boolean> => {
    const text = strings();
    const options = {
      type: 'question' as const,
      message: hub.ctx.mode === 'instance' ? text.recentAskTitle(new URL(origin).host) : text.recentAskTitleApp,
      detail: text.recentAskDetail,
      buttons: [text.recentAskAllow, text.recentAskDeny],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    };
    const parent = window instanceof BrowserWindow && !window.isDestroyed() ? window : null;
    const { response } = await (parent ? showMessageBox(parent, options) : showMessageBox(options));
    return response === 0;
  };
  const consent = new RecentConsent({
    store: {
      has: (origin) => stored().includes(origin),
      add: (origin) => keep([...stored().filter((entry) => entry !== origin), origin]),
      remove: (origin) => keep(stored().filter((entry) => entry !== origin)),
      clear: () => keep([]),
    },
    ask,
  });
  const forget = (origin?: string) => {
    consent.forget(origin);
    // An id from a list before is no way in any more.
    listed.clear();
  };
  // A wipe takes every server's yes: the next list asks again.
  addWipeStep(async () => forget());

  const remember = (sender: WebContents, ids: Map<string, string>) => {
    if (!listed.has(sender.id)) {
      const id = sender.id;
      sender.once('destroyed', () => listed.delete(id));
    }
    listed.set(sender.id, ids);
  };

  const list = async (sender: WebContents, origin: string): Promise<RecentFilesResult> => {
    if (!recentFilesAllowed()) return { ok: false, reason: 'policy' };
    if (hub.locked) return { ok: false, reason: 'locked' };
    if (!takeUserGesture(sender)) return { ok: false, reason: 'gesture' };
    // A no answers as no click does: the page shows no list either way.
    if (!(await consent.decide(origin, BrowserWindow.fromWebContents(sender)))) return { ok: false, reason: 'gesture' };
    // Locked or switched off while it asked.
    if (!recentFilesAllowed()) return { ok: false, reason: 'policy' };
    if (hub.locked) return { ok: false, reason: 'locked' };
    if (sender.isDestroyed()) return { ok: false, reason: 'gesture' };
    const session = new WorkerSession();
    try {
      const found = newestCandidates(await candidates(session), process.platform);
      const checks = new Map<number, RecentCheck>();
      // The size goes to the page, which greys out a file larger than the server takes.
      const sizes = new Map<RecentCandidate, number>();
      if (found.length > 0) {
        await session.ask({ op: 'check', paths: found.map((entry) => entry.path) }, RECENT_CHECK_TIMEOUT_MS, (message) => {
          if (message.type !== 'checked') return false;
          checks.set(message.index, message.kind);
          if (typeof message.size === 'number' && found[message.index]) sizes.set(found[message.index], message.size);
          return enoughKnown(found.length, checks);
        });
      }
      session.stop();
      const shown = shownCandidates(found, checks);
      const ids = new Map<string, string>();
      const home = homedir();
      const files: RecentFile[] = await Promise.all(shown.map(async (entry) => {
        const id = randomUUID();
        ids.set(id, entry.path);
        const icon = await iconOf(entry.path);
        return {
          id,
          name: displayName(entry.path, process.platform),
          folder: displayFolder(entry.path, process.platform, home),
          path: entry.path,
          usedAt: entry.usedAt,
          ...(sizes.has(entry) ? { size: sizes.get(entry)! } : {}),
          ...(icon ? { icon } : {}),
        };
      }));
      // Locked or switched off while it looked, or the yes taken back.
      if (!recentFilesAllowed()) return { ok: false, reason: 'policy' };
      if (hub.locked) return { ok: false, reason: 'locked' };
      if (!consent.allowed(origin)) return { ok: false, reason: 'gesture' };
      if (!sender.isDestroyed()) remember(sender, ids);
      return { ok: true, files };
    } finally {
      session.stop();
    }
  };

  const attach = async (sender: WebContents, origin: string, id: unknown): Promise<RecentFileAttachResult> => {
    if (!recentFilesAllowed()) return { ok: false, reason: 'policy' };
    if (hub.locked) return { ok: false, reason: 'locked' };
    if (!takeUserGesture(sender)) return { ok: false, reason: 'gesture' };
    // Only a list this server was given after a yes it still has.
    const file = typeof id === 'string' && consent.allowed(origin) ? listed.get(sender.id)?.get(id) : undefined;
    if (!file) return { ok: false, reason: 'unknown' };
    const session = new WorkerSession();
    let answer: Extract<RecentWorkerMessage, { type: 'read' }> | null = null;
    try {
      await session.ask({ op: 'read', path: file, max: MAX_LAUNCH_FILE_BYTES }, READ_TIMEOUT_MS, (message) => {
        if (message.type !== 'read') return false;
        answer = message;
        return true;
      });
    } finally {
      session.stop();
    }
    const read = answer as Extract<RecentWorkerMessage, { type: 'read' }> | null;
    if (!read) return { ok: false, reason: 'failed' };
    if (!read.ok) return { ok: false, reason: read.reason };
    if (!recentFilesAllowed()) return { ok: false, reason: 'policy' };
    if (hub.locked) return { ok: false, reason: 'locked' };
    return { ok: true, file: { name: displayName(file, process.platform), data: read.data } };
  };

  hub.ctx.handle(CHANNEL.recentFilesList, (event) => list(event.sender, originOf(event)));
  hub.ctx.handle(CHANNEL.recentFilesAttach, (event, _window, id) => attach(event.sender, originOf(event), id));
  return { list, attach, forget };
}
