import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { request as httpsRequest } from 'node:https';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { ACCOUNT, dialogHost, ENT_PASSWORD, expectMailShown, fakeOsIntegration, fillLogin, launch, launchStandalone, opened, removeOsTraces, removeProfile, requireAccount, shownPage, STALWARTS, tempProfile, waitForLogin } from './helpers';
import { pageWith } from './native-helpers';
import { startHostileInstance, type HostileInstance } from './support/hostile-instance';
import { startInputInstance, type InputInstance } from './support/input-instance';

/**
 * Everything that opens the app from outside, end to end on a real server: mail links in
 * every shape, cold and warm, locked, signed out and offline; calendar links; .ics and .vcf
 * files; two accounts. Needs a webmail build of this branch in ./webmail (or BULWARK_TEST_WEBMAIL).
 *
 *   IT_ENT_PASSWORD=<password> BULWARK_TEST_ACCOUNT=<a> BULWARK_TEST_ACCOUNT_B=<b> npx playwright test test/links-mail.spec.ts
 *
 * BULWARK_TEST_SERVER_LABEL picks one Stalwart (1.0 or 0.16); both run without it. Teardown
 * deletes only drafts, calendars and contacts carrying this run's tag.
 */

const ROOT = path.resolve(import.meta.dirname, '..');
const MAIN = path.join(ROOT, 'dist', 'main.mjs');
const SECOND = process.env.BULWARK_TEST_ACCOUNT_B ?? 'ent-bob@example.org';
const TAG = `lk${Date.now().toString(36)}`;
const COMPOSER = '[data-testid="email-composer"]';
const subjectField = (page: Page) => page.locator('[data-testid="composer-subject"]');

const servers = STALWARTS.filter((s) => !process.env.BULWARK_TEST_SERVER_LABEL || s.label === process.env.BULWARK_TEST_SERVER_LABEL);

type Call = [string, Record<string, unknown>, string];

/** Bare JMAP with the capabilities this file needs. Test servers only. */
async function jmapCall(server: string, user: string, calls: Call[], using: string[] = []): Promise<[string, Record<string, unknown>, string][]> {
  const session = JSON.parse(await fetchText(`${server}/jmap/session`, user)) as { apiUrl: string; primaryAccounts: Record<string, string> };
  const capability = using.find((u) => session.primaryAccounts[u]) ?? 'urn:ietf:params:jmap:mail';
  const accountId = session.primaryAccounts[capability] ?? session.primaryAccounts['urn:ietf:params:jmap:mail'];
  const body = JSON.stringify({
    using: ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', ...using],
    methodCalls: calls.map(([name, args, tag]) => [name, { accountId, ...args }, tag]),
  });
  return (JSON.parse(await fetchText(new URL(session.apiUrl, server).toString(), user, body)) as { methodResponses: [string, Record<string, unknown>, string][] }).methodResponses;
}

