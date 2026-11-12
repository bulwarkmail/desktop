import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { APP_ORIGIN, fakeOsIntegration, launch, launchStandalone, removeProfile, shownPage, tempProfile, waitForLogin } from './helpers';
import { startHostileInstance, type HostileInstance } from './support/hostile-instance';

// A wipe leaves windows with no page in them. Nobody is left to answer a close, and nothing
// may wait for an answer. The app starts again on a clean first screen.

const CLOSE_LIMIT_MS = 30_000;

/** A real close. It has to end by itself: no fake dialog stands in for the one that would hang it. */
async function closesWithin(app: ElectronApplication, limit = CLOSE_LIMIT_MS): Promise<boolean> {
  return Promise.race([
    app.close().then(() => true, () => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), limit)),
  ]);
}

const exits = (app: ElectronApplication) => new Promise<void>((resolve) => app.process().once('exit', () => resolve()));

function wipeFromTest(app: ElectronApplication): Promise<unknown> {
  return app.evaluate(() => (globalThis as unknown as { __bulwarkAppLock: { wipe(): Promise<unknown> } }).__bulwarkAppLock.wipe());
}

/** Everything of the restart for real but the new process, which nothing here could reach. */
function noteRelaunch(app: ElectronApplication, marker: string): Promise<void> {
  return app.evaluate(({ app: electronApp }, file) => {
    electronApp.relaunch = (() => {
      process.getBuiltinModule('node:fs').writeFileSync(file, 'relaunched');
    }) as typeof electronApp.relaunch;
  }, marker);
}

test.describe('a window with nobody left in it', () => {
  test.setTimeout(120_000);
  let profile = '';
  let app: ElectronApplication;
  let page: Page;
  // Asked of the app after it has closed, this throws.
  let running: ChildProcess;

  const launchIt = async () => {
    ({ app, page } = await launchStandalone(profile));
    running = app.process();
    await waitForLogin(page);
  };

  test.beforeEach(async () => {
    profile = tempProfile('wipe');
    await launchIt();
  });

  test.afterEach(async () => {
    if (running.exitCode === null) await closesWithin(app, 10_000);
    if (running.exitCode === null) running.kill();
    removeProfile(profile);
  });

  const onFlush = () => page.evaluate(() => {
    (window as unknown as { bulwarkDesktop: { lifecycle: { onFlushRequest: (h: () => Promise<unknown>) => void } } }).bulwarkDesktop.lifecycle.onFlushRequest(async () => ({}));
  });

  test('a quit finishes when the page that said it saves has gone to a blank one', async () => {
    await onFlush();
    await app.evaluate(async ({ BrowserWindow }) => { await BrowserWindow.getAllWindows()[0].webContents.loadURL('about:blank'); });
    expect(await closesWithin(app)).toBe(true);
  });

  test('closing such a window asks nobody and goes', async () => {
    await onFlush();
    await app.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      await window.webContents.loadURL('about:blank');
      window.close();
    });
    // Gone, or in the tray by the user's setting. Nothing asks, so a modal would stop this read.
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter((w) => w.isVisible()).length), { timeout: CLOSE_LIMIT_MS }).toBe(0);
  });

  test('a page that dies with a save pending doesn\'t hold up a quit', async () => {
    await page.evaluate(() => {
      (window as unknown as { bulwarkDesktop: { lifecycle: { onFlushRequest: (h: () => Promise<unknown>) => void } } }).bulwarkDesktop.lifecycle.onFlushRequest(() => new Promise(() => {}));
    });
    // Asked and not answering, and then there's nobody to answer.
    const gone = exits(app);
    await app.evaluate(({ app: electronApp, BrowserWindow }) => {
      electronApp.quit();
      setTimeout(() => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer(), 300);
    });
    await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, CLOSE_LIMIT_MS))]);
    expect(running.exitCode, 'the quit went through').not.toBeNull();
  });

  test('a page asking "leave this site?" stops neither a wipe nor its restart', async () => {
    const marker = path.join(profile, 'relaunched');
    await noteRelaunch(app, marker);
    await page.locator('body').click();
    await page.evaluate(() => {
      window.addEventListener('beforeunload', (event) => { event.preventDefault(); event.returnValue = ''; });
    });
    const gone = exits(app);
    await wipeFromTest(app).catch(() => undefined);
    await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, CLOSE_LIMIT_MS))]);
    expect(running.exitCode, 'the app ended by itself').not.toBeNull();
    expect(existsSync(marker)).toBe(true);
  });

  test('a wipe ends in a real restart by itself, with no question, and the next start is clean', async () => {
    const marker = path.join(profile, 'relaunched');
    await noteRelaunch(app, marker);
    await page.evaluate(() => { localStorage.setItem('wipe-marker', 'x'); });
    await onFlush();
    const gone = exits(app);
    await wipeFromTest(app).catch(() => undefined);
    await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, CLOSE_LIMIT_MS))]);
    expect(running.exitCode, 'the app ended by itself').not.toBeNull();
    expect(existsSync(marker), 'and asked for a new start').toBe(true);

    await launchIt();
    expect(await page.evaluate(() => localStorage.getItem('wipe-marker'))).toBeNull();
  });
});

