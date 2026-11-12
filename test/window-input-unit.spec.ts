import { expect, test } from '@playwright/test';
import type { Input } from 'electron';
import { AltTracker } from '../src/main/features/window-input';

/**
 * What main's Alt-and-letter reader takes as the user asking for a menu. Alt and Edit's letter
 * opens the system's Edit menu, so these are the keys that must, and must not, count. The events
 * are built as Electron hands them to `before-input-event`.
 */

type Key = Pick<Input, 'type' | 'key' | 'alt' | 'control' | 'meta' | 'shift'> & Partial<Input>;
const down = (key: string, extra: Partial<Input> = {}): Key => ({ type: 'keyDown', key, code: '', alt: false, control: false, meta: false, shift: false, isAutoRepeat: false, isComposing: false, modifiers: [], ...extra });
const up = (key: string, extra: Partial<Input> = {}): Key => ({ ...down(key, extra), type: 'keyUp' });
const english = [{ id: 'file', label: 'File', mnemonic: 'f' }, { id: 'edit', label: 'Edit', mnemonic: 'e' }, { id: 'view', label: 'View', mnemonic: 'v' }];
const german = [{ id: 'file', label: 'Datei', mnemonic: 'd' }, { id: 'edit', label: 'Bearbeiten', mnemonic: 'b' }, { id: 'view', label: 'Ansicht', mnemonic: 'a' }];
const run = (keys: Key[], entries = english) => {
  const tracker = new AltTracker();
  return keys.map((input) => tracker.feed(input, entries));
};
const opened = (actions: ReturnType<typeof run>) => actions.filter((action) => action.type === 'open');

test('AltGr+E, the euro sign, as Windows reports it (a left Ctrl, then the right Alt, then E with Ctrl and Alt held), opens nothing in English or German', () => {
  const ctrlAlt = { control: true, alt: true, modifiers: ['control', 'alt'] };
  const euro = [
    down('Control', { code: 'ControlLeft', control: true, modifiers: ['control'] }),
    down('AltGraph', { code: 'AltRight', ...ctrlAlt }),
    down('€', { code: 'KeyE', ...ctrlAlt }),
    up('€', { code: 'KeyE', ...ctrlAlt }),
    up('AltGraph', { code: 'AltRight', control: true, modifiers: ['control'] }),
    up('Control', { code: 'ControlLeft' }),
  ];
  expect(opened(run(euro)), 'English').toEqual([]);
  expect(opened(run(euro, german)), 'German').toEqual([]);
  // The same with the right Alt reported as Alt, and with the letter instead of the character.
  const asAlt = euro.map((input) => (input.key === 'AltGraph' ? { ...input, key: 'Alt' } : input));
  expect(opened(run(asAlt)), 'right Alt named Alt').toEqual([]);
  const letter = euro.map((input) => (input.key === '€' ? { ...input, key: 'e' } : input));
  expect(opened(run(letter)), 'E with Ctrl and Alt').toEqual([]);
  // Every AltGr character of a German keyboard, and the German Edit letter with AltGr.
  for (const [char, code] of [['@', 'KeyQ'], ['€', 'KeyE'], ['µ', 'KeyM'], ['{', 'Digit7'], ['[', 'Digit8'], [']', 'Digit9'], ['}', 'Digit0'], ['\\', 'Minus'], ['~', 'BracketRight'], ['|', 'IntlBackslash'], ['²', 'Digit2'], ['³', 'Digit3'], ['b', 'KeyB']]) {
    expect(opened(run([down('AltGraph', ctrlAlt), down(char, { code, ...ctrlAlt })], german)), `AltGr+${code}`).toEqual([]);
  }
});

test('an AltGr character reported with Alt alone (as a layout without Ctrl might) is no menu letter either', () => {
  for (const char of ['€', 'é', 'ę', 'ł', '@']) {
    expect(opened(run([down('Alt', { alt: true }), down(char, { alt: true })])), char).toEqual([]);
  }
});

test('the user\'s own Alt+E opens Edit, in English; Alt+B in German; Alt+Shift+E, Ctrl+Alt+E, Win+Alt+E and Alt and a number pad digit do not', () => {
  expect(opened(run([down('Alt', { alt: true }), down('e', { alt: true })]))).toEqual([{ type: 'open', id: 'edit' }]);
  expect(opened(run([down('Alt', { alt: true }), down('E', { alt: true })])), 'capital E (Caps Lock)').toEqual([{ type: 'open', id: 'edit' }]);
  expect(opened(run([down('Alt', { alt: true }), down('b', { alt: true })], german))).toEqual([{ type: 'open', id: 'edit' }]);
  expect(opened(run([down('Alt', { alt: true }), down('e', { alt: true }), up('e', { alt: true }), down('f', { alt: true })])), 'Alt held, E then F').toEqual([{ type: 'open', id: 'edit' }, { type: 'open', id: 'file' }]);
  for (const [what, extra] of [['Shift', { shift: true }], ['Ctrl', { control: true }], ['Win', { meta: true }]] as const) {
    expect(opened(run([down('Alt', { alt: true }), down('E', { alt: true, ...extra })])), what).toEqual([]);
  }
  for (const digit of ['0', '1', '2', '8']) expect(opened(run([down('Alt', { alt: true }), down(digit, { alt: true, code: `Numpad${digit}` })])), `Alt+Numpad${digit}`).toEqual([]);
});

test('a held Alt+E opens one menu, and Alt+E while an input method is composing opens none', () => {
  // A held key: the OS repeats it, and Electron says so in isAutoRepeat and in the modifiers.
  const repeat = { alt: true, isAutoRepeat: true, modifiers: ['alt', 'isautorepeat'] };
  expect(opened(run([down('Alt', { alt: true }), down('e', { alt: true }), down('e', repeat), down('e', repeat)])), 'Alt+E held, two repeats').toEqual([{ type: 'open', id: 'edit' }]);
  expect(opened(run([down('Alt', { alt: true }), down('e', { alt: true, isAutoRepeat: true })])), 'a repeat said by isAutoRepeat alone').toEqual([]);
  expect(opened(run([down('Alt', { alt: true }), down('e', { alt: true, modifiers: ['alt', 'isautorepeat'] })])), 'a repeat said by the modifiers alone').toEqual([]);
  // A key an input method is composing is the input method's.
  expect(opened(run([down('Alt', { alt: true }), down('e', { alt: true, isComposing: true })])), 'composing').toEqual([]);
  expect(opened(run([down('Alt', { alt: true }), down('b', { alt: true, isComposing: true })], german)), 'composing, German').toEqual([]);
  // One real Alt+E still opens Edit, and Alt held alone still shows the strip when it's let go.
  expect(opened(run([down('Alt', { alt: true }), down('e', { alt: true }), up('e', { alt: true }), up('Alt')]))).toEqual([{ type: 'open', id: 'edit' }]);
  const altHeld = run([down('Alt', { alt: true }), down('Alt', { alt: true, isAutoRepeat: true, modifiers: ['alt', 'isautorepeat'] }), up('Alt')]);
  expect(altHeld.map((action) => action.type), 'Alt held, then let go').toEqual(['none', 'none', 'toggle']);
});
