/**
 * Mail as real files: dragged out to Explorer or Finder, or copied to the clipboard.
 * The file must exist before the drag starts, so it goes in a private folder, never the
 * shared temp folder, on this machine only (Local, not a roaming profile), and leaves again
 * minutes later. Each file is marked as coming from outside, as a browser's download is, so
 * Windows treats it with the same care.
 *
 * A program opened straight from this folder may hold a file: that one stays until it's
 * free, tried again every few minutes and at the next start. If that program saves in
 * place and is closed after the file went, the edit went with it, so Explorer's copy is
 * the place to work on. See "OS integration" in the README.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { app, clipboard, nativeImage, type WebContents } from 'electron';
import { writeFilesToClipboard } from '../file-clipboard';
import { removeOwn } from '../remove-tree';
import { safeDragFileName } from './os-rules';
import { isInstalledBuild } from '../installed';

/** A drop is over when Windows' startDrag returns. Elsewhere it returns at once. */
const DRAG_FILE_LIFE_MS = process.platform === 'win32' ? 2 * 60 * 1000 : 10 * 60 * 1000;
/** Long enough to go and paste. The file is plain mail on disk until then. */
const COPY_FILE_LIFE_MS = 10 * 60 * 1000;
const RETRY_LOCKED_MS = 5 * 60 * 1000;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const MAX_FILES = 200;

interface Incoming {
  name: string;
  data: Uint8Array;
}

function cleanFiles(raw: unknown): Incoming[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_FILES) return null;
  let total = 0;
  const seen = new Set<string>();
  const files: Incoming[] = [];
  for (const entry of raw) {
    const input = (entry ?? {}) as { name?: unknown; data?: unknown };
    if (!(input.data instanceof Uint8Array)) return null;
    total += input.data.byteLength;
    if (total > MAX_TOTAL_BYTES) return null;
    const first = safeDragFileName(input.name);
    let name = first;
    for (let n = 2; seen.has(name.toLowerCase()); n += 1) {
      const ext = path.extname(first);
      name = `${path.basename(first, ext)} (${n})${ext}`;
    }
    seen.add(name.toLowerCase());
    files.push({ name, data: input.data });
  }
  return files;
}

function copyToClipboard(paths: string[]): Promise<boolean> {
  // A real file list (CF_HDROP), which is what Explorer pastes, through the native helper.
  if (process.platform === 'win32') return writeFilesToClipboard(paths);
  return new Promise((resolve) => {
    if (process.platform === 'darwin') {
      const script = 'on run argv\nset out to {}\nrepeat with p in argv\nset end of out to (POSIX file (p as text))\nend repeat\nset the clipboard to out\nend run';
      execFile('/usr/bin/osascript', ['-e', script, ...paths], { timeout: 15_000 }, (error) => resolve(!error));
    } else {
      const uris = paths.map((p) => `file://${p.split('/').map(encodeURIComponent).join('/')}`);
      // Marked experimental, so it isn't in Electron's types.
      const writer = clipboard as unknown as { writeBuffer?: (format: string, data: Buffer) => void };
      writer.writeBuffer?.('text/uri-list', Buffer.from(`${uris.join('\r\n')}\r\n`));
      writer.writeBuffer?.('x-special/gnome-copied-files', Buffer.from(`copy\n${uris.join('\n')}`));
      resolve(!!writer.writeBuffer);
    }
  });
}

/**
 * Marked as coming from outside, as a browser's download is. Off NTFS there's nowhere to put the mark.
 * `exclusive`: fails with EEXIST rather than overwrite what's there.
 */
export async function writeMarkedFile(target: string, data: Uint8Array, options: { exclusive?: boolean } = {}): Promise<void> {
  await writeFile(target, data, { mode: 0o600, flag: options.exclusive ? 'wx' : 'w' });
  if (process.platform === 'win32') {
    await writeFile(`${target}:Zone.Identifier`, '[ZoneTransfer]\r\nZoneId=3\r\n').catch(() => {});
  }
}

export interface FilesHandle {
  directory: string;
  prepare: (raw: unknown) => Promise<{ folder: string; paths: string[] } | null>;
  startDrag: (contents: WebContents, raw: unknown) => Promise<boolean>;
  copy: (raw: unknown) => Promise<boolean>;
  /** Sign-out, a wipe, the lock: what's free goes now. */
  clear: () => void;
}

function filesRoot(): string {
  const local = process.env.LOCALAPPDATA;
  if (process.platform === 'win32' && isInstalledBuild() && local) return path.join(local, 'Bulwark', 'os-files');
  return path.join(app.getPath('userData'), 'os-files');
}

/** A held file stops only itself: never the start of the app, and never a quit. */
function sweep(directory: string): void {
  let folders: string[];
  try {
    folders = readdirSync(directory);
  } catch {
    return;
  }
  for (const folder of folders) {
    try {
      removeOwn(path.join(directory, folder), { root: directory, tries: 1 });
    } catch {
      // Held by a program. The next sweep, at the latest the next start.
    }
  }
}

export function setupFiles(iconPath: string): FilesHandle {
  const directory = filesRoot();
  // Whatever a crash, a held file or the last run left.
  sweep(directory);

  const removeLater = (folder: string, afterMs: number) => {
    const timer = setTimeout(() => {
      try {
        removeOwn(folder, { root: directory, tries: 1 });
      } catch {
        removeLater(folder, RETRY_LOCKED_MS);
      }
    }, afterMs);
    timer.unref?.();
  };

  const prepare = async (raw: unknown) => {
    const files = cleanFiles(raw);
    if (!files) return null;
    const folder = path.join(directory, randomUUID());
    await mkdir(folder, { recursive: true });
    const paths: string[] = [];
    for (const file of files) {
      const target = path.join(folder, file.name);
      await writeMarkedFile(target, file.data);
      paths.push(target);
    }
    return { folder, paths };
  };

  const startDrag = async (contents: WebContents, raw: unknown) => {
    const prepared = await prepare(raw);
    if (!prepared) return false;
    const { folder, paths } = prepared;
    contents.startDrag({ file: paths[0], files: paths, icon: nativeImage.createFromPath(iconPath) });
    removeLater(folder, DRAG_FILE_LIFE_MS);
    return true;
  };

  const copy = async (raw: unknown) => {
    const prepared = await prepare(raw);
    if (!prepared) return false;
    removeLater(prepared.folder, COPY_FILE_LIFE_MS);
    return copyToClipboard(prepared.paths);
  };

  const clear = () => sweep(directory);

  app.on('will-quit', clear);

  return { directory, prepare, startDrag, copy, clear };
}
