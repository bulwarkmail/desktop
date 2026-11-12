// A local https server that plays an instance whose page calls for the system's Edit menu (the
// one with Paste) by every route the bridge has, and a page that draws a menu bar holding the
// focus while the shell says the bar has the keys. No real server, no real data.
//
// The page never reads what a paste carries: its paste handler cancels the event and reports only
// where it arrived. Keep it that way: the clipboard on the machine that runs this is real.
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { generateCertificate } from '../../src/main/cert';

export type EditMenuMode = 'idle' | 'many-calls' | 'popup-paste' | 'bar-focus' | 'keys';

export interface EditMenuInstance {
  origin: string;
  mode: EditMenuMode;
  /** What the page reported, in order. */
  seen: { kind: string; body: unknown }[];
  close: () => void;
}

const SCRIPT = `
(() => {
  const mode = document.documentElement.dataset.mode;
  const d = window.bulwarkDesktop;
  const send = (kind, body) => fetch('/seen?kind=' + encodeURIComponent(kind), { method: 'POST', body: JSON.stringify(body ?? null) });
  if (!d) { send('no-bridge', null); return; }
  send('bridge', null);
  d.os.setLocked(false);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // Only where a paste arrived. The event is cancelled and what it carries is never touched.
  document.addEventListener('paste', (event) => {
    event.preventDefault();
    const target = event.target && event.target.id ? event.target.id : (event.target && event.target.nodeName) || null;
    send('paste-event', { target, active: document.activeElement && (document.activeElement.id || document.activeElement.nodeName) });
  }, true);

  // A strip in the top row with a search field, and a field lower down.
  const strip = document.createElement('div');
  strip.id = 'strip';
  strip.style.cssText = 'position:fixed;left:0;top:0;width:900px;height:40px;background:#e8e8e8;z-index:10';
  const top = document.createElement('input');
  top.id = 'top-field';
  top.style.cssText = 'position:absolute;left:180px;top:6px;width:320px;height:26px';
  strip.appendChild(top);
  document.body.appendChild(strip);
  const field = document.createElement('input');
  field.id = 'field';
  field.style.cssText = 'position:fixed;left:40px;top:120px;width:300px;height:30px;z-index:10';
  document.body.appendChild(field);
  field.addEventListener('keydown', (event) => send('typed', { key: event.key, alt: event.altKey, ctrl: event.ctrlKey }));
  field.addEventListener('input', () => send('value', field.value));

  if (mode === 'many-calls') {
    // Every 50 ms for six seconds, whatever the user does: the Edit menu under every name, a bar
    // said to be the title bar's height, and the other menus too.
    (async () => {
      await sleep(300);
      d.menu.bar.report({ height: 56, active: true });
      const ids = ['edit', 'Edit', 'EDIT', 'edit ', ' edit', 'edit\\u0000', '1', 'role.editMenu', 'editMenu', 'file', 'view'];
      let calls = 0;
      const started = performance.now();
      send('ready', null);
      while (performance.now() - started < 6000) {
        for (const id of ids) { d.menu.bar.open(id, { x: 220, y: 20 }); calls += 1; }
        await sleep(50);
      }
      send('calls-done', { calls });
    })();
    for (const type of ['mousedown', 'mouseup', 'click', 'keydown', 'pointerdown']) window.addEventListener(type, () => d.menu.bar.open('edit', { x: 0, y: 0 }), true);
  }

  if (mode === 'popup-paste') {
    // The page's own menu, with lines that say they are Paste, in every shape the call might take.
    (async () => {
      await sleep(300);
      const items = [
        { id: 'p1', label: 'Paste', role: 'paste', accelerator: 'CmdOrCtrl+V' },
        { id: 'p2', label: 'Paste', type: 'normal', click: 'paste', role: 'pasteAndMatchStyle' },
        { label: 'Edit', role: 'editMenu', submenu: [{ id: 'p3', label: 'Paste', role: 'paste' }] },
      ];
      const picked = await d.menu.popup(items, { x: 200, y: 200 });
      send('popup-answer', picked);
    })();
    send('ready', null);
  }

  if (mode === 'bar-focus' || mode === 'keys') {
    // As the released bar does: while the shell says the bar has the keys, the focus is on the
    // bar's first name; when it goes, back where it was.
    const name = document.createElement('button');
    name.id = 'bar-name';
    name.textContent = 'File';
    name.style.cssText = 'position:fixed;left:8px;top:8px;width:60px;height:24px;z-index:20';
    document.body.appendChild(name);
    let before = null;
    d.menu.bar.onEvent((event) => {
      send('bar-event', event);
      if (mode !== 'bar-focus') return;
      if (event.visible) { before = document.activeElement; name.focus(); }
      else if (before) { before.focus(); before = null; }
    });
    d.menu.bar.report({ height: 0, active: false });
    field.focus();
    send('ready', { focused: document.activeElement === field });
  }

  if (mode === 'idle') send('ready', null);
})();
`;

const page = (mode: EditMenuMode) => `<!doctype html><html data-mode="${mode}"><head><meta charset="utf-8"><title>Mail - Bulwark</title>
<style>:root{--titlebar-right-inset:140px}html,body{margin:0;height:100%;font:15px system-ui}</style></head>
<body><main style="padding:340px 24px 0"><h1>Inbox</h1><p>An ordinary-looking page.</p></main>
<script src="/script.js"></script></body></html>`;

export async function startEditMenuInstance(port: number): Promise<EditMenuInstance> {
  const certificate = generateCertificate('localhost');
  const state: EditMenuInstance = { origin: '', mode: 'idle', seen: [], close: () => {} };
  const server: Server = createServer({ key: certificate.keyPem, cert: certificate.certPem }, (req, res) => {
    const url = new URL(req.url ?? '/', 'https://localhost');
    if (url.pathname === '/api/config') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ appName: 'Bulwark', jmapServerUrl: 'https://mail.example.invalid' }));
      return;
    }
    if (url.pathname === '/script.js') {
      res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
      res.end(SCRIPT);
      return;
    }
    if (url.pathname === '/seen') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        let body: unknown = null;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          // Not JSON: kept as nothing.
        }
        state.seen.push({ kind: url.searchParams.get('kind') ?? '', body });
        res.writeHead(204).end();
      });
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      res.end(page(state.mode));
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
