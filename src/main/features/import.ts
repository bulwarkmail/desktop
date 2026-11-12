/**
 * Import of local mail data: Thunderbird profiles and Outlook PST files.
 *
 * A privileged plugin's frame is same-origin and can reach parent.bulwarkDesktop, and its
 * calls look like the main frame's, so the webmail's UI is no boundary. Here in main:
 * - Looking is a native question. Without a yes, nothing on the disk is touched.
 * - The page only ever gets opaque handles, and can't name a path.
 * - Reading is a second native question that lists the real paths. Only then do bytes go
 *   anywhere, and only for those files (import-files.ts).
 * - An interrupted job comes back only through a third native question.
 *
 * The list of confirmed paths stays in the state file so an import can go on after a
 * restart: an import under a server's upload limit can take days.
 */

import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, protocol } from 'electron';
import {
  CHANNEL,
  type LocalImportFile,
  type LocalImportGrantResult,
  type LocalImportResumeResult,
  type LocalImportScanResult,
} from '../../shared/bridge';
import { IMPORT_SCHEME, ImportGrants, type ConfirmedFile } from '../import-files';
import { FILES_SCHEME } from '../files/read-grants';
import type { FoundBook, FoundFile, ScanEnv } from '../import-scan';
import { runImportWorker, type WorkerOutcome } from '../import-worker-client';
import type { WorkerScan } from '../import-worker';
import type { StoredImportJob } from '../state';
import { strings } from '../strings';
import { wipeCovers } from '../wipe-scope';
import { addWipeStep } from './local-wipe';
import type { Feature } from './index';
import { showMessageBox } from '../message-box';

/** A job not touched for this long is forgotten: the file has likely changed or been forgotten. */
const JOB_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;
/** After a no, a page asking again gets a no without a dialog, so it can't nag. */
const QUIET_AFTER_NO_MS = 5000;
const NAMES_IN_PROMPT = 12;
/** How long the worker may look. Past that it goes, and what it found so far is the answer. */
const SCAN_TIMEOUT_MS = 60_000;
/** How long it may look at confirmed files and read address books. */
const PREPARE_TIMEOUT_MS = 120_000;

declare const __BULWARK_TEST_BUILD__: boolean;

/** A test's stand-in for a file that never answers. */
const TEST_HANG = __BULWARK_TEST_BUILD__ && process.argv.includes('--bulwark-test-import-hang');

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'import-worker.cjs');

/**
 * Before `ready`, or the scheme isn't privileged. bypassCSP: an instance's own CSP has no reason to name it.
 * The files sync's reads (features/files-folders.ts) go in the same call: Electron takes one list.
 */
export function registerImportScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: IMPORT_SCHEME, privileges: { secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true } },
    { scheme: FILES_SCHEME, privileges: { secure: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true } },
  ]);
}