// A wipe asked for by a server's page, or by that server's admin through a remote wipe, removes
// that server's data on this device and nothing of another server's. Nobody is asked: the page
// asked its own question, and a remote wipe has nobody to ask.
test.describe("a server's page wipes its own server", () => {
  let instance: HostileInstance;

  test.beforeAll(async () => {
    instance = await startHostileInstance(3850);
  });
  test.afterAll(() => instance?.close());

  const reported = (kind: string) => instance.loot.filter((entry) => entry.kind === kind).map((entry) => entry.body);

  async function openInstance(profile: string, mode: HostileInstance['mode']): Promise<{ app: ElectronApplication; page: Page }> {
    instance.loot.length = 0;
    instance.mode = mode;
    const app = await launch(profile, `--instance=${instance.origin}/`, '--ignore-certificate-errors', '--bulwark-test-no-native');
    const page = await shownPage(app);
    await app.evaluate(({ app: electronApp, shell }) => {
      electronApp.relaunch = () => undefined;
      shell.openExternal = async () => undefined;
    });
    return { app, page };
  }

  interface Kept { otherCookie: number; ownCookie: number; approvedServers: number }

  /** The other server's session, this server's session, the approved servers. */
  function kept(app: ElectronApplication, origin: string): Promise<Kept> {
    return app.evaluate(async ({ session, BrowserWindow }, own) => {
      const mine = BrowserWindow.getAllWindows().map((w) => w.webContents).find((c) => c.getURL().startsWith(own))?.session;
      const state = (globalThis as unknown as { __bulwarkOs: { hub: { ctx: { state: { data: { approvedServers: unknown[] } } } } } }).__bulwarkOs.hub.ctx.state.data;
      return {
        otherCookie: (await session.fromPartition('persist:bulwark').cookies.get({ name: 'other_server' })).length,
        ownCookie: mine ? (await mine.cookies.get({ name: 'own_server' })).length : -1,
        approvedServers: state.approvedServers.length,
      };
    }, origin);
  }

  test("the page's wipe takes this server's session and leaves the other server's and the approved servers", async () => {
    test.setTimeout(180_000);
    const profile = tempProfile('wipe-own');
    // As someone who used two servers left it: a session on the standalone partition with an
    // approved LAN server, and a session on this instance's partition.
    const seed = await openInstance(profile, 'idle');
    try {
      await seed.app.evaluate(async ({ session, BrowserWindow }, own) => {
        const expirationDate = Date.now() / 1000 + 86400;
        const other = session.fromPartition('persist:bulwark');
        await other.cookies.set({ url: 'https://app.bulwark.localhost', name: 'other_server', value: 'standalone-session', expirationDate, secure: true, httpOnly: true });
        await other.cookies.flushStore();
        const mine = BrowserWindow.getAllWindows().map((w) => w.webContents).find((c) => c.getURL().startsWith(own))!.session;
        await mine.cookies.set({ url: own, name: 'own_server', value: 'instance-session', expirationDate, secure: true, httpOnly: true });
        await mine.cookies.flushStore();
        const state = (globalThis as unknown as { __bulwarkOs: { hub: { ctx: { state: { data: { partitions?: string[]; approvedServers: unknown[] }; save: () => void } } } } }).__bulwarkOs.hub.ctx.state;
        state.data.partitions = [...new Set([...(state.data.partitions ?? []), 'persist:bulwark'])];
        state.data.approvedServers.push({ origin: 'http://192.168.1.10:8080', approvedAt: Date.now() });
        state.save();
      }, instance.origin);
      expect(await kept(seed.app, instance.origin)).toEqual({ otherCookie: 1, ownCookie: 1, approvedServers: 1 });
    } finally {
      await seed.app.close().catch(() => {});
    }

    // The page asks for a wipe as soon as it loads. Nobody clicks; a native question would get its safe button.
    const { app } = await openInstance(profile, 'wipe');
    const running = app.process();
    const gone = exits(app);
    try {
      await fakeOsIntegration(app, 1);
      await expect.poll(() => reported('wipe-done').length + reported('wipe-error').length + reported('wipe-no-claim').length, { timeout: 30_000 }).toBeGreaterThan(0);
      expect(reported('wipe-no-claim'), 'the wipe is still on the bridge').toEqual([]);
      expect(reported('wipe-error')).toEqual([]);
      expect(reported('wipe-done')).toEqual([{ failed: [] }]);
      // Main finishes by itself when the page doesn't (after about 20 seconds) and restarts. The new
      // process is stubbed, so this one just ends.
      await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, 60_000))]);
      expect(running.exitCode, 'the app ended by itself for its restart').not.toBeNull();
    } finally {
      await app.close().catch(() => {});
    }

    // What the start after the wipe finds.
    const back = await openInstance(profile, 'idle');
    try {
      expect(await kept(back.app, instance.origin), "this server's session is gone; the other server's session and the approved servers are still there").toEqual({ otherCookie: 1, ownCookie: 0, approvedServers: 1 });
    } finally {
      await back.app.close().catch(() => {});
      removeProfile(profile);
    }
  });

  test("the shell's records: this server's go, the standalone page's stay, also with a second window open", async () => {
    test.setTimeout(180_000);
    const profile = tempProfile('wipe-records');
    // A first start, so the profile is one this app made; then both servers' records go in.
    const first = await openInstance(profile, 'idle');
    await first.app.close().catch(() => {});
    seedRecords(profile, instance.origin);
    expect(records(profile, instance.origin), 'seeded for this server').toEqual(ALL_KEPT);
    expect(records(profile, APP_ORIGIN), 'seeded for the standalone page').toEqual(ALL_KEPT);

    const { app, page } = await openInstance(profile, 'idle');
    const running = app.process();
    const gone = exits(app);
    try {
      await fakeOsIntegration(app, 1);
      // A second window of the same server, open while the wipe runs.
      await app.evaluate((_electron, url) => {
        (globalThis as unknown as { __bulwarkOs: { hub: { ctx: { windows: { open(request: unknown): void } } } } }).__bulwarkOs.hub.ctx.windows.open({ type: 'main', url, key: 'main:second' });
      }, `${instance.origin}/`);
      await expect.poll(() => app.evaluate(({ BrowserWindow }, own) => BrowserWindow.getAllWindows().filter((w) => w.webContents.getURL().startsWith(own)).length, instance.origin)).toBe(2);
      const answer = await page.evaluate(() => {
        const held = window as unknown as { __controls: { localWipe(request: unknown): Promise<unknown> }; bulwarkDesktop: { appLock: { claim(): never } } };
        held.__controls = held.bulwarkDesktop.appLock.claim();
        return held.__controls.localWipe({ reason: 'settings', account: null });
      });
      expect(answer).toEqual({ failed: [] });
      // The page has told its server: main takes the rest and restarts.
      await page.evaluate(() => (window as unknown as { __controls: { finishLocalWipe(options: unknown): Promise<void> } }).__controls.finishLocalWipe({ keepLocalStorage: false })).catch(() => undefined);
      await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, 60_000))]);
      expect(running.exitCode, 'the app ended by itself for its restart, both windows with it').not.toBeNull();
    } finally {
      await app.close().catch(() => {});
    }
    expect(records(profile, APP_ORIGIN), "the standalone page's records").toEqual(ALL_KEPT);
    expect(records(profile, instance.origin), "this server's records").toEqual(ALL_GONE);
    removeProfile(profile);
  });

  test('a step that fails is named in the answer and the others still run; one account goes on its own', async () => {
    test.setTimeout(180_000);
    const profile = tempProfile('wipe-step');
    const first = await openInstance(profile, 'idle');
    await first.app.close().catch(() => {});
    seedRecords(profile, instance.origin);
    const { app, page } = await openInstance(profile, 'idle');
    try {
      await fakeOsIntegration(app, 1);
      await app.evaluate(() => {
        const hooks = globalThis as unknown as { __bulwarkAppLock: { addWipeStep(step: (scope: unknown) => Promise<void>, options?: { perAccount?: boolean }): void }; __scopes: unknown[] };
        hooks.__scopes = [];
        hooks.__bulwarkAppLock.addWipeStep(async () => {
          throw new Error('a test step broke');
        });
        hooks.__bulwarkAppLock.addWipeStep(async (scope) => {
          hooks.__scopes.push(scope);
        }, { perAccount: true });
      });
      const controls = () => page.evaluate(async (request) => {
        const held = window as unknown as { __controls?: { localWipe(request: unknown): Promise<unknown>; finishLocalWipe(options: unknown): Promise<void> }; bulwarkDesktop: { appLock: { claim(): never } } };
        held.__controls ??= held.bulwarkDesktop.appLock.claim();
        return held.__controls!.localWipe(request);
      }, { reason: 'remote', account: 'a@example.test' });
      expect(await controls(), 'one account').toEqual({ failed: [] });
      expect(records(profile, instance.origin), "one account leaves the server's records").toEqual(ALL_KEPT);

      const all = await page.evaluate(() => (window as unknown as { __controls: { localWipe(request: unknown): Promise<unknown> } }).__controls.localWipe({ reason: 'settings', account: null }));
      expect(all).toEqual({ failed: ['a test step broke'] });
      const scopes = await app.evaluate(() => (globalThis as unknown as { __scopes: unknown[] }).__scopes);
      expect(scopes).toEqual([
        { reason: 'remote', origin: instance.origin, account: 'a@example.test' },
        { reason: 'settings', origin: instance.origin, account: null },
      ]);
      // The steps after the broken one ran, and so did the records.
      expect(records(profile, instance.origin)).toMatchObject({ importJob: false, editCopy: false, syncedFolder: false, recentYes: false });
      expect(records(profile, APP_ORIGIN)).toEqual(ALL_KEPT);
      // Not done, so no restart: the page's finish does nothing.
      await page.evaluate(() => (window as unknown as { __controls: { finishLocalWipe(options: unknown): Promise<void> } }).__controls.finishLocalWipe({ keepLocalStorage: false }));
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBeGreaterThan(0);
    } finally {
      await app.close().catch(() => {});
      removeProfile(profile);
    }
  });

  test('changing the connection offers to remove the server being left: Keep keeps it, Remove takes it and nothing else', async () => {
    test.setTimeout(240_000);
    for (const choice of ['keep', 'remove'] as const) {
      const profile = tempProfile(`wipe-switch-${choice}`);
      const seed = await openInstance(profile, 'idle');
      try {
        await seedSessions(seed.app, instance.origin);
      } finally {
        await seed.app.close().catch(() => {});
      }
      seedRecords(profile, instance.origin);

      const { app, page } = await openInstance(profile, 'idle');
      const running = app.process();
      const gone = exits(app);
      try {
        // Remove is the first button, Keep the second and the default.
        await fakeOsIntegration(app, choice === 'remove' ? 0 : 1);
        expect(await page.evaluate(() => (window as unknown as { bulwarkDesktop: { menu: { changeConnection(): Promise<boolean> } } }).bulwarkDesktop.menu.changeConnection())).toBe(true);
        await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, 60_000))]);
        expect(running.exitCode, 'the switch restarts').not.toBeNull();
      } finally {
        await app.close().catch(() => {});
      }
      const asked = readFileSync(path.join(profile, 'shell-state.json'), 'utf8');
      expect(JSON.parse(asked).askConnection, 'the next start asks how to connect').toBe(true);
      expect(records(profile, APP_ORIGIN), `${choice}: the other page's records`).toEqual(ALL_KEPT);
      expect(records(profile, instance.origin), `${choice}: this server's records`).toEqual(choice === 'remove' ? ALL_GONE : ALL_KEPT);

      const back = await openInstance(profile, 'idle');
      try {
        expect(await kept(back.app, instance.origin), choice).toEqual({ otherCookie: 1, ownCookie: choice === 'remove' ? 0 : 1, approvedServers: 1 });
      } finally {
        await back.app.close().catch(() => {});
        removeProfile(profile);
      }
    }
  });

  test("the standalone page's wipe takes its partition, the approved servers and the CORS origins, and leaves an instance's", async () => {
    test.setTimeout(240_000);
    const profile = tempProfile('wipe-standalone');
    const other = instance.origin;
    const otherPartition = `persist:instance-${Buffer.from(other).toString('base64url')}`;
    const seed = await openInstance(profile, 'idle');
    try {
      await seedSessions(seed.app, other);
      await seed.app.evaluate(({ app: electronApp }) => {
        const state = (globalThis as unknown as { __bulwarkOs: { hub: { ctx: { state: { data: { corsOrigins: string[]; signInPorts?: Record<string, number> }; save: () => void } } } } }).__bulwarkOs.hub.ctx.state;
        state.data.corsOrigins = ['https://mail.example.test'];
        state.data.signInPorts = { 'https://mail.example.test': 41234 };
        state.save();
        return electronApp.getName();
      });
    } finally {
      await seed.app.close().catch(() => {});
    }
    seedRecords(profile, other, APP_ORIGIN);

    let launched = await launchStandalone(profile);
    const running = launched.app.process();
    const gone = exits(launched.app);
    try {
      await launched.app.evaluate(({ app: electronApp }) => {
        electronApp.relaunch = () => undefined;
      });
      await launched.page.goto(new URL('/api/health', launched.page.url()).href);
      const answer = await launched.page.evaluate(() => {
        const held = window as unknown as { __controls: { localWipe(request: unknown): Promise<unknown> }; bulwarkDesktop: { appLock: { claim(): never } } };
        held.__controls = held.bulwarkDesktop.appLock.claim();
        return held.__controls.localWipe({ reason: 'settings', account: null });
      });
      expect(answer).toEqual({ failed: [] });
      const saved = JSON.parse(readFileSync(path.join(profile, 'shell-state.json'), 'utf8')) as { approvedServers: unknown[]; corsOrigins: unknown[]; signInPorts?: unknown };
      expect({ approved: saved.approvedServers, cors: saved.corsOrigins, ports: saved.signInPorts ?? null }).toEqual({ approved: [], cors: [], ports: null });
      await launched.page.evaluate(() => (window as unknown as { __controls: { finishLocalWipe(options: unknown): Promise<void> } }).__controls.finishLocalWipe({ keepLocalStorage: false })).catch(() => undefined);
      await Promise.race([gone, new Promise((resolve) => setTimeout(resolve, 60_000))]);
      expect(running.exitCode, 'the app ended by itself for its restart').not.toBeNull();
    } finally {
      await launched.app.close().catch(() => {});
    }
    expect(records(profile, other), "the instance's records").toEqual(ALL_KEPT);
    expect(records(profile, APP_ORIGIN), "the standalone page's records").toEqual(ALL_GONE);

    launched = await launchStandalone(profile);
    try {
      const cookies = await launched.app.evaluate(async ({ session }, partition) => ({
        own: (await session.fromPartition('persist:bulwark').cookies.get({ name: 'other_server' })).length,
        instance: (await session.fromPartition(partition).cookies.get({ name: 'own_server' })).length,
      }), otherPartition);
      expect(cookies, "the standalone page's session goes, the instance's stays").toEqual({ own: 0, instance: 1 });
    } finally {
      await launched.app.close().catch(() => {});
      removeProfile(profile);
    }
  });

  /** A session on each partition, and an approved LAN server, as someone who used both left them. */
  async function seedSessions(app: ElectronApplication, own: string): Promise<void> {
    await app.evaluate(async ({ session, BrowserWindow }, origin) => {
      const expirationDate = Date.now() / 1000 + 86400;
      const other = session.fromPartition('persist:bulwark');
      await other.cookies.set({ url: 'https://app.bulwark.localhost', name: 'other_server', value: 'standalone-session', expirationDate, secure: true, httpOnly: true });
      await other.cookies.flushStore();
      const mine = BrowserWindow.getAllWindows().map((w) => w.webContents).find((c) => c.getURL().startsWith(origin))!.session;
      await mine.cookies.set({ url: origin, name: 'own_server', value: 'instance-session', expirationDate, secure: true, httpOnly: true });
      await mine.cookies.flushStore();
      const state = (globalThis as unknown as { __bulwarkOs: { hub: { ctx: { state: { data: { partitions?: string[]; approvedServers: unknown[] }; save: () => void } } } } }).__bulwarkOs.hub.ctx.state;
      state.data.partitions = [...new Set([...(state.data.partitions ?? []), 'persist:bulwark'])];
      state.data.approvedServers.push({ origin: 'http://192.168.1.10:8080', approvedAt: Date.now() });
      state.save();
    }, own);
  }
});

