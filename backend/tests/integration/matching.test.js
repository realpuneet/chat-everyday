import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { makeRedis, makeMatching } from '../helpers/redis.js';
import { K } from '../../src/config/redis.js';
import { CASES, FIXTURE_NOW } from '../fixtures/matchCases.js';
import { uuid } from '../../src/utils/crypto.js';

let redis;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const uid = (() => {
  let n = 0;
  return (p = 'u') => `${p}${++n}_${Math.random().toString(36).slice(2, 6)}`;
})();

beforeAll(() => {
  redis = makeRedis();
});
afterAll(async () => {
  await redis.quit();
});
beforeEach(async () => {
  await redis.flushall();
});

/** Invariant checker: every chat has exactly two distinct users, and each user is in at most one chat. */
async function assertConsistent(userIds) {
  const seenChats = new Map();
  for (const u of userIds) {
    const cid = await redis.get(K.userChat(u));
    if (!cid) continue;
    const c = await redis.hgetall(K.chat(cid));
    expect([c.a, c.b]).toContain(u);
    expect(c.a).not.toBe(c.b);
    const other = c.a === u ? c.b : c.a;
    expect(await redis.get(K.userChat(other))).toBe(cid);
    seenChats.set(cid, new Set([c.a, c.b]));
  }
  return seenChats;
}

describe('Lua matcher vs shared fixtures', () => {
  for (const c of CASES) {
    it(c.name, async () => {
      const { matching } = makeMatching(redis, { fallbackMs: 100_000, cooldownSec: 600 });
      const a = uid('a');
      const b = uid('b');
      // Re-create the fixture conditions in real time: "past" fallback = no tags OR fallbackMs 0.
      const prep = async (id, t) => {
        // Write the ticket directly so fallbackAt matches the fixture exactly.
        const now = Date.now();
        const fb = t.fallbackAt <= FIXTURE_NOW ? now - 1 : now + 100_000;
        await redis.hset(K.ticket(id), { uid: id, tags: t.tags.join(','), lang: t.lang, gender: t.gender, pref: t.pref, at: now - (id === a ? 500 : 1000), fb });
        await redis.expire(K.ticket(id), 600);
        await redis.zadd(K.qGeneral, now - 1000, id);
        for (const tag of t.tags) {
          await redis.zadd(K.qTag(tag), now - 1000, id);
          await redis.sadd(K.tags, tag);
        }
        if (t.tags.length) await redis.zadd(K.qFallback, fb, id);
      };
      if (c.blocked) await matching.setBlocked(a, [b]);
      if (c.cooldown) await redis.set(K.cooldown(a, b), '1', 'EX', 600);
      await prep(b, c.cand); // candidate is already waiting
      await prep(a, c.me);
      const res = await matching.retry(a);
      expect(res.status === 'matched').toBe(c.expect);
      if (c.expect) expect(res.partnerId).toBe(b);
    });
  }
});

