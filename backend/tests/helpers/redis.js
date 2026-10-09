import { createRedis } from '../../src/config/redis.js';
import { MatchingService } from '../../src/services/matchingService.js';
import { RateLimiter } from '../../src/utils/rateLimit.js';

export function makeRedis() {
  return createRedis(process.env.REDIS_URL);
}

/** Matching service whose settings never hit Mongo (pure Redis tests). */
export function makeMatching(redis, overrides = {}) {
  const base = {
    matching: { fallbackMs: 8000, cooldownSec: 600, maxWaitMs: 120000, disconnectGraceMs: 10000, scan: 50, ...overrides },
  };
  const settings = { get: async () => base };
  return { matching: new MatchingService({ redis, settings }), settings };
}

export const makeLimiter = (redis) => new RateLimiter(redis);
