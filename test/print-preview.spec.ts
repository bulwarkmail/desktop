// The print preview (src/main/print-preview.ts) on the sign-in page, which has the bridge: no
// account needed. Printers are a fake list (test build) and print jobs are recorded, never
// sent; the save dialog is stubbed to a temp folder. Nothing reaches a printer.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { fakeOsIntegration, launchStandalone, opened, removeProfile, tempProfile, waitForLogin } from './helpers';

const FAKE_PRINTERS = {
  printers: [
    { name: 'Office Laser', displayName: 'Office Laser', options: {} },
    { name: 'Label Printer', displayName: 'Label Printer', options: {} },
  ],
  defaultPrinter: 'Office Laser',
  jobs: [] as { kind: string; options: Record<string, unknown> }[],
  renders: [] as string[],
};

let profile = '';
let app: ElectronApplication;
let page: Page;
let saveDir = '';

async function fakePrinters(): Promise<void> {
  await app.evaluate((_electron, fake) => {
    (globalThis as unknown as { __bulwarkFakePrinting: unknown }).__bulwarkFakePrinting = structuredClone(fake);
  }, FAKE_PRINTERS);
}

function jobs(): Promise<{ kind: string; options: Record<string, unknown> }[]> {
  return app.evaluate(() => (globalThis as unknown as { __bulwarkFakePrinting: { jobs: { kind: string; options: Record<string, unknown> }[] } }).__bulwarkFakePrinting.jobs);
}

/** Starts a preview of the page without waiting for it; `outcome()` waits. */
async function askPreview(request: Record<string, unknown> = { source: 'page', title: 'Sign-in page' }): Promise<void> {
  await page.evaluate((r) => {
    const w = window as unknown as { __outcome?: Promise<unknown>; bulwarkDesktop: { print: { preview(r: unknown): Promise<unknown> } } };
    w.__outcome = w.bulwarkDesktop.print.preview(r);
  }, request);
}

/** A print window as the webmail opens one: hidden, named bulwark-print-…, with `pages` pages. */
async function openPrintWindow(name: string, pages: number): Promise<void> {
  await page.evaluate(({ n, count }) => {
    const win = window.open('', n)!;
    const parts = Array.from({ length: count }, (_, i) => `<section style="break-after:page"><h1>Page ${i + 1}</h1><p>Print window test.</p></section>`);
    win.document.write(`<!DOCTYPE html><html><head><title>Test message</title></head><body>${parts.join('')}</body></html>`);
    win.document.close();
  }, { n: name, count: pages });
}

function blankWindows() {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.webContents.getURL() === 'about:blank').map((w) => ({ visible: w.isVisible() })));
}

function outcome(): Promise<unknown> {
  return page.evaluate(() => (window as unknown as { __outcome: Promise<unknown> }).__outcome);
}

function previewWindows() {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().flatMap((w) => {
    if (w.isDestroyed() || !w.webContents?.getURL().startsWith('data:') || !w.isVisible()) return [];
    return [{ id: w.id, parent: w.getParentWindow()?.id ?? null, modal: w.isModal(), title: w.getTitle() }];
  }));
}

const used = new Set<Page>();
async function previewPage(): Promise<Page> {
  await expect.poll(async () => (await previewWindows()).length, { timeout: 20_000 }).toBe(1);
  const fresh = () => app.windows().find((p) => !used.has(p) && !p.isClosed() && p.url().startsWith('data:'));
  await expect.poll(() => Boolean(fresh()), { timeout: 15_000 }).toBe(true);
  const found = fresh()!;
  used.add(found);
  await found.waitForFunction(() => document.getElementById('title')?.textContent);
  return found;
}

/** The page count the preview shows once its pages are in. */
async function shownCount(preview: Page): Promise<string> {
  await expect(preview.locator('#count')).not.toHaveText('', { timeout: 30_000 });
  return (await preview.locator('#count').textContent()) ?? '';
}

