import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { encrypt, decrypt, deriveKey, signUrlParams, verifyUrlSig, totp, verifyTotp, newTotpSecret, base32Encode, base32Decode, hashIp, hashDevice, timingSafeEqualStr } from '../../src/utils/crypto.js';

describe('crypto helpers', () => {
  const master = crypto.randomBytes(32);

  it('AES-256-GCM round trips unicode', () => {
    const key = deriveKey(master, 'doc:1');
    const enc = encrypt('namaste 🙏 नमस्ते', key, 'aad');
    expect(decrypt(enc, key, 'aad')).toBe('namaste 🙏 नमस्ते');
  });

  it('uses a fresh IV every time', () => {
    const key = deriveKey(master, 'doc:1');
    expect(encrypt('x', key).iv).not.toBe(encrypt('x', key).iv);
  });

  it('rejects tampering, wrong key and wrong AAD', () => {
    const key = deriveKey(master, 'doc:1');
    const enc = encrypt('secret', key, 'a');
    expect(() => decrypt({ ...enc, ct: Buffer.from('zzzz').toString('base64url') }, key, 'a')).toThrow();
    expect(() => decrypt(enc, deriveKey(master, 'doc:2'), 'a')).toThrow();
    expect(() => decrypt(enc, key, 'b')).toThrow();
    const t = Buffer.from(enc.tag, 'base64url');
    t[0] ^= 1;
    expect(() => decrypt({ ...enc, tag: t.toString('base64url') }, key, 'a')).toThrow();
  });

  it('derived keys differ per context and are 32 bytes', () => {
    expect(deriveKey(master, 'a').equals(deriveKey(master, 'b'))).toBe(false);
    expect(deriveKey(master, 'a')).toHaveLength(32);
  });

  it('signed URL params verify, expire and are bound to path/extra', () => {
    const exp = Date.now() + 5000;
    const sig = signUrlParams('/p', exp, 'x');
    expect(verifyUrlSig('/p', exp, 'x', sig)).toBe(true);
    expect(verifyUrlSig('/q', exp, 'x', sig)).toBe(false);
    expect(verifyUrlSig('/p', exp, 'y', sig)).toBe(false);
    const past = Date.now() - 1;
    expect(verifyUrlSig('/p', past, 'x', signUrlParams('/p', past, 'x'))).toBe(false);
  });

  it('TOTP matches RFC 6238 test vector (SHA1, 8 digits)', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(totp(secret, 59_000, 30, 8)).toBe('94287082');
    expect(totp(secret, 1111111109_000, 30, 8)).toBe('07081804');
  });

  it('verifies TOTP within window only', () => {
    const s = newTotpSecret();
    expect(verifyTotp(s, totp(s))).toBe(true);
    expect(verifyTotp(s, '000000') || verifyTotp(s, '000001')).toBe(false);
    expect(base32Decode(base32Encode(Buffer.from('hello'))).toString()).toBe('hello');
  });

  it('hashes identifiers deterministically without leaking them', () => {
    expect(hashIp('1.2.3.4')).toBe(hashIp('1.2.3.4'));
    expect(hashIp('1.2.3.4')).not.toContain('1.2.3.4');
    expect(hashDevice('abc')).not.toBe(hashIp('abc'));
    expect(timingSafeEqualStr('a', 'a')).toBe(true);
    expect(timingSafeEqualStr('a', 'ab')).toBe(false);
  });
});
