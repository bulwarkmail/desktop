#!/usr/bin/env node
// Start-up time and idle cost of a packed test build (`BULWARK_TEST_PACK=1 node build.mjs --test`,
// then electron-builder), signed in to a real mail server. For a nightly job or a bench machine,
// never a busy developer machine: timings there mean nothing.
//
//   BULWARK_PERF_SERVER=<jmap url> BULWARK_PERF_USER=<address> BULWARK_PERF_PASSWORD=<password> \
//     node scripts/perf-check.mjs --app /opt/Bulwark/bulwark [--runs 10] [--idle-minutes 5]
//     [--idle-window 120] [--out result.json] [--budget budgets.json]
//
// Each run: the time from just before the process starts to the first mail row on screen
// (read over the remote debugging port, which only a test build opens), and to the page's
// navigation start, which is the shell's own share. Then one more start, left alone for
// --idle-minutes, and on Linux the memory of all its processes (PSS from smaps_rollup) and
// their CPU time and wake-ups (voluntary context switches) over --idle-window seconds.
//
// --budget names a JSON file such as {"startMedianMs": 9000, "shellMedianMs": 2500,
// "idlePssMb": 700, "idleWakeupsPerMinute": 400}: the check fails when a measured value is
// over its budget; keys starting with "_" are notes. A run that times out is an error and
// fails the check, never a number. So does a package that carries the server's code cache
// when the server used none of it.

import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { asarHasCodeCache, codeCacheUsed, serverAsarFor } from './perf-code-cache.mjs';

const ROW = '[data-testid="email-list-item"]';
const APP_ORIGIN = 'https://app.bulwark.localhost';

function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : fallback;
}

const app = option('app');
const runs = Number(option('runs', '10'));
const idleMinutes = Number(option('idle-minutes', '5'));
const idleWindow = Number(option('idle-window', '120'));
const out = option('out');
const budgetFile = option('budget');
const port = Number(option('port', '9333'));
const { BULWARK_PERF_SERVER: server, BULWARK_PERF_USER: user, BULWARK_PERF_PASSWORD: password } = process.env;
if (!app || !server || !user || !password) {
  console.error('usage: BULWARK_PERF_SERVER=… BULWARK_PERF_USER=… BULWARK_PERF_PASSWORD=… node scripts/perf-check.mjs --app <binary> [options]');
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function quantile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return NaN;
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (h - lo);
}

function launch(profile) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.BULWARK_PERF_PASSWORD;
  const child = spawn(app, [`--user-data-dir=${profile}`, '--lang=en-US', `--remote-debugging-port=${port}`], { env, stdio: 'ignore' });
  return child;
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  for (let i = 0; i < 300 && child.exitCode === null; i += 1) await sleep(100);
  if (child.exitCode === null) child.kill('SIGKILL');
  await sleep(2000);
}

async function connect(deadline) {
  while (Date.now() < deadline) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 5000 });
    } catch {
      await sleep(25);
    }
  }
  throw new Error('the remote debugging port never answered');
}

async function appPage(browser, deadline) {
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        if (!page.isClosed() && page.url().startsWith(APP_ORIGIN) && !page.url().includes('/popout/')) return page;
      }
    }
    await sleep(25);
  }
  // What Chromium itself lists, apart from what the driver saw: tells a window that never loaded
  // the app from one the driver missed.
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => []);
  throw new Error(`no app window; driver saw ${JSON.stringify(browser.contexts().flatMap((c) => c.pages().map((p) => p.url())))}, Chromium lists ${JSON.stringify(targets.map((t) => `${t.type} ${t.url}`.slice(0, 120)))}`);
}

/** What the app shows when the mail list doesn't come: its windows, the page's URL and text, a screenshot. */
async function whereItStopped(browser, page) {
  const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => []);
  const windows = targets.filter((t) => t.type === 'page').map((t) => t.url.slice(0, 120));
  const text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
  const pages = browser.contexts().flatMap((c) => c.pages()).filter((p) => !p.isClosed());
  for (const [i, shown] of pages.entries()) await shown.screenshot({ path: `perf-stopped-${i}.png` }).catch(() => {});
  return `windows ${JSON.stringify(windows)}, page ${page.url()} says ${JSON.stringify(text.replace(/\s+/g, ' ').slice(0, 400))}`;
}