/** The last PDF the preview showed (main records them in a test build: the page's CSP keeps a test from reading its blob). */
async function shownPdf(preview: Page): Promise<{ size: number; landscape: boolean | null; pages: number }> {
  await preview.waitForFunction(() => document.querySelector('iframe.front')?.getAttribute('src'), undefined, { timeout: 30_000 });
  await expect(preview.locator('#status')).toHaveText('', { timeout: 30_000 });
  const last = await app.evaluate(() => (globalThis as unknown as { __bulwarkFakePrinting: { renders: string[] } }).__bulwarkFakePrinting.renders.at(-1) ?? '');
  const bytes = Buffer.from(last, 'base64');
  const text = bytes.toString('latin1');
  const box = /\/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\]/.exec(text);
  const landscape = box ? Number(box[3]) - Number(box[1]) > Number(box[4]) - Number(box[2]) : null;
  return { size: bytes.length, landscape, pages: (text.match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length };
}

async function pressClosing(preview: Page, key: string): Promise<void> {
  await preview.keyboard.press(key).catch((error: Error) => {
    if (!/closed/.test(error.message)) throw error;
  });
}

test.beforeAll(async () => {
  profile = tempProfile('print');
  saveDir = mkdtempSync(path.join(tmpdir(), 'bw-print-save-'));
  ({ app, page } = await launchStandalone(profile));
  await waitForLogin(page);
  // Links never reach the real browser; no native prompt waits on the hidden desktop.
  await fakeOsIntegration(app);
  await fakePrinters();
});

test.afterAll(async () => {
  await app.close().catch(() => {});
  removeProfile(profile);
  rmSync(saveDir, { recursive: true, force: true });
});

test('the preview opens over the window with the fake printers, the default first, and shows pages', async () => {
  await askPreview();
  const preview = await previewPage();
  const [shown] = await previewWindows();
  const mainId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().startsWith('https://app.bulwark.localhost'))!.id);
  expect(shown.parent).toBe(mainId);
  if (process.platform !== 'darwin') expect(shown.modal).toBe(true);
  const options = await preview.locator('#destination option').allTextContents();
  expect(options).toEqual(['Office Laser', 'Label Printer', 'Save as PDF']);
  expect(await shownCount(preview)).toMatch(/^\d+ pages?$/);
  const pdf = await shownPdf(preview);
  expect(pdf.pages).toBeGreaterThan(0);
  expect(pdf.landscape).toBe(false);
  // Chromium's PDF viewer drew the pages: its own frame, and inside it the document's.
  await expect.poll(() => {
    const urls = preview.frames().map((frame) => frame.url());
    return urls.some((url) => url.startsWith('chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/')) && urls.filter((url) => url.startsWith('blob:')).length >= 2;
  }, { timeout: 20_000 }).toBe(true);
  await pressClosing(preview, 'Escape');
  expect(await outcome()).toBe('cancelled');
  await expect.poll(async () => (await previewWindows()).length).toBe(0);
  expect(await jobs()).toEqual([]);
});

test('landscape makes the pages again, and Print sends the chosen options to the chosen printer only', async () => {
  await askPreview();
  const preview = await previewPage();
  await shownCount(preview);
  const before = await shownPdf(preview);
  await preview.locator('#layout').selectOption('landscape');
  await expect.poll(async () => (await shownPdf(preview)).landscape, { timeout: 20_000 }).toBe(true);
  expect((await shownPdf(preview)).size).not.toBe(before.size);
  await preview.locator('#destination').selectOption({ label: 'Label Printer' });
  await preview.locator('#copies').fill('3');
  await preview.locator('#color').selectOption('mono');
  await preview.locator('#more-toggle').click();
  await preview.locator('#margins').selectOption('none');
  await preview.locator('#scale').fill('80');
  await preview.locator('#header-footer').check();
  await expect(preview.locator('#go')).toBeEnabled();
  await preview.locator('#go').click().catch(() => {});
  expect(await outcome()).toBe('printed');
  const [job] = await jobs();
  expect(job.kind).toBe('printer');
  expect(job.options).toMatchObject({
    silent: true,
    deviceName: 'Label Printer',
    copies: 3,
    landscape: true,
    color: false,
    scaleFactor: 80,
    margins: { marginType: 'none' },
    usePrinterDefaultPageSize: true,
    header: 'Sign-in page',
    footer: '',
  });
  expect(job.options.pageRanges).toBeUndefined();
});

