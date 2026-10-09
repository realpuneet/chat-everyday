import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { makeRedis, makeLimiter } from '../helpers/redis.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let redis;
beforeAll(() => {
  redis = makeRedis();
});
afterAll(async () => redis.quit());
beforeEach(async () => redis.flushall());

describe('token bucket (real Redis)', () => {
  it('allows a burst up to capacity, then rejects with a retry hint, then refills', async () => {
    const rl = makeLimiter(redis);
    const results = [];
    for (let i = 0; i < 8; i++) results.push(await rl.bucket('t', 'u1', { capacity: 5, refillPerSec: 5 }));
    expect(results.filter((r) => r.allowed).length).toBe(5);
    expect(results[5].allowed).toBe(false);
    expect(results[5].retryAfterMs).toBeGreaterThan(0);
    expect(results[5].retryAfterMs).toBeLessThanOrEqual(250);
    await sleep(450);
    expect((await rl.bucket('t', 'u1', { capacity: 5, refillPerSec: 5 })).allowed).toBe(true);
  });

  it('is atomic under concurrency and shared across limiter instances (multi-instance safe)', async () => {
    const [a, b] = [makeLimiter(redis), makeLimiter(makeRedis())];
    const calls = Array.from({ length: 40 }, (_, i) => (i % 2 ? a : b).bucket('t', 'shared', { capacity: 10, refillPerSec: 0.001 }));
    const out = await Promise.all(calls);
    expect(out.filter((r) => r.allowed).length).toBe(10);
  });

  it('keeps users independent', async () => {
    const rl = makeLimiter(redis);
    for (let i = 0; i < 5; i++) await rl.bucket('t', 'a', { capacity: 5, refillPerSec: 0.001 });
    expect((await rl.bucket('t', 'a', { capacity: 5, refillPerSec: 0.001 })).allowed).toBe(false);
    expect((await rl.bucket('t', 'b', { capacity: 5, refillPerSec: 0.001 })).allowed).toBe(true);
  });
});

describe('sliding window (real Redis)', () => {
  it('enforces N events per window and recovers as events age out', async () => {
    const rl = makeLimiter(redis);
    const opts = { limit: 3, windowMs: 400 };
    expect((await rl.window('w', 'u', opts)).allowed).toBe(true);
    expect((await rl.window('w', 'u', opts)).allowed).toBe(true);
    expect((await rl.window('w', 'u', opts)).allowed).toBe(true);
    const blocked = await rl.window('w', 'u', opts);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterMs).toBeLessThanOrEqual(400);
    await sleep(450);
    expect((await rl.window('w', 'u', opts)).allowed).toBe(true);
  });

  it('assertWindow/assertBucket throw typed 429 errors with retry-after', async () => {
    const rl = makeLimiter(redis);
    await rl.assertWindow('x', 'u', { limit: 1, windowMs: 5000 });
    await expect(rl.assertWindow('x', 'u', { limit: 1, windowMs: 5000 })).rejects.toMatchObject({ status: 429, code: 'RATE_LIMITED', details: { retryAfterSec: expect.any(Number) } });
    await rl.assertBucket('y', 'u', { capacity: 1, refillPerSec: 0.1 });
    await expect(rl.assertBucket('y', 'u', { capacity: 1, refillPerSec: 0.1 })).rejects.toMatchObject({ status: 429 });
  });
});
