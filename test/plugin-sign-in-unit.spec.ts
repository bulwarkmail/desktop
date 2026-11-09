import { expect, test } from '@playwright/test';
import { isPluginSignIn } from '../src/main/navigation-rules';

const ORIGIN = 'https://bulwark.example.org';
const authorize = (redirect: string | string[], base = 'https://idp.example.org/application/o/authorize/') => {
  const url = new URL(base);
  for (const value of [redirect].flat()) url.searchParams.append('redirect_uri', value);
  url.searchParams.set('state', 's');
  return url;
};

test('an authorize request back to the plugin callback is a plugin sign-in, with or without a locale or base path', () => {
  expect(isPluginSignIn(authorize(`${ORIGIN}/plugins/oauth/callback`), ORIGIN)).toBe(true);
  expect(isPluginSignIn(authorize(`${ORIGIN}/de/plugins/oauth/callback`), ORIGIN)).toBe(true);
  expect(isPluginSignIn(authorize(`${ORIGIN}/pt-BR/plugins/oauth/callback/`), ORIGIN)).toBe(true);
  expect(isPluginSignIn(authorize(`${ORIGIN}/webmail/en/plugins/oauth/callback`), ORIGIN)).toBe(true);
});

test('anything else is not', () => {
  // The app's own sign-in and other pages on the instance.
  expect(isPluginSignIn(authorize(`${ORIGIN}/en/auth/callback`), ORIGIN)).toBe(false);
  expect(isPluginSignIn(authorize(`${ORIGIN}/plugins/oauth/callback/../../en/login`), ORIGIN)).toBe(false);
  expect(isPluginSignIn(authorize(`${ORIGIN}/plugins/oauth/callback/more`), ORIGIN)).toBe(false);
  // Another origin, two redirect_uri values, a page on the instance itself, plain http, credentials.
  expect(isPluginSignIn(authorize('https://evil.example.org/plugins/oauth/callback'), ORIGIN)).toBe(false);
  expect(isPluginSignIn(authorize([`${ORIGIN}/plugins/oauth/callback`, 'https://evil.example.org/']), ORIGIN)).toBe(false);
  expect(isPluginSignIn(authorize(`${ORIGIN}/plugins/oauth/callback`, `${ORIGIN}/elsewhere`), ORIGIN)).toBe(false);
  expect(isPluginSignIn(authorize(`${ORIGIN}/plugins/oauth/callback`, 'http://idp.example.org/authorize'), ORIGIN)).toBe(false);
  expect(isPluginSignIn(authorize(`${ORIGIN}/plugins/oauth/callback`, 'https://user:pw@idp.example.org/authorize'), ORIGIN)).toBe(false);
  expect(isPluginSignIn(new URL('https://idp.example.org/authorize?post_logout_redirect_uri=' + encodeURIComponent(`${ORIGIN}/plugins/oauth/callback`)), ORIGIN)).toBe(false);
});