const site = (origin: string) => createHash('sha256').update(origin).digest('hex').slice(0, 16);
const EDIT_ID = (origin: string) => (origin === APP_ORIGIN ? 'bbbbbbbbbbbbbbbb' : 'aaaaaaaaaaaaaaaa');
const ROOT_ID = (origin: string) => (origin === APP_ORIGIN ? 'standaloneroot01' : 'instanceroot0001');
const ACCOUNT_OF = (origin: string) => (origin === APP_ORIGIN ? 'old-acct' : 'own-acct');

interface Records {
  appLock: boolean;
  editCopy: boolean;
  importJob: boolean;
  recentYes: boolean;
  keystoreYes: boolean;
  overlay: boolean;
  certificate: boolean;
  syncedFolder: boolean;
  driveAccount: boolean;
  driveYes: boolean;
}
const ALL_KEPT: Records = { appLock: true, editCopy: true, importJob: true, recentYes: true, keystoreYes: true, overlay: true, certificate: true, syncedFolder: true, driveAccount: true, driveYes: true };
const ALL_GONE: Records = { appLock: false, editCopy: false, importJob: false, recentYes: false, keystoreYes: false, overlay: false, certificate: false, syncedFolder: false, driveAccount: false, driveYes: false };

/**
 * The shell's records of two servers, written into a profile that isn't running: an instance's,
 * stamped with its origin, and the standalone page's, the way older versions left them (no origin
 * where the record had none then). `running` is the one the next start opens: it gets no gate
 * record, which would lock that start.
 */
