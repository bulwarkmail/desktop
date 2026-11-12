/**
 * Text for native menus and file names, and what a page sent for a menu made safe.
 * No Electron at run time, so the tests can reach it.
 */

import type { MenuItemConstructorOptions } from 'electron';
import type { MenuBarItem, NativeMenuItem } from '../shared/bridge';

const MAX_ITEMS = 2000;
const MAX_DEPTH = 5;
const MAX_LABEL = 300;

/**
 * A letter for Alt on each of the menu bar's names. Each takes the first letter in it
 * no earlier one has. A name that already marks one keeps it.
 */
export function assignMnemonics(labels: string[]): string[] {
  const used = new Set<string>();
  for (const label of labels) {
    const at = label.indexOf('&');
    if (at >= 0 && label[at + 1]) used.add(label[at + 1].toLowerCase());
  }
  return labels.map((label) => {
    if (label.includes('&')) return label;
    const chars = [...label];
    const at = chars.findIndex((c) => /\p{L}|\p{N}/u.test(c) && !used.has(c.toLowerCase()));
    if (at < 0) return label;
    used.add(chars[at].toLowerCase());
    return `${chars.slice(0, at).join('')}&${chars.slice(at).join('')}`;
  });
}

/** A menu label as text, with `&&` as one `&`, and where its `&` marker was, or -1. */
export function labelParts(label: string): { text: string; mnemonic: number } {
  let text = '';
  let mnemonic = -1;
  for (let i = 0; i < label.length; i++) {
    const c = label[i];
    if (c === '&' && label[i + 1] === '&') {
      text += '&';
      i++;
    } else if (c === '&' && i + 1 < label.length && mnemonic < 0) {
      mnemonic = text.length;
    } else if (c !== '&') {
      text += c;
    }
  }
  return { text, mnemonic };
}

/** For the lines of one menu: where each one's Alt letter is, the first letter no earlier line has, or -1. */
export function lineMnemonics(texts: string[]): number[] {
  const used = new Set<string>();
  return texts.map((text) => {
    const chars = [...text];
    let offset = 0;
    for (const c of chars) {
      if (/\p{L}|\p{N}/u.test(c) && !used.has(c.toLowerCase())) {
        used.add(c.toLowerCase());
        return offset;
      }
      offset += c.length;
    }
    return -1;
  });
}

/** What the drawn menu bar needs of a menu item. Electron's MenuItem has all of it. */
export interface BarSourceItem {
  /** The line's command id, which the page draws an icon by. */
  id?: string | null;
  label: string;
  type: string;
  enabled: boolean;
  visible: boolean;
  checked: boolean;
  accelerator?: string | null;
  role?: string | null;
  submenu?: { items: BarSourceItem[] } | null;
  getDefaultRoleAccelerator?: () => string | undefined | null;
}

/**
 * The roles the bar a page draws may run: each works on the page's own content (its selection,
 * its editing history) or on the window, and brings nothing into the page. Cut and Copy put the
 * page's own selection on the clipboard, which a page can do itself at the same click or key.
 */
const PAGE_BAR_ROLES = new Set(['undo', 'redo', 'cut', 'copy', 'selectall', 'togglefullscreen', 'close', 'quit', 'about']);

/**
 * Whether the bar a page draws may run a line. Which line was picked there is the page's
 * word. A role does what Electron says it does, so only the roles known to hand the page
 * nothing are the page's to run. Any other, Paste first of all (the clipboard's content
 * arrives in the page) and any role this list doesn't know yet, is left to the menus the OS
 * draws, where only the user can pick, and to the keys. A line with no role is the app's own
 * (`MenuSection` in menu.ts says what such a line may do).
 */
export function pageBarMayRun(item: { role?: string | null }): boolean {
  const role = (item.role ?? '').toLowerCase();
  return role === '' || PAGE_BAR_ROLES.has(role);
}

/** Whether a menu has a line only the OS's own menu may run (`pageBarMayRun`), submenus included. */
export function holdsOsMenuLine(items: readonly BarSourceItem[]): boolean {
  return items.some((item) => {
    if (item.visible === false || item.type === 'separator') return false;
    return item.submenu ? holdsOsMenuLine(item.submenu.items) : !pageBarMayRun(item);
  });
}

