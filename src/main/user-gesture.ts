/**
 * Whether the user just did something, in a way no script can say for them, and used up once.
 * What a page's own `navigator.userActivation` can't give: it stays active for 5 seconds
 * after a click, so one click would let a same-origin plugin frame start twenty things, and
 * it's gone when someone takes longer than that over a native menu.
 *
 * A left mouse button or Enter or Space reaching a window, as Chromium's browser process
 * sees it, and a pick from a native menu, which main itself recorded. Taking it spends it.
 * The keys that choose in a closed list (arrows, Home, End, Page Up and Down) count too: a
 * drive letter picked with them changes the list without Enter (pass-3 files-p3-15).
 *
 * Only that input and a native menu's pick are noted. A page's word, such as which line of
 * its own menu bar was picked, is never one: `pickedJustNow` only asks whether a click or
 * Enter reached the window a moment ago, and leaves the gesture where it is.
 */

import type { WebContents } from 'electron';

/** About what Chromium gives a click, and past the longest a click handler should need. */
const GESTURE_LIFE_MS = 5_000;
/** From the click or key that picked a line of a menu the page draws to the page's report of it. */
const PICK_LIFE_MS = 1_000;

const gestures = new WeakMap<WebContents, number>();
/** The last left click or Enter or Space in a window, for `pickedJustNow`. Never spent. */
const picks = new WeakMap<WebContents, number>();
/** Enter, Space, and the keys that choose in a list. Chromium's names, and the DOM's. */
const GESTURE_KEYS = new Set(['Enter', 'Return', 'Space', ' ', 'Up', 'Down', 'ArrowUp', 'ArrowDown', 'Left', 'Right', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Prior', 'Next']);
/** The keys that run the line a menu has selected. */
const PICK_KEYS = new Set(['Enter', 'Return', 'Space', ' ']);
const watched = new WeakSet<WebContents>();

export function noteUserGesture(contents: WebContents): void {
  gestures.set(contents, Date.now());
}

export function takeUserGesture(contents: WebContents): boolean {
  const at = gestures.get(contents);
  gestures.delete(contents);
  return at !== undefined && Date.now() - at <= GESTURE_LIFE_MS;
}

/**
 * A left click (pressed or let go) or Enter or Space reached this window in the last second,
 * as the browser process saw it. Spends nothing: the gesture that input noted is still there
 * for what the pick runs.
 */
export function pickedJustNow(contents: WebContents): boolean {
  const at = picks.get(contents);
  return at !== undefined && Date.now() - at <= PICK_LIFE_MS;
}

export function watchUserGestures(contents: WebContents): void {
  if (watched.has(contents)) return;
  watched.add(contents);
  contents.on('input-event', (_event, input) => {
    const button = (input as unknown as { button?: string }).button;
    const key = (input as unknown as { keyCode?: string }).keyCode;
    const clicked = input.type === 'mouseDown' && button === 'left';
    const pressed = input.type === 'rawKeyDown' && !!key && GESTURE_KEYS.has(key);
    if (clicked || pressed) noteUserGesture(contents);
    const released = input.type === 'mouseUp' && button === 'left';
    if (clicked || released || (input.type === 'rawKeyDown' && !!key && PICK_KEYS.has(key))) picks.set(contents, Date.now());
  });
}