function fetchText(url: string, user: string, body?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, {
      method: body ? 'POST' : 'GET',
      rejectUnauthorized: false,
      headers: { Authorization: `Basic ${Buffer.from(`${user}:${ENT_PASSWORD}`).toString('base64')}`, 'Content-Type': 'application/json' },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if ((res.statusCode ?? 500) >= 400) reject(new Error(`${res.statusCode} from ${url}`));
        else resolve(text);
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

interface Draft { id: string; to: { email: string; name: string | null }[] | null; cc: { email: string }[] | null; bcc: { email: string }[] | null; subject: string; from: { email: string }[] | null; text: string }

/** This run's drafts in an account, with what a send would carry. */
async function draftsTagged(server: string, user: string, subjectPart: string): Promise<Draft[]> {
  const responses = await jmapCall(server, user, [
    ['Email/query', { filter: { subject: subjectPart, hasKeyword: '$draft' }, limit: 20 }, 'q'],
    ['Email/get', { '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: ['id', 'to', 'cc', 'bcc', 'from', 'subject', 'textBody', 'htmlBody', 'bodyValues'], fetchAllBodyValues: true }, 'g'],
  ]);
  const list = (responses[1][1].list ?? []) as (Omit<Draft, 'text'> & { bodyValues: Record<string, { value: string }> })[];
  return list.map((email) => ({ ...email, text: Object.values(email.bodyValues ?? {}).map((part) => part.value).join('\n') }));
}

async function destroyTagged(server: string, user: string): Promise<void> {
  const [[, found]] = await jmapCall(server, user, [['Email/query', { filter: { subject: TAG }, limit: 100 }, 'q']]);
  const ids = (found.ids ?? []) as string[];
  if (ids.length) await jmapCall(server, user, [['Email/set', { destroy: ids }, 'd']]);
  const calendars = await jmapCall(server, user, [['Calendar/get', { properties: ['id', 'name'] }, 'c']], ['urn:ietf:params:jmap:calendars']).catch(() => null);
  const ours = ((calendars?.[0]?.[1].list ?? []) as { id: string; name: string }[]).filter((c) => c.name.includes(TAG)).map((c) => c.id);
  if (ours.length) await jmapCall(server, user, [['Calendar/set', { destroy: ours, onDestroyRemoveEvents: true }, 'd']], ['urn:ietf:params:jmap:calendars']).catch(() => {});
  const events = await jmapCall(server, user, [['CalendarEvent/query', { filter: { text: TAG }, limit: 50 }, 'q']], ['urn:ietf:params:jmap:calendars']).catch(() => null);
  const eventIds = (events?.[0]?.[1].ids ?? []) as string[];
  if (eventIds.length) await jmapCall(server, user, [['CalendarEvent/set', { destroy: eventIds }, 'd']], ['urn:ietf:params:jmap:calendars']).catch(() => {});
  const cards = await jmapCall(server, user, [['ContactCard/query', { filter: { text: TAG }, limit: 50 }, 'q']], ['urn:ietf:params:jmap:contacts']).catch(() => null);
  const cardIds = (cards?.[0]?.[1].ids ?? []) as string[];
  if (cardIds.length) await jmapCall(server, user, [['ContactCard/set', { destroy: cardIds }, 'd']], ['urn:ietf:params:jmap:contacts']).catch(() => {});
}

async function eventsTagged(server: string, user: string, text: string): Promise<number> {
  const answer = await jmapCall(server, user, [['CalendarEvent/query', { filter: { text }, limit: 10 }, 'q']], ['urn:ietf:params:jmap:calendars']);
  return ((answer[0][1].ids ?? []) as string[]).length;
}

async function cardsTagged(server: string, user: string, text: string): Promise<number> {
  const answer = await jmapCall(server, user, [['ContactCard/query', { filter: { text }, limit: 10 }, 'q']], ['urn:ietf:params:jmap:contacts']);
  return ((answer[0][1].ids ?? []) as string[]).length;
}

async function calendarNamed(server: string, user: string, name: string): Promise<boolean> {
  const answer = await jmapCall(server, user, [['Calendar/get', { properties: ['id', 'name'] }, 'c']], ['urn:ietf:params:jmap:calendars']);
  return ((answer[0][1].list ?? []) as { name: string }[]).some((c) => c.name === name);
}

/** A real second launch on the same profile, as Windows starts a registered handler. */
function secondLaunch(profile: string, ...args: string[]): Promise<void> {
  const require = createRequire(import.meta.url);
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const server = process.env.BULWARK_TEST_WEBMAIL ? [`--bulwark-server-dir=${process.env.BULWARK_TEST_WEBMAIL}`] : [];
  const child = spawn(require('electron') as unknown as string, [MAIN, `--bulwark-user-data=${profile}`, ...server, '--', ...args], { env, stdio: 'ignore' });
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill(); resolve(); }, 30_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

/** The main window's page: shownPage() may hand back a compose window that opened first. */
async function mainPage(app: ElectronApplication): Promise<Page> {
  await expect.poll(() => app.windows().some((w) => !w.isClosed() && w.url().startsWith('https://') && !w.url().includes('/popout/')), { timeout: 60_000 }).toBe(true);
  return app.windows().find((w) => !w.isClosed() && w.url().startsWith('https://') && !w.url().includes('/popout/'))!;
}

const composerWindows = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().includes('/popout/compose')).length);
const mainVisible = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('/popout/'))?.isVisible() ?? false);