describe('matching flow', () => {
  it('pairs two general users and records chat state both ways', async () => {
    const { matching } = makeMatching(redis);
    const a = uid();
    const b = uid();
    expect((await matching.join(a, {})).status).toBe('queued');
    const r = await matching.join(b, {});
    expect(r.status).toBe('matched');
    expect(r.partnerId).toBe(a);
    expect((await matching.activeChat(a)).partnerId).toBe(b);
    expect((await matching.activeChat(b)).partnerId).toBe(a);
    expect(await matching.isParticipant(r.chatId, a)).toBe(true);
    expect(await redis.zcard(K.qGeneral)).toBe(0);
  });

  it('matches by shared tag immediately and reports shared tags', async () => {
    const { matching } = makeMatching(redis);
    const a = uid();
    const b = uid();
    await matching.join(a, { tags: ['cricket', 'music'] });
    const r = await matching.join(b, { tags: ['music'] });
    expect(r.status).toBe('matched');
    expect(r.sharedTags).toEqual(['music']);
  });

  it('prefers the candidate with more overlapping tags', async () => {
    const { matching } = makeMatching(redis);
    const [x, y, me] = [uid(), uid(), uid()];
    // different languages keep x and y from matching each other; `me` (any language) fits both
    await matching.join(x, { tags: ['a'], lang: 'en' });
    await matching.join(y, { tags: ['a', 'b'], lang: 'hi' });
    const r = await matching.join(me, { tags: ['a', 'b'] });
    expect(r.partnerId).toBe(y);
  });

  it('is idempotent for a user already in a chat (no second match)', async () => {
    const { matching } = makeMatching(redis);
    const [a, b, c] = [uid(), uid(), uid()];
    await matching.join(a, {});
    const first = await matching.join(b, {});
    await matching.join(c, {});
    const again = await matching.join(b, {});
    expect(again.status).toBe('in_chat');
    expect(again.chatId).toBe(first.chatId);
    expect(await matching.isQueued(c)).toBe(true);
  });

  it('leave() ends the chat for both and frees them to match again', async () => {
    const { matching } = makeMatching(redis, { cooldownSec: 0 });
    const [a, b] = [uid(), uid()];
    await matching.join(a, {});
    const m = await matching.join(b, {});
    const left = await matching.leave(a);
    expect(left).toMatchObject({ kind: 'left_chat', chatId: m.chatId, partnerId: b });
    expect(await matching.activeChat(a)).toBe(null);
    expect(await matching.activeChat(b)).toBe(null);
    expect((await matching.leave(b)).kind).toBe('noop');
    await matching.join(a, {});
    expect((await matching.join(b, {})).status).toBe('matched');
  });

  it('leave() removes a waiting user from every queue', async () => {
    const { matching } = makeMatching(redis);
    const a = uid();
    await matching.join(a, { tags: ['x', 'y'] });
    expect(await redis.zcard(K.qTag('x'))).toBe(1);
    expect((await matching.leave(a)).kind).toBe('dequeued');
    expect(await redis.zcard(K.qGeneral)).toBe(0);
    expect(await redis.zcard(K.qTag('x'))).toBe(0);
    expect(await redis.zcard(K.qTag('y'))).toBe(0);
    expect(await redis.zcard(K.qFallback)).toBe(0);
    expect(await redis.exists(K.ticket(a))).toBe(0);
  });

  it('re-joining replaces the old ticket instead of duplicating queue entries', async () => {
    const { matching } = makeMatching(redis);
    const a = uid();
    await matching.join(a, { tags: ['x'] });
    await matching.join(a, { tags: ['y'] });
    expect(await redis.zcard(K.qGeneral)).toBe(1);
    expect(await redis.zcard(K.qTag('x'))).toBe(0);
    expect(await redis.zcard(K.qTag('y'))).toBe(1);
  });

  it('recently-matched pair is not re-matched during cooldown, but is after it expires', async () => {
    const { matching } = makeMatching(redis, { cooldownSec: 1 });
    const [a, b] = [uid(), uid()];
    await matching.join(a, {});
    await matching.join(b, {});
    await matching.leave(a);
    await matching.join(a, {});
    expect((await matching.join(b, {})).status).toBe('queued'); // cooldown active
    await matching.leave(a);
    await matching.leave(b);
    await sleep(1200);
    await matching.join(a, {});
    expect((await matching.join(b, {})).status).toBe('matched');
  });

  it('blocked users never match, in either direction', async () => {
    const { matching } = makeMatching(redis);
    const [a, b] = [uid(), uid()];
    await matching.setBlocked(a, [b]);
    await matching.join(b, {});
    expect((await matching.join(a, {})).status).toBe('queued');
    await matching.leave(a);
    await matching.leave(b);
    await matching.join(a, {});
    expect((await matching.join(b, {})).status).toBe('queued');
  });

  it('gender preference + language filters apply on join', async () => {
    const { matching } = makeMatching(redis);
    const [m, f, hi] = [uid(), uid(), uid()];
    await matching.join(f, { gender: 'female', pref: 'any', lang: 'en' });
    // male wants male only -> skips the female candidate
    expect((await matching.join(m, { gender: 'male', pref: 'male' })).status).toBe('queued');
    await matching.leave(m);
    // language mismatch
    expect((await matching.join(hi, { gender: 'male', lang: 'hi' })).status).toBe('queued');
  });

  it('fallback: tag-only users with different tags match only after the fallback window', async () => {
    const { matching } = makeMatching(redis, { fallbackMs: 400 });
    const [a, b] = [uid(), uid()];
    await matching.join(a, { tags: ['cricket'] });
    expect((await matching.join(b, { tags: ['music'] })).status).toBe('queued');
    expect(await matching.claimDueFallbacks()).toEqual([]); // too early
    await sleep(500);
    const due = await matching.claimDueFallbacks();
    expect(due.sort()).toEqual([a, b].sort());
    // a retries first: both are now fallback-eligible -> match
    const r = await matching.retry(a);
    expect(r.status).toBe('matched');
    expect(r.partnerId).toBe(b);
    // claimed entries are not claimed twice
    expect(await matching.claimDueFallbacks()).toEqual([]);
  });

  it('fallback timer is ~8s by default (fallbackAt reflects settings)', async () => {
    const { matching } = makeMatching(redis);
    const a = uid();
    const t0 = Date.now();
    const r = await matching.join(a, { tags: ['cricket'] });
    expect(r.fallbackAt - t0).toBeGreaterThanOrEqual(7900);
    expect(r.fallbackAt - t0).toBeLessThan(8500);
    const noTags = await matching.join(uid(), {});
    expect(noTags.status).toBe('queued');
  });

  it('stale sweeper removes expired queue entries from all queues', async () => {
    const { matching } = makeMatching(redis, { maxWaitMs: 300 });
    const a = uid();
    await matching.join(a, { tags: ['x'] });
    await sleep(450);
    expect(await matching.sweepStale()).toEqual([a]);
    expect(await redis.zcard(K.qGeneral)).toBe(0);
    expect(await redis.zcard(K.qTag('x'))).toBe(0);
    expect(await redis.exists(K.ticket(a))).toBe(0);
  });

  it('orphaned queue entries (ticket expired) are skipped and cleaned, never matched', async () => {
    const { matching } = makeMatching(redis);
    const [ghost, b] = [uid(), uid()];
    await redis.zadd(K.qGeneral, Date.now() - 1000, ghost); // no ticket hash
    const r = await matching.join(b, {});
    expect(r.status).toBe('queued');
    expect(await redis.zscore(K.qGeneral, ghost)).toBe(null);
  });

  it('disconnect during queue/match: leave frees the partner; grace entries are claimable once', async () => {
    const { matching } = makeMatching(redis);
    const [a, b] = [uid(), uid()];
    await matching.join(a, {});
    await matching.join(b, {});
    await matching.scheduleDisconnect(a, 150);
    await matching.cancelDisconnect(a); // reconnected within grace
    await sleep(200);
    expect(await matching.claimDueDisconnects()).toEqual([]);
    await matching.scheduleDisconnect(a, 50);
    await sleep(100);
    expect(await matching.claimDueDisconnects()).toEqual([a]);
    expect(await matching.claimDueDisconnects()).toEqual([]);
    const left = await matching.leave(a);
    expect(left.partnerId).toBe(b);
    expect(await matching.activeChat(b)).toBe(null);
  });

  it('cooldown/chat keys are all under the {mm} hash tag (cluster-safe)', async () => {
    const { matching } = makeMatching(redis);
    const [a, b] = [uid(), uid()];
    await matching.join(a, { tags: ['t'] });
    await matching.join(b, { tags: ['t'] });
    const keys = await redis.keys('*');
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(k.startsWith('{mm}:'), k).toBe(true);
  });
});

