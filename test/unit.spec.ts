import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createHttpsServer, request } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { fingerprintOf, generateCertificate } from '../src/main/cert';
import { externalOpenAllowed, isJmapProxyPath, isSsoStart, looksLikeProviderLogout, parse, shownHost, SHOWN_HOST_MAX, UNCLICKED_OPEN_MAX, UNCLICKED_OPEN_MS } from '../src/main/navigation-rules';
import { isPrivateAddress, isPrivateHost, isRealHostname, serverOrigin } from '../src/main/server-address';
import { CorsInjector } from '../src/main/cors';
import { pluginFacts, pluginPrompt, type PromptText } from '../src/main/plugin-prompt';
import { serverEnv, profilePaths } from '../src/main/profile';
import { findHomePaths, findProblems, guardPackage, scrubPaths } from '../scripts/package-guard.mjs';
import { cascadeFrom, centreIn, CASCADE_PX, isOnSomeDisplay, placeWindow } from '../src/main/window-placement';
import { forwardJmap, isJmapRoute, parseJmapRoute, safeContentType } from '../src/server/jmap-proxy';
import { isAdminLogin, isImageOptimizer, sanitizeRequest } from '../src/server/sanitize';

const HOST = 'app.bulwark.localhost';
const display = (x: number, y: number, width = 1920, height = 1040) => ({ workArea: { x, y, width, height } });

