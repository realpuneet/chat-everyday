import { K } from '../config/redis.js';

const EVENT_TTL_SEC = 2 * 3600;
const MAX_EVENTS = 200;

/**
 * Ephemeral per-conversation event log in Redis (ring buffer). Powers:
 *  - reconnect/resume (client sends lastSeq and receives what it missed)
 *  - report evidence (last N messages)
 * Entries expire automatically; nothing here is written to MongoDB.
 */
export class EventStore {
  constructor({ redis }) {
    this.redis = redis;
  }

  #keys(scope, id) {
    return scope === 'room' ? [K.roomSeq(id), K.roomEvents(id)] : [K.chatSeq(id), K.chatEvents(id)];
  }

  async append(scope, id, event) {
    const [seqKey, listKey] = this.#keys(scope, id);
    const seq = await this.redis.incr(seqKey);
    const full = { ...event, seq, ts: event.ts ?? Date.now() };
    await this.redis.multi().rpush(listKey, JSON.stringify(full)).ltrim(listKey, -MAX_EVENTS, -1).expire(listKey, EVENT_TTL_SEC).expire(seqKey, EVENT_TTL_SEC).exec();
    return full;
  }

  async after(scope, id, lastSeq = 0) {
    const [, listKey] = this.#keys(scope, id);
    const raw = await this.redis.lrange(listKey, 0, -1);
    return raw.map((r) => JSON.parse(r)).filter((e) => e.seq > lastSeq);
  }

  async recent(scope, id, n = 20) {
    const [, listKey] = this.#keys(scope, id);
    const raw = await this.redis.lrange(listKey, -n, -1);
    return raw.map((r) => JSON.parse(r));
  }

  /** Keep the buffer around for reports after a chat ended, but not for long. */
  async shorten(scope, id, ttlSec = 3600) {
    const [seqKey, listKey] = this.#keys(scope, id);
    await this.redis.multi().expire(listKey, ttlSec).expire(seqKey, ttlSec).exec();
  }

  /** Idempotency for client retries: returns the previous ack if this clientMsgId was already handled. */
  async beginIdempotent(userId, clientMsgId) {
    const key = K.idem(userId, clientMsgId);
    const ok = await this.redis.set(key, 'pending', 'EX', 300, 'NX');
    if (ok) return { first: true };
    for (let i = 0; i < 10; i++) {
      const v = await this.redis.get(key);
      if (v && v !== 'pending') return { first: false, ack: JSON.parse(v) };
      await new Promise((r) => setTimeout(r, 30));
    }
    return { first: false, ack: null };
  }

  async completeIdempotent(userId, clientMsgId, ack) {
    await this.redis.set(K.idem(userId, clientMsgId), JSON.stringify(ack), 'EX', 300);
  }

  async abortIdempotent(userId, clientMsgId) {
    await this.redis.del(K.idem(userId, clientMsgId));
  }
}