function seedRecords(profile: string, instanceOrigin: string, running = instanceOrigin): void {
  const own = instanceOrigin;
  const lock = path.join(profile, 'app-lock');
  mkdirSync(lock, { recursive: true });
  for (const origin of [own, APP_ORIGIN]) {
    writeFileSync(path.join(lock, `app-lock-pepper-${site(origin)}.bin`), 'a pepper');
    if (origin !== running) writeFileSync(path.join(lock, `${site(origin)}.json`), JSON.stringify({ proofHash: 'x', guesses: 0, blockedUntil: 0 }));
  }
  for (const origin of [own, APP_ORIGIN]) {
    const folder = path.join(profile, 'edit-files', EDIT_ID(origin));
    mkdirSync(path.join(folder, 'f'), { recursive: true });
    writeFileSync(path.join(folder, 'f', 'notes.txt'), 'an edited copy');
    const now = Date.now();
    writeFileSync(path.join(folder, 'session.json'), JSON.stringify({ id: EDIT_ID(origin), key: `k-${origin}`, name: 'notes.txt', type: 'text/plain', account: 'acct', source: 'src', origin, createdAt: now, touchedAt: now, baseHash: 'h', currentHash: 'h', version: 1 }));
    mkdirSync(path.join(profile, 'picked', ROOT_ID(origin)), { recursive: true });
  }
  mkdirSync(path.join(profile, 'files-sync'), { recursive: true });
  writeFileSync(path.join(profile, 'files-sync', 'roots.json'), JSON.stringify({
    roots: [own, APP_ORIGIN].map((origin) => ({ id: ROOT_ID(origin), account: 'acct', origin, dir: path.join(profile, 'picked', ROOT_ID(origin)), remoteId: null, remoteLabel: 'Files', paused: false, createdAt: 1 })),
  }));
  const file = path.join(profile, 'shell-state.json');
  const state = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  const job = (id: string, origin: string) => ({ id, origin, touchedAt: Date.now(), profiles: [], files: [] });
  Object.assign(state, {
    importJobs: [job('own-job', own), job('other-job', APP_ORIGIN)],
    recentFilesOrigins: [own, APP_ORIGIN],
    keystoreOrigins: [own, APP_ORIGIN],
    overlayByOrigin: { ...(state.overlayByOrigin as object), [own]: true, [APP_ORIGIN]: true },
    certificateChoices: { 'own.example:443': { fingerprint: 'aa', origin: own }, 'mail.example:443': { fingerprint: 'bb' } },
    filesDrive: {
      accounts: {
        'own-acct': { label: 'own@example.org', folder: 'own', rootId: 'r-own', createdAt: 1, origin: own },
        'old-acct': { label: 'old@example.org', folder: 'old', rootId: 'r-old', createdAt: 1 },
      },
    },
    filesDriveConsent: [{ origin: own, account: 'own-acct' }, { origin: APP_ORIGIN, account: 'old-acct' }],
  });
  writeFileSync(file, JSON.stringify(state, null, 2));
}

