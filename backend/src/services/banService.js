import { Ban } from '../models/Ban.js';
import { User } from '../models/User.js';
import { K } from '../config/redis.js';
import { banned } from '../utils/errors.js';
import { IMMEDIATE_BAN_CATEGORIES } from './contentPolicy.js';
import { logger } from '../config/logger.js';

const HOUR = 3600 * 1000;

/**
 * Escalation ladder. First strike -> hours[0], second -> hours[1], third+ -> permanent.
 * Immediate-ban categories (CSAM, minors) are always permanent.
 * @returns {number|null} duration in ms, null = permanent
 */
export function escalationDuration(priorBans, category, hours = [24, 168]) {
  if (IMMEDIATE_BAN_CATEGORIES.includes(category)) return null;
  if (priorBans < hours.length) return hours[priorBans] * HOUR;
  return null;
}

export class BanService {
  constructor({ redis, settings, audit }) {
    this.redis = redis;
    this.settings = settings;
    this.audit = audit;
  }

  #cacheKey(type, value) {
    return K.ban(type, value);
  }

  async #cacheSet(ban) {
    const payload = JSON.stringify({ id: String(ban._id), reason: ban.reason, category: ban.category, until: ban.expiresAt ? +ban.expiresAt : null });
    const key = this.#cacheKey(ban.type, ban.value);
    if (ban.expiresAt) {
      const ttl = Math.ceil((+ban.expiresAt - Date.now()) / 1000);
      if (ttl > 0) await this.redis.set(key, payload, 'EX', ttl);
    } else {
      await this.redis.set(key, payload);
    }
  }

  /** Rebuild the Redis cache from Mongo (called on boot and periodically by the sweeper). */
  async warmCache() {
    const now = new Date();
    const bans = await Ban.find({ active: true, $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] }).lean();
    for (const b of bans) await this.#cacheSet(b);
    return bans.length;
  }

  /**
   * Check every identity attached to a request/socket. Returns the first ban found or null.
   * @param {{userId?:string, ipHash?:string, deviceHash?:string, identities?:string[]}} who
   */
  async check({ userId, ipHash, deviceHash, identities = [] }) {
    const probes = [];
    if (userId) probes.push(['account', userId]);
    if (ipHash) probes.push(['ip', ipHash]);
    if (deviceHash) probes.push(['device', deviceHash]);
    for (const i of identities) probes.push(['identity', i]);
    if (!probes.length) return null;
    const vals = await this.redis.mget(probes.map(([t, v]) => this.#cacheKey(t, v)));
    for (let i = 0; i < vals.length; i++) {
      if (vals[i]) return { type: probes[i][0], ...JSON.parse(vals[i]) };
    }
    return null;
  }

  async assertNotBanned(who) {
    const b = await this.check(who);
    if (b) throw banned('Your access has been restricted', { reason: b.reason, until: b.until, category: b.category, banId: b.id });
  }

  async create({ type, value, userId, reason, category = 'other', durationMs = null, createdBy = 'system', level = 1 }) {
    const ban = await Ban.create({
      type,
      value,
      userId,
      reason,
      category,
      level,
      createdBy,
      expiresAt: durationMs ? new Date(Date.now() + durationMs) : null,
    });
    await this.#cacheSet(ban);
    return ban;
  }

  /**
   * Ban a user across account + device + IP (+ linked identities). IP bans are capped at 7 days
   * because shared / carrier-grade NAT IPs would otherwise lock out innocent users.
   */
  async banUser(userId, { reason, category = 'other', createdBy = 'system', durationMs, ipHashes = [], deviceHashes = [], identities = [] }) {
    const user = await User.findById(userId);
    const prior = user?.banCount ?? 0;
    const hours = (await this.settings.get()).moderation.banEscalationHours;
    const duration = durationMs === undefined ? escalationDuration(prior, category, hours) : durationMs;
    const level = prior + 1;
    const opts = { reason, category, createdBy, level };
    const ipCap = duration === null ? 7 * 24 * HOUR : Math.min(duration, 7 * 24 * HOUR);

    const created = [await this.create({ type: 'account', value: String(userId), userId: String(userId), durationMs: duration, ...opts })];
    const allIps = [...new Set([...ipHashes, ...(user?.ipHashes ?? []).slice(-3)])];
    const allDevices = [...new Set([...deviceHashes, ...(user?.deviceHashes ?? []).slice(-3)])];
    for (const ip of allIps) created.push(await this.create({ type: 'ip', value: ip, userId: String(userId), durationMs: ipCap, ...opts }));
    for (const d of allDevices) created.push(await this.create({ type: 'device', value: d, userId: String(userId), durationMs: duration, ...opts }));
    for (const i of identities) created.push(await this.create({ type: 'identity', value: i, userId: String(userId), durationMs: duration, ...opts }));
    await User.updateOne({ _id: userId }, { $inc: { banCount: 1 } });
    await this.audit.log({
      actorId: createdBy,
      actorType: createdBy === 'system' ? 'system' : 'admin',
      action: 'ban.create',
      targetType: 'user',
      targetId: userId,
      severity: duration === null ? 'critical' : 'warn',
      meta: { reason, category, level, permanent: duration === null, durationMs: duration, records: created.length },
    });
    logger.warn({ userId, category, permanent: duration === null }, 'user banned');
    return { permanent: duration === null, until: duration ? Date.now() + duration : null, level };
  }

  async lift(banId, adminId) {
    const ban = await Ban.findById(banId);
    if (!ban || !ban.active) return null;
    // Lift every record created in the same action (same user + createdAt second) so unban is complete.
    const siblings = await Ban.find({ userId: ban.userId, active: true, createdAt: { $gte: new Date(+ban.createdAt - 2000), $lte: new Date(+ban.createdAt + 2000) } });
    const all = siblings.length ? siblings : [ban];
    for (const b of all) {
      b.active = false;
      b.liftedBy = adminId;
      b.liftedAt = new Date();
      await b.save();
      await this.redis.del(this.#cacheKey(b.type, b.value));
    }
    await this.audit.log({ actorId: adminId, actorType: 'admin', action: 'ban.lift', targetType: 'user', targetId: ban.userId, meta: { banId, records: all.length } });
    return all.length;
  }

  async list({ active = true, limit = 100 } = {}) {
    const q = active ? { active: true, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] } : {};
    return Ban.find(q).sort({ createdAt: -1 }).limit(limit).lean();
  }
}
