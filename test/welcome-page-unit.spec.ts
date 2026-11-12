import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// The first-run page on its own, in headless Chromium: built the way build.mjs builds it,
// with main's preload replaced by a stand-in that records what the page asks for.

const ROOT = path.resolve(import.meta.dirname, '..');
const STRINGS = JSON.parse(readFileSync(path.join(ROOT, 'src/pages/welcome-strings.json'), 'utf8')) as Record<string, Record<string, string>>;
const text = STRINGS.en;

function builtPage(): string {
  const strings = JSON.stringify(STRINGS);
  const script = readFileSync(path.join(ROOT, 'src/pages/welcome.js'), 'utf8').replace(/\r\n/g, '\n').replace('__WELCOME_STRINGS__', () => strings);
  const hash = createHash('sha256').update(script).digest('base64');
  return readFileSync(path.join(ROOT, 'src/pages/welcome.html'), 'utf8')
    .replace("script-src 'self'", `script-src 'sha256-${hash}'`)
    .replace('<script src="welcome.js"></script>', () => `<script>${script}</script>`);
}

interface Options {
  /** What main answers to the email step. */
  emailAnswer?: { ok: boolean; error?: string; next?: string };
  dark?: boolean | null;
  /** The step main asks for: 'org' after "Use my organisation's Bulwark instead". */
  page?: 'org';
}

async function open(page: Page, options: Options = {}): Promise<void> {
  await page.addInitScript((opts: Options) => {
    const calls: unknown[] = [];
    (window as unknown as { calls: unknown[] }).calls = calls;
    (window as unknown as { bulwarkWelcome: unknown }).bulwarkWelcome = {
      options: { allowStandalone: true, instanceUrl: null, urlLocked: false, page: opts.page ?? null, askTelemetry: true, askCrashReports: true, dark: opts.dark ?? null },
      choose: async (choice: unknown) => {
        calls.push(['choose', choice]);
        return opts.emailAnswer ?? { ok: true, next: 'privacy' };
      },
      answerPrivacy: async () => ({ ok: true }),
      openLink: (name: string) => calls.push(['openLink', name]),
      fit: (height: number) => calls.push(['fit', height]),
    };
  }, options);
  await page.goto(`data:text/html;charset=utf-8;base64,${Buffer.from(builtPage()).toString('base64')}`);
  await page.locator(options.page === 'org' ? '#url' : '#email').waitFor();
}

const calls = (page: Page) => page.evaluate(() => (window as unknown as { calls: unknown[] }).calls);

test.use({ locale: 'en-US' });