test('the next preview starts on the last printer with what was chosen there, but one copy and all pages', async () => {
  await askPreview();
  const preview = await previewPage();
  await expect(preview.locator('#destination')).toHaveValue('printer:1');
  await expect(preview.locator('#layout')).toHaveValue('landscape');
  await expect(preview.locator('#color')).toHaveValue('mono');
  await expect(preview.locator('#copies')).toHaveValue('1');
  await expect(preview.locator('#pages-mode')).toHaveValue('all');
  // Nothing chosen on that printer yet: what is chosen now carries over.
  await preview.locator('#destination').selectOption({ label: 'Office Laser' });
  await expect(preview.locator('#destination')).toHaveValue('printer:0');
  await expect(preview.locator('#layout')).toHaveValue('landscape');
  await pressClosing(preview, 'Escape');
  expect(await outcome()).toBe('cancelled');
});

test('a print window the page opened stays hidden; pages outside it keep Print off; a range prints only those pages', async () => {
  await fakePrinters();
  await openPrintWindow('bulwark-print-range', 3);
  expect(await blankWindows()).toEqual([{ visible: false }]);
  await askPreview({ source: 'window', name: 'bulwark-print-range', title: 'Test message' });
  const preview = await previewPage();
  await preview.locator('#destination').selectOption({ label: 'Office Laser' });
  await preview.locator('#layout').selectOption('portrait');
  await preview.locator('#color').selectOption('color');
  await expect(preview.locator('#count')).toHaveText('3 pages', { timeout: 30_000 });
  await expect.poll(async () => (await shownPdf(preview)).pages, { timeout: 20_000 }).toBe(3);
  await preview.locator('#pages-mode').selectOption('custom');
  await preview.locator('#pages').fill('50-60');
  await expect(preview.locator('#pages-error')).not.toHaveText('');
  await expect(preview.locator('#pages')).toHaveAttribute('aria-invalid', 'true');
  await expect(preview.locator('#go')).toBeDisabled();
  await preview.locator('#pages').fill('1, 3');
  await expect(preview.locator('#count')).toHaveText('2 pages');
  await expect.poll(async () => (await shownPdf(preview)).pages, { timeout: 20_000 }).toBe(2);
  await expect(preview.locator('#go')).toBeEnabled();
  await preview.locator('#pages').press('Enter').catch(() => {});
  expect(await outcome()).toBe('printed');
  const [job] = await jobs();
  expect(job.options).toMatchObject({ deviceName: 'Office Laser', pageRanges: [{ from: 0, to: 0 }, { from: 2, to: 2 }] });
  // The print window goes with the preview.
  await expect.poll(async () => (await blankWindows()).length).toBe(0);
});