async function signIn(profile) {
  const child = launch(profile);
  const deadline = Date.now() + 120_000;
  const browser = await connect(deadline);
  try {
    // A window rebuilt with a native frame (an older webmail) closes the first page: take the next.
    let page;
    for (let tries = 0; ; tries += 1) {
      page = await appPage(browser, deadline);
      try {
        await page.locator('#username').waitFor({ state: 'visible', timeout: 90_000 });
        break;
      } catch (error) {
        if (tries >= 3 || !String(error).includes('closed')) throw error;
      }
    }
    const field = page.locator('#jmap-endpoint');
    if (!(await field.isVisible())) {
      await page.fill('#username', user);
      const change = page.getByTestId('login-server-change');
      await field.or(change).first().waitFor({ state: 'visible', timeout: 30_000 });
      if (!(await field.isVisible())) await change.click();
    }
    await field.fill(server);
    await page.fill('#username', user);
    await page.fill('#password', password);
    await page.keyboard.press('Enter');
    try {
      await page.locator(ROW).first().waitFor({ state: 'visible', timeout: 90_000 });
    } catch (error) {
      throw new Error(`${String(error?.message ?? error).split('\n')[0]}; after signing in: ${await whereItStopped(browser, page)}`);
    }
    // The first sync settles and the session reaches the disk.
    await sleep(15_000);
  } finally {
    await browser.close().catch(() => {});
    await stop(child);
  }
}

/** One start: ms from just before the process to the first row, and to the page's navigation start. */
async function coldStart(profile) {
  const start = Date.now();
  const child = launch(profile);
  const deadline = start + 120_000;
  let browser;
  try {
    browser = await connect(deadline);
    const page = await appPage(browser, deadline);
    await page.locator(ROW).first().waitFor({ state: 'visible', timeout: Math.max(1, deadline - Date.now()) });
    const rowsAt = Date.now();
    const page_ = await page.evaluate((selector) => ({
      origin: performance.timeOrigin,
      rows: document.querySelectorAll(selector).length,
      signIn: !!document.querySelector('#password'),
    }), ROW);
    if (page_.signIn) throw new Error('the sign-in page showed: the saved sign-in was lost');
    if (page_.rows < 5) throw new Error(`only ${page_.rows} rows`);
    return { start: rowsAt - start, shell: Math.round(page_.origin) - start, child };
  } catch (error) {
    await stop(child);
    throw error;
  } finally {
    await browser?.close().catch(() => {});
  }
}

function descendants(pid) {
  const all = new Map();
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, 'utf8');
      all.set(Number(entry), Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]));
    } catch {
      // Gone meanwhile.
    }
  }
  const found = [pid];
  for (let i = 0; i < found.length; i += 1) for (const [child, parent] of all) if (parent === found[i]) found.push(child);
  return found;
}

function kind(pid) {
  try {
    // Chromium rewrites its children's titles: the arguments come joined by spaces.
    const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split(/[\0 ]/);
    const type = args.find((a) => a.startsWith('--type='))?.slice(7) ?? 'main';
    const sub = args.find((a) => a.startsWith('--utility-sub-type='))?.split('.').pop();
    return sub ? `${type}:${sub}` : type;
  } catch {
    return 'gone';
  }
}

