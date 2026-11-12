/**
 * What the mouse and keyboard do to a window outside the page: Ctrl+wheel zooms with
 * the menu's zoom, the mouse's back and forward buttons go through
 * the app's own history, and Alt shows the menu strip where there's no native bar.
 */

import type { BrowserWindow, Input } from 'electron';
import type { MenuBarEntry, MenuBarEvent } from '../../shared/bridge';
import type { Feature } from './index';

/** Only inside the app's history. A pop-out has none, so nothing happens there. */
export function navigateHistory(window: BrowserWindow, direction: 1 | -1): void {
  const history = window.webContents.navigationHistory;
  if (direction < 0 && history.canGoBack()) history.goBack();
  if (direction > 0 && history.canGoForward()) history.goForward();
}

export type AltAction = { type: 'none' } | { type: 'toggle' } | { type: 'open'; id: string };

/**
 * Alt alone shows the strip, and Alt plus a menu's letter opens that menu. AltGr types. A letter
 * the OS repeats while it's held, or one an input method is composing, opens nothing: only the
 * key going down opens a menu.
 */
export class AltTracker {
  private armed = false;

  feed(input: Pick<Input, 'type' | 'key' | 'alt' | 'control' | 'meta' | 'shift'> & Partial<Pick<Input, 'isAutoRepeat' | 'isComposing' | 'modifiers'>>, entries: readonly MenuBarEntry[]): AltAction {
    if (input.type === 'keyDown') {
      if (input.key === 'Alt') {
        this.armed = !input.control && !input.meta && !input.shift;
        return { type: 'none' };
      }
      this.armed = false;
      if (input.isAutoRepeat === true || input.modifiers?.includes('isautorepeat') || input.isComposing === true) return { type: 'none' };
      if (input.alt && !input.control && !input.meta && !input.shift && input.key.length === 1) {
        const found = entries.find((entry) => entry.mnemonic === input.key.toLowerCase());
        if (found) return { type: 'open', id: found.id };
      }
      return { type: 'none' };
    }
    if (input.type === 'keyUp' && input.key === 'Alt' && this.armed) {
      this.armed = false;
      return { type: 'toggle' };
    }
    return { type: 'none' };
  }
}

export const windowInputFeature: Feature = {
  name: 'window-input',
  modes: ['standalone', 'instance'],
  setup({ windows, zoom, menu }) {
    windows.on('created', ({ window }) => {
      const { webContents } = window;

      webContents.on('zoom-changed', (_event, direction) => zoom.step(direction === 'in' ? 1 : -1));
      // Pinch needs nothing: visual zoom is off by default in Electron. Don't call
      // setVisualZoomLevelLimits here to be sure. On a window closing as its page
      // finishes loading it took the whole app down, about one close in four.

      // Windows and Linux. The mouse's own buttons arrive as these.
      window.on('app-command', (_event, command) => {
        if (command === 'browser-backward') navigateHistory(window, -1);
        if (command === 'browser-forward') navigateHistory(window, 1);
      });
      // The macOS swipe.
      window.on('swipe', (_event, direction) => {
        if (direction === 'left') navigateHistory(window, -1);
        if (direction === 'right') navigateHistory(window, 1);
      });

      // A native frame has a native bar, which does this by itself. macOS has its own.
      if (process.platform === 'darwin' || !windows.wantsOverlay()) return;
      const alt = new AltTracker();
      webContents.on('before-input-event', (event, input) => {
        const action = alt.feed(input, menu.barEntries());
        if (action.type === 'none') {
          // A page that draws the whole bar closes its open menu first, then the bar.
          if (menu.isBarShown(window) && !menu.barHandlesEscape(window) && input.type === 'keyDown' && input.key === 'Escape') menu.showBar(window, { visible: false });
          return;
        }
        const message: MenuBarEvent = action.type === 'open' ? { visible: true, open: action.id } : { visible: !menu.isBarShown(window) };
        if (action.type === 'open') event.preventDefault();
        menu.showBar(window, message);
      });
      window.on('blur', () => {
        if (menu.isBarShown(window)) menu.showBar(window, { visible: false });
      });
    });
  },
};
