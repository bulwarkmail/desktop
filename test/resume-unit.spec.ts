import { expect, test } from '@playwright/test';
import { cleanSettingsPatch, defaultSettings, settingsAllowedWithoutClick } from '../src/main/features/os-rules';
import {
  keepForRestart,
  RESUME_MAX_AGE_MS,
  resumeMarkFor,
  resumeUrlFrom,
  settleRestartLoginEntry,
  takeResumeUrl,
  type ResumeMark,
  type ResumeState,
} from '../src/main/resume-rules';

const LOCAL = 'http://127.0.0.1:47811';
const SERVER = 'https://mail.example.com';
const NOW = 1_800_000_000_000;

function state(mark?: ResumeMark): ResumeState & { saves: number } {
  const file = { data: { ...(mark ? { resumeAfterRestart: mark } : {}) } as ResumeState['data'], saves: 0, save() { file.saves += 1; } };
  return file;
}

test.describe('open again after a restart: the setting', () => {
  test('is off until chosen, and a page may set it', () => {
    expect(defaultSettings('win32', {}).reopenAfterRestart).toBe(false);
    expect(cleanSettingsPatch({ reopenAfterRestart: true })).toEqual({ reopenAfterRestart: true });
    expect(cleanSettingsPatch({ reopenAfterRestart: 'yes' })).toEqual({});
  });

  test('turning it on takes a click, as start at login does; turning it off does not', () => {
    expect(settingsAllowedWithoutClick({ reopenAfterRestart: true, closeToTray: false }, false)).toEqual({ closeToTray: false });
    expect(settingsAllowedWithoutClick({ reopenAfterRestart: true }, true)).toEqual({ reopenAfterRestart: true });
    expect(settingsAllowedWithoutClick({ reopenAfterRestart: false }, false)).toEqual({ reopenAfterRestart: false });
    expect(settingsAllowedWithoutClick({ startAtLogin: true, reopenAfterRestart: true }, false)).toEqual({});
  });
});

test.describe('open again after a restart: what is kept', () => {
  test('the page, without the local server\'s port, and whether a login entry is owed', () => {
    const mark = resumeMarkFor(`${LOCAL}/en/mail/inbox/m42?q=1#top`, { mode: 'standalone', origin: LOCAL, now: NOW, startAtLogin: false });
    expect(mark).toEqual({ path: '/en/mail/inbox/m42?q=1#top', mode: 'standalone', at: NOW, loginItem: true });
    expect(resumeMarkFor(`${LOCAL}/en/calendar`, { mode: 'standalone', origin: LOCAL, now: NOW, startAtLogin: true })?.loginItem).toBe(false);
  });

  test('on a server, the server too', () => {
    expect(resumeMarkFor(`${SERVER}/webmail/de/mail/Archiv`, { mode: 'instance', origin: SERVER, now: NOW, startAtLogin: true }))
      .toEqual({ path: '/webmail/de/mail/Archiv', mode: 'instance', origin: SERVER, at: NOW, loginItem: false });
  });

  test('nothing for an error page, a pop-out or a sign-in step', () => {
    const options = { mode: 'standalone' as const, origin: LOCAL, now: NOW, startAtLogin: false };
    expect(resumeMarkFor('about:blank', options)).toBeNull();
    expect(resumeMarkFor('data:text/html,error', options)).toBeNull();
    expect(resumeMarkFor('https://elsewhere.example/en/mail', options)).toBeNull();
    expect(resumeMarkFor(`${LOCAL}/en/popout/compose?draft=d1`, options)).toBeNull();
    expect(resumeMarkFor(`${LOCAL}/login?login_hint=a`, options)).toBeNull();
    expect(resumeMarkFor(`${LOCAL}/en/auth/callback?code=x`, options)).toBeNull();
  });
});

