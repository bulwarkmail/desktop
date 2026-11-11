/**
 * How the outside world reaches the app: a mailto: or webcal: link, a double-clicked
 * .eml, .ics or .vcf, a file dropped on the icon, a jump list entry. On a cold start
 * and on a second launch alike. Everything ends as a command to the page, which takes
 * it through lib/launch-handoff and the protocol handlers.
 */

import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import type { OsCommand, OsFile } from '../../shared/bridge';
import type { OsHub } from './os-hub';
import { deepLinkFromArgv, parseDeepLink } from '../deep-link';
import { launchFolder } from '../launch-folder';
import { deliverSignInLink } from './browser-sign-in';
import {
  fileReason,
  launchFileCommand,
  LaunchFileBatch,
  launchSkipPaths,
  MAX_LAUNCH_FILE_BYTES,
  MAX_LAUNCH_FILES,
  MAX_LAUNCH_TOTAL_BYTES,
  parseArgv,
  parseToastUrl,
  requestFromUrl,
  type LaunchRequest,
  launchOpensOwnWindow,
} from './os-rules';

const early: { urls: string[]; files: string[]; launches: { argv: string[]; cwd: string }[] } = { urls: [], files: [], launches: [] };
let liveHandler: ((request: LaunchRequest) => void) | null = null;
let liveSecondLaunch: ((argv: string[], cwd: string) => void) | null = null;

/**
 * macOS sends these before `ready`, and before anything else is set up, on a cold
 * start. Dropping a file on the dock comes in here too.
 */
export function holdEarlyLaunches(): void {
  // A second launch during the boot waits as well, and doesn't get lost.
  app.on('second-instance', (_event, argv, cwd) => {
    const link = deepLinkFromArgv(argv);
    if (link?.kind === 'sign-in') {
      deliverSignInLink(link.code, link.state);
      return;
    }
    if (liveSecondLaunch) liveSecondLaunch(argv, cwd);
    else early.launches.push({ argv, cwd });
  });
  app.on('open-file', (event, file) => {
    event.preventDefault();
    if (liveHandler) liveHandler({ commands: [], links: [], files: [file], fromLogin: false, toastUrls: [], sendTo: false });
    else early.files.push(file);
  });
  app.on('open-url', (event, url) => {
    event.preventDefault();
    const link = parseDeepLink(url);
    if (link?.kind === 'sign-in') {
      deliverSignInLink(link.code, link.state);
      return;
    }
    const asked = requestFromUrl(url);
    if (asked.commands.length + asked.links.length === 0) return;
    if (liveHandler) liveHandler({ ...asked, files: [], fromLogin: false, toastUrls: [], sendTo: false });
    else early.urls.push(url);
  });
}

/**
 * The file's own name. When the paths don't fit on one command line, Explorer hands over
 * 8.3 short names (REPORT~1.PDF): the file system's real path gives the name back.
 */
async function realName(file: string): Promise<string> {
  return path.basename(await realpath(file).catch(() => file));
}

type FilesCommand = Extract<OsCommand, { type: 'files' }>;

async function readFiles(files: readonly string[], sendTo: boolean): Promise<FilesCommand[]> {
  const byReason: Record<'open' | 'attach', { files: OsFile[]; failed: string[] }> = {
    open: { files: [], failed: [] },
    attach: { files: [], failed: [] },
  };
  let count = 0;
  let total = 0;
  for (const file of files) {
    const reason = launchFileCommand(fileReason(file), sendTo).reason;
    const name = await realName(file);
    try {
      const info = await stat(file);
      if (!info.isFile()) continue;
      if (info.size > MAX_LAUNCH_FILE_BYTES || count >= MAX_LAUNCH_FILES || total + info.size > MAX_LAUNCH_TOTAL_BYTES) {
        byReason[reason].failed.push(name);
        continue;
      }
      count += 1;
      total += info.size;
      byReason[reason].files.push({ name, data: new Uint8Array(await readFile(file)) });
    } catch {
      // Named on a command line and not there: only worth saying if it looks meant.
      if (path.extname(file)) byReason[reason].failed.push(name);
    }
  }
  return (['open', 'attach'] as const)
    .filter((reason) => byReason[reason].files.length + byReason[reason].failed.length > 0)
    .map((reason) => ({ type: 'files' as const, ...launchFileCommand(reason, sendTo), ...byReason[reason] }));
}

