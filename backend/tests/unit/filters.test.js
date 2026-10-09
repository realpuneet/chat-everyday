import { describe, it, expect } from 'vitest';
import { sanitizeText, hasLink, hasPii, findBadWord, evaluateMessage, isCharFlood } from '../../src/services/filters.js';

describe('filters', () => {
  it('sanitizes control and zero-width chars, keeps emoji', () => {
    expect(sanitizeText('he​llo\u0007 wor‮ld 👍🏽')).toBe('hello world 👍🏽');
    expect(sanitizeText('   hi   ')).toBe('hi');
    expect(sanitizeText(42)).toBe('');
  });

  it('collapses zalgo combining marks', () => {
    const z = 'a' + '̀́̂̃̄̅̆';
    expect(sanitizeText(z).length).toBeLessThanOrEqual(3);
  });

  it('detects links in several forms', () => {
    for (const s of ['visit http://x.co now', 'www.foo.bar', 'check example.com/page', 'bit.ly/abc is gone', 'join t.me/xyz  or foo.io']) {
      expect(hasLink(s), s).toBe(true);
    }
    for (const s of ['hello there', 'I said no.Really', 'version 1.2 is out', 'what.is.this']) {
      expect(hasLink(s), s).toBe(false);
    }
  });

  it('detects phone numbers and emails as PII', () => {
    expect(hasPii('call me 98765 43210')).toBe(true);
    expect(hasPii('+91 9876543210')).toBe(true);
    expect(hasPii('mail me a.b@example.com')).toBe(true);
    expect(hasPii('I am 25 and have 3 cats')).toBe(false);
  });

  it('bad-word filter handles leetspeak and word boundaries', () => {
    expect(findBadWord('you are a b@dword!', ['badword'])).toBe('badword');
    expect(findBadWord('assessment', ['ass'])).toBe(null);
    expect(findBadWord('hello', [])).toBe(null);
  });

  it('REPEATED identical messages are allowed (no content-based duplicate blocking)', () => {
    for (let i = 0; i < 5; i++) expect(evaluateMessage('hi', {}).ok).toBe(true);
  });

  it('blocks character flooding but not normal repetition', () => {
    expect(isCharFlood('a'.repeat(60))).toBe(true);
    expect(isCharFlood('hahahahahahahaha')).toBe(false);
    expect(evaluateMessage('a'.repeat(60), {}).code).toBe('SPAM_PATTERN');
  });

  it('enforces length, links, pii and bad words by option', () => {
    expect(evaluateMessage('x'.repeat(11), { maxLength: 10 }).code).toBe('TOO_LONG');
    expect(evaluateMessage('see foo.com', { blockLinks: true }).code).toBe('LINK_BLOCKED');
    expect(evaluateMessage('see foo.com', { blockLinks: false }).ok).toBe(true);
    expect(evaluateMessage('9876543210', { blockPii: true }).code).toBe('PII_BLOCKED');
    expect(evaluateMessage('you idiot', { badWords: ['idiot'] }).code).toBe('BAD_WORD');
    expect(evaluateMessage('   ', {}).code).toBe('EMPTY');
  });
});
