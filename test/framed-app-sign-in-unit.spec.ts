import { expect, test } from '@playwright/test';
import { isFramedAppSignIn, opensWithoutOpener } from '../src/main/navigation-rules';

// A sidebar app (an inline frame on its own origin) that signs in through a pop-up: in the
// system browser the session cookie landed there, and the frame stayed signed out (#1).

const ORIGIN = 'https://bulwark.example.org';
const APP = 'https://chat.example.org';
const authorize = (redirect: string | string[], base = 'https://login.example.com/oauth2/v2.0/authorize') => {
  const url = new URL(base);
  for (const value of [redirect].flat()) url.searchParams.append('redirect_uri', value);
  url.searchParams.set('state', 's');
  return url;
};

test('a pop-up of a framed app to its own origin, or to an authorize request back to it, is its sign-in', () => {
  expect(isFramedAppSignIn(new URL(`${APP}/oauth/openid/login`), APP, ORIGIN)).toBe(true);
  expect(isFramedAppSignIn(authorize(`${APP}/signup/openid/complete`), APP, ORIGIN)).toBe(true);
});

test('anything else is not', () => {
  // A link from the app to another site.
  expect(isFramedAppSignIn(new URL('https://news.example.net/story'), APP, ORIGIN)).toBe(false);
  // An authorize request back to another site, or with two redirect_uri values.
  expect(isFramedAppSignIn(authorize('https://evil.example.net/cb'), APP, ORIGIN)).toBe(false);
  expect(isFramedAppSignIn(authorize([`${APP}/cb`, 'https://evil.example.net/cb']), APP, ORIGIN)).toBe(false);
  expect(isFramedAppSignIn(new URL('https://login.example.com/logout?post_logout_redirect_uri=' + encodeURIComponent(APP)), APP, ORIGIN)).toBe(false);
  // The instance itself asking: its own sign-in goes through the system browser.
  expect(isFramedAppSignIn(authorize(`${ORIGIN}/en/auth/callback`), ORIGIN, ORIGIN)).toBe(false);
  expect(isFramedAppSignIn(new URL(`${ORIGIN}/en/`), ORIGIN, ORIGIN)).toBe(false);
  // No opener known, an opaque or plain-http frame, or an address that isn't plain https.
  expect(isFramedAppSignIn(new URL(`${APP}/login`), null, ORIGIN)).toBe(false);
  expect(isFramedAppSignIn(new URL(`${APP}/login`), 'null', ORIGIN)).toBe(false);
  expect(isFramedAppSignIn(new URL('http://chat.example.org/login'), 'http://chat.example.org', ORIGIN)).toBe(false);
  expect(isFramedAppSignIn(new URL('http://chat.example.org/login'), APP, ORIGIN)).toBe(false);
  expect(isFramedAppSignIn(new URL('https://user:pw@chat.example.org/login'), APP, ORIGIN)).toBe(false);
});

test('window.open with noopener or noreferrer is a link, whatever the case and spacing', () => {
  expect(opensWithoutOpener('noopener,noreferrer')).toBe(true);
  expect(opensWithoutOpener('width=500, NoOpener')).toBe(true);
  expect(opensWithoutOpener('noreferrer=1')).toBe(true);
  expect(opensWithoutOpener('')).toBe(false);
  expect(opensWithoutOpener('width=500,height=600')).toBe(false);
  expect(opensWithoutOpener('popup')).toBe(false);
});
