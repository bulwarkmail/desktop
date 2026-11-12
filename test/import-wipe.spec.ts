import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { fakeOsIntegration, launchStandalone, removeProfile, tempProfile, type Launched } from './helpers';
import { makeThunderbirdProfile } from './fixtures/make-thunderbird-profile';

/**
 * A wipe leaves nothing of a local import behind in main: the state file names the user's
 * own paths, and a token would still read them. Main's own wipe has no page to ask.
 */

test('a wipe takes the confirmed paths and every token', async () => {
  test.skip(process.platform !== 'win32', 'the policy that starts a wipe is read from the registry here');
  test.setTimeout(180_000);
  const root = `HKCU\\Software\\BulwarkTest\\Policies\\importwipe${process.pid}`;
  const base = mkdtempSync(path.join(tmpdir(), 'bw-impwipe-'));
  const profile = tempProfile('impwipe');
  const fixture = makeThunderbirdProfile(base, 'WIPE');
  mkdirSync(path.join(base, 'Documents'), { recursive: true });
  const state = () => JSON.parse(readFileSync(path.join(profile, 'shell-state.json'), 'utf8')) as { importJobs?: unknown[]; policyWipes?: string[] };
  const { app, page } = await launchStandalone(profile, `--bulwark-test-policy-root=${root}`, '--bulwark-test-policy-poll=250');
  let again: Launched | null = null;
  try {
    await fakeOsIntegration(app, 0);
    await app.evaluate(
      ({ app: electronApp }, { appData, documents }) => {
        electronApp.setPath('appData', appData);
        electronApp.setPath('documents', documents);
      },
      { appData: fixture.appData, documents: path.join(base, 'Documents') },
    );
    const url = await page.evaluate(async () => {
      const { localImport } = (window as never as { bulwarkDesktop: { localImport: { scan(): Promise<{ candidates: { handle: string; folder: string[] }[] }>; grant(handles: string[]): Promise<{ files: { url: string }[] }> } } }).bulwarkDesktop;
      const found = await localImport.scan();
      const granted = await localImport.grant([found.candidates.find((c) => c.folder[0] === 'Inbox')!.handle]);
      return granted.files[0].url;
    });
    const read = (window: Page, target: string) =>
      window.evaluate(async (address) => {
        try {
          return (await fetch(address, { headers: { Range: 'bytes=0-4' } })).status;
        } catch {
          return 0;
        }
      }, target);
    expect(await read(page, url)).toBe(206);
    expect(state().importJobs).toHaveLength(1);
    expect(JSON.stringify(state())).toContain('Inbox');

    // A wipe with windows open ends in a restart. The new process is stubbed, so this one ends.
    await app.evaluate(({ app: electronApp }) => {
      electronApp.relaunch = (() => {}) as typeof electronApp.relaunch;
    });
    const gone = new Promise<void>((resolve) => app.process().once('exit', () => resolve()));
    spawnSync('reg.exe', ['add', `${root}\\Machine`, '/v', 'WipeOfflineData', '/t', 'REG_SZ', '/d', 'now', '/f'], { windowsHide: true });
    await expect.poll(() => state().policyWipes, { timeout: 60_000 }).toEqual(['now']);

    expect(state().importJobs).toEqual([]);
    expect(readFileSync(path.join(profile, 'shell-state.json'), 'utf8')).not.toContain('Inbox');
    await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, 60_000))]);
    // The start after it, on the app's own page, where the read means something: the token reads nothing.
    again = await launchStandalone(profile, `--bulwark-test-policy-root=${root}`, '--bulwark-test-policy-poll=250');
    await expect.poll(() => read(again!.page, url).catch(() => -1), { timeout: 30_000 }).toBe(404);
  } finally {
    await app.close().catch(() => undefined);
    await again?.app.close().catch(() => undefined);
    spawnSync('reg.exe', ['delete', root, '/f'], { windowsHide: true });
    removeProfile(profile);
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
});