test.describe('certificate made with Node only', () => {
  test('parses as X.509 for our name, valid today', () => {
    const { certPem } = generateCertificate(HOST);
    const cert = new X509Certificate(certPem);
    expect(cert.subjectAltName).toBe(`DNS:${HOST}`);
    expect(new Date(cert.validFrom).getTime()).toBeLessThan(Date.now());
    expect(new Date(cert.validTo).getTime()).toBeGreaterThan(Date.now() + 365 * 86400_000);
    expect(cert.checkHost(HOST)).toBe(HOST);
    expect(cert.verify(cert.publicKey)).toBe(true);
  });

  test('a TLS server runs on it, and pinning the certificate as the only CA connects', async () => {
    const { keyPem, certPem } = generateCertificate(HOST);
    const server = createHttpsServer({ key: keyPem, cert: certPem }, (_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const body = await new Promise<string>((resolve, reject) => {
      request({ host: '127.0.0.1', port, servername: HOST, ca: certPem, headers: { host: HOST } }, (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve(text));
      }).on('error', reject).end();
    });
    server.close();
    expect(body).toBe('ok');
  });

  test('another certificate does not pass the pin', async () => {
    const mine = generateCertificate(HOST);
    const other = generateCertificate(HOST);
    expect(fingerprintOf(mine.certPem)).not.toBe(fingerprintOf(other.certPem));
    const server = createHttpsServer({ key: other.keyPem, cert: other.certPem }, (_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const code = await new Promise<string>((resolve) => {
      request({ host: '127.0.0.1', port, servername: HOST, ca: mine.certPem }, () => resolve('connected'))
        .on('error', (error: NodeJS.ErrnoException) => resolve(error.code ?? 'error'))
        .end();
    });
    server.close();
    expect(code).not.toBe('connected');
  });
});

test.describe('window placement', () => {
  const size = { width: 800, height: 600 };

  test('a stored position on a monitor that is gone is not used', () => {
    const stored = { x: 3000, y: 200, width: 800, height: 600 };
    expect(isOnSomeDisplay(stored, [display(0, 0)])).toBe(false);
    const placed = placeWindow({ size, stored, displays: [display(0, 0)], current: display(0, 0) });
    expect(placed.x).toBeLessThan(1920);
    expect(placed).toEqual(centreIn(size, display(0, 0).workArea));
  });

  test('a stored position on a second monitor that is still there is kept', () => {
    const stored = { x: 2200, y: 200, width: 800, height: 600 };
    const placed = placeWindow({ size, stored, displays: [display(0, 0), display(1920, 0)], current: display(0, 0) });
    expect(placed).toEqual(stored);
  });

  test('a stored window with its top strip off every screen is not used', () => {
    // Only the bottom of the window is on the monitor: nothing to grab it by.
    const stored = { x: 100, y: -500, width: 800, height: 600 };
    expect(isOnSomeDisplay(stored, [display(0, 0)])).toBe(false);
    const placed = placeWindow({ size, stored, displays: [display(0, 0)], current: display(0, 0) });
    expect(placed.y).toBeGreaterThanOrEqual(0);
  });

  test('a stored window is fitted when its monitor has shrunk', () => {
    const stored = { x: 100, y: 100, width: 1800, height: 1000 };
    const small = display(0, 0, 1280, 720);
    const placed = placeWindow({ size, stored, displays: [small], current: small });
    expect(placed.x + placed.width).toBeLessThanOrEqual(1280);
    expect(placed.y + placed.height).toBeLessThanOrEqual(720);
  });

  test('new windows of a type cascade from the last one', () => {
    const sameType = { x: 100, y: 100, width: 800, height: 600 };
    const placed = placeWindow({ size, sameType, anchor: sameType, displays: [display(0, 0)], current: display(0, 0) });
    expect(placed).toEqual({ x: 100 + CASCADE_PX, y: 100 + CASCADE_PX, width: 800, height: 600 });
  });

  test('the cascade wraps at the edge rather than walk off the screen', () => {
    const area = display(0, 0).workArea;
    const placed = cascadeFrom({ x: 1600, y: 800, width: 800, height: 600 }, size, area);
    expect(placed.x + placed.width).toBeLessThanOrEqual(1920);
    expect(placed.y + placed.height).toBeLessThanOrEqual(1040);
  });

  test('a new window opens on the monitor in use, not where its type last was', () => {
    const stored = { x: 100, y: 100, width: 800, height: 600 };
    const anchor = { x: 2100, y: 100, width: 1000, height: 800 };
    const placed = placeWindow({ size, stored, anchor, displays: [display(0, 0), display(1920, 0)], current: display(1920, 0) });
    expect(placed.x).toBeGreaterThanOrEqual(1920);
  });

  test('never larger than the monitor', () => {
    const placed = placeWindow({ size: { width: 4000, height: 3000 }, displays: [display(0, 0)], current: display(0, 0) });
    expect(placed.width).toBeLessThanOrEqual(1920);
    expect(placed.height).toBeLessThanOrEqual(1040);
  });
});

test.describe('server addresses', () => {
  for (const address of ['10.1.2.3', '127.0.0.1', '192.168.1.5', '172.16.0.1', '169.254.169.254', '100.64.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1']) {
    test(`${address} is private`, () => expect(isPrivateAddress(address)).toBe(true));
  }
  for (const address of ['62.176.249.204', '8.8.8.8', '2a01:584:3e::20']) {
    test(`${address} is public`, () => expect(isPrivateAddress(address)).toBe(false));
  }

  test('the names the webmail refuses are private too, so they get the prompt', async () => {
    for (const host of ['localhost', 'mail.local', 'mail.internal', 'x.localhost', 'mail.localdomain', '[::1]']) {
      expect(await isPrivateHost(host), host).toBe(true);
    }
  });

  test('wildcards and other non-names are no server, though the URL parser takes them', () => {
    for (const url of ['https://*', 'https://*.example.org', 'https://a*b.com', 'https://exa mple.org', 'https://%2A.example.org', 'https://-bad.example.org']) {
      expect(serverOrigin(url), url).toBeNull();
    }
    for (const host of ['mail.example.org', 'localhost', '192.168.1.5', '[::1]', 'xn--bcher-kva.example']) {
      expect(isRealHostname(host), host).toBe(true);
    }
    expect(serverOrigin('https://[::1]:8443/')).toBe('https://[::1]:8443');
    expect(serverOrigin('https://BÜCHER.example/')).toBe('https://xn--bcher-kva.example');
  });

  test('serverOrigin refuses what the login routes would', () => {
    expect(serverOrigin('https://mail.example:8443/jmap')).toBe('https://mail.example:8443');
    expect(serverOrigin('http://192.168.1.5:8080/')).toBe('http://192.168.1.5:8080');
    expect(serverOrigin('ftp://mail.example')).toBeNull();
    expect(serverOrigin('https://user:pw@mail.example')).toBeNull();
    expect(serverOrigin('nonsense')).toBeNull();
    expect(serverOrigin(42)).toBeNull();
  });
});

test.describe('navigation rules', () => {
  const origin = 'https://mail.example.org';

  test('an authorize request back to the instance starts the SSO chain', () => {
    const url = new URL(`https://idp.example/authorize?client_id=x&redirect_uri=${encodeURIComponent(`${origin}/en/auth/callback`)}`);
    expect(isSsoStart(url, origin)).toBe(true);
  });

  test('a link that names another redirect does not', () => {
    const url = new URL('https://evil.example/authorize?redirect_uri=https://evil.example/cb');
    expect(isSsoStart(url, origin)).toBe(false);
    expect(isSsoStart(new URL('https://example.com/page'), origin)).toBe(false);
  });

  test('the forwarding route is recognised, also after the URL parser tidied it', () => {
    expect(isJmapProxyPath(new URL('https://a/__jmap/x/y').pathname)).toBe(true);
    expect(isJmapProxyPath(new URL('https://a/en/../__jmap/x').pathname)).toBe(true);
    expect(isJmapProxyPath(new URL('https://a/__jmap').pathname)).toBe(true);
    expect(isJmapProxyPath(new URL('https://a/__jmapper').pathname)).toBe(false);
    expect(isJmapProxyPath(new URL('https://a/en/mail').pathname)).toBe(false);
  });

  test('provider logout URLs are recognised', () => {
    expect(looksLikeProviderLogout(new URL('https://idp.example/oidc/logout?client_id=x'))).toBe(true);
    expect(looksLikeProviderLogout(new URL('https://idp.example/x?id_token_hint=abc'))).toBe(true);
    expect(looksLikeProviderLogout(new URL('https://idp.example/end_session'))).toBe(true);
    expect(looksLikeProviderLogout(new URL('https://example.com/about'))).toBe(false);
  });

  test('which addresses go to another program, with a click and without one', () => {
    const decide = (url: string, clicked: boolean, recent = 0) => externalOpenAllowed(parse(url), clicked, recent);
    // Web addresses: on a click, and without one only while the window's last ten seconds hold fewer than five.
    for (const url of ['https://example.org/', 'http://example.org/']) {
      expect(decide(url, true, UNCLICKED_OPEN_MAX), url).toBe(true);
      expect(decide(url, false, 0), url).toBe(true);
      expect(decide(url, false, UNCLICKED_OPEN_MAX - 1), url).toBe(true);
      expect(decide(url, false, UNCLICKED_OPEN_MAX), url).toBe(false);
    }
    expect(UNCLICKED_OPEN_MAX).toBe(5);
    expect(UNCLICKED_OPEN_MS).toBe(10_000);
    // Mail, phone, text and calendar: on a click only, upper case as lower.
    for (const url of ['mailto:a@example.org', 'MAILTO:a@example.org', 'tel:+4912345', 'sms:+4912345', 'webcal://example.org/c.ics']) {
      expect(decide(url, true), url).toBe(true);
      expect(decide(url, false), url).toBe(false);
    }
    // Everything else never, nor an address with a user name or password in it.
    for (const url of ['xmpp:a@example.org', 'file:///C:/x', 'ms-msdt:x', 'search-ms:x', 'bulwark://x', 'javascript:1', 'https://user@example.org/', 'https://user:secret@example.org/', 'webcal://user@example.org/c.ics', 'not a url']) {
      expect(decide(url, true), url).toBe(false);
      expect(decide(url, false), url).toBe(false);
    }
  });

  test('a question names a long server by the end that says whose it is, shortened in the middle of the left-hand part', () => {
    // As short as a question needs: whole.
    for (const host of ['mail.example.org', 'localhost:3947', 'xn--pple-43d.localhost:3947', '192.168.1.10:8080', '[2001:db8::1]:8443']) expect(shownHost(host)).toBe(host);
    // A name that starts like a trusted one and ends in another domain.
    const long = `mail.example.com.${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.evil-domain.localhost:3947`;
    const shown = shownHost(long);
    expect(shown.length).toBeLessThanOrEqual(SHOWN_HOST_MAX);
    expect(shown.endsWith('.evil-domain.localhost:3947'), shown).toBe(true);
    expect(shown.startsWith('mail.'), shown).toBe(true);
    expect(shown.split('…')).toHaveLength(2);
    // Three labels under a country code with a short second level, punycode as it is.
    expect(shownHost(`${'x'.repeat(70)}.mail.example.co.uk`).endsWith('.example.co.uk')).toBe(true);
    expect(shownHost(`${'a'.repeat(70)}.xn--pple-43d.com`).endsWith('.xn--pple-43d.com')).toBe(true);
    // An end longer than the room there is: all of it, and nothing of the left.
    const wide = `www.${'c'.repeat(63)}.com:8443`;
    expect(shownHost(wide)).toBe(`….${'c'.repeat(63)}.com:8443`);
    // Whatever the length on the left, the end stays whole.
    for (let n = 1; n <= 200; n += 37) expect(shownHost(`${'q'.repeat(n)}.mail.evil.example`).endsWith('.evil.example')).toBe(true);
  });
});

test.describe('the CORS list', () => {
  function fakeSession() {
    const installed: (string[] | null)[] = [];
    const session = {
      webRequest: {
        onHeadersReceived(filter: { urls: string[] } | null, listener?: unknown) {
          if (filter === null) {
            installed.push(null);
            return;
          }
          // What Electron does with a pattern it can't parse.
          for (const url of filter.urls) if (url.includes('*.') || /a\*b/.test(url)) throw new TypeError(`Invalid url pattern ${url}`);
          if (listener) installed.push(filter.urls);
        },
      },
    };
    return { session: session as never, installed };
  }

  test('one pattern Electron refuses does not take the others down, or throw', () => {
    const { session, installed } = fakeSession();
    const cors = new CorsInjector(session, 'https://app.example');
    expect(() => cors.set(['https://good.example', 'https://a*b.com', 'https://also-good.example'])).not.toThrow();
    expect(installed.at(-1)).toEqual(['https://good.example/*', 'https://also-good.example/*']);
  });

  test('removing the last one removes the listener', () => {
    const { session, installed } = fakeSession();
    const cors = new CorsInjector(session, 'https://app.example');
    cors.add('https://good.example');
    cors.remove('https://good.example');
    expect(installed.at(-1)).toBeNull();
  });
});

test.describe('the utilityProcess env', () => {
  test('is an allowlist: nothing from the user\'s environment and no secret', () => {
    const env = serverEnv(
      profilePaths('C:\\ud'),
      { PATH: 'x', SystemRoot: 'y', REDIS_URL: 'redis://x', DEMO_MODE: 'true', JMAP_SERVER_URL: 'https://x', NODE_OPTIONS: '--inspect', HOSTNAME: 'x', SESSION_SECRET: 'env-secret', ADMIN_PASSWORD: 'env-password', OTEL_EXPORTER: 'x' } as never,
      'win32',
    );
    for (const name of ['REDIS_URL', 'DEMO_MODE', 'JMAP_SERVER_URL', 'NODE_OPTIONS', 'HOSTNAME', 'SESSION_SECRET', 'ADMIN_PASSWORD', 'OTEL_EXPORTER', 'PORT']) {
      expect(env[name], name).toBeUndefined();
    }
    expect(env.PATH).toBe('x');
    expect(env.BULWARK_UPDATE_CHECK).toBe('off');
  });
});

test.describe('the package guard', () => {
  function tree(files: Record<string, string>): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'bw-pack-'));
    for (const [name, body] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      writeFileSync(path.join(dir, name), body);
    }
    return dir;
  }

  test('fails on a planted signing key, a data folder and an env file', () => {
    expect(findProblems(tree({ 'server.js': '', 'data/admin/plugin-signing.key': 'x', '.env': 'x', 'public/plugin-signing.key': 'x' }))).toEqual([
      '.env',
      'data/',
      'public/plugin-signing.key',
    ]);
    expect(() => guardPackage(tree({ 'server.js': '', 'data/x': 'x' }))).toThrow(/Do not ship/);
  });

  test('leaves packages and route folders alone', () => {
    expect(findProblems(tree({ 'server.js': '', 'node_modules/x/data/t.json': '{}', '.next/server/app/api/data/route.js': '' }))).toEqual([]);
  });

  test('removes Next\'s cache', () => {
    const dir = tree({ 'server.js': '', '.next/cache/x': 'x', '.next/BUILD_ID': 'x' });
    guardPackage(dir, { warn: () => {} });
    expect(existsSync(path.join(dir, '.next', 'cache'))).toBe(false);
    expect(existsSync(path.join(dir, '.next', 'BUILD_ID'))).toBe(true);
  });

  test('takes the recorded build paths out, in every spelling', () => {
    const dir = tree({
      '.next/required-server-files.json': JSON.stringify({ config: { outputFileTracingRoot: 'C:/Users/dev', turbopack: { root: 'C:/Users/dev' } }, appDir: 'C:\\\\Users\\\\dev\\\\wt' }),
      '.next/server/chunks/1.js': 'a="C:\\\\Users\\\\dev\\\\wt";b="C:/Users/dev/wt"',
    });
    expect(scrubPaths(dir)).toBe(2);
    const chunk = readFileSync(path.join(dir, '.next/server/chunks/1.js'), 'utf8');
    expect(chunk).not.toContain('dev');
    expect(chunk).toContain('/bulwark-build');
    JSON.parse(readFileSync(path.join(dir, '.next/required-server-files.json'), 'utf8'));
  });

  test('warns about a home folder that is still in there', () => {
    const dir = tree({ '.next/server/chunks/1.js': 'a="D:/Home/dev/x"' });
    expect(findHomePaths(dir, 'D:\\Home\\dev')).toEqual(['.next/server/chunks/1.js']);
    const warnings: string[] = [];
    guardPackage(tree({ 'server.js': '' }), { warn: (m: string) => warnings.push(m) });
    expect(warnings).toEqual([]);
  });
});