async function closeComposerWindows(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) if (window.webContents.getURL().includes('/popout/compose')) window.destroy();
  });
  await expect.poll(() => composerWindows(app), { timeout: 30_000 }).toBe(0);
}

/** The composer a mail link opened: its own window, or the main window's when that's where it went. */
async function linkedComposer(app: ElectronApplication, main: Page, timeoutMs = 60_000): Promise<Page> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const popout = app.windows().find((w) => !w.isClosed() && w.url().includes('/popout/compose'));
    if (popout && await subjectField(popout).isVisible().catch(() => false)) return popout;
    if (await main.locator(COMPOSER).isVisible().catch(() => false)) return main;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`No composer: ${app.windows().map((w) => w.url()).join(', ')}`);
}

async function recipients(composer: Page, label: 'to' | 'cc' | 'bcc'): Promise<string[]> {
  const row = label === 'to' ? composer.locator('[data-testid="composer-to"]') : composer.locator(COMPOSER).locator('div', { has: composer.getByText(new RegExp(`^${label}:$`, 'i')) }).last();
  return row.locator('[data-recipient-chip]').evaluateAll((chips) => chips.map((chip) => (chip.textContent ?? '').trim()));
}

const editor = (composer: Page) => composer.locator(`${COMPOSER} [contenteditable="true"], ${COMPOSER} textarea`).last();

/** One real edit, so the composer saves a draft the server can be asked about. */
async function touchAndSave(composer: Page): Promise<void> {
  await editor(composer).click();
  await composer.keyboard.press('End');
  await composer.keyboard.press('Control+End');
  await composer.keyboard.type(' ');
}

const ICS = (summary: string) => [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Bulwark//Links test//EN',
  'BEGIN:VEVENT', `UID:${summary.replace(/\s+/g, '-')}@example.org`, 'DTSTAMP:20261104T100000Z',
  'DTSTART:20261120T100000Z', 'DTEND:20261120T110000Z', `SUMMARY:${summary}`, 'END:VEVENT',
  'END:VCALENDAR', '',
].join('\r\n');

