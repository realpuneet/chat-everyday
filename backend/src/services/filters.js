// Text filters: sanitize, link, PII, bad-word and spam-pattern filters.
// Repeating the SAME message is explicitly allowed; only speed (rate limiter) and
// pattern abuse (flooding, zalgo, link spam) are restricted.

// eslint-disable-next-line no-control-regex, no-irregular-whitespace
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​‌⁠﻿‪-‮⁦-⁩]/g;
const COMBINING_RUN = /(\p{M}{4,})/gu;
const LINK = /(?:https?:\/\/|www\.)\S+|\b[a-z0-9][a-z0-9-]{1,62}\.(?:com|net|org|in|io|me|co|xyz|ly|gl|app|link|to|gg|tv|cc|info|site|online|ru|cn)\b(?:\/\S*)?/i;
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const PHONE = /(?<![\d])(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{3,5}\)?[\s.-]?)?\d{3,5}[\s.-]?\d{4,5}(?!\d)/;
const CHAR_FLOOD = /(.)\1{39,}/su;

export function sanitizeText(input) {
  if (typeof input !== 'string') return '';
  return input
    .normalize('NFC')
    .replace(CONTROL, '')
    .replace(COMBINING_RUN, (m) => m.slice(0, 2))
    .replace(/[ \t]{3,}/g, '  ')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

export const hasLink = (text) => LINK.test(text);

export function hasPii(text) {
  if (EMAIL.test(text)) return true;
  const digits = text.replace(/\D/g, '');
  return digits.length >= 10 && PHONE.test(text);
}

const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', $: 's', '!': 'i' };
export const normalizeForMatch = (t) =>
  t
    .toLowerCase()
    // digits / symbols count as leetspeak only when glued to a letter ("b@d", "h3llo"); '!' needs letters on both sides
    .replace(/(?<=\p{L})!(?=\p{L})|(?<=\p{L})[01345@$7]|[01345@$7](?=\p{L})/gu, (c) => LEET[c])
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/(.)\1{2,}/g, '$1$1');

export function findBadWord(text, words = []) {
  if (!words.length) return null;
  const n = ` ${normalizeForMatch(text).replace(/\s+/g, ' ')} `;
  for (const w of words) {
    const nw = normalizeForMatch(w).trim();
    if (nw && n.includes(` ${nw} `)) return w;
  }
  return null;
}

export const isCharFlood = (text) => CHAR_FLOOD.test(text);

/**
 * Evaluate a message against the configured filters.
 * @returns {{ok:true,text:string}|{ok:false,code:string,message:string}}
 */
export function evaluateMessage(raw, { maxLength = 1000, blockLinks = true, blockPii = false, badWords = [] } = {}) {
  const text = sanitizeText(raw);
  if (!text) return { ok: false, code: 'EMPTY', message: 'Message is empty' };
  if ([...text].length > maxLength) return { ok: false, code: 'TOO_LONG', message: `Message exceeds ${maxLength} characters` };
  if (isCharFlood(text)) return { ok: false, code: 'SPAM_PATTERN', message: 'Message looks like spam' };
  if (blockLinks && hasLink(text)) return { ok: false, code: 'LINK_BLOCKED', message: 'Links are not allowed here' };
  if (blockPii && hasPii(text)) return { ok: false, code: 'PII_BLOCKED', message: 'Sharing phone numbers or emails is not allowed here' };
  const bad = findBadWord(text, badWords);
  if (bad) return { ok: false, code: 'BAD_WORD', message: 'Message contains a blocked word' };
  return { ok: true, text };
}
