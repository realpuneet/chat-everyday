import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { loadConfig } from '../../src/config/env.js';

describe('environment config', () => {
  it('list variables are ARRAYS both when defaulted and when provided (regression)', () => {
    const d = loadConfig({ NODE_ENV: 'test' });
    expect(d.CORS_ORIGINS).toEqual(['http://localhost:5173']);
    expect(d.STUN_URLS).toEqual(['stun:stun.l.google.com:19302']);
    expect(d.TURN_URLS).toEqual([]);
    expect(d.ADMIN_EMAILS).toEqual([]);
    const p = loadConfig({ NODE_ENV: 'test', CORS_ORIGINS: 'https://a.example, https://b.example ', ADMIN_EMAILS: 'x@y.com' });
    expect(p.CORS_ORIGINS).toEqual(['https://a.example', 'https://b.example']);
    expect(p.ADMIN_EMAILS).toEqual(['x@y.com']);
  });

  it('external services default to DRY-RUN when credentials are blank', () => {
    const c = loadConfig({ NODE_ENV: 'test' });
    expect(c.dryRun).toEqual({ google: true, otp: true, storage: true, moderation: true, hashmatch: true, ageVerify: true, ipRisk: true });
    const real = loadConfig({ NODE_ENV: 'test', GOOGLE_CLIENT_ID: 'abc', OTP_PROVIDER: 'twilio' });
    expect(real.dryRun.google).toBe(false);
    expect(real.dryRun.otp).toBe(false);
  });

  it('production refuses to boot without real secrets (no dev defaults leak into prod)', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/JWT_ACCESS_SECRET.*ENCRYPTION_KEY|Missing required secrets/s);
    const key = crypto.randomBytes(32).toString('base64');
    const ok = loadConfig({ NODE_ENV: 'production', JWT_ACCESS_SECRET: 'a'.repeat(32), JWT_GUEST_SECRET: 'b'.repeat(32), PEPPER: 'c'.repeat(32), URL_SIGNING_SECRET: 'd'.repeat(32), ENCRYPTION_KEY: key });
    expect(ok.isProd).toBe(true);
    expect(ok.COOKIE_SECURE).toBe(true);
    expect(ok.ENCRYPTION_KEY_BUF.length).toBe(32);
  });

  it('rejects malformed encryption keys and invalid values', () => {
    expect(() => loadConfig({ NODE_ENV: 'test', ENCRYPTION_KEY: Buffer.from('short').toString('base64') })).toThrow(/32 bytes/);
    expect(() => loadConfig({ NODE_ENV: 'test', PORT: 'abc' })).toThrow(/Invalid environment/);
  });

  it('dev secrets are deterministic but distinct per purpose', () => {
    const c = loadConfig({ NODE_ENV: 'test' });
    expect(new Set([c.JWT_ACCESS_SECRET, c.JWT_GUEST_SECRET, c.PEPPER, c.URL_SIGNING_SECRET]).size).toBe(4);
  });
});
