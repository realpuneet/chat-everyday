import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { config } from '../config/env.js';
import { K } from '../config/redis.js';
import { sha256, randomId } from '../utils/crypto.js';
import { unauthorized } from '../utils/errors.js';

const ISS = 'chat-everyday';

export class TokenService {
  constructor(redis) {
    this.redis = redis;
  }

  /** Registered users get a 15m access token (secret A); guests a short-lived session token (secret B). */
  signAccess(user, deviceId) {
    const guest = user.kind === 'guest';
    const payload = { knd: guest ? 'guest' : 'registered', role: user.role || 'user', did: deviceId || null };
    return jwt.sign(payload, guest ? config.JWT_GUEST_SECRET : config.JWT_ACCESS_SECRET, {
      subject: String(user._id || user.id),
      expiresIn: guest ? config.GUEST_TTL_SEC : config.ACCESS_TTL_SEC,
      issuer: ISS,
      jwtid: randomId(8),
    });
  }

  verifyAccess(token) {
    if (!token || typeof token !== 'string') throw unauthorized('Missing token');
    const attempts = [
      [config.JWT_ACCESS_SECRET, 'registered'],
      [config.JWT_GUEST_SECRET, 'guest'],
    ];
    for (const [secret, kind] of attempts) {
      try {
        const p = jwt.verify(token, secret, { issuer: ISS, algorithms: ['HS256'] });
        if (p.knd !== kind) continue; // a token must be verified with the secret matching its kind
        return { userId: p.sub, kind: p.knd, role: p.role, deviceId: p.did, exp: p.exp };
      } catch (e) {
        if (e.name === 'TokenExpiredError') throw unauthorized('Token expired', { expired: true });
      }
    }
    throw unauthorized('Invalid token');
  }

  // ---- Rotating refresh tokens with reuse detection (stored in Redis, one family per login) ----

  async issueRefresh(userId, deviceId) {
    const family = randomId(12);
    const secret = randomId(32);
    const exp = Date.now() + config.REFRESH_TTL_SEC * 1000;
    const key = K.refreshFamily(family);
    await this.redis
      .multi()
      .hset(key, { uid: String(userId), cur: sha256(secret), prev: '', did: deviceId || '', exp })
      .expire(key, config.REFRESH_TTL_SEC)
      .sadd(K.userFamilies(userId), family)
      .expire(K.userFamilies(userId), config.REFRESH_TTL_SEC)
      .exec();
    return { token: `${family}.${secret}`, maxAgeMs: config.REFRESH_TTL_SEC * 1000 };
  }

  async rotateRefresh(raw) {
    const [family, secret] = String(raw || '').split('.');
    if (!family || !secret) throw unauthorized('Invalid refresh token');
    const key = K.refreshFamily(family);
    const rec = await this.redis.hgetall(key);
    if (!rec.uid) throw unauthorized('Session expired');
    const presented = sha256(secret);
    if (presented === rec.cur) {
      const next = randomId(32);
      await this.redis.hset(key, { prev: rec.cur, cur: sha256(next) });
      return { userId: rec.uid, deviceId: rec.did, token: `${family}.${next}`, maxAgeMs: Math.max(1000, Number(rec.exp) - Date.now()) };
    }
    if (rec.prev && presented === rec.prev) {
      // A rotated-out token was replayed: assume theft, kill the whole family.
      await this.revokeFamily(family, rec.uid);
      throw unauthorized('Refresh token reuse detected', { reuse: true });
    }
    throw unauthorized('Invalid refresh token');
  }

  async revokeRefresh(raw) {
    const [family] = String(raw || '').split('.');
    if (!family) return;
    const uid = await this.redis.hget(K.refreshFamily(family), 'uid');
    await this.revokeFamily(family, uid);
  }

  async revokeFamily(family, uid) {
    const m = this.redis.multi().del(K.refreshFamily(family));
    if (uid) m.srem(K.userFamilies(uid), family);
    await m.exec();
  }

  async revokeAllForUser(userId) {
    const families = await this.redis.smembers(K.userFamilies(userId));
    if (families.length) await this.redis.del(...families.map(K.refreshFamily));
    await this.redis.del(K.userFamilies(userId));
  }

  /** Time-limited TURN credentials compatible with coturn `use-auth-secret`. */
  turnCredentials(userId, { secret = config.TURN_SECRET, ttlSec = config.TURN_TTL_SEC } = {}) {
    const username = `${Math.floor(Date.now() / 1000) + ttlSec}:${userId}`;
    const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
    return { username, credential };
  }
}