test.describe('request sanitising', () => {
  function requestWith(headers: Record<string, string>): IncomingMessage {
    const raw: string[] = [];
    for (const [name, value] of Object.entries(headers)) raw.push(name, value);
    return { headers: { ...headers }, rawHeaders: raw } as unknown as IncomingMessage;
  }

  test('removes what page script can forge, and sets the real values', () => {
    const req = requestWith({
      host: 'evil.example',
      'x-bulwark-launch': 'secret',
      'x-bulwark-main': 'main-secret',
      'x-forwarded-for': '6.6.6.6',
      'x-forwarded-host': 'evil.example',
      'x-forwarded-proto': 'http',
      'x-forwarded-port': '1',
      'x-middleware-subrequest': 'middleware:middleware',
      'x-real-ip': '6.6.6.6',
      forwarded: 'for=6.6.6.6',
      cookie: 'kept=1',
      'sec-fetch-site': 'same-origin',
    });
    sanitizeRequest(req);
    expect(req.headers).toEqual({
      host: HOST,
      cookie: 'kept=1',
      'sec-fetch-site': 'same-origin',
      'x-forwarded-host': HOST,
      'x-forwarded-proto': 'https',
      'x-forwarded-for': '127.0.0.1',
    });
    expect(req.rawHeaders).not.toContain('secret');
    expect(req.rawHeaders).not.toContain('main-secret');
    expect(req.rawHeaders).not.toContain('6.6.6.6');
  });
});