/**
 * A menu as the page draws it in a window with no native bar. Each line's key is its place,
 * and a pick sends that and its text back, so a menu built anew in between can't run
 * something else (`findBarItem`). A line the page's bar may not run (`pageBarMayRun`) goes
 * out greyed, with its key next to it.
 */
export function barItemsOf(items: readonly BarSourceItem[], prefix: string): MenuBarItem[] {
  const lines: MenuBarItem[] = [];
  const texts: string[] = [];
  items.forEach((item, index) => {
    if (item.visible === false) return;
    const key = `${prefix}/${index}`;
    if (item.type === 'separator') {
      if (lines.length && lines[lines.length - 1].type !== 'separator') lines.push({ key, label: '', type: 'separator', enabled: false });
      return;
    }
    const { text } = labelParts(item.label ?? '');
    if (!text.trim()) return;
    texts.push(text);
    const accelerator = item.accelerator || item.getDefaultRoleAccelerator?.() || undefined;
    const sub = item.submenu?.items;
    // The page draws a line's icon by its id: a command's own, or the role's.
    const id = item.id || (item.role ? `role.${item.role}` : undefined);
    const line: MenuBarItem = {
      key,
      ...(id ? { id } : {}),
      label: text,
      type: sub ? 'submenu' : item.type === 'checkbox' || item.type === 'radio' ? item.type : 'normal',
      enabled: item.enabled !== false && (!!sub || pageBarMayRun(item)),
      ...(item.type === 'checkbox' || item.type === 'radio' ? { checked: item.checked === true } : {}),
      ...(accelerator && !sub ? { accelerator } : {}),
      ...(sub ? { items: barItemsOf(sub, key) } : {}),
    };
    lines.push(line);
  });
  if (lines[lines.length - 1]?.type === 'separator') lines.pop();
  const marks = lineMnemonics(lines.filter((line) => line.type !== 'separator').map((line) => line.label));
  let at = 0;
  for (const line of lines) {
    if (line.type === 'separator') continue;
    const mark = marks[at++];
    if (mark >= 0) line.mnemonic = mark;
  }
  return lines;
}

/**
 * The item a key names, if it still has the text it had when the page drew it. A key is
 * read only as `barItemsOf` writes it, so a line has one key and no other spelling of it.
 */
export function findBarItem<T extends BarSourceItem>(menus: readonly T[], key: string, label: string): T | null {
  const parts = key.split('/');
  if (!parts.every((part) => /^(0|[1-9]\d{0,8})$/.test(part))) return null;
  const path = parts.map((part) => Number(part));
  let list: readonly T[] = menus;
  let found: T | undefined;
  for (const index of path) {
    found = list[index];
    if (!found) return null;
    list = (found.submenu?.items ?? []) as T[];
  }
  if (!found || found.submenu || found.type === 'separator') return null;
  return labelParts(found.label ?? '').text === label ? found : null;
}

/**
 * No line at the start or end of a menu, and none right after another, counting only what
 * shows: a hidden item between two lines would leave them side by side. Hidden items stay,
 * since some still answer their keys. Submenus too.
 */
export function tidySeparators<T extends { type?: string; visible?: boolean; submenu?: unknown }>(items: readonly T[]): T[] {
  const out: T[] = [];
  let lastShown: 'none' | 'item' | 'separator' = 'none';
  for (const item of items) {
    const submenu = Array.isArray(item.submenu) ? { ...item, submenu: tidySeparators(item.submenu as T[]) } : item;
    if (item.type === 'separator') {
      if (lastShown !== 'item') continue;
      lastShown = 'separator';
      out.push(submenu);
      continue;
    }
    out.push(submenu);
    if (item.visible !== false) lastShown = 'item';
  }
  // A line with nothing shown after it.
  for (let at = out.length - 1; at >= 0; at--) {
    if (out[at].type === 'separator') {
      out.splice(at, 1);
      continue;
    }
    if (out[at].visible !== false) break;
  }
  return out;
}

/** Roles that show or keep no mail: the lock screen's field still needs Copy and Paste. */
const ROLES_WHILE_LOCKED = new Set(['about', 'quit', 'minimize', 'zoom', 'front', 'close', 'hide', 'hideothers', 'unhide', 'services', 'undo', 'redo', 'cut', 'copy', 'paste', 'pasteandmatchstyle', 'selectall']);
const IDS_WHILE_LOCKED = new Set(['file.unlock', 'file.quit', 'file.close', 'window.minimize', 'window.cycle', 'help.docs']);

