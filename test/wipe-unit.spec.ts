// Whose things a wipe takes, in plain Node: src/main/wipe-scope.ts.
import { expect, test } from '@playwright/test';
import { urlOfOrigin, wipeCovers } from '../src/main/wipe-scope';

const STANDALONE = 'https://app.bulwark.localhost';
const SERVER = 'https://mail.example.org';

test("a server's wipe takes its own records only; a record with no origin is the standalone page's", () => {
  expect(wipeCovers(SERVER, SERVER)).toBe(true);
  expect(wipeCovers(SERVER, STANDALONE)).toBe(false);
  expect(wipeCovers(SERVER, undefined)).toBe(false);
  expect(wipeCovers(STANDALONE, undefined)).toBe(true);
  expect(wipeCovers(STANDALONE, SERVER)).toBe(false);
  // Same host, another port or scheme: another server.
  expect(wipeCovers(SERVER, 'https://mail.example.org:8443')).toBe(false);
  expect(wipeCovers(SERVER, 'http://mail.example.org')).toBe(false);
  // The policy's wipe takes everyone's.
  for (const owner of [SERVER, STANDALONE, undefined]) expect(wipeCovers(null, owner)).toBe(true);
});

test("a window to bring back is a server's when its page is on that origin", () => {
  expect(urlOfOrigin(`${SERVER}/mail/inbox`, SERVER)).toBe(true);
  expect(urlOfOrigin(`${STANDALONE}/mail/inbox`, SERVER)).toBe(false);
  expect(urlOfOrigin('https://mail.example.org.evil.example/', SERVER)).toBe(false);
  expect(urlOfOrigin('https://mail.example.org:8443/', SERVER)).toBe(false);
  expect(urlOfOrigin('not a url', SERVER)).toBe(false);
  expect(urlOfOrigin('not a url', null)).toBe(true);
});