for (const { label, url: SERVER } of servers) {
  test.describe(`links and files from outside on Stalwart ${label}`, () => {
    test.describe.configure({ mode: 'serial' });
    test.setTimeout(300_000);
    let profile = '';
    let app: ElectronApplication;
    let page: Page;

    test.beforeAll(async () => {
      requireAccount();
      await destroyTagged(SERVER, ACCOUNT).catch(() => {});
    });

    test.afterAll(async () => {
      await app?.close().catch(() => {});
      removeProfile(profile);
      removeOsTraces();
      await destroyTagged(SERVER, ACCOUNT).catch(() => {});
      await destroyTagged(SERVER, SECOND).catch(() => {});
    });

    test('signed out on a cold start: the sign-in first, then the composer with the link in it', async () => {
      profile = tempProfile('lk');
      const subject = `${TAG} signed out`;
      app = await launch(profile, '--standalone', '--', `mailto:someone@example.org?subject=${encodeURIComponent(subject)}`);
      page = await shownPage(app);
      await fakeOsIntegration(app);
      await waitForLogin(page);
      expect(await composerWindows(app)).toBe(0);
      await fillLogin(page, SERVER, ACCOUNT, ENT_PASSWORD);
      await page.keyboard.press('Enter');
      await expectMailShown(page);
      const composer = await linkedComposer(app, page);
      await expect(subjectField(composer)).toHaveValue(subject);
      expect(await recipients(composer, 'to')).toEqual([expect.stringContaining('someone@example.org')]);
      await closeComposerWindows(app);
      if (await page.locator(COMPOSER).isVisible()) await page.getByTestId('composer-close').first().click();
    });

    test('warm start: every field, UTF-8 and line breaks reach a compose window, and the main window stays where it was', async () => {
      const subject = `${TAG} Grüße 😀 & "quotes"`;
      const body = 'Zeile 1\r\nZeile 2\r\n\r\n€ 10 & more';
      const link = `mailto:J%C3%BCrgen%20%3Cjuergen%40example.org%3E,second%40example.org?cc=cc%40example.org&bcc=bcc%40example.org&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
      await secondLaunch(profile, link);
      const composer = await pageWith(app, '/popout/compose');
      await expect(subjectField(composer)).toHaveValue(subject, { timeout: 60_000 });
      expect(await mainVisible(app)).toBe(false);
      const to = await recipients(composer, 'to');
      expect(to).toHaveLength(2);
      expect(to.join(' ')).toContain('Jürgen');
      expect(to.join(' ')).toContain('second@example.org');
      await expect(editor(composer)).toContainText('Zeile 1');
      await expect(editor(composer)).toContainText('€ 10 & more');

      // What a send would carry, read back from the server.
      await touchAndSave(composer);
      let draft: Draft | undefined;
      await expect.poll(async () => {
        draft = (await draftsTagged(SERVER, ACCOUNT, TAG)).find((d) => d.subject === subject);
        return !!draft;
      }, { timeout: 60_000 }).toBe(true);
      expect(draft!.to?.map((a) => a.email).sort()).toEqual(['juergen@example.org', 'second@example.org']);
      expect(draft!.to?.find((a) => a.email === 'juergen@example.org')?.name).toBe('Jürgen');
      expect(draft!.cc?.map((a) => a.email)).toEqual(['cc@example.org']);
      expect(draft!.bcc?.map((a) => a.email)).toEqual(['bcc@example.org']);
      expect(draft!.from?.[0]?.email).toBe(ACCOUNT);
      expect(draft!.text).toMatch(/Zeile 1\s*(\n|<br\s*\/?>|<\/p>\s*<p[^>]*>|<\/div>\s*<div[^>]*>)\s*Zeile 2/);
      expect(draft!.text).toContain('€ 10 &');
      await closeComposerWindows(app);
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    });

    test('a link with a stray percent sign or a broken address still opens the composer', async () => {
      await secondLaunch(profile, `mailto:not-an-address?subject=${TAG}%2050% off`);
      const composer = await linkedComposer(app, page);
      await expect(subjectField(composer)).toHaveValue(`${TAG} 50% off`);
      expect((await recipients(composer, 'to')).join(' ')).toContain('not-an-address');
      await closeComposerWindows(app);
    });

    test('a calendar link goes straight to the subscription, and subscribes on the server', async () => {
      const name = `${TAG} holidays`;
      await secondLaunch(profile, `webcal://feeds.example.org/${TAG}.ics?name=${encodeURIComponent(name)}`);
      await page.waitForURL(/\/calendar/, { timeout: 60_000 });
      const dialog = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Subscribe', exact: true }) });
      await expect(dialog).toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole('button', { name: 'Import once' })).toHaveCount(0);
      await expect(dialog.locator('input').first()).toHaveValue(`https://feeds.example.org/${TAG}.ics?name=${encodeURIComponent(name)}`);
      await expect(dialog.getByRole('textbox').nth(1)).toHaveValue(name);
      // The feed itself, as the app's own server would have fetched it: no request leaves this machine.
      await page.route('**/api/fetch-ical**', (route) => route.fulfill({ status: 200, contentType: 'text/calendar', body: ICS(`${TAG} feed event`) }));
      await dialog.getByRole('button', { name: 'Subscribe', exact: true }).click();
      await expect(dialog).toBeHidden({ timeout: 60_000 });
      await page.unroute('**/api/fetch-ical**');
      await expect.poll(() => calendarNamed(SERVER, ACCOUNT, name).catch(() => false), { timeout: 60_000 }).toBe(true);
    });

    test('an .ics file offers Add to calendar and lands on the server; a .vcf offers Add to contacts', async () => {
      const ics = path.join(profile, `${TAG}.ics`);
      writeFileSync(ics, ICS(`${TAG} file event`));
      await secondLaunch(profile, ics);
      await page.waitForURL(/\/calendar/, { timeout: 60_000 });
      await expect(page.getByText(`${TAG} file event`).first()).toBeVisible({ timeout: 60_000 });
      await page.getByRole('button', { name: /Import selected/ }).click();
      await expect.poll(() => eventsTagged(SERVER, ACCOUNT, `${TAG} file event`).catch(() => 0), { timeout: 60_000 }).toBe(1);

      const vcf = path.join(profile, `${TAG}.vcf`);
      writeFileSync(vcf, ['BEGIN:VCARD', 'VERSION:3.0', `FN:${TAG} Person`, `EMAIL:${TAG}@example.org`, 'END:VCARD', ''].join('\r\n'));
      await secondLaunch(profile, vcf);
      await page.waitForURL(/\/contacts/, { timeout: 60_000 });
      await expect(page.getByText(`${TAG} Person`).first()).toBeVisible({ timeout: 60_000 });
      await page.getByRole('button', { name: 'Import', exact: true }).click();
      await expect.poll(() => cardsTagged(SERVER, ACCOUNT, `${TAG} Person`).catch(() => 0), { timeout: 60_000 }).toBe(1);
    });

    test('several files at once: two calendar files and a contact card all arrive', async () => {
      const a = path.join(profile, `${TAG}-a.ics`);
      const b = path.join(profile, `${TAG}-b.ics`);
      writeFileSync(a, ICS(`${TAG} first of two`));
      writeFileSync(b, ICS(`${TAG} second of two`));
      await app.evaluate((_e, [files, cwd]) => (globalThis as unknown as { __bulwarkOs: { launch: { handle: (a: string[], c: string) => Promise<number> } } }).__bulwarkOs.launch.handle(['bulwark.exe', '--', ...files], cwd), [[a, b], profile] as const);
      await page.waitForURL(/\/calendar/, { timeout: 60_000 });
      await expect(page.getByText(`${TAG} first of two`).first()).toBeVisible({ timeout: 60_000 });
      await page.getByRole('button', { name: /Import selected/ }).click();
      await expect(page.getByText(`${TAG} second of two`).first()).toBeVisible({ timeout: 60_000 });
      await page.getByRole('button', { name: /Import selected/ }).click();
      await expect.poll(() => eventsTagged(SERVER, ACCOUNT, 'of two').catch(() => 0), { timeout: 60_000 }).toBe(2);
    });

    test('offline: a mail link still opens the composer with what it carries', async () => {
      const subject = `${TAG} offline`;
      await app.evaluate(({ session }) => session.fromPartition('persist:bulwark').enableNetworkEmulation({ offline: true }));
      try {
        await secondLaunch(profile, `mailto:someone@example.org?subject=${encodeURIComponent(subject)}`);
        const composer = await linkedComposer(app, page);
        await expect(subjectField(composer)).toHaveValue(subject);
      } finally {
        await app.evaluate(({ session }) => session.fromPartition('persist:bulwark').disableNetworkEmulation());
      }
      await closeComposerWindows(app);
      if (await page.locator(COMPOSER).isVisible()) await page.getByTestId('composer-close').first().click();
    });

    test('cold start, signed in: the link opens a composer once the page is up', async () => {
      await app.close();
      const subject = `${TAG} cold`;
      app = await launch(profile, '--standalone', '--', `mailto:someone@example.org?subject=${encodeURIComponent(subject)}`);
      await shownPage(app);
      page = await mainPage(app);
      await fakeOsIntegration(app);
      const composer = await linkedComposer(app, page, 120_000);
      await expect(subjectField(composer)).toHaveValue(subject);
      await closeComposerWindows(app);
      if (await page.locator(COMPOSER).isVisible()) await page.getByTestId('composer-close').first().click();
    });

    test('two accounts: the default one writes it, From can change it, and nothing asks', async () => {
      await page.getByTestId('account-switcher').first().click();
      await page.getByTestId('add-account').first().click();
      await fillLogin(page, SERVER, SECOND, ENT_PASSWORD);
      await page.keyboard.press('Enter');
      await expectMailShown(page);
      await expect.poll(() => page.getByTestId('account-switcher').first().getAttribute('data-active-account-id'), { timeout: 60_000 }).toBeTruthy();

      const subject = `${TAG} two accounts`;
      await secondLaunch(profile, `mailto:someone@example.org?subject=${encodeURIComponent(subject)}`);
      const composer = await linkedComposer(app, page);
      await expect(subjectField(composer)).toHaveValue(subject);
      await expect(page.getByText(/Choose which account/i)).toHaveCount(0);
      const from = composer.getByTestId('composer-from');
      await expect(from).toBeVisible();
      const selected = await from.evaluate((el) => (el as HTMLSelectElement).selectedOptions[0]?.textContent ?? '');
      expect(selected).toContain(ACCOUNT);
      const options = await from.locator('option').allTextContents();
      expect(options.join('\n')).toContain(SECOND);
      await closeComposerWindows(app);

      // A calendar link with two accounts asks which one, and then nothing more.
      await secondLaunch(profile, `webcal://feeds.example.org/${TAG}-two.ics`);
      await expect(page.getByText(/Choose which account/i)).toBeVisible({ timeout: 60_000 });
      await page.getByRole('dialog').getByRole('button', { name: new RegExp(ACCOUNT.replace(/[.@]/g, '\\$&')) }).first().click();
      const dialog = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: 'Subscribe', exact: true }) });
      await expect(dialog).toBeVisible({ timeout: 60_000 });
      await dialog.getByRole('button', { name: 'Cancel' }).click();
    });

    // Last: from here on the profile has a PIN.
    test('locked: the lock screen and no composer, and the composer after the PIN', async () => {
      const pin = 'links-test-pin';
      // Locking moves the main window to a new renderer process, which Playwright doesn't follow:
      // from then on the main window's page is reached through main.
      const inMain = <T>(code: string) => app.evaluate(({ BrowserWindow }, js) => {
        const main = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('/popout/'));
        return main?.webContents.executeJavaScript(js) ?? null;
      }, code) as Promise<T>;
      const lockShown = () => inMain<boolean>(`!!document.querySelector('[data-testid="app-lock-form"]')`).catch(() => false);

      await page.goto(`${new URL(page.url()).origin}/settings/privacy`);
      const toggle = page.getByTestId('app-lock-switch');
      await expect(toggle).toHaveAttribute('aria-checked', 'false', { timeout: 60_000 });
      await toggle.click();
      // The PIN dialog is a window of its own (dialog-surfaces.ts), or over the page with an older webmail.
      const pinDialog = await dialogHost(app, page, '[data-testid="app-lock-new-pin"]');
      await pinDialog.getByTestId('app-lock-new-pin').fill(pin);
      await pinDialog.getByTestId('app-lock-repeat-pin').fill(pin);
      await pinDialog.getByTestId('app-lock-dialog-save').click();
      await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 30_000 });
      await page.getByTestId('app-lock-now').click();
      await expect.poll(lockShown, { timeout: 60_000 }).toBe(true);

      const subject = `${TAG} locked`;
      await secondLaunch(profile, `mailto:someone@example.org?subject=${encodeURIComponent(subject)}`);
      await new Promise((resolve) => setTimeout(resolve, 3000));
      expect(await composerWindows(app)).toBe(0);
      expect(await lockShown()).toBe(true);
      expect(await mainVisible(app)).toBe(true);
      expect(await inMain<string>('document.body.innerText')).not.toContain(subject);

      await inMain(`(() => {
        const input = document.querySelector('[data-testid="app-lock-pin"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(pin)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector('[data-testid="app-lock-unlock"]').click();
      })()`);
      await expect.poll(lockShown, { timeout: 60_000 }).toBe(false);
      const composer = await pageWith(app, '/popout/compose');
      await expect(subjectField(composer)).toHaveValue(subject, { timeout: 60_000 });
      await closeComposerWindows(app);
    });
  });
}

