import crypto from 'node:crypto';
import { K } from '../config/redis.js';
import { hashIdentity, hmac, timingSafeEqualStr } from '../utils/crypto.js';
import { AppError, tooMany, forbidden, badRequest } from '../utils/errors.js';
import { logger } from '../config/logger.js';
import { config } from '../config/env.js';

const OTP_TTL_SEC = 300;
const RESEND_COOLDOWN_SEC = 30;
const MAX_ATTEMPTS = 5;
const HOUR = 3600_000;

/**
 * Phone OTP with layered abuse protection:
 *  - allow-listed country codes (SMS-pumping to premium / unexpected destinations is the main cost attack)
 *  - per-phone resend cooldown + hourly cap, per-IP + per-device hourly caps
 *  - max distinct phone numbers per IP per hour
 *  - global send-rate circuit breaker
 *  - per-code attempt limit and per-phone verify lockout
 */
export class OtpService {
  constructor({ redis, limiter, settings, provider, audit }) {
    Object.assign(this, { redis, limiter, settings, provider, audit });
  }

  static normalise(phone) {
    return phone.replace(/[\s()-]/g, '');
  }

  async request(rawPhone, client) {
    const phone = OtpService.normalise(rawPhone);
    const cfg = (await this.settings.get()).auth;
    if (!cfg.phoneAllowedCountryCodes.some((cc) => phone.startsWith(cc))) {
      throw forbidden('Phone numbers from this country are not supported yet', { code: 'COUNTRY_NOT_ALLOWED' });
    }
    if (this.provider.mode !== 'sms') throw badRequest('This deployment verifies phones on the client (send idToken)', { code: 'USE_CLIENT_TOKEN' });
    const ph = hashIdentity('phone', phone);
    const ipKey = client.ipHash || 'unknown';

    // 1. resend cooldown (cheap, checked first)
    const cd = await this.redis.set(K.otpCooldown(ph), '1', 'EX', RESEND_COOLDOWN_SEC, 'NX');
    if (!cd) {
      const ttl = await this.redis.ttl(K.otpCooldown(ph));
      throw tooMany('Please wait before requesting another code', Math.max(ttl, 1));
    }
    try {
      // 2. global circuit breaker against SMS pumping
      const g = await this.limiter.window('otp-global', 'all', { limit: 300, windowMs: 60_000 });
      if (!g.allowed) {
        await this.audit.log({ action: 'otp.global_limit', severity: 'critical', meta: { note: 'possible SMS pumping' } });
        throw new AppError(503, 'OTP_PAUSED', 'Phone verification is temporarily unavailable');
      }
      // 3. per-phone / per-IP / per-device hourly caps
      await this.limiter.assertWindow('otp-phone', ph, { limit: 3, windowMs: HOUR }, 'Too many codes requested for this number');
      await this.limiter.assertWindow('otp-ip', ipKey, { limit: 8, windowMs: HOUR }, 'Too many codes requested from this network');
      if (client.deviceHash) await this.limiter.assertWindow('otp-dev', client.deviceHash, { limit: 5, windowMs: HOUR }, 'Too many codes requested from this device');
      // 4. distinct numbers per IP
      const dk = `otpips:${ipKey}`;
      await this.redis.sadd(dk, ph);
      await this.redis.expire(dk, 3600);
      if ((await this.redis.scard(dk)) > 3) throw tooMany('Too many different numbers from this network', 3600);
      // 5. lockout after repeated verify failures
      if (await this.redis.exists(`otplock:${ph}`)) throw tooMany('Too many failed attempts. Try again later.', 900);
    } catch (e) {
      await this.redis.del(K.otpCooldown(ph));
      throw e;
    }

    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    await this.redis
      .multi()
      .hset(K.otp(ph), { h: hmac(`${code}:${ph}`), attempts: 0 })
      .expire(K.otp(ph), OTP_TTL_SEC)
      .exec();
    try {
      await this.provider.send(phone, code);
    } catch (e) {
      logger.error({ err: e.message, provider: this.provider.name }, 'otp send failed');
      await this.redis.multi().del(K.otp(ph)).del(K.otpCooldown(ph)).exec();
      throw new AppError(502, 'OTP_SEND_FAILED', 'Could not send the code, try again shortly');
    }
    return { sent: true, cooldownSec: RESEND_COOLDOWN_SEC, expiresInSec: OTP_TTL_SEC, ...(this.provider.dryRun && config.demo ? { devCode: code, dryRun: true } : {}) };
  }

  /** @returns {string} normalised E.164 phone on success */
  async verify(rawPhone, code) {
    const phone = OtpService.normalise(rawPhone);
    const ph = hashIdentity('phone', phone);
    if (await this.redis.exists(`otplock:${ph}`)) throw tooMany('Too many failed attempts. Try again later.', 900);
    const rec = await this.redis.hgetall(K.otp(ph));
    if (!rec.h) throw badRequest('Code expired or not requested', { code: 'OTP_EXPIRED' });
    const attempts = await this.redis.hincrby(K.otp(ph), 'attempts', 1);
    if (attempts > MAX_ATTEMPTS) {
      await this.redis.del(K.otp(ph));
      throw tooMany('Too many wrong attempts. Request a new code.', 60);
    }
    if (!timingSafeEqualStr(rec.h, hmac(`${code}:${ph}`))) {
      const fails = await this.redis.incr(`otpfail:${ph}`);
      await this.redis.expire(`otpfail:${ph}`, 3600);
      if (fails >= 10) await this.redis.set(`otplock:${ph}`, '1', 'EX', 900);
      throw new AppError(401, 'OTP_INVALID', 'Incorrect code', { attemptsLeft: Math.max(0, MAX_ATTEMPTS - attempts) });
    }
    await this.redis.multi().del(K.otp(ph)).del(`otpfail:${ph}`).exec();
    return phone;
  }

  /** Client-token mode (Firebase). */
  async verifyClientToken(idToken) {
    if (!this.provider.verifyIdToken) throw badRequest('Client-token phone verification is not enabled');
    try {
      return await this.provider.verifyIdToken(idToken);
    } catch (e) {
      logger.warn({ err: e.message }, 'phone id token rejected');
      throw new AppError(401, 'OTP_INVALID', 'Invalid phone verification token');
    }
  }
}
