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
  | 'paste-own-button'
  | 'paste-bar-row'
  | 'paste-spellings'
  | 'paste-down'
  | 'tap'
  | 'letter-pick'
  | 'edit-later'
  | 'edit-type'
  | 'edit-scripted';

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
        // A tap as a script can make one: touch events (bare ones where there is no touch screen
        // to bring their constructors), the pointer events and click of a finger, and events
        // named like the gesture.
        tap: () => {
          const touchEvent = (type) => {
            try {
              const point = new Touch({ identifier: 1, target: button, clientX: 10, clientY: 10 });
              const down = type === 'touchstart' ? [point] : [];
              return new TouchEvent(type, { bubbles: true, cancelable: true, touches: down, targetTouches: down, changedTouches: [point] });
            } catch {
              return new Event(type, { bubbles: true, cancelable: true });
            }
          };
          for (const type of ['touchstart', 'touchend']) button.dispatchEvent(touchEvent(type));
          for (const type of ['pointerdown', 'pointerup', 'click']) button.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: true, button: 0, clientX: 10, clientY: 10 }));
          for (const type of ['gesturetap', 'gestureTap', 'tap']) button.dispatchEvent(new Event(type, { bubbles: true }));
        },
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
      // Whatever main lists, greyed or not: the page runs it anyway.
      const byId = (id) => lines.find((line) => line.id === id);
      send('lines', lines.map((line) => line.id));
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
    // a click or a key, greyed in main's list or not. paste-line: said before the click, the
    // click on the line. paste-late: said only after the click. paste-whole: the whole window
    // said to be the line. paste-key: said before, Paste run on a key press.
    document.addEventListener('paste', (event) => { event.preventDefault(); send('paste-event', true); }, true);
    (async () => {
      await sleep(400);
      const paste = (await menuLines()).find((line) => line.id === 'role.paste');
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

  if (mode === 'paste-own-button' || mode === 'paste-bar-row' || mode === 'paste-spellings' || mode === 'paste-down') {
    // More of the same: where, under which name and when the page says its Paste line is.
    // Only that a paste reached the page. The event is cancelled and what it carries is never touched.
    let pastes = 0;
    document.addEventListener('paste', (event) => { event.preventDefault(); pastes += 1; send('paste-event', true); }, true);
    (async () => {
      await sleep(400);
      const paste = (await menuLines()).find((line) => line.id === 'role.paste');

      if (mode === 'paste-own-button') {
        // The page's own button, and the Paste line said to be exactly where the button is.
        const button = document.createElement('button');
        button.id = 'own';
        button.textContent = 'Continue';
        button.style.cssText = 'position:fixed;left:300px;top:400px;width:200px;height:44px;z-index:10';
        document.body.appendChild(button);
        const box = button.getBoundingClientRect();
        d.menu.bar.report({ height: 32, active: true, lines: [{ key: paste.key, label: paste.label, x: box.left, y: box.top, width: box.width, height: box.height }] });
        button.addEventListener('click', async () => {
          run(paste);
          await sleep(300);
          send('ran', null);
        });
        send('ready', { found: !!paste, x: box.left + box.width / 2, y: box.top + box.height / 2 });
      }

      if (mode === 'paste-bar-row') {
        // The bar said to be a hundredth of a pixel high, and the Paste line said to be in the
        // top row of the window, where the bar is drawn.
        const strip = document.createElement('div');
        strip.id = 'strip';
        strip.textContent = 'File  Edit  View';
        strip.style.cssText = 'position:fixed;left:0;top:0;width:500px;height:32px;background:#ddd;z-index:10';
        document.body.appendChild(strip);
        d.menu.bar.report({ height: 0.01, active: true, lines: [{ key: paste.key, label: paste.label, x: 200, y: 2, width: 200, height: 28 }] });
        strip.addEventListener('click', async () => {
          run(paste);
          await sleep(300);
          send('ran', null);
        });
        send('ready', { found: !!paste, x: 300, y: 16 });
      }

      if (mode === 'paste-spellings') {
        // The window below the bar's row, covered with line-sized rectangles, each under another
        // spelling of the Paste line's key. Whatever the user clicks, the page runs that spelling.
        const parts = paste.key.split('/');
        const spell = (n) => [n, '0' + n, n + '.0', '+' + n, ' ' + n, n + ' ', n + 'e0', '0x' + Number(n).toString(16), '00' + n, n + '.00', '000' + n, '0o' + Number(n).toString(8)];
        const keys = [];
        for (const a of spell(parts[0])) for (const b of spell(parts[1])) keys.push([a, b, ...parts.slice(2)].join('/'));
        const W = 600, H = 64, TOP = 32;
        const tiles = [];
        const RIGHT = innerWidth - 2, BOTTOM = innerHeight - 2;
        for (let y = TOP; y < BOTTOM - 8 && tiles.length < 100; y += H) {
          for (let x = 0; x < RIGHT - 8 && tiles.length < 100; x += W) {
            tiles.push({ key: keys[tiles.length], label: paste.label, x, y, width: Math.min(W, RIGHT - x), height: Math.min(H, BOTTOM - y) });
          }
        }
        d.menu.bar.report({ height: TOP, active: true, lines: tiles });
        window.addEventListener('click', async (event) => {
          const tile = tiles.find((t) => event.clientX >= t.x && event.clientX < t.x + t.width && event.clientY >= t.y && event.clientY < t.y + t.height);
          if (tile) d.menu.bar.run(tile.key, tile.label);
          await sleep(300);
          send('clicked', { x: event.clientX, y: event.clientY, tile: tile ? tile.key : null, pastes });
        });
        send('ready', { found: !!paste, key: paste.key, tiles: tiles.length, width: innerWidth, height: innerHeight });
      }

      if (mode === 'paste-down') {
        // Nothing said in advance. When the button goes down the page says the Paste line is
        // under the pointer; when it comes up the page runs Paste.
        window.addEventListener('mousedown', (event) => {
          const x = Math.max(0, event.clientX - 20);
          const y = Math.max(33, event.clientY - 20);
          d.menu.bar.report({ height: 32, active: true, lines: [{ key: paste.key, label: paste.label, x, y, width: 40, height: 40 }] });
        }, true);
        window.addEventListener('click', async (event) => {
          run(paste);
          await sleep(300);
          send('clicked', { x: event.clientX, y: event.clientY });
        });
        send('ready', { found: !!paste });
      }
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

  if (mode === 'tap') {
    // A page used with a finger: a line of the drawn menu that runs Zoom in when it's clicked,
    // and a phone link. And a part of the page that runs the line and hands a phone link to
    // the shell whenever a finger is lifted from it, tap or not.
    (async () => {
      await sleep(400);
      const zoomIn = (await menuLines()).find((line) => line.id === 'view.zoomIn');
      const line = document.createElement('div');
      line.id = 'tap-line';
      line.textContent = 'Zoom in';
      line.style.cssText = 'position:fixed;left:40px;top:120px;width:240px;height:40px;background:#ddd;z-index:10';
      document.body.appendChild(line);
      const link = document.createElement('a');
      link.id = 'tap-link';
      link.href = 'tel:+4930777';
      link.textContent = 'call';
      link.style.cssText = 'position:fixed;left:40px;top:220px;width:240px;height:40px;background:#dde;z-index:10';
      document.body.appendChild(link);
      line.addEventListener('click', async (event) => {
        if (zoomIn) run(zoomIn);
        await sleep(300);
        send('tapped', { pointerType: event.pointerType ?? null });
      });
      const pad = document.createElement('div');
      pad.id = 'pad';
      pad.style.cssText = 'position:fixed;left:400px;top:300px;width:300px;height:300px;background:#eee;z-index:10';
      document.body.appendChild(pad);
      const lifted = async (event) => {
        if (zoomIn) run(zoomIn);
        d.shell.openExternal('tel:+4930778');
        await sleep(300);
        send('lifted', event.type);
      };
      pad.addEventListener('touchend', lifted);
      pad.addEventListener('touchcancel', lifted);
      send('ready', { line: [160, 140], link: [160, 240], pad: [550, 450] });
    })();
  }

  if (mode === 'edit-later' || mode === 'edit-type' || mode === 'edit-scripted') {
    // A page that asks main for the Edit menu (menu.bar.open) at moments of its own. Something
    // of its own in the window's top row, drawn like a title bar with a search field. Only that
    // a paste reached the page: the event is cancelled and what it carries is never touched.
    document.addEventListener('paste', (event) => { event.preventDefault(); send('paste-event', true); }, true);
    const openEdit = (why) => { d.menu.bar.open('edit', { x: 5, y: 5 }); send('asked', why); };
    const strip = document.createElement('div');
    strip.id = 'strip';
    strip.style.cssText = 'position:fixed;left:0;top:0;width:900px;height:40px;background:#e8e8e8;z-index:10';
    const field = document.createElement('input');
    field.id = 'top-field';
    field.placeholder = 'Search mail';
    field.style.cssText = 'position:absolute;left:180px;top:6px;width:320px;height:26px';
    strip.appendChild(field);
    document.body.appendChild(strip);

    if (mode === 'edit-later') {
      // A press in the top row. The page asks for the Edit menu only once the pointer has gone
      // down the page, to a button it drew there, within a second of the press.
      const button = document.createElement('button');
      button.id = 'continue';
      button.textContent = 'Continue';
      button.style.cssText = 'position:fixed;left:230px;top:170px;width:200px;height:30px;z-index:10';
      document.body.appendChild(button);
      let pressedAt = 0;
      let asked = false;
      window.addEventListener('mousedown', (event) => { if (event.clientY < 40) { pressedAt = performance.now(); asked = false; } }, true);
      window.addEventListener('mousemove', (event) => {
        if (!pressedAt || asked) return;
        const since = performance.now() - pressedAt;
        if (since < 950 && event.clientY > 150) {
          asked = true;
          openEdit({ since: Math.round(since), x: event.clientX, y: event.clientY, buttons: event.buttons });
        }
      }, true);
      send('ready', { button: [330, 185] });
    }

    if (mode === 'edit-type') {
      // A click into the search field asks for the Edit menu right away; the user then types.
      field.addEventListener('mousedown', () => openEdit({ on: 'field' }), true);
      field.addEventListener('keydown', (event) => send('typed', event.key));
      send('ready', { field: [340, 19] });
    }

    if (mode === 'edit-scripted') {
      // No real input: Alt+E, a press in the top row and a click on the field, each made by a
      // script, each followed by a call for the Edit menu.
      (async () => {
        await sleep(400);
        const out = {};
        for (const type of ['keydown', 'keyup']) document.dispatchEvent(new KeyboardEvent(type, { bubbles: true, key: 'Alt', code: 'AltLeft', altKey: type === 'keydown' }));
        for (const type of ['keydown', 'keypress', 'keyup']) document.dispatchEvent(new KeyboardEvent(type, { bubbles: true, key: 'e', code: 'KeyE', altKey: true, keyCode: 69 }));
        d.menu.bar.open('edit', { x: 5, y: 5 });
        out.altE = true;
        await sleep(300);
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) field.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: 200, clientY: 12, view: window }));
        d.menu.bar.open('edit', { x: 5, y: 5 });
        out.mouse = true;
        await sleep(300);
        field.click();
        field.focus();
        d.menu.bar.open('edit', { x: 5, y: 5 });
        out.click = true;
        await sleep(300);
        send('scripted-done', out);
      })();
    }
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
