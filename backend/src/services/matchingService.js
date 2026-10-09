import { K } from '../config/redis.js';
import { uuid } from '../utils/crypto.js';
import { normalizeTags } from './matchingRules.js';

const GENDERS = ['male', 'female', 'nonbinary', 'undisclosed'];

/**
 * Thin JS wrapper around the atomic Lua matcher. All pairing decisions happen inside Redis
 * (single-threaded script) so a user can never be matched with two people.
 */
export class MatchingService {
  constructor({ redis, settings }) {
    this.redis = redis;
    this.settings = settings;
  }

  /** @returns {{status:'queued'|'matched'|'in_chat', ...}} */
  async join(userId, { tags = [], lang = '', gender = 'undisclosed', pref = 'any' } = {}) {
    const s = (await this.settings.get()).matching;
    const g = GENDERS.includes(gender) ? gender : 'undisclosed';
    const p = pref === 'any' || GENDERS.includes(pref) ? pref : 'any';
    const res = await this.redis.mmJoin(
      K.ticket(userId),
      userId,
      normalizeTags(tags).join(','),
      String(lang || '').toLowerCase().slice(0, 8),
      g,
      p,
      Date.now(),
      s.fallbackMs,
      uuid(),
      s.cooldownSec,
      Math.ceil(s.maxWaitMs / 1000) + 30,
      s.scan,
    );
    return this.#parse(res, userId);
  }

  async retry(userId) {
    const s = (await this.settings.get()).matching;
    const res = await this.redis.mmRetry(K.ticket(userId), userId, Date.now(), uuid(), s.cooldownSec, s.scan);
    return this.#parse(res, userId);
  }

  /** Leave queue and/or active chat. Returns what was cleaned up. */
  async leave(userId) {
    const [kind, chatId, partnerId] = await this.redis.mmLeave(K.ticket(userId), userId);
    return { kind, chatId: chatId || null, partnerId: partnerId || null };
  }

  async activeChat(userId) {
    const chatId = await this.redis.get(K.userChat(userId));
    if (!chatId) return null;
    const c = await this.redis.hgetall(K.chat(chatId));
    if (!c.a) return null;
    return { chatId, partnerId: c.a === userId ? c.b : c.a, startedAt: Number(c.at), sharedTags: c.tags ? c.tags.split(',') : [] };
  }

  async isParticipant(chatId, userId) {
    return (await this.redis.sismember(K.chatParticipants(chatId), userId)) === 1;
  }

  async isQueued(userId) {
    return (await this.redis.exists(K.ticket(userId))) === 1;
  }

  async setBlocked(userId, blockedIds) {
    const key = K.blocked(userId);
    const m = this.redis.multi().del(key);
    if (blockedIds.length) m.sadd(key, ...blockedIds);
    await m.exec();
  }

  async addBlock(userId, targetId) {
    await this.redis.sadd(K.blocked(userId), targetId);
  }

  /** Users whose fallback timer is due get a second matching attempt. */
  async claimDueFallbacks(limit = 200) {
    return this.redis.zClaimDue(K.qFallback, Date.now(), limit);
  }

  async sweepStale() {
    const s = (await this.settings.get()).matching;
    return this.redis.mmSweepStale(K.qGeneral, Date.now() - s.maxWaitMs);
  }

  // ---- disconnect grace ----
  async scheduleDisconnect(userId, graceMs) {
    await this.redis.zadd(K.disc, Date.now() + graceMs, userId);
  }
  async cancelDisconnect(userId) {
    return this.redis.zrem(K.disc, userId);
  }
  async claimDueDisconnects(limit = 200) {
    return this.redis.zClaimDue(K.disc, Date.now(), limit);
  }

  async queueStats() {
    const [waiting, activeChats] = await Promise.all([this.redis.zcard(K.qGeneral), this.redis.scard('{mm}:chats')]);
    return { waiting, activeChats };
  }

  #parse(res, userId) {
    const [status, a, b, c] = res;
    if (status === 'matched') return { status, chatId: a, partnerId: b, sharedTags: c ? c.split(',') : [], userId };
    if (status === 'in_chat') return { status, chatId: a, partnerId: b, userId };
    return { status: 'queued', fallbackAt: a ? Number(a) : undefined, userId };
  }
}