test.describe('open again after a restart: where the main window opens', () => {
  const mark: ResumeMark = { path: '/en/mail/inbox/m42', mode: 'standalone', at: NOW, loginItem: false };

  test('on the kept page, under this start\'s port', () => {
    expect(resumeUrlFrom(mark, { mode: 'standalone', origin: 'http://127.0.0.1:50000', now: NOW + 60_000 })).toBe('http://127.0.0.1:50000/en/mail/inbox/m42');
  });

  test('not in the other mode, on another server, or long after', () => {
    expect(resumeUrlFrom(mark, { mode: 'instance', origin: SERVER, now: NOW })).toBeNull();
    const onServer: ResumeMark = { path: '/en/mail', mode: 'instance', origin: SERVER, at: NOW, loginItem: false };
    expect(resumeUrlFrom(onServer, { mode: 'instance', origin: 'https://other.example.com', now: NOW })).toBeNull();
    expect(resumeUrlFrom(onServer, { mode: 'instance', origin: SERVER, now: NOW })).toBe(`${SERVER}/en/mail`);
    expect(resumeUrlFrom(mark, { mode: 'standalone', origin: LOCAL, now: NOW + RESUME_MAX_AGE_MS + 1 })).toBeNull();
    expect(resumeUrlFrom(mark, { mode: 'standalone', origin: LOCAL, now: NOW - 1 })).toBeNull();
  });

  test('an edited state file can\'t send it anywhere else', () => {
    const options = { mode: 'standalone' as const, origin: LOCAL, now: NOW };
    for (const path of ['//evil.example/x', 'https://evil.example/', '/\\evil.example', '/en/mail\n', 'en/mail', '/en/popout/message/1']) {
      expect(resumeUrlFrom({ ...mark, path }, options), path).toBeNull();
    }
    expect(resumeUrlFrom('nonsense', options)).toBeNull();
    expect(resumeUrlFrom({ ...mark, at: 'soon' }, options)).toBeNull();
  });

  test('once: the mark goes as it is read, whether it fits or not', () => {
    const file = state(mark);
    expect(takeResumeUrl(file, 'standalone', LOCAL, NOW)).toBe(`${LOCAL}/en/mail/inbox/m42`);
    expect(file.data.resumeAfterRestart).toBeUndefined();
    expect(takeResumeUrl(file, 'standalone', LOCAL, NOW)).toBeNull();

    const other = state(mark);
    expect(takeResumeUrl(other, 'instance', SERVER, NOW)).toBeNull();
    expect(other.data.resumeAfterRestart).toBeUndefined();
  });
});

test.describe('open again after a restart: the login entry', () => {
  test('the session ends: the page is kept, and with start at login off the app starts once at the next sign-in', () => {
    const file = state();
    const login: boolean[] = [];
    expect(keepForRestart(file, { url: `${LOCAL}/en/mail/inbox`, mode: 'standalone', origin: LOCAL, now: NOW, startAtLogin: false }, (on) => login.push(on))).toBe(true);
    expect(login).toEqual([true]);
    expect(file.data.resumeAfterRestart).toMatchObject({ path: '/en/mail/inbox', loginItem: true });
    expect(file.saves).toBe(1);
  });

  test('with start at login on, the entry is already there and stays the user\'s', () => {
    const file = state();
    const login: boolean[] = [];
    keepForRestart(file, { url: `${LOCAL}/en/mail/inbox`, mode: 'standalone', origin: LOCAL, now: NOW, startAtLogin: true }, (on) => login.push(on));
    expect(login).toEqual([]);
    expect(settleRestartLoginEntry(file, true, (on) => login.push(on))).toBe(false);
    expect(login).toEqual([]);
  });

  test('nothing is kept or registered for a page that can\'t come back', () => {
    const file = state();
    const login: boolean[] = [];
    expect(keepForRestart(file, { url: 'about:blank', mode: 'standalone', origin: LOCAL, now: NOW, startAtLogin: false }, (on) => login.push(on))).toBe(false);
    expect(login).toEqual([]);
    expect(file.data.resumeAfterRestart).toBeUndefined();
  });

  test('the next start puts the entry back the way the user has it, and keeps the page for the window', () => {
    const file = state({ path: '/en/mail/inbox', mode: 'standalone', at: NOW, loginItem: true });
    const login: boolean[] = [];
    expect(settleRestartLoginEntry(file, false, (on) => login.push(on))).toBe(true);
    expect(login).toEqual([false]);
    expect(file.data.resumeAfterRestart).toMatchObject({ path: '/en/mail/inbox', loginItem: false });
    // A second start doesn't touch the entry again.
    expect(settleRestartLoginEntry(file, false, (on) => login.push(on))).toBe(false);
    expect(login).toEqual([false]);
  });
});
