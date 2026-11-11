import { EventEmitter } from 'node:events';
import { expect, test } from '@playwright/test';
import type { WebContents } from 'electron';
import { pickedJustNow, takeUserGesture, watchUserGestures } from '../src/main/user-gesture';

/** What counts as the user doing something, as main sees the input reach a window. */

function contents() {
  const emitter = new EventEmitter();
  watchUserGestures(emitter as unknown as WebContents);
  const input = (value: Record<string, unknown>) => emitter.emit('input-event', {}, value);
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
  page.input({ type: 'mouseDown', button: 'left' });
  expect(page.picked()).toBe(true);
  expect(page.picked(), 'asking twice spends nothing').toBe(true);
  expect(page.take(), 'the click is still a gesture for what the line runs').toBe(true);
  page.input({ type: 'rawKeyDown', keyCode: 'Enter' });
  expect(later(900, page.picked)).toBe(true);
  expect(later(1_200, page.picked), 'a second later is too late').toBe(false);
  expect(later(6_000, page.picked)).toBe(false);
  page.input({ type: 'mouseUp', button: 'left' });
  expect(page.picked(), 'a click let go').toBe(true);
});

test('typing, a right click, the arrows and nothing at all are no pick', () => {
  const page = contents();
  page.input({ type: 'rawKeyDown', keyCode: 'A' });
  page.input({ type: 'mouseDown', button: 'right' });
  page.input({ type: 'rawKeyDown', keyCode: 'Down' });
  page.input({ type: 'keyUp', keyCode: 'Enter' });
  expect(page.picked()).toBe(false);
});

test('a left click, Enter and Space count, once each', () => {
  const page = contents();
  page.input({ type: 'mouseDown', button: 'left' });
  expect(page.take()).toBe(true);
  expect(page.take()).toBe(false);
  page.input({ type: 'rawKeyDown', keyCode: 'Enter' });
  expect(page.take()).toBe(true);
  page.input({ type: 'rawKeyDown', keyCode: 'Space' });
  expect(page.take()).toBe(true);
});

test('the keys that pick in a closed list count too, so a drive letter can be chosen without the mouse (files-p3-15)', () => {
  const page = contents();
  for (const key of ['Down', 'Up', 'Home', 'End', 'PageDown']) {
    page.input({ type: 'rawKeyDown', keyCode: key });
    expect(page.take()).toBe(true);
  }
});

test('typing, a right click and a key let go do not', () => {
  const page = contents();
  page.input({ type: 'rawKeyDown', keyCode: 'A' });
  page.input({ type: 'mouseDown', button: 'right' });
  page.input({ type: 'keyUp', keyCode: 'Enter' });
  expect(page.take()).toBe(false);
});
