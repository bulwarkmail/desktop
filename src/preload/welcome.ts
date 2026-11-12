/**
 * The first-run page's only way out: it names a mode, main validates it.
 * Separate from the app's bridge, since this page isn't the webmail.
 */

import { contextBridge, ipcRenderer } from 'electron';
import { CHANNEL } from '../shared/bridge';

function options(): { allowStandalone: boolean; instanceUrl: string | null; urlLocked: boolean; page?: 'org' | null; askTelemetry?: boolean; askCrashReports?: boolean; dark?: boolean | null } {
  const prefix = '--bulwark-welcome=';
  try {
    return JSON.parse(decodeURIComponent(process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length) ?? ''));
  } catch {
    return { allowStandalone: true, instanceUrl: null, urlLocked: false };
  }
}

contextBridge.exposeInMainWorld('bulwarkWelcome', {
  options: options(),
  choose: (choice: { mode: 'standalone'; email: string } | { mode: 'instance'; url: string }): Promise<{ ok: boolean; error?: string; next?: 'privacy' }> =>
    ipcRenderer.invoke(CHANNEL.welcomeChoose, choice),
  answerPrivacy: (answers: { telemetry: boolean; crashReports: boolean }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(CHANNEL.welcomePrivacy, answers),
  /** A page main knows by this name, in the browser: "providers". */
  openLink: (name: string): void => ipcRenderer.send(CHANNEL.welcomeOpenLink, name),
  /** The height the page needs, in CSS pixels. Main sizes the window to it. */
  fit: (height: number): void => ipcRenderer.send(CHANNEL.welcomeFit, height),
});