function sample(pid) {
  let pss = 0;
  let rss = 0;
  try {
    for (const line of readFileSync(`/proc/${pid}/smaps_rollup`, 'utf8').split('\n')) {
      if (line.startsWith('Pss:')) pss = Number(line.split(/\s+/)[1]);
      if (line.startsWith('Rss:')) rss = Number(line.split(/\s+/)[1]);
    }
  } catch {
    // Gone meanwhile.
  }
  let ticks = 0;
  let wakeups = 0;
  try {
    for (const tid of readdirSync(`/proc/${pid}/task`)) {
      const stat = readFileSync(`/proc/${pid}/task/${tid}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      ticks += Number(fields[11]) + Number(fields[12]);
      const status = readFileSync(`/proc/${pid}/task/${tid}/status`, 'utf8');
      wakeups += Number(/voluntary_ctxt_switches:\s+(\d+)/.exec(status)?.[1] ?? 0);
    }
  } catch {
    // Gone meanwhile.
  }
  return { pss, rss, ticks, wakeups };
}

async function idle(profile) {
  const { child } = await coldStart(profile);
  try {
    await sleep(idleMinutes * 60_000);
    if (process.platform !== 'linux') return null;
    const pids = descendants(child.pid);
    const before = new Map(pids.map((pid) => [pid, sample(pid)]));
    await sleep(idleWindow * 1000);
    const processes = pids.map((pid) => {
      const a = before.get(pid);
      const b = sample(pid);
      // USER_HZ is 100 on every Linux this runs on.
      return { kind: kind(pid), pssMb: Math.round(a.pss / 1024), rssMb: Math.round(a.rss / 1024), cpuMs: (b.ticks - a.ticks) * 10, wakeups: b.wakeups - a.wakeups };
    }).filter((p) => p.kind !== 'gone');
    return {
      processes,
      pssMb: processes.reduce((sum, p) => sum + p.pssMb, 0),
      rssMb: processes.reduce((sum, p) => sum + p.rssMb, 0),
      wakeupsPerMinute: Math.round((processes.reduce((sum, p) => sum + p.wakeups, 0) * 60) / idleWindow),
      cpuMsPerMinute: Math.round((processes.reduce((sum, p) => sum + p.cpuMs, 0) * 60) / idleWindow),
    };
  } finally {
    await stop(child);
  }
}

const profile = mkdtempSync(path.join(tmpdir(), 'bulwark-perf-'));
writeFileSync(path.join(profile, 'shell-state.json'), JSON.stringify({ mode: 'standalone' }));
const result = { app, runs: [], errors: [] };
try {
  await signIn(profile);
  // One start to warm the disk cache and the profile, not counted.
  await stop((await coldStart(profile)).child);
  // A build that carries the server's code cache has to use it: none used starts as slowly as
  // a build without one (another V8, a damaged cache).
  const carried = asarHasCodeCache(serverAsarFor(app));
  let used = null;
  try {
    used = codeCacheUsed(readFileSync(path.join(profile, 'logs', 'server.log'), 'utf8'));
  } catch {
    // No log: counted as none used below.
  }
  result.codeCache = { carried, used };
  console.log(`code cache: ${carried ? 'in the package' : 'not in the package'}, ${used ?? 'no'} files used at ready`);
  if (carried && !used) result.errors.push('the package carries a code cache and the server used none of it');
  for (let i = 0; i < runs; i += 1) {
    try {
      const run = await coldStart(profile);
      await stop(run.child);
      result.runs.push({ start: run.start, shell: run.shell });
      console.log(`run ${i + 1}: first rows after ${run.start} ms, page started loading after ${run.shell} ms`);
    } catch (error) {
      result.errors.push(String(error?.message ?? error));
      console.log(`run ${i + 1}: ERROR ${error?.message ?? error}`);
    }
  }
  const starts = result.runs.map((r) => r.start);
  const shells = result.runs.map((r) => r.shell);
  result.startMedianMs = Math.round(quantile(starts, 0.5));
  result.startP75Ms = Math.round(quantile(starts, 0.75));
  result.shellMedianMs = Math.round(quantile(shells, 0.5));
  result.shellP75Ms = Math.round(quantile(shells, 0.75));
  console.log(`first rows: median ${result.startMedianMs} ms, p75 ${result.startP75Ms} ms; shell: median ${result.shellMedianMs} ms, p75 ${result.shellP75Ms} ms`);
  if (idleMinutes > 0) {
    result.idle = await idle(profile);
    if (result.idle) {
      console.log(`idle after ${idleMinutes} min: ${result.idle.processes.length} processes, PSS ${result.idle.pssMb} MB, RSS ${result.idle.rssMb} MB, ${result.idle.wakeupsPerMinute} wake-ups and ${result.idle.cpuMsPerMinute} ms CPU per minute`);
      for (const p of [...result.idle.processes].sort((a, b) => b.pssMb - a.pssMb)) console.log(`  ${p.kind.padEnd(28)} PSS ${String(p.pssMb).padStart(4)} MB  wake-ups ${p.wakeups}  CPU ${p.cpuMs} ms`);
    }
  }
} catch (error) {
  result.errors.push(String(error?.message ?? error));
  console.log(`ERROR ${error?.message ?? error}`);
} finally {
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

if (out) writeFileSync(out, JSON.stringify(result, null, 2));
const over = [];
if (budgetFile) {
  const budget = JSON.parse(readFileSync(budgetFile, 'utf8'));
  const measured = { startMedianMs: result.startMedianMs, shellMedianMs: result.shellMedianMs, idlePssMb: result.idle?.pssMb, idleWakeupsPerMinute: result.idle?.wakeupsPerMinute };
  for (const [key, limit] of Object.entries(budget)) {
    // "_why" and the like: notes, not budgets.
    if (key.startsWith('_')) continue;
    if (measured[key] === undefined || Number.isNaN(measured[key])) over.push(`${key}: not measured`);
    else if (measured[key] > limit) over.push(`${key}: ${measured[key]} over the budget of ${limit}`);
  }
}
for (const line of over) console.log(`OVER BUDGET ${line}`);
process.exit(result.errors.length || over.length ? 1 : 0);