test.describe('the image optimizer', () => {
  test('is recognised however it is spelled, and nothing else is', () => {
    for (const url of ['/_next/image', '/_next/image?url=%2Fa.png&w=64&q=75', '//_next//image', '/_next/%69mage', '/_NEXT/image/']) {
      expect(isImageOptimizer(url), url).toBe(true);
    }
    for (const url of ['/_next/./image?url=x', '/_next/static/../image']) expect(isImageOptimizer(url), url).toBe(true);
    for (const url of ['/_next/static/chunks/image.js', '/_next/images', '/api/og-image', undefined]) {
      expect(isImageOptimizer(url), String(url)).toBe(false);
    }
  });
});

test.describe('the admin login route', () => {
  test('is recognised however it is spelled, reading its status is not', () => {
    for (const url of [
      '/api/admin/auth', '/api/admin/auth/', '//api//admin/auth', '/api/admin/%61uth', '/API/admin/auth?x=1',
      // Next resolves these before it routes, so they reach the login.
      '/api/admin/./auth', '/api/admin/x/../auth', '/_next/../api/admin/auth', '/api/admin/%2e/auth', '/api/admin/x/%2E%2E/auth',
      '/api\\admin\\auth', 'https://app.bulwark.localhost/api/admin/auth', 'http://x/api/admin/auth',
    ]) {
      expect(isAdminLogin('POST', url), url).toBe(true);
    }
    expect(isAdminLogin('GET', '/api/admin/auth')).toBe(false);
    expect(isAdminLogin('GET', '/api/admin/./auth')).toBe(false);
    expect(isAdminLogin('POST', '/api/admin/plugins')).toBe(false);
    expect(isAdminLogin('POST', '/api/admin/auth/../plugins')).toBe(false);
  });
});

