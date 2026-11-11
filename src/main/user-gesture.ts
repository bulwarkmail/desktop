/**
 * Whether the user just did something, in a way no script can say for them, and used up once.
 * What a page's own `navigator.userActivation` can't give: it stays active for 5 seconds
 * after a click, so one click would let a same-origin plugin frame start twenty things, and
 * it's gone when someone takes longer than that over a native menu.
 *
 * A left mouse button or Enter or Space reaching a window, as Chromium's browser process
 * sees it, and a pick from a native menu, which main itself recorded. Taking it spends it.
 * The keys that choose in a closed list (arrows, Home, End, Page Up and Down) count too: a
 * drive letter picked with them changes the list without Enter (pass-3 files-p3-15). A key
 * held down counts once: its repeats are no new press.
 *
 * Only that input and a native menu's pick are noted. A page's word, such as which line of
 * its own menu bar was picked, is never one: `pickedJustNow` only asks whether a click or
 * Enter reached the window a moment ago, and leaves the gesture where it is.
 */

import type { Input, WebContents } from 'electron';

/** About what Chromium gives a click, and past the longest a click handler should need. */
const GESTURE_LIFE_MS = 5_000;
/** From the click or key that picked a line of a menu the page draws to the page's report of it. */
const PICK_LIFE_MS = 1_000;

const gestures = new WeakMap<WebContents, number>();
/** The last left click or Enter or Space in a window, for `pickedJustNow`. Never spent. */
const picks = new WeakMap<WebContents, number>();
/** Enter, Space, and the keys that choose in a list, by the `key` the input event carries (the DOM's names). */
const GESTURE_KEYS = new Set(['Enter', ' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
/** The keys that run the line a menu has selected. */
const PICK_KEYS = new Set(['Enter', ' ']);
const watched = new WeakSet<WebContents>();

/**
 * What `input-event` hands over. Electron types it as the bare InputEvent; a key's event carries
 * what `Input` describes (`key`, `code`, `isAutoRepeat`, the modifiers), a mouse event `button`.
 */
type SeenInput = Partial<Pick<Input, 'key' | 'code' | 'isAutoRepeat'>> & { type: string; button?: string; modifiers?: string[] };

/** A key that went down, not one the OS repeats while it's held. */
function keyPressed(input: SeenInput): string | null {
  if (input.type !== 'rawKeyDown' || typeof input.key !== 'string') return null;
  if (input.isAutoRepeat === true || input.modifiers?.includes('isautorepeat')) return null;
  return input.key;
}

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
  contents.on('input-event', (_event, raw) => {
    const input = raw as unknown as SeenInput;
    const key = keyPressed(input);
    const clicked = input.type === 'mouseDown' && input.button === 'left';
    const pressed = key !== null && GESTURE_KEYS.has(key);
    if (clicked || pressed) noteUserGesture(contents);
    const released = input.type === 'mouseUp' && input.button === 'left';
    if (clicked || released || (key !== null && PICK_KEYS.has(key))) picks.set(contents, Date.now());
  });
}