function scanEnv(): ScanEnv {
  return {
    platform: process.platform,
    home: app.getPath('home'),
    appData: app.getPath('appData'),
    localAppData: process.env.LOCALAPPDATA,
    documents: app.getPath('documents'),
  };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function pathList(paths: string[]): string {
  const shown = paths.slice(0, NAMES_IN_PROMPT).join('\n');
  const more = paths.length - NAMES_IN_PROMPT;
  return more > 0 ? `${shown}\n${strings().importMore(more)}` : shown;
}

async function ask(window: BrowserWindow | null, options: Electron.MessageBoxOptions): Promise<number> {
  const parent = window && !window.isDestroyed() ? window : null;
  const { response } = await (parent ? showMessageBox(parent, options) : showMessageBox(options));
  return response;
}

function toConfirmed(file: FoundFile): ConfirmedFile {
  return { path: file.path, root: file.root, kind: file.kind, name: file.name, folder: file.folder };
}

export const importFeature: Feature = {
  name: 'import',
  modes: ['standalone', 'instance'],
  setup(ctx) {
    const grants = new ImportGrants(ctx.origin);
    ctx.session.protocol.handle(IMPORT_SCHEME, (request) => grants.serve(request));

    // What the last scan found, by opaque handle. A new scan replaces it.
    let candidates = new Map<string, FoundFile>();
    let bookHandles = new Map<string, FoundBook>();
    let profiles: string[] = [];
    let asking = false;
    let noUntil = 0;

    const stored = () => (ctx.state.data.importJobs ?? []).filter((job) => job.origin === ctx.origin);
    const saveJobs = (jobs: StoredImportJob[]) => {
      ctx.state.data.importJobs = [...(ctx.state.data.importJobs ?? []).filter((job) => job.origin !== ctx.origin), ...jobs];
      // At once: a kill right after confirming must not lose the job.
      ctx.state.save();
    };
    saveJobs(stored().filter((job) => Date.now() - job.touchedAt < JOB_MAX_AGE_MS));

    // A wipe takes the paths the user confirmed and every way to read them: a server's wipe the
    // jobs started from its page, the policy's every page's. What this run holds is this page's.
    addWipeStep(async ({ origin }) => {
      await grants.releaseAll();
      candidates = new Map();
      bookHandles = new Map();
      profiles = [];
      ctx.state.data.importJobs = (ctx.state.data.importJobs ?? []).filter((job) => !wipeCovers(origin, job.origin));
      ctx.state.save();
    });

    /** One dialog at a time, and quiet for a moment after a no. */
    const question = async <T>(busy: T, declined: T, run: () => Promise<T>): Promise<T> => {
      if (asking) return busy;
      if (Date.now() < noUntil) return declined;
      asking = true;
      try {
        const answer = await run();
        if (answer === declined) noUntil = Date.now() + QUIET_AFTER_NO_MS;
        return answer;
      } finally {
        asking = false;
      }
    };

    const host = new URL(ctx.origin).host;

    ctx.handle(CHANNEL.localImportScan, (_event, window): Promise<LocalImportScanResult> => {
      const busy: LocalImportScanResult = { ok: false, reason: 'busy' };
      const declined: LocalImportScanResult = { ok: false, reason: 'declined' };
      return question(busy, declined, async () => {
        const text = strings();
        const response = await ask(window, {
          type: 'question',
          message: text.importScanTitle(host),
          detail: text.importScanDetail,
          buttons: [text.importScanAllow, text.importDeny],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        });
        if (response !== 0) return declined;
        const outcome: WorkerOutcome = await runImportWorker(
          WORKER,
          { op: 'scan', env: scanEnv(), hangAfterFirstProfile: TEST_HANG },
          TEST_HANG ? 3000 : SCAN_TIMEOUT_MS,
        );
        let found: WorkerScan | null = null;
        if (outcome.done && outcome.message.type === 'scan') found = outcome.message.scan;
        else if (!outcome.done) found = outcome.partial;
        if (!found) return { ok: false, reason: 'failed' };
        candidates = new Map(found.files.map((file) => [randomBytes(16).toString('base64url'), file]));
        profiles = found.profiles;
        const bookEntries = found.books.map((book) => ({ handle: randomBytes(16).toString('base64url'), book }));
        bookHandles = new Map(bookEntries.map((entry) => [entry.handle, entry.book]));
        return {
          ok: true,
          candidates: [...candidates].map(([handle, file]) => ({
            handle,
            app: file.app,
            kind: file.kind,
            group: file.group,
            account: file.account,
            folder: file.folder,
            name: file.name,
            size: file.size,
            lastModified: file.lastModified,
            messages: file.messages,
          })),
          books: bookEntries.map((entry) => ({ handle: entry.handle, group: entry.book.group, name: entry.book.name, contacts: entry.book.contacts })),
          refused: found.refused,
          calendars: found.calendars,
          thunderbirdRunning: found.thunderbirdRunning,
          ...(outcome.done ? {} : { incomplete: true }),
        };
      });
    });

    /**
     * The files that pass, as grants of a job. What doesn't pass is named. Null when the worker
     * didn't come back: nothing is known about any of them.
     */
    const openJob = async (jobId: string, files: ConfirmedFile[], books: FoundBook[], jobProfiles: string[]) => {
      const outcome = await runImportWorker(
        WORKER,
        { op: 'prepare', files, books: books.map((book) => book.path), profiles: jobProfiles, platform: process.platform },
        PREPARE_TIMEOUT_MS,
      );
      if (!outcome.done || outcome.message.type !== 'prepared') return null;
      const { message } = outcome;
      const granted: LocalImportFile[] = [];
      const refused: string[] = [];
      let inUse = false;
      message.files.forEach((answer, index) => {
        if ('prepared' in answer) {
          granted.push(grants.add(jobId, files[index], answer.prepared));
          return;
        }
        refused.push(files[index].name);
        if (answer.failure === 'in-use') inUse = true;
      });
      const refusedBooks = books.filter((book) => message.refusedBooks.includes(book.path)).map((book) => book.name);
      return { granted, refused: [...refused, ...refusedBooks], inUse, contacts: message.contacts, thunderbirdRunning: message.thunderbirdRunning };
    };

    ctx.handle(CHANNEL.localImportGrant, (_event, window, handles): Promise<LocalImportGrantResult> => {
      const busy: LocalImportGrantResult = { ok: false, reason: 'busy' };
      const declined: LocalImportGrantResult = { ok: false, reason: 'declined' };
      const invalid: LocalImportGrantResult = { ok: false, reason: 'invalid' };
      // Only handles the last scan handed out mean anything. Anything else, a path included, is refused here.
      if (!Array.isArray(handles) || handles.length === 0) return Promise.resolve(invalid);
      if (handles.some((handle) => typeof handle !== 'string' || (!candidates.has(handle) && !bookHandles.has(handle)))) return Promise.resolve(invalid);
      const wanted = handles as string[];
      return question(busy, declined, async () => {
        const text = strings();
        const files = wanted.flatMap((handle) => candidates.get(handle) ?? []);
        const books = wanted.flatMap((handle) => bookHandles.get(handle) ?? []);
        const confirmed = files.map(toConfirmed);
        const size = files.reduce((total, file) => total + file.size, 0);
        const response = await ask(window, {
          type: 'question',
          message: text.importReadTitle(host, confirmed.length + books.length),
          detail: `${text.importReadDetail(formatBytes(size))}\n\n${pathList([...confirmed.map((file) => file.path), ...books.map((book) => book.path)])}`,
          buttons: [text.allow, text.importDeny],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        });
        if (response !== 0) return declined;
        const jobId = randomBytes(16).toString('base64url');
        const opened = await openJob(jobId, confirmed, books, profiles);
        if (!opened) return { ok: false, reason: 'invalid', refused: [...confirmed.map((file) => file.name), ...books.map((book) => book.name)] };
        const { granted, refused, contacts, thunderbirdRunning } = opened;
        if (granted.length === 0 && contacts.length === 0) return { ok: false, reason: 'invalid', refused };
        if (granted.length > 0) {
          const grantedNames = new Set(granted.map((file) => file.name));
          saveJobs([...stored(), { id: jobId, origin: ctx.origin, touchedAt: Date.now(), profiles, files: confirmed.filter((file) => grantedNames.has(file.name)) }]);
        }
        return { ok: true, jobId, files: granted, contacts, refused, thunderbirdRunning };
      });
    });

    ctx.handle(CHANNEL.localImportResume, (_event, window, jobId): Promise<LocalImportResumeResult> => {
      const job = stored().find((entry) => entry.id === jobId);
      if (!job) return Promise.resolve({ ok: false, reason: 'unknown' });
      const busy: LocalImportResumeResult = { ok: false, reason: 'busy' };
      const later: LocalImportResumeResult = { ok: false, reason: 'later' };
      return question(busy, later, async () => {
        const text = strings();
        const response = await ask(window, {
          type: 'question',
          message: text.importResumeTitle(host),
          detail: `${text.importResumeDetail}\n\n${pathList(job.files.map((file) => file.path))}`,
          buttons: [text.importResumeContinue, text.importResumeLater, text.importResumeStop],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
        });
        if (response === 2) {
          await grants.release(job.id);
          saveJobs(stored().filter((entry) => entry.id !== job.id));
          return { ok: false, reason: 'stopped' };
        }
        if (response !== 0) return later;
        await grants.release(job.id);
        const opened = await openJob(job.id, job.files, [], job.profiles);
        const names = job.files.map((file) => file.name);
        // Nothing known about any of them: they may well come back.
        if (!opened) return { ok: false, reason: 'in-use', refused: names };
        if (opened.granted.length === 0) {
          if (opened.inUse) return { ok: false, reason: 'in-use', refused: opened.refused };
          // All gone for good. Nothing can come of this job, so it doesn't keep their paths either.
          saveJobs(stored().filter((entry) => entry.id !== job.id));
          return { ok: false, reason: 'invalid', refused: opened.refused };
        }
        job.touchedAt = Date.now();
        saveJobs(stored());
        return { ok: true, jobId: job.id, files: opened.granted, contacts: [], refused: opened.refused, thunderbirdRunning: opened.thunderbirdRunning };
      });
    });

    // These only narrow, so any page may call them and none gains by it.
    ctx.handle(CHANNEL.localImportRelease, async (_event, _window, jobId) => {
      if (typeof jobId !== 'string') return;
      await grants.release(jobId);
      saveJobs(stored().filter((job) => job.id !== jobId));
    });
    ctx.handle(CHANNEL.localImportReleaseAll, async () => {
      await grants.releaseAll();
      candidates = new Map();
      bookHandles = new Map();
      saveJobs([]);
    });
  },
};
