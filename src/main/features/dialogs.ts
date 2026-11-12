/**
 * Questions and files on the clipboard. Save, open and pick-a-folder need nothing
 * here: Chromium's own file pickers already are the OS's. `confirm` is the OS's own
 * message box; `show` is a window of the app's own (dialog-window.ts).
 */

import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { app, clipboard, powerMonitor } from 'electron';
import { removeOwn } from '../remove-tree';
import { addWipeStep } from './local-wipe';
import { CHANNEL, type ConfirmOptions } from '../../shared/bridge';
import { dialogWindows } from '../dialog-window';
import { showDialogSurface } from '../dialog-surfaces';
import { shownHost } from '../navigation-rules';
import { strings } from '../strings';
import { writeFilesToClipboard } from '../file-clipboard';
import type { Feature } from './index';
import { writeMarkedFile } from './os-files';
import { safeDragFileName } from './os-rules';
import { showMessageBox } from '../message-box';

/** In Electron, but left out of its types as experimental. */
function writeClipboardBuffer(format: string, data: Buffer): void {
  (clipboard as unknown as { writeBuffer: (format: string, data: Buffer) => void }).writeBuffer(format, data);
}

const MAX_TEXT = 2000;
/** More than the page ever has open. Past this, a loop of questions gets "no" and no box. */
const MAX_WAITING_QUESTIONS = 3;
const MAX_FILE_BYTES = 200 * 1024 * 1024;
/** Long enough to go and paste it. An attachment shouldn't sit around in the clear. */
const CLIPBOARD_FILE_MS = 10 * 60_000;

/** Files handed to the clipboard live here until the next start: a paste can come any time. */
function clipboardFolder(): string {
  return path.join(app.getPath('userData'), 'clipboard-files');
}

function emptyClipboardFolder(): void {
  try {
    for (const entry of readdirSync(clipboardFolder())) removeOwn(path.join(clipboardFolder(), entry), { root: clipboardFolder() });
  } catch {
    // Nothing there yet.
  }
}

/**
 * The OS's file clipboard. Electron has no call for it, and on Windows the format
 * Explorer pastes isn't one a buffer can be written to: the native helper writes it.
 */
function putFileOnClipboard(file: string): Promise<boolean> {
  if (process.platform === 'darwin') {
    const plist = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><array><string>${file.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</string></array></plist>`;
    writeClipboardBuffer('NSFilenamesPboardType', Buffer.from(plist));
    return Promise.resolve(true);
  }
  if (process.platform === 'linux') {
    const uri = `file://${file.split('/').map(encodeURIComponent).join('/')}`;
    writeClipboardBuffer('text/uri-list', Buffer.from(`${uri}\r\n`));
    writeClipboardBuffer('x-special/gnome-copied-files', Buffer.from(`copy\n${uri}`));
    return Promise.resolve(true);
  }
  return writeFilesToClipboard([file]);
}

export const dialogsFeature: Feature = {
  name: 'dialogs',
  modes: ['standalone', 'instance'],
  setup(ctx) {
    // A wipe of what's local covers the copies waiting to be pasted. All of them are this run's,
    // so its server's: the folder is emptied at every start and quit.
    addWipeStep(async () => emptyClipboardFolder());
    emptyClipboardFolder();
    app.on('will-quit', emptyClipboardFolder);
    powerMonitor.on('lock-screen', emptyClipboardFolder);
    ctx.on(CHANNEL.clipboardClearFiles, () => emptyClipboardFolder());

    let waitingQuestions = 0;
    ctx.handle(CHANNEL.dialogsConfirm, async (_event, window, options) => {
      const { message, detail, buttons, defaultId, type } = (options ?? {}) as Partial<ConfirmOptions>;
      if (typeof message !== 'string' || !Array.isArray(buttons)) throw new Error('Not a question');
      const labels = buttons.filter((b): b is string => typeof b === 'string').slice(0, 4).map((b) => b.slice(0, 80));
      if (labels.length === 0) throw new Error('Not a question');
      if (waitingQuestions >= MAX_WAITING_QUESTIONS) return labels.length - 1;
      // In instance mode the page writes the rest of the box, so this is what tells the
      // server's questions from the app's own. The app's dialog window shows no title, so
      // it goes under the text. Standalone, the page is the app's own build: its questions
      // are the app's, and its internal address would only look broken.
      const standalone = ctx.mode === 'standalone';
      const from = standalone ? strings().windowNames.main : strings().pageQuestionFrom.replaceAll('{caller}', shownHost(new URL(ctx.origin).host));
      const text = typeof detail === 'string' ? detail.slice(0, MAX_TEXT) : undefined;
      const settings: Electron.MessageBoxOptions = {
        type: type === 'info' || type === 'warning' || type === 'question' ? type : 'question',
        title: from,
        message: message.slice(0, MAX_TEXT),
        detail: !standalone ? [text, from].filter(Boolean).join('\n\n') : text,
        buttons: labels,
        defaultId: typeof defaultId === 'number' && defaultId >= 0 && defaultId < labels.length ? defaultId : labels.length - 1,
        cancelId: labels.length - 1,
        noLink: true,
      };
      waitingQuestions += 1;
      try {
        const answer = window ? await showMessageBox(window, settings) : await showMessageBox(settings);
        return answer.response;
      } finally {
        waitingQuestions -= 1;
      }
    });

    const windows = dialogWindows();
    ctx.handle(CHANNEL.dialogsShow, (event, window, request) => windows.ask(event.sender, window, request));
    ctx.on(CHANNEL.dialogsCancel, (event, _window, id) => windows.cancel(event.sender, id));
    // The page's own dialogs in windows of their own (dialog-surfaces.ts).
    ctx.handle(CHANNEL.dialogsShowWindow, (event, _window, name) => showDialogSurface(event.sender, name));

    ctx.handle(CHANNEL.clipboardCopyFile, async (_event, _window, name, data) => {
      if (!(data instanceof ArrayBuffer) && !ArrayBuffer.isView(data)) return false;
      const bytes = data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      if (bytes.byteLength > MAX_FILE_BYTES) return false;
      // Its own folder, so two attachments with the same name don't overwrite each other.
      const folder = path.join(clipboardFolder(), randomBytes(8).toString('hex'));
      mkdirSync(folder, { recursive: true });
      const file = path.join(folder, safeDragFileName(name));
      await writeMarkedFile(file, bytes);
      setTimeout(() => {
        try {
          removeOwn(folder, { root: clipboardFolder() });
        } catch {
          // Held by a program: the folder is emptied at the next quit or start.
        }
      }, CLIPBOARD_FILE_MS).unref?.();
      return putFileOnClipboard(file);
    });
  },
};