test.describe('links a page hands to other programs', () => {
  // An instance whose page opens addresses itself (test/support/hostile-instance.ts). No mail
  // server: the system browser and every other program are stood in for (fakeOsIntegration).
  let hostile: HostileInstance;
  test.beforeAll(async () => {
    hostile = await startHostileInstance(3844);
  });
  test.afterAll(() => hostile?.close());

  test('with no click only web addresses open, five in ten seconds; mail, phone, text and calendar need a click; nothing else ever', async () => {
    test.setTimeout(180_000);
    const lootOf = (kind: string) => hostile.loot.filter((entry) => entry.kind === kind);
    const profile = tempProfile('links-rules');
    hostile.loot.length = 0;
    hostile.mode = 'idle';
    const app = await launch(profile, `--instance=${hostile.origin}/`, '--ignore-certificate-errors', '--bulwark-test-no-native');
    try {
      const page = await shownPage(app);
      await app.evaluate(({ app: electronApp }) => {
        electronApp.relaunch = () => undefined;
      });
      await fakeOsIntegration(app, 1);
      // On load, eight addresses and no click.
      hostile.mode = 'open-external';
      await page.reload();
      await expect.poll(() => lootOf('open-external-called').length).toBe(1);
      const firstAt = Date.now();
      await page.waitForTimeout(500);
      expect(await opened(app)).toEqual(['https://attacker.example/landing']);

      const call = (url: string) => page.evaluate((address) => (window as unknown as { bulwarkDesktop: { shell: { openExternal: (u: string) => void } } }).bulwarkDesktop.shell.openExternal(address), url);
      const clickThen = async (url: string) => {
        await page.mouse.click(400, 500);
        await call(url);
      };
      for (const url of ['MAILTO:a@example.org', 'tel:+4912345', 'sms:+4912345', 'webcal://example.org/c.ics', 'xmpp:a@example.org', 'webcal://user@example.org/c.ics']) await clickThen(url);
      await call('mailto:b@example.org');
      await call('tel:+4999');
      await page.waitForTimeout(500);
      expect((await opened(app)).slice(1)).toEqual(['mailto:a@example.org', 'tel:+4912345', 'sms:+4912345', 'webcal://example.org/c.ics']);

      // A mail link the user clicks on the page goes the same way, on that click. The mouse, as
      // a locator's click would wait for a navigation the guard stops.
      const link = (await page.locator('#mail-link').boundingBox())!;
      await page.mouse.click(link.x + link.width / 2, link.y + link.height / 2);
      await expect.poll(() => opened(app)).toContain('mailto:someone@example.org');

      // Web addresses with no click, once the first one's ten seconds are over: five, not six,
      // and one more after another ten seconds.
      await page.waitForTimeout(Math.max(0, firstAt + 10_500 - Date.now()));
      const before = (await opened(app)).length;
      for (let n = 1; n <= 6; n += 1) await call(`https://example.org/${n}`);
      await page.waitForTimeout(500);
      expect((await opened(app)).slice(before)).toEqual([1, 2, 3, 4, 5].map((n) => `https://example.org/${n}`));
      await page.waitForTimeout(10_500);
      await call('https://example.org/7');
      await expect.poll(() => opened(app)).toContain('https://example.org/7');
    } finally {
      await app.close().catch(() => {});
      removeProfile(profile);
    }
  });
});

