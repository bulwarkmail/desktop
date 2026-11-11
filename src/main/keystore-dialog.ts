/**
 * What the keystore's native question says and offers. No Electron in this file, so plain
 * Node tests read it.
 *
 * Signing has no "for a while" button: each send asks. Names come from certificates anyone
 * can make, so they lose control and format characters here too, whatever the helper did,
 * and the issuer and date are there to tell a renewed certificate from the old one.
 */

import type { ConsentAnswer, ConsentQuestion } from './keystore-consent';
import { fillKeystoreText, type KeystoreText } from './keystore-strings';
import { shownHost } from './navigation-rules';

const MAX_NAME = 200;

function plainName(name: string): string {
  const clean = name.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim();
  return clean.length > MAX_NAME ? `${clean.slice(0, MAX_NAME)}…` : clean;
}

function plainDate(at: number, language: string): string {
  try {
    return new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeZone: 'UTC' }).format(at);
  } catch {
    return new Date(at).toISOString().slice(0, 10);
  }
}

export interface KeystoreDialog {
  message: string;
  detail: string;
  buttons: string[];
  answers: ConsentAnswer[];
}

/** `standalone`: the only page is the app's own, and its internal host name means nothing to anyone. */
export function keystoreDialog(question: ConsentQuestion, text: KeystoreText, standalone: boolean, language: string): KeystoreDialog {
  const who = standalone ? text.thisApp : shownHost(new URL(question.origin).host);
  if (question.kind === 'first-use') {
    return {
      message: fillKeystoreText(text.firstUseTitle, { who }),
      detail: fillKeystoreText(text.firstUseDetail, { who }),
      answers: ['session', 'deny'],
      buttons: [text.allow, text.deny],
    };
  }
  if (question.kind === 'list') {
    return {
      message: fillKeystoreText(text.listTitle, { who }),
      detail: text.listDetail,
      answers: ['session', 'once', 'deny'],
      buttons: [text.allowSession, text.allowOnce, text.deny],
    };
  }
  const signing = question.kind === 'sign';
  const detail = [
    [
      fillKeystoreText(text.certificate, { subject: plainName(question.certificate) }),
      fillKeystoreText(text.issued, { issuer: plainName(question.issuer), date: plainDate(question.notAfter, language) }),
    ].join('\n'),
    signing ? text.signDetail : text.unwrapDetail,
    ...(question.overRate ? [text.overRate] : []),
    ...(question.perOperation ? [text.perOperation] : []),
  ].join('\n\n');
  const once = signing || question.perOperation;
  return {
    message: fillKeystoreText(signing ? text.signTitle : text.unwrapTitle, { who }),
    detail,
    answers: once ? ['once', 'deny'] : ['session', 'once', 'deny'],
    buttons: once ? [text.allowOnce, text.deny] : [text.allowTimed, text.allowOnce, text.deny],
  };
}