/**
 * What the menus still offer while the app is locked: About, Unlock, Exit, the Window menu's
 * basics and the editing keys of the PIN field. Nothing that shows, prints, saves or sends mail,
 * and no settings: the page under the lock screen can't act, so they'd print the lock screen.
 */
export function enabledWhileLocked(item: { id?: string | null; role?: string | null }): boolean {
  if (item.role && ROLES_WHILE_LOCKED.has(item.role.toLowerCase())) return true;
  return !!item.id && (IDS_WHILE_LOCKED.has(item.id) || item.id.startsWith('window.focus.'));
}

const WINDOW_NAME_MAX = 50;

/**
 * The Window menu's lines: each window by the name its page gave (the main window by view and
 * account, a message by its subject, a composer by its subject or "New message"), else its
 * title, else its kind. Long names end in "…", and two the same get a number, so no two lines
 * read alike. Locked, only the kinds: a subject is mail.
 */
export function windowMenuNames(
  list: readonly { type: string; title: string; menuName?: string }[],
  kinds: Record<string, string>,
  locked = false,
): string[] {
  const cut = (name: string) => {
    const chars = Array.from(name);
    return chars.length > WINDOW_NAME_MAX ? `${chars.slice(0, WINDOW_NAME_MAX - 1).join('').trimEnd()}…` : name;
  };
  const names = list.map((info) => cut((locked ? '' : (info.menuName || info.title)).trim() || kinds[info.type] || ''));
  const total = new Map<string, number>();
  for (const name of names) total.set(name, (total.get(name) ?? 0) + 1);
  const seen = new Map<string, number>();
  return names.map((name) => {
    if ((total.get(name) ?? 0) < 2) return name;
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(name, n);
    return n === 1 ? name : `${name} (${n})`;
  });
}

/** Native menus read & as a marker. A folder called "R&D" has to stay that. */
export function escapeMenuLabel(label: string): string {
  return label.replace(/&/g, '&&');
}

