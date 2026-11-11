/**
 * "Open again after a restart". When the computer restarts or the user signs out with the app
 * running, the shell keeps the main window's page and, with start at login off, makes a login
 * entry for the next start only. That start opens the main window on the page (index.ts) and
 * puts the login entry back the way the user has it (resume-rules.ts). Windows says so through
 * a window's `session-end`, macOS and Linux through powerMonitor's `shutdown`.
 */

import { powerMonitor } from 'electron';
import { keepForRestart, settleRestartLoginEntry } from '../resume-rules';
import type { OsHub } from './os-hub';

export function setupRestart(hub: OsHub, applyLoginItem: (openAtLogin: boolean) => void): void {
  const { state, windows, mode, origin } = hub.ctx;
  hub.startedForRestart = settleRestartLoginEntry(state, hub.settings().startAtLogin, applyLoginItem);

  let kept = false;
  const keep = () => {
    if (kept || !hub.settings().reopenAfterRestart) return;
    const main = windows.mainWindow();
    if (!main || main.isDestroyed()) return;
    kept = keepForRestart(state, { url: main.webContents.getURL(), mode, origin, now: Date.now(), startAtLogin: hub.settings().startAtLogin }, applyLoginItem);
  };
  windows.on('sessionEnding', keep);
  powerMonitor.on('shutdown', keep);
}
