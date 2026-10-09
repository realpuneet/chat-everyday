import { describe, it, expect } from 'vitest';
import { ageFromDob, isAdult } from '../../src/utils/age.js';
import { escalationDuration } from '../../src/services/banService.js';
import { deepMerge, DEFAULT_SETTINGS, settingsSchema } from '../../src/services/settingsService.js';
import { generateIdentity } from '../../src/utils/nickname.js';
import { toErrorPayload, AppError, tooMany } from '../../src/utils/errors.js';
import * as S from '../../src/validators/socketSchemas.js';
import * as H from '../../src/validators/httpSchemas.js';
import { TokenService } from '../../src/services/tokenService.js';

describe('age', () => {
  const now = new Date('2026-06-15T00:00:00Z');
  it('computes whole years and handles birthdays', () => {
    expect(ageFromDob('2008-06-15', now)).toBe(18);
    expect(ageFromDob('2008-06-16', now)).toBe(17);
    expect(ageFromDob('1990-01-01', now)).toBe(36);
  });
  it('rejects invalid / future dates', () => {
    expect(ageFromDob('2026-13-40', now)).toBe(null);
    expect(ageFromDob('2030-01-01', now)).toBe(null);
    expect(ageFromDob('nope', now)).toBe(null);
    expect(ageFromDob('2001-02-30', now)).toBe(null);
  });
  it('isAdult enforces the 18 floor', () => {
    expect(isAdult('2008-06-15', now)).toBe(true);
    expect(isAdult('2008-06-16', now)).toBe(false);
    expect(isAdult('1800-01-01', now)).toBe(false);
  });
});

describe('ban escalation', () => {
  it('escalates 24h -> 7d -> permanent', () => {
    expect(escalationDuration(0, 'harassment')).toBe(24 * 3600e3);
    expect(escalationDuration(1, 'harassment')).toBe(168 * 3600e3);
    expect(escalationDuration(2, 'harassment')).toBe(null);
    expect(escalationDuration(5, 'spam')).toBe(null);
  });
  it('CSAM / minor signals are always permanent', () => {
    expect(escalationDuration(0, 'csam')).toBe(null);
    expect(escalationDuration(0, 'minor')).toBe(null);
  });
  it('honours custom ladder', () => {
    expect(escalationDuration(0, 'spam', [1])).toBe(3600e3);
    expect(escalationDuration(1, 'spam', [1])).toBe(null);
  });
});

describe('settings', () => {
  it('defaults satisfy the schema', () => {
    expect(settingsSchema.safeParse(DEFAULT_SETTINGS).success).toBe(true);
  });
  it('deepMerge overrides nested keys only', () => {
    const m = deepMerge(structuredClone(DEFAULT_SETTINGS), { limits: { msgBurst: 9 } });
    expect(m.limits.msgBurst).toBe(9);
    expect(m.limits.msgPer10s).toBe(DEFAULT_SETTINGS.limits.msgPer10s);
  });
  it('rejects out-of-range and unknown keys', () => {
    expect(settingsSchema.safeParse(deepMerge(structuredClone(DEFAULT_SETTINGS), { limits: { msgBurst: 0 } })).success).toBe(false);
    expect(settingsSchema.safeParse(deepMerge(structuredClone(DEFAULT_SETTINGS), { limits: { nope: 1 } })).success).toBe(false);
  });
});

describe('identity generator', () => {
  it('is deterministic for a seed and random without one', () => {
    expect(generateIdentity('a:b')).toEqual(generateIdentity('a:b'));
    expect(generateIdentity('a:b').alias).not.toBe(generateIdentity('a:c').alias);
    expect(generateIdentity().alias).toMatch(/^[A-Z][a-z]+[A-Z][a-z]+\d{3}$/);
  });
});