export interface LaunchHandle {
  handle: (argv: string[], cwd: string) => Promise<number>;
  /** File > Open…: the files picked go exactly where "Open with" from Explorer sends them. */
  openFiles: (files: string[]) => void;
}

export function setupLaunch(hub: OsHub): LaunchHandle {
  const skip = launchSkipPaths(!!process.defaultApp, app.getAppPath(), process.argv[1]);

  /** What the toast URLs ask for. One that isn't ours is dropped. */
  const toastActions = (request: LaunchRequest) => request.toastUrls.flatMap((url) => parseToastUrl(url, hub.toastSecret()) ?? []);

  // Files for a message arrive one launch each from "Open with" on several files, and one
  // open-file each on macOS: picked together, they go on one message, behind one question.
  const asking = new LaunchFileBatch<FilesCommand>((command) => hub.dispatch(command));
  const sending = new LaunchFileBatch<FilesCommand>((command) => hub.dispatch(command));

  const run = async (request: LaunchRequest): Promise<number> => {
    const commands = [...request.commands, ...(await readFiles(request.files, request.sendTo))];
    for (const command of commands) {
      if (command.type === 'files' && command.reason === 'attach') (command.ask ? asking : sending).add(command);
      else hub.dispatch(command);
    }
    for (const link of request.links) hub.ctx.openLink(link);
    const actions = toastActions(request);
    for (const { action, context } of actions) hub.toastAction(action, context);
    return commands.length + request.links.length + actions.length;
  };

  /** Pressing Archive shows nothing. Any other launch means "show me the app". */
  const staysHidden = (request: LaunchRequest) =>
    request.commands.length === 0 && request.links.length === 0 && request.files.length === 0 && toastActions(request).length > 0 && toastActions(request).every(({ action }) => action !== 'open' && action !== 'reply');


  liveHandler = (request) => void run(request);

  const handle = (argv: string[], cwd: string) => run(parseArgv(argv, { cwd, skip }));

  liveSecondLaunch = (argv, cwd) => {
    const request = parseArgv(argv, { cwd, skip });
    if (!staysHidden(request) && !launchOpensOwnWindow(request, hub.messageFileWindows)) hub.ctx.showMain();
    void run(request);
  };
  for (const { argv, cwd } of early.launches.splice(0)) liveSecondLaunch(argv, cwd);

  // A second launch with these files on its command line, as Explorer's "Open with" makes one.
  const openFiles = (files: string[]) => {
    const request: LaunchRequest = { commands: [], links: [], files, fromLogin: false, toastUrls: [], sendTo: false };
    if (!launchOpensOwnWindow(request, hub.messageFileWindows)) hub.ctx.showMain();
    void run(request);
  };

  const first = parseArgv(process.argv, { cwd: launchFolder(), skip });
  const wasAtLogin = process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin;
  for (const url of early.urls) {
    const asked = requestFromUrl(url);
    first.commands.push(...asked.commands);
    first.links.push(...asked.links);
  }
  first.files.push(...early.files);
  early.urls.length = 0;
  early.files.length = 0;
  if ((first.fromLogin || wasAtLogin) && hub.settings().startMinimized && !hub.startedForRestart && first.commands.length === 0 && first.links.length === 0 && first.files.length === 0) {
    hub.ctx.windows.startMainHidden();
  }
  // With close to tray off the user has no reason to look there, so the window shows.
  if (staysHidden(first) && hub.settings().closeToTray) hub.ctx.windows.startMainHidden();
  void run(first);

  return { handle, openFiles };
}