test('a PDF shows its own pages, without margins or header lines, and prints through its own window', async () => {
  await fakePrinters();
  // A 3-page PDF, made the way the shell makes them.
  const pdf = await app.evaluate(async ({ BrowserWindow }) => {
    const maker = new BrowserWindow({ show: false });
    const html = Array.from({ length: 3 }, (_, i) => `<section style="break-after:page"><h1>PDF page ${i + 1}</h1></section>`).join('');
    await maker.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const data = await maker.webContents.printToPDF({});
    maker.destroy();
    return data.toString('base64');
  });
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const w = window as unknown as { __outcome?: Promise<unknown>; bulwarkDesktop: { print: { preview(r: unknown): Promise<unknown> } } };
    w.__outcome = w.bulwarkDesktop.print.preview({ source: 'pdf', data: bytes, title: 'Invoice' });
  }, pdf);
  const preview = await previewPage();
  await expect(preview.locator('#count')).toHaveText('3 pages', { timeout: 30_000 });
  await preview.locator('#more-toggle').click();
  await expect(preview.locator('#margins-field')).toBeHidden();
  await expect(preview.locator('#options-field')).toBeHidden();
  await expect(preview.locator('#paper')).toBeVisible();
  await preview.locator('#pages-mode').selectOption('custom');
  await preview.locator('#pages').fill('2-3');
  await expect(preview.locator('#count')).toHaveText('2 pages');
  await preview.locator('#destination').selectOption({ label: 'Office Laser' });
  await expect(preview.locator('#go')).toBeEnabled();
  await preview.locator('#go').click().catch(() => {});
  expect(await outcome()).toBe('printed');
  const [job] = await jobs();
  expect(job.options).toMatchObject({ deviceName: 'Office Laser', pageRanges: [{ from: 1, to: 2 }] });
  // The PDF's hidden window goes with it.
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.webContents.getURL().startsWith('https://print.bulwark.invalid/')).length)).toBe(0);
});

/** A PDF of `count` pages, made the way the shell makes them, base64. */
function makePdf(count: number): Promise<string> {
  return app.evaluate(async ({ BrowserWindow }, pages) => {
    const maker = new BrowserWindow({ show: false });
    const html = Array.from({ length: pages }, (_, i) => `<section style="break-after:page"><h1>PDF page ${i + 1}</h1></section>`).join('');
    await maker.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const data = await maker.webContents.printToPDF({});
    maker.destroy();
    return data.toString('base64');
  }, count);
}

/** The PDF as a blob: window of its own, as the webmail opens an attachment in a new window. Its window id. */
async function openPdfWindow(pages: number): Promise<number> {
  const pdf = await makePdf(pages);
  await page.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    window.open(URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })), '_blank');
  }, pdf);
  let id = 0;
  await expect.poll(async () => {
    id = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().startsWith('blob:'))?.id ?? 0);
    return id;
  }, { timeout: 15_000 }).not.toBe(0);
  // Until the shell has taken the viewer's print.
  await expect.poll(() => app.evaluate(async ({ BrowserWindow }, windowId) => {
    const frame = BrowserWindow.fromId(windowId)?.webContents.mainFrame.framesInSubtree.find((f) => f.url.startsWith('chrome-extension://'));
    if (!frame) return false;
    return frame.executeJavaScript(`Object.prototype.hasOwnProperty.call(document.querySelector('pdf-viewer') ?? {}, 'onPrint_')`).catch(() => false);
  }, id), { timeout: 20_000 }).toBe(true);
  return id;
}

function closeWindow(id: number): Promise<void> {
  return app.evaluate(({ BrowserWindow }, windowId) => BrowserWindow.fromId(windowId)?.destroy(), id);
}

test('the print button of the PDF viewer in a window of its own opens the preview with the PDF’s pages', async () => {
  await fakePrinters();
  const pdfWindow = await openPdfWindow(3);
  await app.evaluate(({ BrowserWindow }, windowId) => {
    const frame = BrowserWindow.fromId(windowId)!.webContents.mainFrame.framesInSubtree.find((f) => f.url.startsWith('chrome-extension://'))!;
    void frame.executeJavaScript(`document.querySelector('pdf-viewer').shadowRoot.querySelector('viewer-toolbar').shadowRoot.querySelector('#print').click()`);
  }, pdfWindow);
  const preview = await previewPage();
  const [shown] = await previewWindows();
  expect(shown.parent).toBe(pdfWindow);
  await expect(preview.locator('#count')).toHaveText('3 pages', { timeout: 30_000 });
  await preview.locator('#destination').selectOption({ label: 'Office Laser' });
  await preview.locator('#go').click().catch(() => {});
  await expect.poll(async () => (await jobs()).length).toBe(1);
  expect((await jobs())[0]).toMatchObject({ kind: 'printer', options: { deviceName: 'Office Laser' } });
  // The button goes to the preview each time, not to the OS's dialog after the first.
  await app.evaluate(({ BrowserWindow }, windowId) => {
    const frame = BrowserWindow.fromId(windowId)!.webContents.mainFrame.framesInSubtree.find((f) => f.url.startsWith('chrome-extension://'))!;
    void frame.executeJavaScript(`document.querySelector('pdf-viewer').shadowRoot.querySelector('viewer-toolbar').shadowRoot.querySelector('#print').click()`);
  }, pdfWindow);
  const again = await previewPage();
  await expect(again.locator('#count')).toHaveText('3 pages', { timeout: 30_000 });
  await pressClosing(again, 'Escape');
  await expect.poll(async () => (await previewWindows()).length).toBe(0);
  expect((await jobs()).filter((job) => job.kind === 'system')).toEqual([]);
  await closeWindow(pdfWindow);
});

