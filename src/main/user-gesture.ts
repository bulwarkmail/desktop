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
 * its own menu bar was picked, is never one. For that bar main keeps the last pick apart
 * (`takePick`): what it was (a click, Enter or Space, or a letter) and when. One pick runs one
 * line, and the menu decides whether it fits the line the page names. Where the left button
 * last went down is kept too (`takePress`), for a menu that opens only from the window's top row.
 */

import type { Input, WebContents } from 'electron';

/** About what Chromium gives a click, and past the longest a click handler should need. */
const GESTURE_LIFE_MS = 5_000;
/** From the click or key that picked a line of a menu the page draws to the page's report of it. */
const PICK_LIFE_MS = 1_000;

/** What picked a line in a menu the page draws: a left click let go, Enter or Space, or a plain letter or digit. */
export interface MenuPick {
  at: number;
  kind: 'click' | 'key' | 'letter';
  /** For a letter: the letter, lower case. */
  letter?: string;
}

/** The left button going down in a window: when, and where in the window's pixels, as the input event has it. */
export interface SeenPress {
  at: number;
  x: number;
  y: number;
}

const gestures = new WeakMap<WebContents, number>();
/** The last pick in a window, for `takePick`. */
const picks = new WeakMap<WebContents, MenuPick>();
/** The last press of the left button in a window, for `takePress`. */
const presses = new WeakMap<WebContents, SeenPress>();
/** Enter, Space, and the keys that choose in a list, by the `key` the input event carries (the DOM's names). */
const GESTURE_KEYS = new Set(['Enter', ' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
/** The keys that run the line a menu has selected. */
const PICK_KEYS = new Set(['Enter', ' ']);
const watched = new WeakSet<WebContents>();

/**
 * What `input-event` hands over. Electron types it as the bare InputEvent; a key's event carries
 * what `Input` describes (`key`, `code`, `isAutoRepeat`, `isComposing`, the modifiers), a mouse
 * event `button` and where it was, `x` and `y`.
 */
type SeenInput = Partial<Pick<Input, 'key' | 'code' | 'isAutoRepeat' | 'isComposing' | 'control' | 'alt' | 'meta'>> & {
  type: string;
  button?: string;
  modifiers?: string[];
  x?: number;
  y?: number;
};

/** A key that went down, not one the OS repeats while it's held. */
function keyPressed(input: SeenInput): string | null {
  if (input.type !== 'rawKeyDown' || typeof input.key !== 'string') return null;
  if (input.isAutoRepeat === true || input.modifiers?.includes('isautorepeat')) return null;
  return input.key;
}

/** A letter or digit typed on its own: what picks a menu line by its underlined letter. */
function plainLetter(input: SeenInput, key: string): string | null {
  if ([...key].length !== 1 || !/^[\p{L}\p{N}]$/u.test(key) || input.isComposing === true) return null;
  const held = input.modifiers ?? [];
  if (input.control || input.alt || input.meta || held.includes('control') || held.includes('alt') || held.includes('meta')) return null;
  return key.toLowerCase();
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
 * The click or key that reached this window in the last second, as the browser process saw
 * it, for a line of a menu the page draws. Taking it spends it: one pick runs one line. The
 * gesture the same input noted is apart from it, for what the line runs.
 */
export function takePick(contents: WebContents): MenuPick | null {
  const pick = picks.get(contents);
  picks.delete(contents);
  return pick && Date.now() - pick.at <= PICK_LIFE_MS ? pick : null;
}

/**
 * Where the left button went down in this window in the last second, as the browser process
 * saw it. Taking it spends it. The page has no say in it: it's what tells a click in the
 * window's top row, where a menu bar is, from one anywhere else.
 */
export function takePress(contents: WebContents): SeenPress | null {
  const press = presses.get(contents);
  presses.delete(contents);
  return press && Date.now() - press.at <= PICK_LIFE_MS ? press : null;
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
    const now = Date.now();
    if (clicked && typeof input.x === 'number' && typeof input.y === 'number' && Number.isFinite(input.x) && Number.isFinite(input.y)) presses.set(contents, { at: now, x: input.x, y: input.y });
    // A click picks a line when it's let go, where a page's click handler runs: one pick per click.
    if (input.type === 'mouseUp' && input.button === 'left') picks.set(contents, { at: now, kind: 'click' });
    else if (key !== null && PICK_KEYS.has(key)) picks.set(contents, { at: now, kind: 'key' });
    else if (key !== null) {
      const letter = plainLetter(input, key);
      if (letter) picks.set(contents, { at: now, kind: 'letter', letter });
    }
  });
}
