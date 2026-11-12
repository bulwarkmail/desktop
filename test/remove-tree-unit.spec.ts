// Removing the app's folders never goes through a link someone put in them: a junction, a
// directory symlink, a link deeper down, or the folder itself a link. Every case runs twice:
// in the test runner's Node, and in Electron's own Node (ELECTRON_RUN_AS_NODE, no window, no
// native helper), whose recursive rmSync does follow junctions. Every link and every target
// is inside the test's own temp folder.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildSync } from 'esbuild';
import { expect, test } from '@playwright/test';
import { runRemovals } from './support/link-removals';

const ELECTRON = createRequire(import.meta.url)('electron') as unknown as string;

interface Planted {
  work: string;
  /** Folders a link points at: each must keep exactly these entries. */
  targets: Map<string, string[]>;
  /** The app's own files: each must be gone. */
  own: string[];
  links: string[];
}

/** A folder outside the app's, with a file and a subfolder with a file. */
function target(work: string, name: string): string {
  const dir = path.join(work, 'outside', name);
  mkdirSync(path.join(dir, 'Local Storage'), { recursive: true });
  writeFileSync(path.join(dir, 'keep.txt'), "not the app's");
  writeFileSync(path.join(dir, 'Local Storage', 'kept.log'), "not the app's either");
  return dir;
}

function plant(): Planted {
  const work = mkdtempSync(path.join(tmpdir(), 'bw-links-'));
  const targets = new Map<string, string[]>();
  const own: string[] = [];
  const links: string[] = [];
  const app = (...parts: string[]) => path.join(work, 'app', ...parts);
  const file = (where: string, text = 'the app\'s own') => {
    mkdirSync(path.dirname(where), { recursive: true });
    writeFileSync(where, text);
    own.push(where);
  };
  const link = (to: string, at: string, kind: 'junction' | 'dir') => {
    mkdirSync(path.dirname(at), { recursive: true });
    symlinkSync(to, at, kind);
    links.push(at);
    targets.set(to, ['Local Storage', 'keep.txt']);
  };

  // A folder with a junction and a directory symlink in it, and a junction deeper down.
  file(app('tree', 'a.txt'));
  link(target(work, 'tree-junction'), app('tree', 'Network'), 'junction');
  link(target(work, 'tree-symlink'), app('tree', 'Cache'), 'dir');
  file(app('tree', 'deep', 'er', 'b.txt'));
  link(target(work, 'tree-deep'), app('tree', 'deep', 'er', 'Projects'), 'junction');
  // A path that is itself a junction: removeTree refuses it, removeOwn takes the link alone.
  link(target(work, 'tree-at-link'), app('tree-at-link'), 'junction');
  link(target(work, 'own-at-link'), app('own-at-link'), 'junction');
  // A folder reached through a junction below the root: refused.
  const via = target(work, 'via');
  mkdirSync(path.join(via, 'inside'));
  writeFileSync(path.join(via, 'inside', 'x.txt'), "not the app's");
  link(via, app('via'), 'junction');
  targets.set(via, ['Local Storage', 'inside', 'keep.txt']);
  // Wiped partitions: a junction inside, the folder itself a junction; with and without kept local storage.
  for (const keep of ['', 'k']) {
    file(app('profile', 'Partitions', `instance-inner${keep}`, 'Cookies'));
    link(target(work, `inner${keep}`), app('profile', 'Partitions', `instance-inner${keep}`, 'Network'), 'junction');
    link(target(work, `innersym${keep}`), app('profile', 'Partitions', `instance-inner${keep}`, 'Code Cache'), 'dir');
    link(target(work, `top${keep}`), app('profile', 'Partitions', `instance-top${keep}`), 'junction');
  }
  // The Files drive at an uninstall: a junction the user made in the account's folder.
  file(app('Bulwark Files', 'me@example.org', 'notes.txt'));
  link(target(work, 'projects'), app('Bulwark Files', 'me@example.org', 'Projects'), 'junction');
  return { work, targets, own, links };
}

function check(planted: Planted, outcome: Record<string, string>, runtime: string): void {
  expect(outcome, `${runtime}: what each removal answered`).toEqual({ tree: 'ok', treeAtLink: 'ELINK', ownAtLink: 'ok', treeThroughLink: 'ELINK', partitions: 'ok', drive: 'ok' });
  for (const [dir, entries] of planted.targets) {
    expect(readdirSync(dir).sort(), `${runtime}: ${path.relative(planted.work, dir)} keeps every file`).toEqual(entries);
    expect(readdirSync(path.join(dir, 'Local Storage')), `${runtime}: ${path.relative(planted.work, dir)} keeps what is deeper in it`).toEqual(['kept.log']);
  }
  for (const file of planted.own) expect(existsSync(file), `${runtime}: ${path.relative(planted.work, file)} goes`).toBe(false);
  const app = path.join(planted.work, 'app');
  expect(existsSync(path.join(app, 'tree')), `${runtime}: the folder goes`).toBe(false);
  expect(lstatSync(path.join(app, 'tree-at-link')).isSymbolicLink(), `${runtime}: a refused link stays a link`).toBe(true);
  expect(existsSync(path.join(app, 'own-at-link')), `${runtime}: removeOwn takes the link itself`).toBe(false);
  expect(existsSync(path.join(planted.work, 'outside', 'via', 'inside', 'x.txt')), `${runtime}: nothing through a link below the root`).toBe(true);
  // Moved aside and then removed; the kept one had no local storage to bring back.
  expect(readdirSync(path.join(app, 'profile', 'Partitions')), `${runtime}: the partitions' folders`).toEqual([]);
  expect(existsSync(path.join(app, 'Bulwark Files', 'me@example.org')), `${runtime}: the drive's folder goes`).toBe(false);
}

/** Links first, never through them; then the rest, which has no link left in it. */
function cleanUp(planted: Planted): void {
  for (const link of planted.links) {
    try {
      unlinkSync(link);
    } catch {
      try {
        rmdirSync(link);
      } catch {
        // Gone with a removal.
      }
    }
  }
  rmSync(planted.work, { recursive: true, force: true });
}

test.skip(process.platform !== 'win32', 'junctions are a Windows thing');

test("in the test runner's Node, no removal goes through a link", async () => {
  const planted = plant();
  try {
    check(planted, await runRemovals(planted.work), `node ${process.versions.node}`);
  } finally {
    cleanUp(planted);
  }
});

test("in Electron's own Node, which the app runs in, no removal goes through a link", () => {
  const planted = plant();
  try {
    const bundle = path.join(planted.work, 'link-removals.cjs');
    buildSync({ entryPoints: [path.join(import.meta.dirname, 'support', 'link-removals.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'silent' });
    const script = path.join(planted.work, 'run.cjs');
    writeFileSync(script, `require(${JSON.stringify(bundle)}).runRemovals(process.argv[2]).then((outcome) => process.stdout.write(JSON.stringify({ node: process.versions.node, outcome })), (error) => { console.error(error); process.exit(2); });`);
    const run = spawnSync(ELECTRON, [script, planted.work], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 60_000, windowsHide: true });
    expect(run.status, run.stderr).toBe(0);
    const { node, outcome } = JSON.parse(run.stdout) as { node: string; outcome: Record<string, string> };
    expect(node, 'the app runtime').not.toBe(process.versions.node);
    check(planted, outcome, `electron node ${node}`);
  } finally {
    cleanUp(planted);
  }
});