test('File > Print (Ctrl+P) in a window that is a PDF shows the PDF’s pages', async () => {
  await fakePrinters();
  const pdfWindow = await openPdfWindow(2);
  await app.evaluate(({ BrowserWindow, Menu }, windowId) => {
    BrowserWindow.fromId(windowId)!.focus();
    Menu.getApplicationMenu()?.getMenuItemById('file.print')?.click();
  }, pdfWindow);
  const preview = await previewPage();
  expect((await previewWindows())[0].parent).toBe(pdfWindow);
  await expect(preview.locator('#count')).toHaveText('2 pages', { timeout: 30_000 });
  await pressClosing(preview, 'Escape');
  await expect.poll(async () => (await previewWindows()).length).toBe(0);
  await closeWindow(pdfWindow);
});

test('each printer comes back with its own choices', async () => {
  await askPreview();
  const preview = await previewPage();
  await expect(preview.locator('#destination')).toHaveValue('printer:0');
  await expect(preview.locator('#layout')).toHaveValue('portrait');
  await expect(preview.locator('#color')).toHaveValue('color');
  await preview.locator('#destination').selectOption({ label: 'Label Printer' });
  await expect(preview.locator('#layout')).toHaveValue('landscape');
  await expect(preview.locator('#color')).toHaveValue('mono');
  await preview.locator('#destination').selectOption({ label: 'Office Laser' });
  await expect(preview.locator('#layout')).toHaveValue('portrait');
  await pressClosing(preview, 'Escape');
  expect(await outcome()).toBe('cancelled');
});

test('a print window that is not this page’s, or a name that is not a print window’s, is refused', async () => {
  const ask = (request: unknown) => page.evaluate((r) => (window as unknown as { bulwarkDesktop: { print: { preview(r: unknown): Promise<unknown> } } }).bulwarkDesktop.print.preview(r), request);
  expect(await ask({ source: 'window', name: 'bulwark-print-nothing' })).toBe('refused');
  expect(await ask({ source: 'window', name: 'other' })).toBe('refused');
  expect(await previewWindows()).toEqual([]);
});

test('Save as PDF writes the pages to the file the save dialog names', async () => {
  await fakePrinters();
  const file = path.join(saveDir, 'out.pdf');
  await app.evaluate(({ dialog }, target) => {
    const g = globalThis as unknown as { __saveAsked: unknown[] };
    g.__saveAsked = [];
    dialog.showSaveDialog = (async (...args: unknown[]) => {
      g.__saveAsked.push(args[args.length - 1]);
      return { canceled: false, filePath: target };
    }) as typeof dialog.showSaveDialog;
  }, file);
  await askPreview({ source: 'page', title: 'Quarterly: report?' });
  const preview = await previewPage();
  await preview.locator('#destination').selectOption('pdf');
  await expect(preview.locator('#go')).toHaveText('Save');
  await expect(preview.locator('#copies-field')).toBeHidden();
  await shownCount(preview);
  await preview.locator('#go').click().catch(() => {});
  expect(await outcome()).toBe('saved');
  expect(existsSync(file)).toBe(true);
  const bytes = readFileSync(file);
  expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  expect((bytes.toString('latin1').match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length).toBeGreaterThan(0);
  const asked = await app.evaluate(() => (globalThis as unknown as { __saveAsked: { defaultPath: string }[] }).__saveAsked);
  expect(asked[0].defaultPath).toBe('Quarterly report.pdf');
  expect(await jobs()).toEqual([]);
});

test('"Print using system dialog…" hands the page to the OS dialog', async () => {
  await fakePrinters();
  await askPreview();
  const preview = await previewPage();
  await preview.locator('#system').click().catch(() => {});
  expect(await outcome()).toBe('system');
  const [job] = await jobs();
  expect(job).toEqual({ kind: 'system', options: { silent: false, printBackground: true } });
});

/** File > Print, as Ctrl+P runs it. */
function menuPrint(): Promise<void> {
  return app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()?.getMenuItemById('file.print');
    item?.click();
  });
}

