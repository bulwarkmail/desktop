import { EventEmitter } from 'node:events';
import { expect, test } from '@playwright/test';
import type { Input, MouseInputEvent, WebContents } from 'electron';
import { pickedJustNow, takeUserGesture, watchUserGestures } from '../src/main/user-gesture';

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
  return { input, take: () => takeUserGesture(emitter as unknown as WebContents), picked: () => pickedJustNow(emitter as unknown as WebContents) };
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

test('a line of a menu the page draws: a click or Enter just now lets it run, and the gesture is still there after', () => {
  const page = contents();
  expect(page.picked(), 'no input at all').toBe(false);
  page.input(mouseEvent('mouseDown', 'left'));
  expect(page.picked()).toBe(true);
  expect(page.picked(), 'asking twice spends nothing').toBe(true);
  expect(page.take(), 'the click is still a gesture for what the line runs').toBe(true);
  page.input(keyEvent('rawKeyDown', 'Enter', 'Enter'));
  expect(later(900, page.picked)).toBe(true);
  expect(later(1_200, page.picked), 'a second later is too late').toBe(false);
  expect(later(6_000, page.picked)).toBe(false);
  page.input(mouseEvent('mouseUp', 'left'));
  expect(page.picked(), 'a click let go').toBe(true);
});

test('Space and the Enter of the number pad pick as Enter does', () => {
  for (const [key, code] of [[' ', 'Space'], ['Enter', 'NumpadEnter']]) {
    const page = contents();
    page.input(keyEvent('rawKeyDown', key, code));
    expect(page.picked(), code).toBe(true);
  }
});

test('typing, a right click, the arrows and nothing at all are no pick', () => {
  const page = contents();
  page.input(keyEvent('rawKeyDown', 'a', 'KeyA'));
  page.input(keyEvent('char', 'a', 'KeyA'));
  page.input(mouseEvent('mouseDown', 'right'));
  page.input(keyEvent('rawKeyDown', 'ArrowDown', 'ArrowDown'));
  page.input(keyEvent('keyUp', 'Enter', 'Enter'));
  expect(page.picked()).toBe(false);
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
  expect(later(1_200, page.picked), 'a repeat is no pick: the press was more than a second ago').toBe(false);
});

test('typing, a right click and a key let go do not', () => {
  const page = contents();
  page.input(keyEvent('rawKeyDown', 'a', 'KeyA'));
  page.input(mouseEvent('mouseDown', 'right'));
  page.input(keyEvent('keyUp', 'Enter', 'Enter'));
  expect(page.take()).toBe(false);
});