describe('errors', () => {
  it('normalises typed, zod and unknown errors', () => {
    expect(toErrorPayload(tooMany('x', 3)).status).toBe(429);
    expect(toErrorPayload(new AppError(404, 'NOT_FOUND', 'n')).error.code).toBe('NOT_FOUND');
    const r = H.guestBody.safeParse({});
    expect(toErrorPayload(r.error).status).toBe(422);
    expect(toErrorPayload(new Error('boom'))).toEqual({ status: 500, error: { code: 'INTERNAL', message: 'Internal error' } });
  });
});

describe('validators', () => {
  it('socket chat:send requires strict shape and clientMsgId', () => {
    expect(S.chatSend.safeParse({ chatId: 'c', clientMsgId: 'abcdefgh12', text: 'hi' }).success).toBe(true);
    expect(S.chatSend.safeParse({ chatId: 'c', clientMsgId: 'short', text: 'hi' }).success).toBe(false);
    expect(S.chatSend.safeParse({ chatId: 'c', clientMsgId: 'abcdefgh12', text: 'hi', evil: 1 }).success).toBe(false);
    expect(S.chatSend.safeParse({ chatId: 'c', clientMsgId: 'abcdefgh12', text: 'x'.repeat(9000) }).success).toBe(false);
  });
  it('match:start normalises tags and caps them', () => {
    expect(S.matchStart.parse({ tags: ['#Cricket'] }).tags).toEqual(['#cricket']);
    expect(S.matchStart.safeParse({ tags: ['a', 'b', 'c', 'd', 'e', 'f'] }).success).toBe(false);
    expect(S.matchStart.safeParse({ genderPref: 'alien' }).success).toBe(false);
  });
  it('age gate requires literal true confirmation and a DOB', () => {
    expect(H.guestBody.safeParse({ dob: '2000-01-01', ageConfirmed: true }).success).toBe(true);
    expect(H.guestBody.safeParse({ dob: '2000-01-01', ageConfirmed: false }).success).toBe(false);
    expect(H.guestBody.safeParse({ dob: '01/01/2000', ageConfirmed: true }).success).toBe(false);
  });
  it('signup enforces password length and email format', () => {
    const base = { dob: '2000-01-01', ageConfirmed: true, email: 'A@B.com', password: 'longenough1' };
    expect(H.emailSignupBody.parse(base).email).toBe('a@b.com');
    expect(H.emailSignupBody.safeParse({ ...base, password: 'short' }).success).toBe(false);
    expect(H.emailSignupBody.safeParse({ ...base, email: 'nope' }).success).toBe(false);
  });
  it('phone must be E.164', () => {
    const age = { dob: '2000-01-01', ageConfirmed: true };
    expect(H.phoneRequestBody.safeParse({ ...age, phone: '+919876543210' }).success).toBe(true);
    expect(H.phoneRequestBody.safeParse({ ...age, phone: '9876543210' }).success).toBe(false);
    expect(H.phoneRequestBody.safeParse({ phone: '+919876543210' }).success).toBe(false); // age gate is mandatory
  });
});

describe('access tokens', () => {
  const ts = new TokenService(null);
  it('guest and registered tokens verify with their own secret and carry kind', () => {
    const g = ts.verifyAccess(ts.signAccess({ _id: 'g1', kind: 'guest' }, 'dev12345'));
    expect(g).toMatchObject({ userId: 'g1', kind: 'guest', deviceId: 'dev12345' });
    const r = ts.verifyAccess(ts.signAccess({ _id: 'r1', kind: 'registered', role: 'admin' }));
    expect(r).toMatchObject({ userId: 'r1', kind: 'registered', role: 'admin' });
  });
  it('rejects garbage and tampered tokens', () => {
    expect(() => ts.verifyAccess('abc')).toThrow();
    expect(() => ts.verifyAccess(null)).toThrow();
    const tok = ts.signAccess({ _id: 'r1', kind: 'registered' });
    expect(() => ts.verifyAccess(tok.slice(0, -2) + 'xx')).toThrow();
  });
});