test('File > Print (Ctrl+P) opens the preview of the window as it stands, and not over the preview again', async () => {
  await fakePrinters();
  await page.bringToFront();
  await menuPrint();
  const preview = await previewPage();
  await shownCount(preview);
  // Ctrl+P while the preview has the focus: still one preview.
  await menuPrint();
  await preview.waitForTimeout(500);
  expect(await previewWindows()).toHaveLength(1);
  await pressClosing(preview, 'Escape');
  await expect.poll(async () => (await previewWindows()).length).toBe(0);
});

test('File > Print (Ctrl+P) asks a page that listens to run its own Print', async () => {
  await page.evaluate(() => {
    const w = window as unknown as { __asked: number; bulwarkDesktop: { print: { onRequest(listener: () => void): () => void } } };
    w.__asked = 0;
    w.bulwarkDesktop.print.onRequest(() => { w.__asked += 1; });
  });
  await page.bringToFront();
  await menuPrint();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __asked: number }).__asked)).toBe(1);
  // The shell opened none of its own. A webmail that listens too (desktop-host) opens the
  // page's preview itself: at most that one, closed again here.
  await page.waitForTimeout(1000);
  const shown = await previewWindows();
  expect(shown.length).toBeLessThanOrEqual(1);
  for (const window of shown) await app.evaluate(({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.close(), window.id);
  await expect.poll(async () => (await previewWindows()).length).toBe(0);
});

/**
 * The page's menu state as the device policy says, and a preview asked for right after it, in
 * one go: the webmail sends its own state now and then, and would put printing back between two calls.
 */
async function askWithState(state: Record<string, boolean>): Promise<void> {
  await page.evaluate((s) => {
    const w = window as unknown as { __outcome?: Promise<unknown>; bulwarkDesktop: { menu: { setState(s: unknown): void }; print: { preview(r: unknown): Promise<unknown> } } };
    w.bulwarkDesktop.menu.setState(s);
    w.__outcome = w.bulwarkDesktop.print.preview({ source: 'page', title: 'Sign-in page' });
  }, state);
}

test('with printing off by policy no preview opens', async () => {
  await fakePrinters();
  await askWithState({ 'file.print': false, 'file.savePdf': false });
  expect(await outcome()).toBe('refused');
  expect(await previewWindows()).toEqual([]);
  // Save as PDF alone: only that destination.
  await askWithState({ 'file.print': false, 'file.savePdf': true });
  const preview = await previewPage();
  expect(await preview.locator('#destination option').allTextContents()).toEqual(['Save as PDF']);
  await expect(preview.locator('#system')).toBeHidden();
  await pressClosing(preview, 'Escape');
  expect(await outcome()).toBe('cancelled');
  await page.evaluate(() => (window as unknown as { bulwarkDesktop: { menu: { setState(s: unknown): void } } }).bulwarkDesktop.menu.setState({ 'file.print': true, 'file.savePdf': true }));
  expect(await jobs()).toEqual([]);
  expect(await opened(app)).toEqual([]);
});
