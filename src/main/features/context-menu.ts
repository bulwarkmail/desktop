/**
 * Native right-click menus. There are two kinds.
 *
 * What Chromium knows about: text, a link, an image, a misspelled word, here and in a
 * mail body's frame. It reports those with `context-menu`, which fires only when the
 * page didn't take the right-click itself.
 *
 * What the app knows about: a message, a folder, a contact. The webmail reads its
 * own HTML menu back and hands it over through `menu.popup`, so the contents are the
 * ones the browser shows and the two can't drift (lib/desktop/native-menu.ts).
 *
 * Opening a link goes back to the page, which runs it past the same checks as a click
 * on it (plugins, mailto in the app's composer). Spellcheck languages follow what the
 * webmail says about the interface and composer, plus the languages set up in the OS.
 *
 * Windows checks spelling itself, in the languages installed there, with nothing to
 * download: a language it lacks goes unchecked, and the page hears nothing about a
 * dictionary. Elsewhere a missing dictionary is the page's question to ask.
 */

import { app, clipboard, Menu, type BrowserWindow, type ContextMenuParams, type DownloadItem, type MenuItemConstructorOptions, type Session, type WebContents } from 'electron';
import { CHANNEL, type LanguagesUpdate, type MenuBarEntry, type MenuBarMenu, type MenuState } from '../../shared/bridge';
import { escapeMenuLabel, linkOffersOpen, pickSpellLanguages, safeImageName, spellLanguagesFor, toMenuTemplate } from '../menu-text';
import { openExternally } from '../navigation';
import { missingDictionaries, onDictionaryMissing, openDictionaryDownloads, outsideHostsAllowed } from '../spellcheck';
import { setUiLanguage, strings } from '../strings';
import { noteUserGesture, watchUserGestures } from '../user-gesture';
import { clientAuth } from './client-certificates';
import type { Feature } from './index';

const MAX_SUGGESTIONS = 6;
/** How much of a selection the Search entry quotes, and how much it searches for. */
const SEARCH_LABEL_CHARS = 30;
const SEARCH_TEXT_CHARS = 200;

