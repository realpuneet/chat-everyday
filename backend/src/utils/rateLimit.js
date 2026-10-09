import { uuid } from './crypto.js';
import { K } from '../config/redis.js';
import { tooMany } from './errors.js';

/** Redis-backed limiters. All state is in Redis so limits hold across instances. */
export class RateLimiter {
  constructor(redis) {
    this.redis = redis;
  }

  /** Token bucket: allows bursts up to `capacity`, refills `refillPerSec`. */
  async bucket(name, id, { capacity, refillPerSec, cost = 1 }) {
    const [allowed, left, retryMs] = await this.redis.tokenBucket(K.rl(name, id), capacity, refillPerSec, Date.now(), cost);
    return { allowed: allowed === 1, remaining: left, retryAfterMs: retryMs };
  }

  /** Sliding window log: at most `limit` events per `windowMs`. */
  async window(name, id, { limit, windowMs }) {
    const [allowed, count, retryMs] = await this.redis.slidingWindow(K.rl(name, id), limit, windowMs, Date.now(), uuid());
    return { allowed: allowed === 1, count, retryAfterMs: retryMs };
  }

  async assertWindow(name, id, opts, message) {
    const r = await this.window(name, id, opts);
    if (!r.allowed) throw tooMany(message || `Rate limit exceeded (${name})`, Math.ceil(r.retryAfterMs / 1000));
    return r;
  }

  async assertBucket(name, id, opts, message) {
    const r = await this.bucket(name, id, opts);
    if (!r.allowed) throw tooMany(message || `Slow down (${name})`, Math.ceil(r.retryAfterMs / 1000));
    return r;
  }
}