test.describe('/__jmap route', () => {
  let upstream: Server;
  let origin = '';
  const seen: { url: string; method: string; headers: IncomingMessage['headers']; body: string }[] = [];

  test.beforeAll(async () => {
    upstream = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        seen.push({ url: req.url ?? '', method: req.method ?? '', headers: req.headers, body: Buffer.concat(chunks).toString() });
        if (req.url === '/.well-known/jmap') {
          res.writeHead(307, { location: '/jmap/session' }).end();
          return;
        }
        if (req.url === '/redirect-out') {
          res.writeHead(302, { location: 'http://unapproved.invalid/steal' }).end();
          return;
        }
        if (req.url === '/redirect-post') {
          res.writeHead(307, { location: '/jmap/' }).end();
          return;
        }
        if (req.url === '/html') {
          res.writeHead(200, { 'content-type': 'text/html', 'content-disposition': 'inline', 'access-control-allow-origin': '*', 'content-security-policy': "default-src *" });
          res.end('<script>steal()</script>');
          return;
        }
        if (req.url === '/stream') {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('data: one\n\n');
          setTimeout(() => {
            res.write('data: two\n\n');
            res.end();
          }, 200);
          return;
        }
        res.writeHead(200, {
          'content-type': 'application/json',
          'set-cookie': 'upstream=1',
          'www-authenticate': 'Basic realm=x',
        });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  });

  test.afterAll(() => {
    upstream.close();
    upstream.closeAllConnections();
  });

  const idOf = (value: string) => Buffer.from(value).toString('base64url');

  const PAGE_FETCH = { 'sec-fetch-dest': 'empty', 'sec-fetch-site': 'same-origin' };

  async function through(url: string, init: RequestInit & { headers?: Record<string, string> } = {}, trusted = true, sentFrom: Record<string, string> = PAGE_FETCH) {
    init = { ...init, headers: { ...sentFrom, ...init.headers } };
    const server = createHttpServer((req, res) => {
      void forwardJmap(req, res, (candidate) => trusted && candidate === origin);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const response = await fetch(address + url, init);
      return { status: response.status, headers: response.headers, text: await response.text() };
    } finally {
      server.close();
      server.closeAllConnections();
    }
  }

  test('a server that is not approved gets nothing', async () => {
    const before = seen.length;
    const answer = await through(`/__jmap/${idOf(origin)}/jmap/`, {}, false);
    expect(answer.status).toBe(403);
    expect(seen.length).toBe(before);
  });

  test('forwards with the path, and follows the discovery redirect', async () => {
    const answer = await through(`/__jmap/${idOf(origin)}/.well-known/jmap`);
    expect(answer.status).toBe(200);
    expect(seen.at(-1)?.url).toBe('/jmap/session');
    expect(JSON.parse(answer.text)).toEqual({ ok: true });
  });

  test('the app\'s cookies never reach the mail server, and its cookies never reach the app', async () => {
    const answer = await through(`/__jmap/${idOf(origin)}/jmap/`, {
      method: 'POST',
      body: '{"using":[]}',
      headers: { authorization: 'Basic abc', cookie: 'jmap_session=secret', origin: 'https://app.bulwark.localhost', 'content-type': 'application/json' },
    });
    const sent = seen.at(-1)!;
    expect(sent.method).toBe('POST');
    expect(sent.body).toBe('{"using":[]}');
    expect(sent.headers.authorization).toBe('Basic abc');
    expect(sent.headers.cookie).toBeUndefined();
    expect(sent.headers.origin).toBeUndefined();
    expect(answer.headers.get('set-cookie')).toBeNull();
    expect(answer.headers.get('www-authenticate')).toBeNull();
  });

  test('the push stream arrives piece by piece', async () => {
    const server = createHttpServer((req, res) => {
      void forwardJmap(req, res, (candidate) => candidate === origin);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const response = await fetch(`${address}/__jmap/${idOf(origin)}/stream`, { headers: PAGE_FETCH });
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain('one');
    expect(first).not.toContain('two');
    await reader.cancel();
    server.close();
    server.closeAllConnections();
  });

  for (const [what, headers] of [
    ['a navigation', { 'sec-fetch-dest': 'document', 'sec-fetch-site': 'same-origin' }],
    ['a frame', { 'sec-fetch-dest': 'iframe', 'sec-fetch-site': 'same-origin' }],
    ['a worker script', { 'sec-fetch-dest': 'worker', 'sec-fetch-site': 'same-origin' }],
    ['another site', { 'sec-fetch-dest': 'empty', 'sec-fetch-site': 'cross-site' }],
    ['an opaque frame', { 'sec-fetch-dest': 'empty', 'sec-fetch-site': 'none' }],
    ['no browser headers at all', {}],
  ] as [string, Record<string, string>][]) {
    test(`${what} gets 403 and reaches nothing`, async () => {
      const before = seen.length;
      const answer = await through(`/__jmap/${idOf(origin)}/html`, {}, true, headers);
      expect(answer.status).toBe(403);
      expect(seen.length).toBe(before);
    });
  }

  test('an answer cannot render on the app origin: sandboxed, and its type is gone', async () => {
    const answer = await through(`/__jmap/${idOf(origin)}/html`);
    expect(answer.status).toBe(200);
    expect(answer.headers.get('content-type')).toBe('application/octet-stream');
    expect(answer.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
    expect(answer.headers.get('x-content-type-options')).toBe('nosniff');
    expect(answer.headers.get('content-disposition')).toBeNull();
    expect(answer.headers.get('access-control-allow-origin')).toBeNull();
  });

  test('only the answer headers JMAP needs come back, and the safe ones win', async () => {
    const hostile = createHttpServer((_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/html',
        'clear-site-data': '"*"',
        'x-content-type-options': 'off',
        'cross-origin-resource-policy': 'cross-origin',
        'cache-control': 'public, max-age=31536000',
        'content-security-policy': 'default-src *',
        'report-to': '{}',
        nel: '{}',
        'reporting-endpoints': 'a="https://x.invalid"',
        'service-worker-allowed': '/',
        'x-frame-options': 'ALLOWALL',
        'permissions-policy': 'camera=*',
        'set-cookie': 'a=1',
        'www-authenticate': 'Basic',
        'proxy-authenticate': 'Basic',
        location: 'https://x.invalid',
        refresh: '0;url=https://x.invalid',
        link: '<https://x.invalid>; rel=preload',
        'x-anything': 'a',
        etag: '"v1"',
        'last-modified': 'Wed, 04 Nov 2026 01:00:00 GMT',
        'retry-after': '7',
        'content-length': String('<script>1</script>'.length),
      });
      res.end('<script>1</script>');
    });
    await new Promise<void>((resolve) => hostile.listen(0, '127.0.0.1', resolve));
    const hostileOrigin = `http://127.0.0.1:${(hostile.address() as AddressInfo).port}`;
    const front = createHttpServer((req, res) => {
      void forwardJmap(req, res, (candidate) => candidate === hostileOrigin);
    });
    await new Promise<void>((resolve) => front.listen(0, '127.0.0.1', resolve));
    try {
      const answer = await fetch(`http://127.0.0.1:${(front.address() as AddressInfo).port}/__jmap/${idOf(hostileOrigin)}/x`, { headers: PAGE_FETCH });
      const names = [...answer.headers.keys()].filter((name) => !['connection', 'date', 'keep-alive', 'transfer-encoding'].includes(name)).sort();
      expect(names).toEqual([
        'cache-control',
        'content-length',
        'content-security-policy',
        'content-type',
        'cross-origin-resource-policy',
        'etag',
        'last-modified',
        'retry-after',
        'x-content-type-options',
      ]);
      expect(answer.headers.get('cache-control')).toBe('no-store');
      expect(answer.headers.get('x-content-type-options')).toBe('nosniff');
      expect(answer.headers.get('cross-origin-resource-policy')).toBe('same-origin');
      expect(answer.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
      expect(answer.headers.get('content-type')).toBe('application/octet-stream');
      expect(answer.headers.get('etag')).toBe('"v1"');
      expect(answer.headers.get('retry-after')).toBe('7');
      expect(answer.headers.get('content-length')).toBe(String('<script>1</script>'.length));
      expect(await answer.text()).toBe('<script>1</script>');
    } finally {
      for (const server of [hostile, front]) {
        server.close();
        server.closeAllConnections();
      }
    }
  });

  test('a compressed answer loses its length: fetch has decoded the body by then', async () => {
    const body = JSON.stringify({ text: 'x'.repeat(2000) });
    const zipped = gzipSync(body);
    const compressing = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': String(zipped.length) });
      res.end(zipped);
    });
    await new Promise<void>((resolve) => compressing.listen(0, '127.0.0.1', resolve));
    const compressingOrigin = `http://127.0.0.1:${(compressing.address() as AddressInfo).port}`;
    const front = createHttpServer((req, res) => {
      void forwardJmap(req, res, (candidate) => candidate === compressingOrigin);
    });
    await new Promise<void>((resolve) => front.listen(0, '127.0.0.1', resolve));
    try {
      const answer = await fetch(`http://127.0.0.1:${(front.address() as AddressInfo).port}/__jmap/${idOf(compressingOrigin)}/x`, { headers: PAGE_FETCH });
      expect(answer.headers.get('content-encoding')).toBeNull();
      expect(answer.headers.get('content-length')).toBeNull();
      expect(answer.headers.get('content-type')).toBe('application/json');
      expect(await answer.text()).toBe(body);
    } finally {
      for (const server of [compressing, front]) {
        server.close();
        server.closeAllConnections();
      }
    }
  });

  test('a refusal is not stored either', async () => {
    const answer = await through(`/__jmap/${idOf(origin)}/html`, {}, false);
    expect(answer.status).toBe(403);
    expect(answer.headers.get('cache-control')).toBe('no-store');
  });

  test('JSON stays JSON', () => {
    expect(safeContentType('application/json; charset=utf-8')).toBe('application/json; charset=utf-8');
    expect(safeContentType('application/problem+json')).toBe('application/problem+json');
    for (const type of ['text/html', 'image/svg+xml', 'text/xml', 'application/xhtml+xml', 'text/json-html', null]) {
      expect(safeContentType(type), String(type)).toBe('application/octet-stream');
    }
  });

  test('a redirect to a server nobody approved is not followed', async () => {
    const answer = await through(`/__jmap/${idOf(origin)}/redirect-out`);
    expect(answer.status).toBe(502);
    expect(answer.text).toContain('not been approved');
  });

  test('a POST redirect fails clearly, without reaching the target', async () => {
    const before = seen.filter((request) => request.url === '/jmap/').length;
    const answer = await through(`/__jmap/${idOf(origin)}/redirect-post`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(answer.status).toBe(502);
    expect(answer.text).toContain('redirected');
    expect(seen.filter((request) => request.url === '/jmap/').length).toBe(before);
  });

  test('route parsing refuses what is not an origin', () => {
    expect(isJmapRoute('/__jmap/abc/x')).toBe(true);
    expect(isJmapRoute('/en/mail')).toBe(false);
    expect(parseJmapRoute(`/__jmap/${idOf('http://a.example:8080')}/jmap/?x=1`)).toEqual({ origin: 'http://a.example:8080', rest: '/jmap/?x=1' });
    expect(parseJmapRoute(`/__jmap/${idOf('http://a.example/path')}/x`)).toBeNull();
    expect(parseJmapRoute(`/__jmap/${idOf('file:///etc/passwd')}/x`)).toBeNull();
    expect(parseJmapRoute('/__jmap/..%2f/x')).toBeNull();
  });

});

test.describe('the system CA store in the embedded server', () => {
  const electronBinary = path.resolve(import.meta.dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe');

  test.skip(process.platform !== 'win32', 'run with the Windows binary here');

  test('setDefaultCACertificates governs fetch under Electron\'s Node, and the OS list is readable', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bw-ca-'));
    const { keyPem, certPem } = generateCertificate('localhost');
    const script = path.join(dir, 'check.cjs');
    writeFileSync(script, `
      const tls = require('node:tls'), https = require('node:https');
      const key = ${JSON.stringify(keyPem)}, cert = ${JSON.stringify(certPem)};
      (async () => {
        const out = { bundled: tls.getCACertificates('default').length, system: tls.getCACertificates('system').length };
        const server = https.createServer({ key, cert }, (q, s) => s.end('ok'));
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        const url = 'https://localhost:' + server.address().port + '/';
        out.before = await fetch(url).then((r) => r.status).catch((e) => String(e.cause?.code ?? e.message));
        tls.setDefaultCACertificates([...tls.getCACertificates('default'), cert]);
        out.after = await fetch(url).then((r) => r.status).catch((e) => String(e.cause?.code ?? e.message));
        server.close(); server.closeAllConnections();
        console.log(JSON.stringify(out));
      })();
    `);
    const run = spawnSync(electronBinary, [script], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8' });
    const result = JSON.parse(run.stdout.trim().split('\n').at(-1) ?? '{}');
    expect(result.system, 'the OS store is readable').toBeGreaterThan(0);
    expect(result.before, 'a private CA fails by default').not.toBe(200);
    expect(result.after, 'and works once added').toBe(200);
  });
});

test.describe('/__jmap redirects between servers', () => {
  const PAGE_FETCH = { 'sec-fetch-dest': 'empty', 'sec-fetch-site': 'same-origin' };

  async function listen(handler: Parameters<typeof createHttpServer>[1]) {
    const server = createHttpServer(handler);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
  }

  test('each hop is checked: an approved target is followed, without the password if the host changes', async () => {
    const seen: { auth?: string }[] = [];
    const second = await listen((req, res) => {
      seen.push({ auth: req.headers.authorization });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"second":true}');
    });
    // Same address, another name: a host change as far as credentials go.
    const secondByName = second.origin.replace('127.0.0.1', 'localhost');
    const first = await listen((_req, res) => {
      res.writeHead(302, { location: `${secondByName}/x` }).end();
    });
    const front = await listen((req, res) => {
      void forwardJmap(req, res, (candidate) => candidate === first.origin || candidate === secondByName);
    });
    const id = Buffer.from(first.origin).toString('base64url');
    const answer = await fetch(`${front.origin}/__jmap/${id}/start`, { headers: { ...PAGE_FETCH, authorization: 'Basic abc' } });
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ second: true });
    expect(seen).toEqual([{ auth: undefined }]);

    // Taken off the list, the same redirect stops.
    const frontStrict = await listen((req, res) => {
      void forwardJmap(req, res, (candidate) => candidate === first.origin);
    });
    const refused = await fetch(`${frontStrict.origin}/__jmap/${id}/start`, { headers: PAGE_FETCH });
    expect(refused.status).toBe(502);
    expect(seen).toHaveLength(1);
    for (const { server } of [first, second, front, frontStrict]) {
      server.close();
      server.closeAllConnections();
    }
  });

  const secrets = { authorization: 'Basic ACCOUNT-A', 'x-account-key': 'K', 'x-custom': 'C', accept: 'application/json', 'accept-language': 'de' };

  test('another port is another server: only standard headers go along', async () => {
    const got: IncomingMessage['headers'][] = [];
    const second = await listen((req, res) => {
      got.push(req.headers);
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
    const first = await listen((_req, res) => {
      res.writeHead(302, { location: `${second.origin}/x` }).end();
    });
    const front = await listen((req, res) => {
      void forwardJmap(req, res, (candidate) => candidate === first.origin || candidate === second.origin);
    });
    const id = Buffer.from(first.origin).toString('base64url');
    expect((await fetch(`${front.origin}/__jmap/${id}/start`, { headers: { ...PAGE_FETCH, ...secrets } })).status).toBe(200);
    expect(got).toHaveLength(1);
    expect(got[0].authorization).toBeUndefined();
    expect(got[0]['x-account-key']).toBeUndefined();
    expect(got[0]['x-custom']).toBeUndefined();
    expect(got[0].accept).toBe('application/json');
    expect(got[0]['accept-language']).toBe('de');
    for (const { server } of [first, second, front]) {
      server.close();
      server.closeAllConnections();
    }
  });

  test('the same origin keeps everything along a redirect', async () => {
    const got: IncomingMessage['headers'][] = [];
    const only = await listen((req, res) => {
      if (req.url === '/start') {
        res.writeHead(307, { location: '/x' }).end();
        return;
      }
      got.push(req.headers);
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
    const front = await listen((req, res) => {
      void forwardJmap(req, res, (candidate) => candidate === only.origin);
    });
    const id = Buffer.from(only.origin).toString('base64url');
    expect((await fetch(`${front.origin}/__jmap/${id}/start`, { headers: { ...PAGE_FETCH, ...secrets } })).status).toBe(200);
    expect(got[0].authorization).toBe('Basic ACCOUNT-A');
    expect(got[0]['x-account-key']).toBe('K');
    expect(got[0]['x-custom']).toBe('C');
    for (const { server } of [only, front]) {
      server.close();
      server.closeAllConnections();
    }
  });

  test('moving up to TLS on the same host is another origin too: nothing of the account goes along', async () => {
    const cert = generateCertificate('localhost');
    const got: IncomingMessage['headers'][] = [];
    const tls = createHttpsServer({ key: cert.keyPem, cert: cert.certPem }, (req, res) => {
      got.push(req.headers);
      res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    });
    await new Promise<void>((resolve) => tls.listen(0, '127.0.0.1', resolve));
    const first = await listen((_req, res) => {
      res.writeHead(301, { location: `https://127.0.0.1:${(tls.address() as AddressInfo).port}/x` }).end();
    });
    const front = await listen((req, res) => {
      void forwardJmap(req, res, (candidate) => candidate === first.origin);
    });
    const id = Buffer.from(first.origin).toString('base64url');
    const insecure = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
      expect((await fetch(`${front.origin}/__jmap/${id}/start`, { headers: { ...PAGE_FETCH, ...secrets } })).status).toBe(200);
    } finally {
      if (insecure === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = insecure;
    }
    expect(got).toHaveLength(1);
    expect(got[0].authorization).toBeUndefined();
    expect(got[0]['x-account-key']).toBeUndefined();
    expect(got[0]['x-custom']).toBeUndefined();
    for (const server of [first.server, front.server, tls]) {
      server.close();
      server.closeAllConnections();
    }
  });

  test('a same-host move up to TLS may stay, though only http was approved', async () => {
    // The hop itself fails here, since nothing listens with TLS: what counts is that it is tried, not refused.
    const first = await listen((_req, res) => {
      res.writeHead(301, { location: 'https://127.0.0.1:1/x' }).end();
    });
    const front = await listen((req, res) => {
      void forwardJmap(req, res, (candidate) => candidate === first.origin);
    });
    const id = Buffer.from(first.origin).toString('base64url');
    const answer = await fetch(`${front.origin}/__jmap/${id}/start`, { headers: PAGE_FETCH });
    expect(answer.status).toBe(502);
    expect(await answer.text()).toContain('could not be reached');
    for (const { server } of [first, front]) {
      server.close();
      server.closeAllConnections();
    }
  });
});

test.describe('the install prompt', () => {
  const text: PromptText = {
    pluginInstallTitle: (name) => `Install ${name}?`,
    pluginPublisher: (publisher, verified) => `By ${publisher}${verified ? ' (verified)' : ''}`,
    pluginNoPublisher: 'No publisher',
    pluginPermissions: 'It asks to:',
    pluginNoPermissions: 'No permissions',
    pluginPrivileged: 'FULL ACCESS WARNING',
    pluginKeystore: 'Use certificates on this computer',
    pluginNewPermissions: 'New in this version:',
    install: 'Install',
    cancel: 'Cancel',
  };
  const detail = (tier?: string) => ({
    extension: {
      name: 'Secure Mail',
      author: { displayName: 'Acme', githubLogin: 'acme', verified: true },
      permissionDetails: [{ title: 'Read your mail', highRisk: true }, { title: 'Use the network' }],
    },
    preview: { version: '1.2.3', yanked: null },
    bundle: { manifest: tier ? { tier } : {} },
  });

  test('names it, its publisher and what it may do, with Cancel as the default', () => {
    const box = pluginPrompt(pluginFacts(detail(), 'secure-mail'), text);
    expect(box.message).toBe('Install Secure Mail?');
    expect(box.detail).toContain('By Acme (verified)');
    expect(box.detail).toContain('Read your mail');
    expect(box.detail).toContain('Use the network');
    expect(box.detail).not.toContain('FULL ACCESS');
    expect(box.type).toBe('question');
    expect(box.buttons![box.defaultId!]).toBe('Cancel');
    expect(box.buttons![box.cancelId!]).toBe('Cancel');
  });

  test('warns separately about the privileged tier', () => {
    const box = pluginPrompt(pluginFacts(detail('privileged'), 'secure-mail'), text);
    expect(box.detail).toContain('FULL ACCESS WARNING');
    expect(box.type).toBe('warning');
    expect(box.buttons![box.defaultId!]).toBe('Cancel');
  });

  test('a permission the directory leaves out still shows: optional ones count too', () => {
    const bundled = { tier: 'privileged', permissions: ['crypto:full', 'email:read'], optionalPermissions: ['keystore'] };
    const facts = pluginFacts({
      extension: { name: 'S/MIME', permissionDetails: [{ id: 'crypto:full', title: 'Full crypto' }, { id: 'email:read', title: 'Read your mail' }] },
      preview: { version: '1.5.0' },
      bundle: { manifest: bundled },
    }, 'smime');
    expect(facts.permissionIds).toEqual(['crypto:full', 'email:read', 'keystore']);
    expect(pluginPrompt(facts, text).detail).toContain('Use certificates on this computer');
  });

  test('the server\'s own text for keystore wins, and it never shows without the privileged tier', () => {
    const titled = pluginFacts({
      extension: { permissionDetails: [{ id: 'keystore', title: 'Certificates, from the server' }] },
      preview: { version: '1.0.0' },
      bundle: { manifest: { tier: 'privileged', optionalPermissions: ['keystore'] } },
    }, 'x');
    expect(titled.permissions).toEqual(['Certificates, from the server']);
    const untrusted = pluginFacts({ preview: { version: '1.0.0' }, bundle: { manifest: { optionalPermissions: ['keystore'] } } }, 'x');
    expect(untrusted.permissionIds).toEqual([]);
  });

  test('an update says what it adds', () => {
    const facts = pluginFacts({
      extension: { permissionDetails: [{ id: 'email:read', title: 'Read your mail' }] },
      preview: { version: '2.0.0' },
      bundle: { manifest: { tier: 'privileged', permissions: ['email:read'], optionalPermissions: ['keystore'] }, addedPermissions: ['keystore'] },
    }, 'x');
    const lines = String(pluginPrompt(facts, text).detail).split('\n');
    expect(lines.slice(lines.indexOf('New in this version:'))).toEqual(['New in this version:', '• Use certificates on this computer', '', 'FULL ACCESS WARNING']);
    expect(pluginPrompt(pluginFacts(detail(), 'x'), text).detail).not.toContain('New in this version');
  });

  test('a yanked version has nothing to install, and missing facts stay honest', () => {
    expect(pluginFacts({ ...detail(), preview: { version: '1.2.3', yanked: true } }, 'x').version).toBeNull();
    const bare = pluginFacts({ preview: { version: '1.0.0' } }, 'bare-slug');
    expect(bare.name).toBe('bare-slug');
    expect(pluginPrompt(bare, text).detail).toContain('No publisher');
    expect(pluginPrompt(bare, text).detail).toContain('No permissions');
  });
});
