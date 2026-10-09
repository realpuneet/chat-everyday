import crypto from 'node:crypto';
import { config } from '../config/env.js';

export const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
export const hmac = (v, key = config.PEPPER) => crypto.createHmac('sha256', key).update(String(v)).digest('hex');
export const randomId = (bytes = 12) => crypto.randomBytes(bytes).toString('base64url');
export const uuid = () => crypto.randomUUID();
export const hashIp = (ip) => (ip ? hmac(`ip:${ip}`).slice(0, 32) : '');
export const hashDevice = (d) => (d ? hmac(`dev:${d}`).slice(0, 32) : '');
export const hashIdentity = (kind, value) => hmac(`${kind}:${String(value).toLowerCase().trim()}`).slice(0, 40);

export function timingSafeEqualStr(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

/** HKDF-derived per-document data key so one leaked doc key does not expose others. */
export function deriveKey(masterKey, context) {
  return Buffer.from(crypto.hkdfSync('sha256', masterKey, Buffer.alloc(0), Buffer.from(context), 32));
}

/** AES-256-GCM. Returns base64url fields; `aad` binds ciphertext to its context. */
export function encrypt(plaintext, key, aad = '') {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  return {
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ct: ct.toString('base64url'),
  };
}

export function decrypt({ iv, tag, ct }, key, aad = '') {
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  if (aad) d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

/** Short-lived signed URL tokens (local storage delivery, uploads). */
export function signUrlParams(path, expiresAtMs, extra = '', secret = config.URL_SIGNING_SECRET) {
  return crypto.createHmac('sha256', secret).update(`${path}|${expiresAtMs}|${extra}`).digest('base64url');
}
export function verifyUrlSig(path, expiresAtMs, extra, sig, secret = config.URL_SIGNING_SECRET) {
  if (!sig || Number(expiresAtMs) < Date.now()) return false;
  return timingSafeEqualStr(signUrlParams(path, expiresAtMs, extra, secret), sig);
}

// ---- TOTP (RFC 6238) for the optional admin 2FA hook ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(buf) {
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}
export function base32Decode(str) {
  let bits = '';
  for (const c of str.replace(/=+$/, '').toUpperCase()) bits += B32.indexOf(c).toString(2).padStart(5, '0');
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}
export function totp(secretB32, atMs = Date.now(), step = 30, digits = 6) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 1000 / step)));
  const h = crypto.createHmac('sha1', base32Decode(secretB32)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h.readUInt32BE(o) & 0x7fffffff) % 10 ** digits).toString().padStart(digits, '0');
  return code;
}
export function verifyTotp(secretB32, code, window = 1) {
  const now = Date.now();
  for (let w = -window; w <= window; w++) {
    if (timingSafeEqualStr(totp(secretB32, now + w * 30000), String(code))) return true;
  }
  return false;
}
export const newTotpSecret = () => base32Encode(crypto.randomBytes(20));
