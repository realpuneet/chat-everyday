import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { boot, guest, connect, call, waitFor, collect, sleep, mid, matchedPair, HAS_MONGO, DOB } from '../helpers/harness.js';

describe.skipIf(!HAS_MONGO)('socket random-chat flow', () => {
  let h;
  beforeAll(async () => {
    h = await boot();
    await h.redis.flushall();
  });
  afterEach(async () => h?.reset());
  afterAll(async () => h?.stop());

  it('rejects sockets without a valid token and underage guests', async () => {
    await expect(connect(h, { token: 'nope' })).rejects.toThrow();
    const res = await h.agent.post('/api/auth/guest').set('x-device-id', 'underagedev01').send({ dob: '2015-01-01', ageConfirmed: true });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('UNDERAGE');
    // same device is locked out for 24h even with a "correct" DOB afterwards
    const retry = await h.agent.post('/api/auth/guest').set('x-device-id', 'underagedev01').send({ dob: DOB, ageConfirmed: true });
    expect(retry.status).toBe(403);
    expect(retry.body.error.code).toBe('AGE_BLOCKED');
  });

  it('matches two guests, exchanges messages with ack + partner nickname', async () => {
    const { a, b, chatId, ma, mb } = await matchedPair(h);
    expect(ma.partner.nickname).toMatch(/^Bob/);
    expect(mb.partner.nickname).toMatch(/^Alice/);
    const got = waitFor(b, 'chat:msg');
    const ack = await call(a, 'chat:send', { chatId, clientMsgId: mid(), text: 'hello there' });
    expect(ack).toMatchObject({ ok: true, seq: 1, text: 'hello there' });
    const m = await got;
    expect(m).toMatchObject({ from: 'them', text: 'hello there', seq: 1 });
  });

  it('typing indicator reaches the partner only', async () => {
    const { a, b, chatId } = await matchedPair(h);
    const t = waitFor(b, 'chat:typing');
    await call(a, 'chat:typing', { chatId, on: true });
    expect(await t).toMatchObject({ on: true });
  });

  it('SAME message can be sent repeatedly (no content dedupe)', async () => {
    const { a, b, chatId } = await matchedPair(h);
    const received = collect(b, 'chat:msg', 800);
    for (let i = 0; i < 4; i++) {
      const ack = await call(a, 'chat:send', { chatId, clientMsgId: mid(), text: 'hi' });
      expect(ack.ok).toBe(true);
      await sleep(250); // stay inside the rate limit
    }
    const msgs = await received;
    expect(msgs.length).toBe(4);
    expect(new Set(msgs.map((m) => m.seq)).size).toBe(4);
  });

  it('clientMsgId idempotency: retry returns same ack and delivers once', async () => {
    const { a, b, chatId } = await matchedPair(h);
    const id = mid();
    const received = collect(b, 'chat:msg', 600);
    const first = await call(a, 'chat:send', { chatId, clientMsgId: id, text: 'once' });
    const retry = await call(a, 'chat:send', { chatId, clientMsgId: id, text: 'once' });
    expect(retry).toMatchObject({ ok: true, seq: first.seq, duplicate: true });
    expect((await received).length).toBe(1);
  });

  it('rate limit: bursts above the token bucket are rejected, then recover', async () => {
    const { a, chatId } = await matchedPair(h);
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => call(a, 'chat:send', { chatId, clientMsgId: mid(), text: 'x' + i })));
    const ok = results.filter((r) => r.ok).length;
    const limited = results.filter((r) => !r.ok && r.error.code === 'RATE_LIMITED').length;
    expect(ok).toBeGreaterThanOrEqual(5);
    expect(ok).toBeLessThan(12);
    expect(limited).toBeGreaterThan(0);
    await sleep(1200);
    expect((await call(a, 'chat:send', { chatId, clientMsgId: mid(), text: 'again' })).ok).toBe(true);
  });

  it('rejects invalid payloads with typed validation errors and bad chat ids', async () => {
    const { a } = await matchedPair(h);
    const bad = await call(a, 'chat:send', { chatId: 'x', clientMsgId: 'short', text: 'hi' });
    expect(bad).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    const wrong = await call(a, 'chat:send', { chatId: 'not-my-chat', clientMsgId: mid(), text: 'hi' });
    expect(wrong.ok).toBe(false);
    expect(wrong.error.code).toBe('NOT_IN_CHAT');
  });

  it('link filter blocks links; repeated identical text still allowed', async () => {
    const { a, chatId } = await matchedPair(h);
    const r = await call(a, 'chat:send', { chatId, clientMsgId: mid(), text: 'visit http://spam.example now' });
    expect(r).toMatchObject({ ok: false, error: { code: 'LINK_BLOCKED' } });
  });

  it('partner leave -> "chat:ended" for the other side; next starts a fresh search', async () => {
    const { a, b, chatId } = await matchedPair(h);
    const ended = waitFor(b, 'chat:ended');
    await call(a, 'match:leave');
    expect(await ended).toMatchObject({ chatId, reason: 'partner_left' });
    const late = await call(b, 'chat:send', { chatId, clientMsgId: mid(), text: 'anyone?' });
    expect(late.ok).toBe(false);
    const queued = waitFor(b, 'match:queued');
    await call(b, 'match:start');
    await queued;
  });

  it('disconnect: partner sees reconnecting, then partner_disconnected after the grace period', async () => {
    h.svc.settings.cache = { ...(await h.svc.settings.get()), matching: { ...(await h.svc.settings.get()).matching, disconnectGraceMs: 300 } };
    h.svc.settings.loadedAt = Date.now() + 60_000;
    const { a, b, chatId } = await matchedPair(h);
    const status = waitFor(b, 'chat:partner_status');
    a.close();
    expect(await status).toMatchObject({ status: 'reconnecting' });
    await sleep(450);
    const ended = waitFor(b, 'chat:ended');
    await h.svc.chat.processDisconnects();
    expect(await ended).toMatchObject({ chatId, reason: 'partner_disconnected' });
  });

  it('reconnect within grace resumes the same chat and replays missed messages', async () => {
    h.svc.settings.cache = { ...(await h.svc.settings.get()), matching: { ...(await h.svc.settings.get()).matching, disconnectGraceMs: 5000 } };
    h.svc.settings.loadedAt = Date.now() + 60_000;
    const { A, a, b, chatId } = await matchedPair(h);
    await call(b, 'chat:send', { chatId, clientMsgId: mid(), text: 'one' });
    a.close();
    await sleep(100);
    await call(b, 'chat:send', { chatId, clientMsgId: mid(), text: 'sent while away' });
    const a2 = await connect(h, A);
    const resumed = await call(a2, 'chat:resume', { chatId, lastSeq: 1 });
    expect(resumed.state).toBe('chatting');
    expect(resumed.events.map((e) => e.text)).toEqual(['sent while away']);
    expect(resumed.events[0].from).toBe('them');
    // grace timer was cancelled: sweeper must not end the chat
    await h.svc.chat.processDisconnects();
    expect((await call(a2, 'chat:resume', { chatId, lastSeq: 0 })).state).toBe('chatting');
  });

  it('block: blocked partner can never be matched again and chat ends', async () => {
    const { a, b, chatId } = await matchedPair(h);
    const ended = waitFor(b, 'chat:ended');
    expect((await call(a, 'block:add', { chatId })).ok).toBe(true);
    await ended;
    await call(a, 'match:start');
    const q = await call(b, 'match:start');
    expect(q.status).toBe('queued'); // would have matched immediately without the block
  });

  it('live online count reflects connected users', async () => {
    const before = await h.svc.presence.onlineCount();
    const g = await guest(h);
    const s = await connect(h, g);
    expect(await h.svc.presence.onlineCount()).toBe(before + 1);
    s.close();
    await sleep(200);
    expect(await h.svc.presence.onlineCount()).toBe(before);
  });
});