describe('concurrency', () => {
  it('1000 concurrent joiners: zero double-matches, all pairs consistent', async () => {
    const { matching } = makeMatching(redis, { cooldownSec: 0 });
    const N = 1000;
    const users = Array.from({ length: N }, () => uid('c'));
    // Mix of tags/no-tags to exercise every queue path; use several independent connections.
    const conns = Array.from({ length: 8 }, () => makeRedis());
    const svcs = conns.map((c) => makeMatching(c, { cooldownSec: 0 }).matching);
    const tagSets = [[], ['a'], ['a', 'b'], ['b']];
    const results = await Promise.all(
      users.map((u, i) => svcs[i % svcs.length].join(u, { tags: tagSets[i % tagSets.length], gender: 'undisclosed' })),
    );
    // Everyone left in the queue is in fallback-limited states; drain with fallback retries.
    for (let round = 0; round < 3; round++) {
      await Promise.all(users.map((u, i) => (matching.isQueued(u) ? svcs[i % svcs.length].retry(u).catch(() => null) : null)));
    }
    const chats = await assertConsistent(users);

    // Every matched result must agree with Redis; nobody appears in two chats.
    const inChat = new Map();
    for (const [cid, set] of chats) for (const u of set) {
      expect(inChat.has(u), `user ${u} in two chats`).toBe(false);
      inChat.set(u, cid);
    }
    for (const r of results.filter((x) => x.status === 'matched')) {
      expect(inChat.get(r.userId)).toBe(r.chatId);
      expect(inChat.get(r.partnerId)).toBe(r.chatId);
    }
    // Pair count is exact: 2 users per chat.
    expect(inChat.size).toBe(chats.size * 2);
    expect(chats.size).toBeGreaterThan(200); // sanity: lots of pairs actually formed
    // Nobody who is queued is also in a chat.
    for (const u of users) {
      if (await matching.isQueued(u)) expect(inChat.has(u)).toBe(false);
    }
    await Promise.all(conns.map((c) => c.quit()));
  }, 60_000);

  it('same user joining from many sockets at once ends in at most one chat', async () => {
    const { matching } = makeMatching(redis, { cooldownSec: 0 });
    const target = uid('multi');
    const others = Array.from({ length: 20 }, () => uid('o'));
    const res = await Promise.all([...Array.from({ length: 10 }, () => matching.join(target, {})), ...others.map((o) => matching.join(o, {}))]);
    const chats = await assertConsistent([target, ...others]);
    let count = 0;
    for (const set of chats.values()) if (set.has(target)) count++;
    expect(count).toBeLessThanOrEqual(1);
    expect(res.length).toBe(30);
  });

  it('racing leave() and join() never leaves dangling chat pointers', async () => {
    const { matching } = makeMatching(redis, { cooldownSec: 0 });
    const users = Array.from({ length: 200 }, () => uid('r'));
    await Promise.all(users.map((u) => matching.join(u, {})));
    await Promise.all(users.flatMap((u, i) => [i % 2 ? matching.leave(u) : matching.join(u, {}), matching.retry(u).catch(() => null)]));
    await assertConsistent(users);
    for (const cid of await redis.smembers('{mm}:chats')) {
      const c = await redis.hgetall(K.chat(cid));
      expect(c.a).toBeTruthy();
      expect(await redis.get(K.userChat(c.a))).toBe(cid);
      expect(await redis.get(K.userChat(c.b))).toBe(cid);
    }
    expect(uuid()).toBeTruthy();
  });
});
