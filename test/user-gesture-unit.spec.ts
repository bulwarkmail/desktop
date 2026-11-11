import { EventEmitter } from 'node:events';
import { expect, test } from '@playwright/test';
import type { Input, MouseInputEvent, WebContents } from 'electron';
import { takePick, takePress, takeUserGesture, watchUserGestures } from '../src/main/user-gesture';

/**
 * What counts as the user doing something, as main sees the input reach a window. The events
 * are built the way Electron hands them to `input-event`: a key as `Input` (`key`, `code`,
 * `isAutoRepeat`, the modifiers; there is no `keyCode`), a click as a mouse input event.
 */

/** A key event as Electron sends it. `key` is the DOM's name for it, `code` the key's place. */
function keyEvent(type: 'rawKeyDown' | 'keyUp' | 'char', key: string, code: string, more: Partial<Input> = {}): Input {
  return { type, key, code, isAutoRepeat: false, isComposing: false, shift: false, control: false, alt: false, meta: false, location: 0, modifiers: [], ...more };
}

function mouseEvent(type: 'mouseDown' | 'mouseUp', button: 'left' | 'right' | 'middle', x = 200, y = 300): MouseInputEvent {
  return { type, button, x, y, clickCount: 1, modifiers: button === 'left' ? ['leftbuttondown'] : [] };
}

function contents() {
  const emitter = new EventEmitter();
  watchUserGestures(emitter as unknown as WebContents);
  const input = (value: Input | MouseInputEvent) => emitter.emit('input-event', {}, value);
  return {
    input,
    take: () => takeUserGesture(emitter as unknown as WebContents),
    pick: () => takePick(emitter as unknown as WebContents),
    press: () => takePress(emitter as unknown as WebContents),
  };
}

/** A left click as the OS sends it: pressed, then let go at the same place. */
function click(page: ReturnType<typeof contents>, x = 200, y = 300): void {
  page.input(mouseEvent('mouseDown', 'left', x, y));
  page.input(mouseEvent('mouseUp', 'left', x, y));
}

/** Runs `body` with Date.now moved on by `ms` from here. */
function later<T>(ms: number, body: () => T): T {
  const real = Date.now;
  const at = real();
  Date.now = () => at + ms;
  try {
    return body();
  } finally {
    Date.now = real;
  }
}

test('a line of a menu the page draws: a click just now picks one line, once it is let go, and leaves its gesture', () => {
  const page = contents();
  expect(page.pick(), 'no input at all').toBeNull();
  page.input(mouseEvent('mouseDown', 'left', 50, 60));
  expect(page.pick(), 'pressed, not let go yet').toBeNull();
  page.input(mouseEvent('mouseUp', 'left', 52, 61));
  expect(page.pick()).toMatchObject({ kind: 'click' });
  expect(page.pick(), 'one click picks one line').toBeNull();
  expect(page.take(), 'the click is still a gesture for what the line runs').toBe(true);
});

test('where the left button went down is kept for a second, once, apart from the pick and the gesture', () => {
  const page = contents();
  expect(page.press(), 'no input at all').toBeNull();
  page.input(mouseEvent('mouseDown', 'left', 210, 14));
  expect(page.press()).toMatchObject({ x: 210, y: 14 });
  expect(page.press(), 'one press, taken once').toBeNull();
  expect(page.take(), 'the gesture is still there').toBe(true);
  page.input(mouseEvent('mouseDown', 'left', 210, 14));
  page.input(mouseEvent('mouseUp', 'left', 300, 400));
  expect(page.press(), 'the place is where it went down, not where it was let go').toMatchObject({ x: 210, y: 14 });
  page.input(mouseEvent('mouseDown', 'left', 210, 14));
  expect(later(1_200, page.press), 'a second later is too late').toBeNull();
});

test('a right or middle button, a button let go, and a key are no press', () => {
  const page = contents();
  page.input(mouseEvent('mouseDown', 'right', 210, 14));
  page.input(mouseEvent('mouseDown', 'middle', 210, 14));
  page.input(mouseEvent('mouseUp', 'left', 210, 14));
  page.input(keyEvent('rawKeyDown', 'Enter', 'Enter'));
  page.input(keyEvent('rawKeyDown', ' ', 'Space'));
  expect(page.press()).toBeNull();
});

