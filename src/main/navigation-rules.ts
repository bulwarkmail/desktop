/** The URL rules behind navigation.ts. No Electron here, so tests can load them. */

export function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** The embedded server's forwarding route, which holds other servers' answers on our origin. */
export function isJmapProxyPath(pathname: string): boolean {
  return pathname === '/__jmap' || pathname.startsWith('/__jmap/');
}

export function sameOrigin(url: URL | null, origin: string): boolean {
  return !!url && url.origin === origin;
}

/** An authorize or end-session request that comes back to this origin. */
export function isSsoStart(url: URL, origin: string): boolean {
  for (const name of ['redirect_uri', 'post_logout_redirect_uri']) {
    const target = url.searchParams.get(name);
    if (target && parse(target)?.origin === origin) return true;
  }
  return false;
}

/**
 * A plugin's sign-in path on the instance: the webmail's locale and its base path may stand in
 * front (main knows the instance's origin, not its path). The webmail vouches for the rest.
 */
const PLUGIN_CALLBACK_PATH = /^(?:\/[^/]+)*\/plugins\/oauth\/callback\/?$/;

/**
 * A plugin's OAuth request, as the webmail hands it over: an https page elsewhere whose one
 * `redirect_uri` is the instance's own plugin callback. Only the bridge call opens it in the
 * app; a link with the same address still goes to the system browser.
 */
export function isPluginSignIn(url: URL, origin: string): boolean {
  if (url.protocol !== 'https:' || url.origin === origin || url.username || url.password) return false;
  const redirects = url.searchParams.getAll('redirect_uri');
  if (redirects.length !== 1) return false;
  const target = parse(redirects[0]);
  return !!target && target.origin === origin && PLUGIN_CALLBACK_PATH.test(target.pathname);
}

/** How long a single sign-in may stay away from the origin, when a policy forces it. */
export const FORCED_SSO_LIMIT_MS = 10 * 60_000;

/**
 * While a sign-in redirect chain runs, the window may show any https page. It ends on the
 * way back to the origin, on a failed load, and, with a limit, after a while: a forced
 * server shouldn't become a general browser through an SSO link.
 */
export class SsoChain {
  private startedAt: number | null = null;

  constructor(
    private readonly limitMs: () => number | null,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    this.startedAt = this.now();
  }

  end(): void {
    this.startedAt = null;
  }

  active(): boolean {
    if (this.startedAt === null) return false;
    const limit = this.limitMs();
    if (limit !== null && this.now() - this.startedAt > limit) {
      this.startedAt = null;
      return false;
    }
    return true;
  }
}

/** Mail, phone, text and calendar addresses: another program opens them, and only on a click. */
const CLICK_SCHEMES = new Set(['mailto:', 'tel:', 'sms:', 'webcal:']);
const WEB_SCHEMES = new Set(['http:', 'https:']);
/** Web addresses the app may open for one server without a click, all its windows together: as many as deep links, 5 in 10 seconds. */
export const UNCLICKED_OPEN_MAX = 5;
export const UNCLICKED_OPEN_MS = 10_000;

/**
 * Whether an address goes to the program the OS has for it. A web address opens in the browser
 * on a click, and without one only while the app's windows opened fewer than UNCLICKED_OPEN_MAX
 * that way in the last UNCLICKED_OPEN_MS (`recent`): the webmail opens a reminder's meeting link and
 * a provider's sign-out page with no click of the window's own. Mail, phone, text and calendar
 * addresses open only on a click. Any other scheme never leaves the app, and neither does an
 * address with a user name or password in it.
 */
export function externalOpenAllowed(url: URL | null, clicked: boolean, recent: number): boolean {
  if (!url || url.username || url.password) return false;
  if (WEB_SCHEMES.has(url.protocol)) return clicked || recent < UNCLICKED_OPEN_MAX;
  return CLICK_SCHEMES.has(url.protocol) && clicked;
}

/** The longest a server's name is shown in a question: past this it would push the rest out of view. */
export const SHOWN_HOST_MAX = 52;

/**
 * A server's host (as `URL.host` gives it, punycode and port included) the way a question shows
 * it: whole when it's short, else shortened in the middle of its left-hand labels, so the end
 * that says whose server it is always shows. That end is the last two labels, or three under
 * a country code with a short second level (`example.co.uk`); there is no public suffix list
 * here, so for a name like `x.github.io` it keeps less than the registrable part. The port and
 * an IPv6 literal are never cut.
 */
export function shownHost(host: string, max = SHOWN_HOST_MAX): string {
  if (host.length <= max || host.startsWith('[')) return host;
  const port = /:\d+$/.exec(host)?.[0] ?? '';
  const labels = host.slice(0, host.length - port.length).split('.');
  const last = labels[labels.length - 1] ?? '';
  const second = labels[labels.length - 2] ?? '';
  const keep = labels.length >= 3 && /^[a-z]{2}$/i.test(last) && second.length <= 3 ? 3 : 2;
  if (labels.length <= keep) return host;
  const tail = `${labels.slice(-keep).join('.')}${port}`;
  const head = labels.slice(0, -keep).join('.');
  // What's left for the left-hand part, less the dot before the tail and the ellipsis.
  const room = max - tail.length - 2;
  if (room < 2) return `….${tail}`;
  const start = Math.ceil(room / 2);
  return `${head.slice(0, start)}…${head.slice(head.length - (room - start))}.${tail}`;
}

export function looksLikeProviderLogout(url: URL): boolean {
  return (
    url.searchParams.has('post_logout_redirect_uri') ||
    url.searchParams.has('id_token_hint') ||
    /(^|\/)(logout|signout|sign-out|end[-_]?session)(\/|$)/i.test(url.pathname)
  );
}