test.describe('links on a page used with the keyboard, and pop-ups', () => {
  // An instance whose page has a phone link with the focus, or opens addresses through pop-ups
  // of its own (test/support/input-instance.ts).
  let instance: InputInstance;
  test.beforeAll(async () => {
    instance = await startInputInstance(3846);
  });
  test.afterAll(() => instance?.close());

  /** The instance's page in `mode`, with the system browser and every other program stood in for. */
  async function openInstance(profile: string, mode: InputInstance['mode']): Promise<{ app: ElectronApplication; page: Page }> {
    instance.loot.length = 0;
    instance.mode = 'idle';
    const app = await launch(profile, `--instance=${instance.origin}/`, '--ignore-certificate-errors', '--bulwark-test-no-native');
    const page = await shownPage(app);
    await app.evaluate(({ app: electronApp }) => {
      electronApp.relaunch = () => undefined;
    });
    await fakeOsIntegration(app, 1);
    await expect.poll(() => instance.loot.some((entry) => entry.kind === 'bridge')).toBe(true);
    instance.loot.length = 0;
    instance.mode = mode;
    await page.reload();
    return { app, page };
  }

  test('a phone link opens when the user presses Enter on it', async () => {
    const profile = tempProfile('links-enter');
    const { app, page } = await openInstance(profile, 'key-link');
    try {
      await expect.poll(() => instance.loot.filter((entry) => entry.kind === 'ready').map((entry) => entry.body), { timeout: 30_000 }).toEqual([true]);
      // Enter as the OS sends it, through the browser's input path: a raw key down, its character, the key up.
      const cdp = await page.context().newCDPSession(page);
      const enter = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...enter });
      await cdp.send('Input.dispatchKeyEvent', { type: 'char', ...enter, text: '\r', unmodifiedText: '\r' });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...enter });
      await expect.poll(() => opened(app), { timeout: 8_000 }).toContain('tel:+4930555');
    } finally {
      await app.close().catch(() => {});
      removeProfile(profile);
    }
  });

  test('web addresses with no click: five in ten seconds for the app, its pop-ups included', async () => {
    const profile = tempProfile('links-popups');
    const { app } = await openInstance(profile, 'popups');
    try {
      // Seven through the bridge, then three pop-ups the page makes, each sent to two addresses.
      await expect.poll(() => instance.loot.filter((entry) => entry.kind === 'popups-done').length, { timeout: 60_000 }).toBe(1);
      const went = await opened(app);
      expect(went.filter((url) => url.includes('/own-')), 'through the bridge').toHaveLength(5);
      expect(went.length, 'web addresses the page opened in the browser with no click, inside ten seconds').toBeLessThanOrEqual(5);
    } finally {
      await app.close().catch(() => {});
      removeProfile(profile);
    }
  });

  test('a phone link in a mail framed as the webmail frames it opens on the click, handed over by the page or by itself', async () => {
    const profile = tempProfile('links-frame');
    const { app, page } = await openInstance(profile, 'mail-frame');
    try {
      await expect.poll(() => instance.loot.filter((entry) => entry.kind === 'ready').length, { timeout: 30_000 }).toBe(1);
      // The first link: the page hands it to the shell on the click. The second opens by itself.
      await page.mouse.click(60, 40);
      await expect.poll(() => opened(app), { timeout: 10_000 }).toContain('tel:+4930991');
      await page.mouse.click(60, 120);
      await expect.poll(() => opened(app), { timeout: 10_000 }).toContain('tel:+4930992');
    } finally {
      await app.close().catch(() => {});
      removeProfile(profile);
    }
  });
});
