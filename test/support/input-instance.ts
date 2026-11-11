// A local https server that plays an instance whose page acts on the user's real input: it runs
// lines of the menu bar at a click or a key press, hands links to the shell, asks for recent
// files. Varied from test/support/hostile-instance-2.ts. What the page gets back is recorded in
// `loot`. No real server, no real data. The page never reads or sends what a paste put anywhere.
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { generateCertificate } from '../../src/main/cert';

export type InputMode =
  | 'idle'
  | 'synthetic'
  | 'blank-click'
  | 'recent-each-click'
  | 'recent-two-on-one'
  | 'popups'
  | 'mail-frame'
  | 'key-pick'
  | 'key-link'
  | 'paste-line'
  | 'paste-late'
  | 'paste-whole'
  | 'paste-key'
  | 'letter-pick';

export interface InputInstance {
  origin: string;
  mode: InputMode;
  loot: { kind: string; body: unknown }[];
  close: () => void;
}

const PAYLOAD = `
(() => {
  const mode = document.documentElement.dataset.mode;
  const d = window.bulwarkDesktop;
  const send = (kind, body) => fetch('/loot?kind=' + encodeURIComponent(kind), { method: 'POST', body: JSON.stringify(body ?? null) });
  if (!d) { send('no-bridge', null); return; }
  send('bridge', null);
  d.os.setLocked(false);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const flatten = (items, out = []) => {
    for (const item of items) {
      if (item.items) flatten(item.items, out);
      else if (item.type !== 'separator') out.push(item);
    }
    return out;
  };
  const menuLines = async () => flatten((await d.menu.bar.menus()).flatMap((menu) => menu.items));
  const run = (line) => d.menu.bar.run(line.key, line.label);
  const listed = async () => {
    const result = await d.recentFiles.list();
    return result.ok ? { ok: true, ids: result.files.map((file) => file.id), names: result.files.map((file) => file.name) } : result;
  };

  if (mode === 'synthetic') {
    // No mouse and no key: everything a script can do that looks like input.
    (async () => {
      await sleep(400);
      const lines = await menuLines();
      const zoomIn = lines.find((line) => line.id === 'view.zoomIn');
      const button = document.getElementById('b');
      const form = document.getElementById('f');
      const tries = {
        mouse: () => { for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) button.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: 1, view: window, clientX: 10, clientY: 10 })); },
        elementClick: () => button.click(),
        keyEnter: () => { button.focus(); for (const type of ['keydown', 'keypress', 'keyup']) button.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter', keyCode: 13, which: 13 })); },
        keySpace: () => { for (const type of ['keydown', 'keyup']) document.dispatchEvent(new KeyboardEvent(type, { bubbles: true, key: ' ', code: 'Space', keyCode: 32 })); },
        accessKey: () => { button.accessKey = 'q'; button.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'q', altKey: true })); },
        submit: () => { button.focus(); form.requestSubmit(); },
        focusBlur: () => { window.focus(); button.blur(); button.focus(); },
        touch: () => { try { button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', isPrimary: true })); button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch', isPrimary: true })); } catch {} },
      };
      const out = {};
      for (const [name, attempt] of Object.entries(tries)) {
        try { attempt(); } catch (error) { out[name + 'Error'] = String(error); }
        await sleep(30);
        if (zoomIn) run(zoomIn);
        await sleep(200);
        out[name] = { list: await listed(), active: navigator.userActivation.isActive };
      }
      // Links to other programs, each by another road, still with no input.
      d.shell.openExternal('tel:+4930111');
      d.shell.openExternal('mailto:one@example.org');
      d.shell.openExternal('MAILTO:two@example.org');
      d.shell.openExternal('sms:+4930112');
      d.shell.openExternal('webcal://example.org/a.ics');
      try { window.open('tel:+4930113', '_blank'); } catch {}
      try { window.open('mailto:three@example.org'); } catch {}
      const link = document.getElementById('l');
      link.href = 'webcal://example.org/b.ics';
      link.click();
      await sleep(200);
      link.href = 'mailto:four@example.org';
      link.target = '_blank';
      link.click();
      await sleep(200);
      link.target = '';
      location.href = 'sms:+4930114';
      await sleep(200);
      location.assign('tel:+4930115');
      await sleep(200);
      const linkForm = document.getElementById('lf');
      linkForm.action = 'mailto:five@example.org';
      linkForm.submit();
      await sleep(200);
      const meta = document.createElement('meta');
      meta.httpEquiv = 'refresh';
      meta.content = '0;url=tel:+4930116';
      document.head.appendChild(meta);
      await sleep(500);
      send('synthetic-done', out);
    })();
  }

  if (mode === 'blank-click') {
    // Only that a paste reached the page, never what it carries.
    document.addEventListener('paste', (event) => { event.preventDefault(); send('paste-event', true); }, true);
    // The user clicks somewhere on the page for a reason of their own. The page then runs lines
    // of the menu bar they never picked.
    (async () => {
      await sleep(400);
      const lines = await menuLines();
      const byId = (id) => lines.find((line) => line.id === id && line.enabled);
      send('lines', lines.filter((line) => line.enabled).map((line) => line.id));
      window.addEventListener('click', async () => {
        const ran = {};
        for (const id of ['role.paste', 'view.zoomIn', 'role.selectall']) {
          const line = byId(id);
          ran[id] = !!line;
          if (line) run(line);
        }
        const docs = byId('help.docs');
        ran.docs = 0;
        if (docs) for (let n = 0; n < 8; n += 1) { run(docs); ran.docs += 1; }
        await sleep(400);
        send('blank-ran', ran);
      }, { once: true });
      send('ready', null);
    })();
  }

  if (mode === 'recent-each-click') {
    let busy = false;
    window.addEventListener('click', async () => {
      if (busy) return;
      busy = true;
      send('recent', await listed());
      busy = false;
    });
    send('ready', null);
  }

  if (mode === 'recent-two-on-one') {
    // After a yes: what one click is worth.
    let clicks = 0;
    let ids = [];
    window.addEventListener('click', async () => {
      clicks += 1;
      if (clicks === 1) {
        const first = await listed();
        ids = first.ok ? first.ids : [];
        const sameClick = ids.length ? await d.recentFiles.attach(ids[0]) : null;
        send('first-click', { list: first.ok, names: first.ok ? first.names.length : 0, attachOnSameClick: sameClick ? (sameClick.ok ? 'ok' : sameClick.reason) : 'none' });
      } else if (clicks === 2) {
        const one = ids[0] ? await d.recentFiles.attach(ids[0]) : null;
        const two = ids[1] ? await d.recentFiles.attach(ids[1]) : null;
        send('second-click', { one: one ? (one.ok ? 'ok' : one.reason) : 'none', two: two ? (two.ok ? 'ok' : two.reason) : 'none' });
      }
    });
    send('ready', null);
  }

  if (mode === 'mail-frame') {
    // An honest page: a mail body in a frame as the webmail frames it, with a phone link the
    // page hands to the shell on a click, and one that opens by itself.
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-same-origin allow-popups allow-popups-to-escape-sandbox');
    frame.style.cssText = 'position:absolute;left:0;top:0;width:320px;height:200px;border:0;background:#eef';
    frame.srcdoc = '<body style="margin:0"><a id="a" href="tel:+4930991" style="display:block;height:80px">call (page)</a><a id="b" href="tel:+4930992" target="_blank" style="display:block;height:80px">call (own)</a></body>';
    frame.addEventListener('load', () => {
      frame.contentDocument.getElementById('a').addEventListener('click', (event) => { event.preventDefault(); d.shell.openExternal(event.currentTarget.href); });
      send('ready', null);
    });
    document.body.appendChild(frame);
  }

  if (mode === 'key-pick') {
    // A menu the page draws, used with the keyboard: every key press runs Zoom in.
    (async () => {
      await sleep(400);
      const zoomIn = (await menuLines()).find((line) => line.id === 'view.zoomIn');
      window.addEventListener('keydown', async (event) => {
        if (zoomIn) run(zoomIn);
        await sleep(300);
        send('key-ran', event.key);
      });
      send('ready', null);
    })();
  }

  if (mode === 'paste-line' || mode === 'paste-late' || mode === 'paste-whole' || mode === 'paste-key') {
    // A line of the page's own Edit menu, drawn at a place it tells main about, and Paste run on
    // a click or a key. paste-line: said before the click, the click on the line. paste-late:
    // said only after the click. paste-whole: the whole window said to be the line. paste-key:
    // said before, Paste run on a key press.
    document.addEventListener('paste', (event) => { event.preventDefault(); send('paste-event', true); }, true);
    (async () => {
      await sleep(400);
      const paste = (await menuLines()).find((line) => line.id === 'role.paste' && line.enabled);
      const line = document.createElement('div');
      line.id = 'paste-line';
      line.textContent = 'Paste';
      line.style.cssText = 'position:fixed;left:40px;top:120px;width:240px;height:30px;background:#ddd;z-index:10';
      document.body.appendChild(line);
      const box = line.getBoundingClientRect();
      const said = mode === 'paste-whole'
        ? { x: 0, y: 0, width: innerWidth, height: innerHeight }
        : { x: box.left, y: box.top, width: box.width, height: box.height };
      const report = () => d.menu.bar.report({ height: 32, active: true, lines: [{ key: paste.key, label: paste.label, ...said }] });
      if (mode !== 'paste-late') report();
      const go = async () => {
        if (mode === 'paste-late') report();
        run(paste);
        await sleep(300);
        send('ran', null);
      };
      if (mode === 'paste-key') window.addEventListener('keydown', go, { once: true });
      else window.addEventListener('click', go, { once: true });
      send('ready', { found: !!paste, x: box.left + box.width / 2, y: box.top + box.height / 2 });
    })();
  }

  if (mode === 'letter-pick') {
    // Zoom in, run at every key press: by its own underlined letter, or by another.
    (async () => {
      await sleep(400);
      const zoomIn = (await menuLines()).find((line) => line.id === 'view.zoomIn');
      window.addEventListener('keydown', async (event) => {
        if (zoomIn) run(zoomIn);
        await sleep(300);
        send('key-ran', event.key);
      });
      send('ready', { letter: zoomIn && zoomIn.mnemonic !== undefined ? zoomIn.label[zoomIn.mnemonic].toLowerCase() : null });
    })();
  }

  if (mode === 'key-link') {
    // An honest page: a phone link that has the focus, for someone who uses the keyboard.
    const link = document.getElementById('l');
    link.href = 'tel:+4930555';
    link.focus();
    send('ready', document.activeElement === link);
  }

  if (mode === 'popups') {
    // No input. Web addresses first through the bridge until the limit, then through pop-ups.
    (async () => {
      await sleep(400);
      for (let n = 1; n <= 7; n += 1) d.shell.openExternal('https://127.0.0.1:1/own-' + n);
      await sleep(300);
      const made = [];
      for (let p = 1; p <= 3; p += 1) {
        let child = null;
        try { child = window.open('about:blank', 'popup-' + p, 'width=200,height=200'); } catch {}
        made.push(!!child);
        if (!child) continue;
        await sleep(300);
        for (let n = 1; n <= 2; n += 1) {
          try { child.location.href = 'https://127.0.0.1:1/popup-' + p + '-' + n; } catch {}
          await sleep(250);
        }
      }
      await sleep(300);
      send('popups-done', made);
    })();
  }
})();
`;

const page = (mode: InputMode) => `<!doctype html><html data-mode="${mode}"><head><meta charset="utf-8"><title>Mail - Bulwark</title>
<style>:root{--titlebar-right-inset:140px}html,body{margin:0;height:100%;font:15px system-ui}</style></head>
<body><main style="padding:340px 24px 0"><h1>Inbox</h1><p>An ordinary-looking page.</p>
<form id="f" onsubmit="return false"><button id="b" type="submit" autofocus>ok</button></form>
<form id="lf" method="get"></form><a id="l" href="#">link</a></main>
<script src="/payload.js"></script></body></html>`;

export async function startInputInstance(port: number): Promise<InputInstance> {
  const certificate = generateCertificate('localhost');
  const state: InputInstance = { origin: '', mode: 'idle', loot: [], close: () => {} };
  const server: Server = createServer({ key: certificate.keyPem, cert: certificate.certPem }, (req, res) => {
    const url = new URL(req.url ?? '/', 'https://localhost');
    if (url.pathname === '/api/config') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ appName: 'Bulwark', jmapServerUrl: 'https://mail.example.invalid' }));
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
