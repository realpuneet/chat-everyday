import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { boot, guest, connect, call, waitFor, matchedPair, HAS_MONGO } from '../helpers/harness.js';
import { RtcService } from '../../src/services/rtcService.js';
import { TokenService } from '../../src/services/tokenService.js';
import crypto from 'node:crypto';

describe('rtc ICE config (unit)', () => {
  it('returns STUN only without TURN, and time-limited coturn credentials with TURN', () => {
    const tokens = new TokenService(null);
    const plain = new RtcService({ tokens, cfg: { STUN_URLS: ['stun:s'], TURN_URLS: [], TURN_SECRET: '', TURN_TTL_SEC: 3600 } });
    expect(plain.iceServers('u1')).toMatchObject({ relay: false, iceServers: [{ urls: ['stun:s'] }] });
    const turn = new RtcService({ tokens, cfg: { STUN_URLS: ['stun:s'], TURN_URLS: ['turn:t:3478'], TURN_SECRET: 'sekret', TURN_TTL_SEC: 600 } });
    const r = turn.iceServers('user42');
    const t = r.iceServers[1];
    expect(t.urls).toEqual(['turn:t:3478']);
    const [expiry, uid] = t.username.split(':');
    expect(uid).toBe('user42');
    expect(Number(expiry) * 1000).toBeGreaterThan(Date.now());
    expect(Number(expiry) * 1000).toBeLessThanOrEqual(Date.now() + 601_000);
    expect(t.credential).toBe(crypto.createHmac('sha1', 'sekret').update(t.username).digest('base64'));
  });
});

describe.skipIf(!HAS_MONGO)('video chat signalling', () => {
  let h;
  beforeAll(async () => {
    h = await boot();
  });
  afterEach(async () => h.reset());
  afterAll(async () => h?.stop());

  it('requires explicit acceptance before any SDP/ICE is relayed, then relays both ways', async () => {
    const { a, b, chatId } = await matchedPair(h);
    const sig = { chatId, type: 'offer', data: { sdp: 'v=0...' } };
    expect((await call(a, 'rtc:signal', sig)).error.code).toBe('RTC_NOT_ACTIVE');

    const incoming = waitFor(b, 'rtc:incoming');
    expect((await call(a, 'rtc:request', { chatId })).state).toBe('requested');
    await incoming;
    expect((await call(a, 'rtc:signal', sig)).ok).toBe(false); // still not accepted
    const accA = waitFor(a, 'rtc:accepted');
    const accB = waitFor(b, 'rtc:accepted');
    await call(b, 'rtc:respond', { chatId, accept: true });
    expect((await accA).role).toBe('caller');
    expect((await accB).role).toBe('callee');

    const relayed = waitFor(b, 'rtc:signal');
    expect((await call(a, 'rtc:signal', sig)).ok).toBe(true);
    expect(await relayed).toMatchObject({ chatId, type: 'offer', data: { sdp: 'v=0...' } });
    const back = waitFor(a, 'rtc:signal');
    await call(b, 'rtc:signal', { chatId, type: 'answer', data: { sdp: 'answer' } });
    expect((await back).type).toBe('answer');

    const ended = waitFor(b, 'rtc:ended');
    await call(a, 'rtc:end', { chatId });
    await ended;
  });

  it('decline works; outsiders cannot signal; leaving the chat ends the call', async () => {
    const { a, b, chatId } = await matchedPair(h);
    await call(a, 'rtc:request', { chatId });
    const declined = waitFor(a, 'rtc:declined');
    await call(b, 'rtc:respond', { chatId, accept: false });
    await declined;

    const outsider = await connect(h, await guest(h));
    expect((await call(outsider, 'rtc:request', { chatId })).error.code).toBe('NOT_IN_CHAT');
    expect((await call(outsider, 'rtc:signal', { chatId, type: 'ice', data: {} })).ok).toBe(false);

    await call(a, 'rtc:request', { chatId });
    await call(b, 'rtc:respond', { chatId, accept: true });
    const ended = waitFor(b, 'rtc:ended');
    await call(a, 'match:leave');
    await ended;
  });

  it('oversized signalling payloads are rejected; ICE endpoint is authenticated', async () => {
    const { a, chatId } = await matchedPair(h);
    const big = await call(a, 'rtc:signal', { chatId, type: 'offer', data: { sdp: 'x'.repeat(20000) } });
    expect(big).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect((await h.agent.get('/api/rtc/ice')).status).toBe(401);
    const G = await guest(h);
    const ice = await h.agent.get('/api/rtc/ice').set('authorization', `Bearer ${G.token}`);
    expect(ice.status).toBe(200);
    expect(ice.body.iceServers.length).toBeGreaterThan(0);
  });
});