const ACCELERATOR = /^((Ctrl|Cmd|CmdOrCtrl|Alt|Shift|Super)\+){0,3}([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|[)!@#$%^&*(:;=<,_\-.>?/~`{\][|\\}"']|Plus|Space|Tab|Backspace|Delete|Insert|Enter|Up|Down|Left|Right|Home|End|PageUp|PageDown|Escape)$/;

/**
 * A key the page says it answers, to show next to an item. Only in Electron's own
 * syntax, and never registered: the page runs it. macOS menus show only what they run.
 */
export function shownAccelerator(raw: unknown, platform: string = process.platform): string | undefined {
  if (platform === 'darwin' || typeof raw !== 'string' || raw.length > 40) return undefined;
  return ACCELERATOR.test(raw) ? raw : undefined;
}

/**
 * What a page sent, made safe to show. Anything out of shape is dropped, and a menu
 * with nothing left isn't shown. `onPick` gets the item's id.
 */
export function toMenuTemplate(items: unknown, onPick: (id: string) => void): MenuItemConstructorOptions[] {
  let budget = MAX_ITEMS;
  const walk = (list: unknown, depth: number): MenuItemConstructorOptions[] => {
    if (!Array.isArray(list) || depth > MAX_DEPTH) return [];
    const out: MenuItemConstructorOptions[] = [];
    for (const raw of list as NativeMenuItem[]) {
      if (budget-- <= 0 || !raw || typeof raw !== 'object') continue;
      if (raw.type === 'separator') {
        // None at the start, and none twice.
        if (out.length && out[out.length - 1].type !== 'separator') out.push({ type: 'separator' });
        continue;
      }
      if (typeof raw.label !== 'string' || !raw.label.trim()) continue;
      const label = escapeMenuLabel(raw.label.slice(0, MAX_LABEL));
      const enabled = raw.enabled !== false;
      if (raw.submenu) {
        const submenu = walk(raw.submenu, depth + 1);
        if (submenu.length) out.push({ label, enabled, submenu });
        continue;
      }
      const id = raw.id;
      if (typeof id !== 'string') continue;
      const type = raw.type === 'checkbox' || raw.type === 'radio' ? raw.type : 'normal';
      const key = type === 'normal' ? shownAccelerator(raw.accelerator) : undefined;
      out.push({ label, enabled, type, ...(type !== 'normal' ? { checked: raw.checked === true } : {}), ...(key ? { accelerator: key, registerAccelerator: false } : {}), click: () => onPick(id) });
    }
    if (out[out.length - 1]?.type === 'separator') out.pop();
    return out;
  };
  return walk(items, 0);
}

/** Where a bare language is mostly written, when the OS names no region for it. */
const USUAL_REGION: Record<string, string> = {
  ar: 'SA', ca: 'ES', cs: 'CZ', da: 'DK', el: 'GR', en: 'US', et: 'EE', fa: 'IR', he: 'IL', ja: 'JP',
  ko: 'KR', nb: 'NO', pt: 'BR', sl: 'SI', sr: 'RS', sv: 'SE', uk: 'UA', vi: 'VN', zh: 'CN',
};

const LANGUAGE_TAG = /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i;

/**
 * What to check spelling in: the interface language, the composers' languages, and the
 * languages the user set up in the OS (Windows' input languages), each with its region.
 * Windows' own checker knows "en-US" and "de-DE" but not "en": with a bare tag Chromium
 * wants a downloaded dictionary instead. A bare tag takes the region the OS uses for
 * that language, else the usual one.
 */
export function spellLanguagesFor(ui: string, composer: readonly string[], system: readonly string[]): string[] {
  const os = system.filter((tag) => LANGUAGE_TAG.test(tag));
  const withRegion = (tag: string): string => {
    const [base, ...rest] = tag.split('-');
    if (rest.length) return tag;
    const known = os.find((candidate) => candidate.includes('-') && candidate.split('-')[0].toLowerCase() === base.toLowerCase());
    if (known) return known;
    return `${base.toLowerCase()}-${USUAL_REGION[base.toLowerCase()] ?? base.toUpperCase()}`;
  };
  const out: string[] = [];
  for (const tag of [ui, ...composer, ...os]) {
    if (!LANGUAGE_TAG.test(tag)) continue;
    const full = withRegion(tag);
    if (!out.some((seen) => seen.toLowerCase() === full.toLowerCase())) out.push(full);
  }
  return out;
}

/** The language Chromium has a dictionary for, closest to what was asked. */
export function pickSpellLanguages(wanted: string[], available: string[]): string[] {
  const out: string[] = [];
  for (const language of wanted) {
    const lower = language.toLowerCase();
    const found = available.find((a) => a.toLowerCase() === lower)
      ?? available.find((a) => a.toLowerCase().split('-')[0] === lower.split('-')[0]);
    if (found && !out.includes(found)) out.push(found);
  }
  return out;
}

export function safeFileName(name: unknown): string {
  // eslint-disable-next-line no-control-regex
  const base = String(name ?? '').replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_').replace(/^[ .]+|[ .]+$/g, '').slice(0, 180);
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(base)) return `_${base}`;
  return base || 'attachment';
}

/** What a window title makes as a file name. */
export function pdfFileName(title: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = title.replace(/[\u0000-\u001f<>:"/\\|?*]+/g, ' ').replace(/\s+/g, ' ').replace(/^[ .]+|[ .]+$/g, '').slice(0, 120);
  return `${clean || 'Bulwark'}.pdf`;
}


const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'image/vnd.microsoft.icon': 'ico',
  'image/tiff': 'tiff',
};

/**
 * The name to save an image under, or null if it isn't one. The type decides the
 * extension: a sender calling their file `invoice.exe` gets `invoice.png`.
 */
export function safeImageName(name: unknown, mimeType: unknown): string | null {
  const type = typeof mimeType === 'string' ? mimeType.split(';')[0].trim().toLowerCase() : '';
  const extension = IMAGE_EXTENSIONS[type];
  if (!extension) return null;
  const base = safeFileName(name).replace(/\.[^.]*$/, '').replace(/[. ]+$/, '');
  return `${base || 'image'}.${extension}`;
}

const OPENABLE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:', 'sms:', 'xmpp:', 'webcal:']);

/** Whether a link gets Open and Copy: something the OS can open, outside the app. */
export function linkOffersOpen(url: string, origin: string): boolean {
  try {
    const parsed = new URL(url);
    return OPENABLE_PROTOCOLS.has(parsed.protocol) && parsed.origin !== origin && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}
