import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Writable } from 'node:stream';
import { boot, guest, HAS_MONGO } from '../helpers/harness.js';
import { buildLogger } from '../../src/config/logger.js';

describe('logging', () => {
  it('redacts PII (email, phone, ip, tokens, passwords, OTPs) from structured logs', () => {
    const lines = [];
    const log = buildLogger({ level: 'info', stream: new Writable({ write: (c, _e, cb) => (lines.push(c.toString()), cb()) }) });
    log.info({ email: 'a@b.com', phone: '+919876543210', ip: '1.2.3.4', password: 'hunter2', otp: '123456', user: { email: 'x@y.com', token: 'tok' }, req: { headers: { authorization: 'Bearer abc', cookie: 'rt_x=secret' } } }, 'event');
    const out = lines.join('');
    for (const secret of ['a@b.com', '9876543210', '1.2.3.4', 'hunter2', '123456', 'x@y.com', 'Bearer abc', 'rt_x=secret', '"tok"']) expect(out).not.toContain(secret);
    expect(out).toContain('[redacted]');
  });
});

describe.skipIf(!HAS_MONGO)('http hardening', () => {
  let h;
  beforeAll(async () => {
    h = await boot();
  });
  afterAll(async () => h?.stop());

  it('health + readiness probes; request id is echoed and generated', async () => {
    expect((await h.agent.get('/healthz')).body).toEqual({ ok: true });
    expect((await h.agent.get('/readyz')).body).toEqual({ ready: true });
    const r = await h.agent.get('/healthz').set('x-request-id', 'req-abc-123');
    expect(r.headers['x-request-id']).toBe('req-abc-123');
    expect((await h.agent.get('/healthz')).headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sets security headers (CSP, nosniff, no-referrer, no x-powered-by)', async () => {
    const r = await h.agent.get('/healthz');
    expect(r.headers['content-security-policy']).toMatch(/default-src 'none'/);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['referrer-policy']).toBe('no-referrer');
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(r.headers['strict-transport-security']).toBeDefined();
  });

  it('CORS: only allow-listed origins get credentials headers', async () => {
    const ok = await h.agent.get('/healthz').set('origin', 'http://localhost:5173');
    expect(ok.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const bad = await h.agent.get('/healthz').set('origin', 'https://evil.example');
    expect(bad.headers['access-control-allow-origin']).toBeUndefined();
    const pre = await h.agent.options('/api/auth/guest').set('origin', 'https://evil.example').set('access-control-request-method', 'POST');
    expect(pre.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('typed JSON errors: 404, malformed JSON, oversize payload, validation', async () => {
    const nf = await h.agent.get('/api/nope');
    expect(nf.status).toBe(404);
    expect(nf.body.error).toMatchObject({ code: 'NOT_FOUND', requestId: expect.any(String) });
    const bad = await h.agent.post('/api/auth/guest').set('content-type', 'application/json').send('{"broken":');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('BAD_JSON');
    const big = await h.agent.post('/api/auth/guest').send({ dob: '1990-01-01', ageConfirmed: true, nickname: 'x'.repeat(60_000) });
    expect(big.status).toBe(413);
    const val = await h.agent.post('/api/auth/guest').send({ dob: 'nope', ageConfirmed: false });
    expect(val.status).toBe(422);
    expect(val.body.error.details.issues.length).toBeGreaterThan(0);
  });

  it('error responses never leak internals or stack traces', async () => {
    const r = await h.agent.get('/api/auth/me').set('authorization', 'Bearer garbage');
    expect(r.status).toBe(401);
    expect(JSON.stringify(r.body)).not.toMatch(/at \w+|node_modules|stack/i);
  });

  it('socket handshake payloads are capped at 64KB (backpressure)', async () => {
    const { io: ioc } = await import('socket.io-client');
    const G = await guest(h);
    const s = ioc(h.url, { transports: ['websocket'], auth: { token: G.token, deviceId: G.deviceId }, reconnection: false, forceNew: true });
    await new Promise((r) => s.once('session:ready', r));
    const closed = new Promise((r) => s.once('disconnect', r));
    s.emit('chat:send', { chatId: 'x', clientMsgId: 'abcdefgh12', text: 'x'.repeat(200_000) });
    expect(await Promise.race([closed, new Promise((r) => setTimeout(() => r('open'), 4000))])).not.toBe('open');
    s.close();
  });
});