test.describe('the first-run page', () => {
  test('Gmail and the like: what works, and a Learn more that names a page, never an address', async ({ page }) => {
    await open(page, { emailAnswer: { ok: false, error: 'no_jmap' } });
    await page.fill('#email', 'sam@gmail.com');
    await page.click('#standalone');
    await expect(page.locator('#email-error-text')).toHaveText(text.noJmap);
    await expect(page.locator('#email-error')).not.toContainText('JMAP');
    await expect(page.locator('#email-error-link')).toHaveText(text.learnMore);
    await page.click('#email-error-link');
    expect(await calls(page)).toContainEqual(['openLink', 'providers']);
    // Not a dead end: the field takes another address, and the line goes.
    await page.fill('#email', 'sam@example.org');
    await expect(page.locator('#email-error')).toBeHidden();
    await expect(page.locator('#email')).not.toHaveAttribute('aria-invalid', 'true');
  });

  test("opens on the web address step when the user asked for their organisation's Bulwark (desktop#5)", async ({ page }) => {
    await open(page, { page: 'org' });
    await expect(page.locator('#url')).toBeVisible();
    await expect(page.locator('#url')).toBeFocused();
    await expect(page.locator('#email')).toBeHidden();
    // Back still leads to the email step.
    await page.click('#org-back');
    await expect(page.locator('#email')).toBeVisible();
  });

  test('opens on the email step otherwise', async ({ page }) => {
    await open(page);
    await expect(page.locator('#email')).toBeVisible();
    await expect(page.locator('#url')).toBeHidden();
  });

  test('a web address in the email field leads to the organisation step, with it filled in', async ({ page }) => {
    await open(page, { emailAnswer: { ok: false, error: 'web_address' } });
    await page.fill('#email', 'mail.example.com');
    await page.click('#standalone');
    await expect(page.locator('#email-error-text')).toHaveText(text.webAddress);
    await expect(page.locator('#email-error-link')).toHaveText(text.webAddressLink);
    await page.click('#email-error-link');
    await expect(page.locator('#url')).toBeVisible();
    await expect(page.locator('#url')).toHaveValue('mail.example.com');
    await expect(page.locator('#url')).toBeFocused();
    // Back: the old line under Email is gone.
    await page.click('#org-back');
    await expect(page.locator('#email')).toBeVisible();
    await expect(page.locator('#email-error')).toBeHidden();
    await expect(page.locator('#email')).not.toHaveAttribute('aria-invalid', 'true');
  });

  test('looks like the sign-in page: logo, a primary Continue and Connect, an outline Back, and "Bulwark" as the title throughout', async ({ page }) => {
    await open(page);
    await expect(page.locator('.card svg.logo')).toHaveAttribute('aria-label', 'Bulwark');
    await expect(page).toHaveTitle('Bulwark');
    await expect(page.locator('#standalone')).toHaveClass(/\bprimary\b/);
    const primary = await page.locator('#standalone').evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(primary).toBe('rgb(24, 90, 234)');
    await page.click('#instance');
    await expect(page).toHaveTitle('Bulwark');
    await expect(page.locator('#connect')).toHaveClass(/\bprimary\b/);
    await expect(page.locator('#org-back')).toHaveClass(/\bsecondary\b/);
    await page.click('#org-back');
    await page.fill('#email', 'sam@example.org');
    await page.click('#standalone');
    await page.locator('#privacy.open').waitFor();
    await expect(page).toHaveTitle('Bulwark');
    await expect(page.locator('#continue')).toHaveClass(/\bprimary\b/);
    await expect(page.locator('#back')).toHaveClass(/\bsecondary\b/);
  });

  test('asks main for the height of its card, so the window has no empty half', async ({ page }) => {
    await open(page);
    await expect.poll(async () => (await calls(page)).filter((call) => (call as unknown[])[0] === 'fit').length).toBeGreaterThan(0);
    const card = await page.locator('#card').evaluate((el) => el.getBoundingClientRect().height);
    const fits = (await calls(page)).filter((call) => (call as unknown[])[0] === 'fit').map((call) => (call as [string, number])[1]);
    expect(fits.at(-1)).toBe(Math.ceil(card) + 48);
  });

  test('dark as the app was last, whatever the system says', async ({ page }) => {
    await open(page, { dark: true });
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
    expect(await page.locator('#standalone').evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(250, 250, 250)');
  });

  test('light as the app was last, whatever the system says', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await open(page, { dark: false });
    await expect(page.locator('html')).not.toHaveClass(/dark/);
  });

  test('follows the system while open when the app has no theme yet', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await open(page, { dark: null });
    await expect(page.locator('html')).not.toHaveClass(/\bdark\b/);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveClass(/\bdark\b/);
  });

  test('going to the organisation step and back clears the old line under Email', async ({ page }) => {
    await open(page, { emailAnswer: { ok: false, error: 'email_invalid' } });
    await page.fill('#email', 'sam');
    await page.click('#standalone');
    await expect(page.locator('#email-error-text')).toHaveText(text.emailInvalid);
    await page.click('#instance');
    await page.click('#org-back');
    await expect(page.locator('#email-error')).toBeHidden();
    await expect(page.locator('#email')).not.toHaveAttribute('aria-invalid', 'true');
  });
});