test('Enter, Space and the Enter of the number pad pick as a click does, for a second', () => {
  for (const [key, code] of [['Enter', 'Enter'], [' ', 'Space'], ['Enter', 'NumpadEnter']]) {
    const page = contents();
    page.input(keyEvent('rawKeyDown', key, code));
    expect(later(900, page.pick), code).toMatchObject({ kind: 'key' });
    page.input(keyEvent('rawKeyDown', key, code));
    expect(later(1_200, page.pick), `${code}: a second later is too late`).toBeNull();
  }
});

test('a letter or digit picks only as itself; with Ctrl, Alt or the Windows key, or while composing, it picks nothing', () => {
  const page = contents();
  page.input(keyEvent('rawKeyDown', 'P', 'KeyP', { shift: true, modifiers: ['shift'] }));
  expect(page.pick()).toMatchObject({ kind: 'letter', letter: 'p' });
  page.input(keyEvent('rawKeyDown', '3', 'Digit3'));
  expect(page.pick()).toMatchObject({ kind: 'letter', letter: '3' });
  for (const more of [{ control: true, modifiers: ['control'] }, { alt: true, modifiers: ['alt'] }, { meta: true, modifiers: ['meta'] }, { isComposing: true }] as Partial<Input>[]) {
    page.input(keyEvent('rawKeyDown', 'p', 'KeyP', more));
    expect(page.pick(), JSON.stringify(more)).toBeNull();
  }
});

test('a right click, the arrows, a key let go and a character alone are no pick', () => {
  const page = contents();
  page.input(keyEvent('char', 'a', 'KeyA'));
  page.input(mouseEvent('mouseDown', 'right'));
  page.input(mouseEvent('mouseUp', 'right'));
  page.input(keyEvent('rawKeyDown', 'ArrowDown', 'ArrowDown'));
  page.input(keyEvent('keyUp', 'Enter', 'Enter'));
  page.input(keyEvent('rawKeyDown', 'Tab', 'Tab'));
  expect(page.pick()).toBeNull();
});

test('a left click, Enter and Space count, once each', () => {
  const page = contents();
  page.input(mouseEvent('mouseDown', 'left'));
  expect(page.take()).toBe(true);
  expect(page.take()).toBe(false);
  page.input(keyEvent('rawKeyDown', 'Enter', 'Enter'));
  expect(page.take()).toBe(true);
  page.input(keyEvent('rawKeyDown', ' ', 'Space'));
  expect(page.take()).toBe(true);
});

test('the keys that pick in a closed list count too, so a drive letter can be chosen without the mouse (files-p3-15)', () => {
  const page = contents();
  for (const [key, code] of [['ArrowDown', 'ArrowDown'], ['ArrowUp', 'ArrowUp'], ['Home', 'Home'], ['End', 'End'], ['PageDown', 'PageDown']]) {
    page.input(keyEvent('rawKeyDown', key, code));
    expect(page.take(), key).toBe(true);
  }
});

test('a key held down counts once: its repeats are no new press', () => {
  const page = contents();
  page.input(keyEvent('rawKeyDown', 'Enter', 'Enter'));
  expect(page.take()).toBe(true);
  // The OS repeats the key while it's held, the last repeat almost a second after the press.
  later(900, () => page.input(keyEvent('rawKeyDown', 'Enter', 'Enter', { isAutoRepeat: true, modifiers: ['isautorepeat'] })));
  expect(later(900, page.take), 'a repeat is no gesture').toBe(false);
  expect(later(1_200, page.pick), 'a repeat is no pick: the press was more than a second ago').toBeNull();
});

test('typing, a right click and a key let go do not', () => {
  const page = contents();
  page.input(keyEvent('rawKeyDown', 'a', 'KeyA'));
  page.input(mouseEvent('mouseDown', 'right'));
  page.input(keyEvent('keyUp', 'Enter', 'Enter'));
  expect(page.take()).toBe(false);
});