/** A selection as one line, cut to `max` characters. */
export function selectionExcerpt(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max).trimEnd()}…` : line;
}

export interface ContextTarget {
  params: ContextMenuParams;
  /** The page reported `policy.download: false`. */
  downloadsOff: boolean;
  origin: string;
  /** Opens a link, past the page's checks if it has them. */
  openLink: (url: string, text: string) => void;
  saveImage: (url: string) => void;
  imageAllowed: (url: string) => boolean;
  /** Searches the page's mail for selected text. Absent where the page has no such search. */
  searchMail?: (text: string) => void;
}

/** The menu for what's under the pointer, or nothing where a native app shows nothing. */
export function contextTemplate(contents: WebContents, target: ContextTarget): MenuItemConstructorOptions[] {
  const text = strings();
  const { params, downloadsOff, origin, openLink, saveImage, imageAllowed, searchMail } = target;
  const { editFlags } = params;
  const sections: MenuItemConstructorOptions[][] = [];

  if (params.misspelledWord) {
    const suggestions = params.dictionarySuggestions.slice(0, MAX_SUGGESTIONS);
    sections.push([
      ...(suggestions.length
        ? suggestions.map((word): MenuItemConstructorOptions => ({ label: escapeMenuLabel(word), click: () => contents.replaceMisspelling(word) }))
        : [{ label: text.contextNoSuggestions, enabled: false }]),
      { type: 'separator' },
      {
        id: 'context.addToDictionary',
        label: escapeMenuLabel(text.contextAddToDictionary.replaceAll('{word}', params.misspelledWord)),
        click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
      },
    ]);
  }

  // Not for a link inside the app, or a blob: the page has its own way to those.
  if (params.linkURL && linkOffersOpen(params.linkURL, origin)) {
    const mail = params.linkURL.toLowerCase().startsWith('mailto:');
    sections.push([
      { id: 'context.openLink', label: text.contextOpenLink, click: () => openLink(params.linkURL, params.linkText) },
      {
        id: 'context.copyLink',
        label: mail ? text.contextCopyAddress : text.contextCopyLink,
        click: () => clipboard.writeText(mail ? params.linkURL.slice('mailto:'.length).split('?')[0] : params.linkURL),
      },
    ]);
  }

  if (params.mediaType === 'image' && params.hasImageContents && !downloadsOff && imageAllowed(params.srcURL)) {
    sections.push([
      { id: 'context.saveImage', label: text.contextSaveImage, click: () => saveImage(params.srcURL) },
      { id: 'context.copyImage', label: text.contextCopyImage, click: () => contents.copyImageAt(params.x, params.y) },
    ]);
  }

  if (params.isEditable) {
    sections.push([
      { id: 'context.cut', label: text.contextCut, enabled: editFlags.canCut, click: () => contents.cut() },
      { id: 'context.copy', label: text.contextCopy, enabled: editFlags.canCopy, click: () => contents.copy() },
      { id: 'context.paste', label: text.contextPaste, enabled: editFlags.canPaste, click: () => contents.paste() },
      { id: 'context.selectAll', label: text.contextSelectAll, enabled: editFlags.canSelectAll, click: () => contents.selectAll() },
    ]);
  } else if (params.selectionText.trim()) {
    sections.push([
      { id: 'context.copy', label: text.contextCopy, enabled: editFlags.canCopy, click: () => contents.copy() },
      { id: 'context.selectAll', label: text.contextSelectAll, enabled: editFlags.canSelectAll, click: () => contents.selectAll() },
    ]);
    if (searchMail) {
      const selected = selectionExcerpt(params.selectionText, SEARCH_TEXT_CHARS);
      sections.push([{
        id: 'context.searchMail',
        label: escapeMenuLabel(text.contextSearchMail.replaceAll('{text}', () => selectionExcerpt(params.selectionText, SEARCH_LABEL_CHARS))),
        click: () => searchMail(selected),
      }]);
    }
  }

  return sections.flatMap((section, index) => (index ? [{ type: 'separator' } as MenuItemConstructorOptions, ...section] : section));
}

function policyAllowsDownload(state: MenuState | undefined): boolean {
  return state?.['policy.download'] !== false;
}

/** A sender names an image's file and says what type it is. Only an image is saved, as one. */
export function guardImageDownload(session: Session, pending: Set<string>): void {
  session.on('will-download', (_event, item: DownloadItem) => {
    const url = item.getURL();
    if (!pending.delete(url)) return;
    const name = safeImageName(item.getFilename(), item.getMimeType());
    if (!name) {
      item.cancel();
      return;
    }
    item.setSaveDialogOptions({ defaultPath: name, filters: [{ name: 'Image', extensions: [name.slice(name.lastIndexOf('.') + 1)] }] });
  });
}

export const contextMenuFeature: Feature = {
  name: 'context-menu',
  modes: ['standalone', 'instance'],
  setup(ctx) {
    const { windows, menu, session, origin } = ctx;
    const pendingImages = new Set<string>();
    guardImageDownload(session, pendingImages);

    /**
     * The page's link path where it has one: an older instance has none. Open Link was picked in
     * a menu the OS drew, which is the user's click, for the page's own call that follows too.
     */
    const openLink = (window: BrowserWindow, url: string, text: string) => {
      if (menu.commandState(window)?.['link.check'] === true) {
        noteUserGesture(window.webContents);
        window.webContents.send(CHANNEL.menuCommand, `link.open:${JSON.stringify({ url, text })}`);
      } else {
        openExternally(url, 'user');
      }
    };

    windows.on('created', ({ window }) => {
      // A line of the page's own menu bar runs only on input main saw (`menu.runBarItem`).
      watchUserGestures(window.webContents);
      window.webContents.on('context-menu', (_event, params) => {
        const template = contextTemplate(window.webContents, {
          params,
          origin,
          downloadsOff: !policyAllowsDownload(menu.commandState(window)),
          imageAllowed: (url) => clientAuth.mayFetchForPage(url),
          openLink: (url, text) => openLink(window, url, text),
          // Only a page that says it searches mail this way gets the entry.
          searchMail: menu.commandState(window)?.['mail.searchText'] === true
            ? (text) => window.webContents.send(CHANNEL.menuCommand, `mail.searchText:${JSON.stringify(text)}`)
            : undefined,
          saveImage: (url) => {
            if (!clientAuth.mayFetchForPage(url)) return;
            pendingImages.add(url);
            window.webContents.downloadURL(url);
          },
        });
        if (template.length === 0) return;
        Menu.buildFromTemplate(template).popup({ window });
      });
    });

    ctx.handle(CHANNEL.menuPopup, (_event, window, items, at) => new Promise<string | null>((resolve) => {
      if (!window) {
        resolve(null);
        return;
      }
      let picked: string | null = null;
      // A pick in a menu the OS drew: no script can make one, so it counts as the user's.
      const template = toMenuTemplate(items, (id) => {
        picked = id;
        noteUserGesture(window.webContents);
      });
      if (template.length === 0) {
        resolve(null);
        return;
      }
      const point = (at ?? {}) as { x?: unknown; y?: unknown };
      const scale = window.webContents.getZoomFactor();
      const place = typeof point.x === 'number' && typeof point.y === 'number' && Number.isFinite(point.x) && Number.isFinite(point.y)
        ? { x: Math.round(point.x * scale), y: Math.round(point.y * scale) }
        : {};
      // The callback runs as the menu closes, and an item's click just before it on
      // some platforms and just after on others: a tick lets it land. A pick is a user
      // action, but the page can't know: without this, an entry that opens a file
      // picker or copies to the clipboard would be refused for lack of one.
      const finish = () => {
        if (picked === null || window.isDestroyed()) {
          resolve(picked);
          return;
        }
        void window.webContents.executeJavaScript('0', true).catch(() => {}).finally(() => resolve(picked));
      };
      Menu.buildFromTemplate(template).popup({ window, ...place, callback: () => setTimeout(finish, 0) });
    }));

    ctx.handle(CHANNEL.menuBarEntries, (): MenuBarEntry[] => menu.barEntries());
    ctx.handle(CHANNEL.menuBarMenus, (_event, window): MenuBarMenu[] => (window ? menu.barMenus(window) : []));
    ctx.on(CHANNEL.menuBarRun, (_event, window, key, label) => {
      if (window) menu.runBarItem(window, key, label);
    });
    ctx.on(CHANNEL.menuBarReport, (_event, window, report) => {
      if (window) menu.barReport(window, report);
    });
    ctx.on(CHANNEL.menuBarSetPinned, (_event, _window, pinned) => {
      if (typeof pinned === 'boolean') menu.setBarPinned(pinned);
    });
    ctx.on(CHANNEL.menuBarOpen, (_event, window, id, at) => {
      const point = (at ?? {}) as { x?: unknown; y?: unknown };
      if (window && typeof id === 'string' && typeof point.x === 'number' && typeof point.y === 'number') {
        menu.popupBarMenu(window, id, point.x, point.y);
      }
    });

    let languageNow = '';
    let wantedLanguages: string[] = [];
    const asksForDictionaries = process.platform !== 'win32';
    const applySpellLanguages = () => {
      const languages = pickSpellLanguages(wantedLanguages, session.availableSpellCheckerLanguages);
      // macOS has no such setting: its own spellchecker detects the language.
      if (languages.length && process.platform !== 'darwin') session.setSpellCheckerLanguages(languages);
    };
    // Until the page says what it shows (the sign-in page doesn't): the app's language.
    wantedLanguages = spellLanguagesFor(app.getLocale(), [], app.getPreferredSystemLanguages());
    applySpellLanguages();
    ctx.on(CHANNEL.shellSetLanguages, (_event, _window, update) => {
      const { ui, composer, labels } = (update ?? {}) as Partial<LanguagesUpdate>;
      if (typeof ui !== 'string') return;
      setUiLanguage(ui, labels);
      menu.refresh();
      // A warm spare rendered in the language it was made with.
      if (languageNow && languageNow !== ui) windows.dropSpare();
      languageNow = ui;
      const composers = Array.isArray(composer) ? composer.filter((l): l is string => typeof l === 'string') : [];
      wantedLanguages = spellLanguagesFor(ui, composers, app.getPreferredSystemLanguages());
      applySpellLanguages();
    });

    if (asksForDictionaries) onDictionaryMissing((language) => windows.broadcast(CHANNEL.spellMissing, language));
    ctx.handle(CHANNEL.spellListMissing, () => (asksForDictionaries ? missingDictionaries() : []));
    ctx.on(CHANNEL.spellAllowDownload, () => {
      void outsideHostsAllowed(() => session.fetch(new URL('/api/config', origin).toString())).then((allowed) => {
        if (!allowed) return;
        openDictionaryDownloads(session);
        applySpellLanguages();
      });
    });
  },
};