/** Which of `origin`'s records are still in the profile, read from disk with the app closed. */
function records(profile: string, origin: string): Records {
  const state = JSON.parse(readFileSync(path.join(profile, 'shell-state.json'), 'utf8')) as {
    importJobs?: { origin: string }[];
    recentFilesOrigins?: string[];
    keystoreOrigins?: string[];
    overlayByOrigin?: Record<string, boolean>;
    certificateChoices?: Record<string, { origin?: string }>;
    filesDrive?: { accounts?: Record<string, unknown> };
    filesDriveConsent?: { origin: string }[];
  };
  let lock: string[] = [];
  try {
    lock = readdirSync(path.join(profile, 'app-lock'));
  } catch {
    // None left.
  }
  let synced: { origin: string }[] = [];
  try {
    synced = (JSON.parse(readFileSync(path.join(profile, 'files-sync', 'roots.json'), 'utf8')) as { roots: { origin: string }[] }).roots;
  } catch {
    // None left.
  }
  return {
    appLock: lock.some((name) => name.includes(site(origin))),
    editCopy: existsSync(path.join(profile, 'edit-files', EDIT_ID(origin), 'f', 'notes.txt')),
    importJob: (state.importJobs ?? []).some((job) => job.origin === origin),
    recentYes: (state.recentFilesOrigins ?? []).includes(origin),
    keystoreYes: (state.keystoreOrigins ?? []).includes(origin),
    overlay: origin in (state.overlayByOrigin ?? {}),
    certificate: Object.values(state.certificateChoices ?? {}).some((choice) => (choice.origin ?? APP_ORIGIN) === origin),
    syncedFolder: synced.some((root) => root.origin === origin),
    driveAccount: ACCOUNT_OF(origin) in (state.filesDrive?.accounts ?? {}),
    driveYes: (state.filesDriveConsent ?? []).some((entry) => entry.origin === origin),
  };
}
