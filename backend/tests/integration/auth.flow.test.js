import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { boot, guest, connect, call, waitFor, sleep, mid, HAS_MONGO, DOB } from '../helpers/harness.js';
import { User } from '../../src/models/User.js';

const cookieOf = (res, slot) => {
  const c = (res.headers['set-cookie'] || []).find((x) => x.startsWith(`rt_${slot}=`));
  return c ? c.split(';')[0] : null;
};
const age = { dob: DOB, ageConfirmed: true };

describe.skipIf(!HAS_MONGO)('auth flows', () => {
  let h;
  const dev = () => `dev_${Math.random().toString(36).slice(2, 12)}`;
  beforeAll(async () => {
    h = await boot();
  });
  afterEach(async () => h.reset());
  afterAll(async () => h?.stop());

  const signup = (body, { slot = 'slotaaaa', token, device = dev() } = {}) => {
    const r = h.agent.post('/api/auth/signup').set('x-device-id', device).set('x-session-slot', slot);
    if (token) r.set('authorization', `Bearer ${token}`);
    return r.send({ ...age, ...body });
  };

  it('email signup + login issue an access token and an httpOnly, path-scoped refresh cookie', async () => {
    const res = await signup({ email: 'Alice@Example.com', password: 'correct horse battery' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.user).toMatchObject({ kind: 'registered', hasEmail: true });
    expect(res.body.refresh).toBeUndefined(); // refresh token only travels in the cookie
    const raw = res.headers['set-cookie'].find((c) => c.startsWith('rt_slotaaaa='));
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/Path=\/api\/auth/);
    expect(raw).toMatch(/SameSite=Lax/i);
    const login = await h.agent.post('/api/auth/login').send({ email: 'alice@example.com', password: 'correct horse battery' });
    expect(login.status).toBe(200);
    const me = await h.agent.get('/api/auth/me').set('authorization', `Bearer ${login.body.accessToken}`);
    expect(me.body.user.hasEmail).toBe(true);
    // passwords are hashed (argon2id), never stored in plaintext
    const u = await User.findOne({ email: 'alice@example.com' }).lean();
    expect(u.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it('rejects: underage signup, weak password, duplicate email, wrong password', async () => {
    expect((await signup({ email: 'kid@example.com', password: 'long enough pw', dob: '2012-01-01' }, { device: 'kiddevice001' })).status).toBe(403);
    expect((await signup({ email: 'w@example.com', password: 'short' })).status).toBe(422);
    await signup({ email: 'dup@example.com', password: 'long enough pw' });
    const dup = await signup({ email: 'dup@example.com', password: 'long enough pw' });
    expect(dup.status).toBe(409);
    const bad = await h.agent.post('/api/auth/login').send({ email: 'dup@example.com', password: 'nope nope nope' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.code).toBe('BAD_CREDENTIALS');
    const none = await h.agent.post('/api/auth/login').send({ email: 'ghost@example.com', password: 'nope nope nope' });
    expect(none.body.error.code).toBe('BAD_CREDENTIALS'); // same answer: no account enumeration
  });

  it('locks an account after repeated failed logins', async () => {
    await signup({ email: 'brute@example.com', password: 'long enough pw' });
    let last;
    for (let i = 0; i < 12; i++) last = await h.agent.post('/api/auth/login').send({ email: 'brute@example.com', password: 'wrong wrong wrong' });
    expect(last.status).toBe(429);
    expect(last.headers['retry-after']).toBeDefined();
    const right = await h.agent.post('/api/auth/login').send({ email: 'brute@example.com', password: 'long enough pw' });
    expect(right.status).toBe(429); // still locked even with the right password
  });

  it('refresh rotates the cookie; replaying a rotated token revokes the whole family (reuse detection)', async () => {
    const s = await signup({ email: 'rot@example.com', password: 'long enough pw' }, { slot: 'rotslot1' });
    const c0 = cookieOf(s, 'rotslot1');
    const r1 = await h.agent.post('/api/auth/refresh').set('x-session-slot', 'rotslot1').set('Cookie', c0);
    expect(r1.status).toBe(200);
    expect(r1.body.accessToken).toBeTruthy();
    const c1 = cookieOf(r1, 'rotslot1');
    expect(c1).not.toBe(c0);
    const replay = await h.agent.post('/api/auth/refresh').set('x-session-slot', 'rotslot1').set('Cookie', c0);
    expect(replay.status).toBe(401);
    expect(replay.body.error.details).toMatchObject({ reuse: true });
    const afterTheft = await h.agent.post('/api/auth/refresh').set('x-session-slot', 'rotslot1').set('Cookie', c1);
    expect(afterTheft.status).toBe(401); // legit holder is logged out too: family is dead
  });

  it('refresh requires the session-slot header (CSRF defence) and the matching cookie', async () => {
    const s = await signup({ email: 'csrf@example.com', password: 'long enough pw' }, { slot: 'csrfslot' });
    const c = cookieOf(s, 'csrfslot');
    expect((await h.agent.post('/api/auth/refresh').set('Cookie', c)).status).toBe(401);
    expect((await h.agent.post('/api/auth/refresh').set('x-session-slot', 'otherslot').set('Cookie', c)).status).toBe(401);
  });

  it('two accounts in ONE browser (separate tab slots) keep isolated sessions', async () => {
    const a = await signup({ email: 'tab-a@example.com', password: 'long enough pw' }, { slot: 'tabaaaaa' });
    const b = await signup({ email: 'tab-b@example.com', password: 'long enough pw' }, { slot: 'tabbbbbb' });
    const jar = `${cookieOf(a, 'tabaaaaa')}; ${cookieOf(b, 'tabbbbbb')}`; // one browser cookie jar
    const ra = await h.agent.post('/api/auth/refresh').set('x-session-slot', 'tabaaaaa').set('Cookie', jar);
    const rb = await h.agent.post('/api/auth/refresh').set('x-session-slot', 'tabbbbbb').set('Cookie', jar);
    expect(ra.body.user.id).toBe(a.body.user.id);
    expect(rb.body.user.id).toBe(b.body.user.id);
    expect(ra.body.user.id).not.toBe(rb.body.user.id);
    // logging out tab A does not touch tab B
    await h.agent.post('/api/auth/logout').set('x-session-slot', 'tabaaaaa').set('Cookie', jar);
    expect((await h.agent.post('/api/auth/refresh').set('x-session-slot', 'tabaaaaa').set('Cookie', cookieOf(ra, 'tabaaaaa'))).status).toBe(401);
    expect((await h.agent.post('/api/auth/refresh').set('x-session-slot', 'tabbbbbb').set('Cookie', cookieOf(rb, 'tabbbbbb'))).status).toBe(200);
  });

  it('logout-all revokes every refresh family of the user', async () => {
    const s1 = await signup({ email: 'multi@example.com', password: 'long enough pw' }, { slot: 'multi001' });
    const l2 = await h.agent.post('/api/auth/login').set('x-session-slot', 'multi002').send({ email: 'multi@example.com', password: 'long enough pw' });
    await h.agent.post('/api/auth/logout-all').set('authorization', `Bearer ${s1.body.accessToken}`).set('x-session-slot', 'multi001');
    expect((await h.agent.post('/api/auth/refresh').set('x-session-slot', 'multi001').set('Cookie', cookieOf(s1, 'multi001'))).status).toBe(401);
    expect((await h.agent.post('/api/auth/refresh').set('x-session-slot', 'multi002').set('Cookie', cookieOf(l2, 'multi002'))).status).toBe(401);
  });

  it('guest -> signup UPGRADES the same account: same id, live chat survives', async () => {
    const A = await guest(h, { nickname: 'Upgrader' });
    const B = await guest(h, { nickname: 'Partner' });
    const [a, b] = [await connect(h, A), await connect(h, B)];
    const fa = waitFor(a, 'match:found');
    await call(a, 'match:start');
    await call(b, 'match:start');
    const { chatId } = await fa;
    const up = await signup({ email: 'upgrade@example.com', password: 'long enough pw' }, { token: A.token, slot: 'upslot01' });
    expect(up.status, JSON.stringify(up.body)).toBe(200);
    expect(up.body.upgraded).toBe(true);
    expect(up.body.user.id).toBe(A.user.id);
    expect(up.body.user.kind).toBe('registered');
    const u = await User.findById(A.user.id).lean();
    expect(u.expiresAt).toBeUndefined(); // no longer auto-deleted like a guest
    // swap the token on the live socket; the chat keeps working with no reconnect
    expect((await call(a, 'auth:refresh', { token: up.body.accessToken })).kind).toBe('registered');
    const got = waitFor(b, 'chat:msg');
    expect((await call(a, 'chat:send', { chatId, clientMsgId: mid(), text: 'still here after signup' })).ok).toBe(true);
    expect((await got).text).toBe('still here after signup');
    // and the old guest-secret token still maps to the same (now registered) account
    expect((await h.agent.get('/api/auth/me').set('authorization', `Bearer ${A.token}`)).body.user.kind).toBe('registered');
  });

  it('a socket cannot adopt another user\'s token via auth:refresh', async () => {
    const A = await guest(h);
    const B = await guest(h);
    const a = await connect(h, A);
    const r = await call(a, 'auth:refresh', { token: B.token });
    expect(r.ok).toBe(false);
  });

  it('Google sign-in (dry-run) creates, re-logs in, links by verified email, upgrades guests, bootstraps admin', async () => {
    const g1 = await h.agent.post('/api/auth/google').set('x-device-id', dev()).send({ ...age, idToken: 'dryrun:gsub1:gal@example.com' });
    expect(g1.status, JSON.stringify(g1.body)).toBe(200);
    expect(g1.body.user).toMatchObject({ kind: 'registered', hasGoogle: true, ageLevel: 'google' });
    const g2 = await h.agent.post('/api/auth/google').set('x-device-id', dev()).send({ ...age, idToken: 'dryrun:gsub1:gal@example.com' });
    expect(g2.body.user.id).toBe(g1.body.user.id);
    // links to an existing password account that has the same verified email
    await signup({ email: 'both@example.com', password: 'long enough pw' });
    const linked = await h.agent.post('/api/auth/google').set('x-device-id', dev()).send({ ...age, idToken: 'dryrun:gsub2:both@example.com' });
    expect(linked.body.user).toMatchObject({ hasEmail: true, hasGoogle: true });
    expect(await User.countDocuments({ email: 'both@example.com' })).toBe(1);
    // guest upgrade
    const G = await guest(h);
    const up = await h.agent.post('/api/auth/google').set('authorization', `Bearer ${G.token}`).set('x-device-id', G.deviceId).send({ ...age, idToken: 'dryrun:gsub3:up@example.com' });
    expect(up.body).toMatchObject({ upgraded: true, user: { id: G.user.id, kind: 'registered' } });
    // admin bootstrap only for verified Google emails in ADMIN_EMAILS
    await h.svc.auth.setAdminEmails(['boss@example.com']);
    const adm = await h.agent.post('/api/auth/google').set('x-device-id', dev()).send({ ...age, idToken: 'dryrun:gsub4:boss@example.com' });
    expect(adm.body.user.role).toBe('admin');
    const spoof = await signup({ email: 'boss2@example.com', password: 'long enough pw' });
    expect(spoof.body.user.role).toBe('user');
    await h.svc.auth.setAdminEmails([]);
  });

  it('Google sign-in rejects underage and garbage tokens', async () => {
    expect((await h.agent.post('/api/auth/google').set('x-device-id', 'googlekid0001').send({ dob: '2014-05-05', ageConfirmed: true, idToken: 'dryrun:x@example.com' })).status).toBe(403);
    expect((await h.agent.post('/api/auth/google').set('x-device-id', dev()).send({ ...age, idToken: 'not-a-real-token-1234' })).status).toBe(401);
  });

  describe('phone OTP', () => {
    const req = (phone, device = dev(), ip) => {
      const r = h.agent.post('/api/auth/phone/request').set('x-device-id', device);
      if (ip) r.set('x-forwarded-for', ip);
      return r.send({ ...age, phone });
    };
    const verify = (phone, code, extra = {}) => h.agent.post('/api/auth/phone/verify').set('x-device-id', dev()).send({ ...age, phone, code, ...extra });

    it('request -> verify creates a phone account (hash only, never the number)', async () => {
      const r = await req('+919876543210');
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body).toMatchObject({ sent: true, dryRun: true });
      expect(r.body.devCode).toMatch(/^\d{6}$/);
      const v = await verify('+919876543210', r.body.devCode);
      expect(v.status, JSON.stringify(v.body)).toBe(200);
      expect(v.body.user).toMatchObject({ kind: 'registered', hasPhone: true, ageLevel: 'phone' });
      const u = await User.findById(v.body.user.id).lean();
      expect(u.phoneLast4).toBe('3210');
      expect(JSON.stringify(u)).not.toContain('9876543210');
    });

    it('wrong code is rejected with remaining attempts; code is single-use', async () => {
      const r = await req('+919811111111');
      const bad = await verify('+919811111111', r.body.devCode === '000000' ? '111111' : '000000');
      expect(bad.status).toBe(401);
      expect(bad.body.error.details.attemptsLeft).toBe(4);
      const ok = await verify('+919811111111', r.body.devCode);
      expect(ok.status).toBe(200);
      expect((await verify('+919811111111', r.body.devCode)).status).toBe(400); // already used
    });

    it('burns the code after too many wrong attempts', async () => {
      const r = await req('+919822222222');
      const wrong = r.body.devCode === '123456' ? '654321' : '123456';
      let last;
      for (let i = 0; i < 6; i++) last = await verify('+919822222222', wrong);
      expect(last.status).toBe(429);
      expect((await verify('+919822222222', r.body.devCode)).status).toBe(400);
    });

    it('enforces resend cooldown, hourly per-phone cap and country allow-list', async () => {
      const a = await req('+919833333333');
      expect(a.status).toBe(200);
      const again = await req('+919833333333');
      expect(again.status).toBe(429);
      expect(again.headers['retry-after']).toBeDefined();
      expect((await req('+14155550100')).status).toBe(403); // US not in allow-list
      expect((await req('+14155550100')).body.error.code).toBe('COUNTRY_NOT_ALLOWED');
    });

    it('SMS-pumping guard: one IP cannot request codes for many different numbers', async () => {
      const ip = '203.0.113.9';
      const codes = [];
      for (const n of ['+919844444441', '+919844444442', '+919844444443', '+919844444444']) {
        const r = await req(n, dev(), ip);
        codes.push(r.status);
        await sleep(5);
      }
      expect(codes.slice(0, 3)).toEqual([200, 200, 200]);
      expect(codes[3]).toBe(429);
    });

    it('requires the age gate before spending an SMS', async () => {
      const r = await h.agent.post('/api/auth/phone/request').set('x-device-id', 'phonekid00001').send({ phone: '+919855555555', dob: '2013-01-01', ageConfirmed: true });
      expect(r.status).toBe(403);
    });

    it('guest + phone verify upgrades the guest', async () => {
      const G = await guest(h);
      const r = await req('+919866666666', G.deviceId);
      const v = await h.agent.post('/api/auth/phone/verify').set('authorization', `Bearer ${G.token}`).set('x-device-id', G.deviceId).send({ ...age, phone: '+919866666666', code: r.body.devCode });
      expect(v.body).toMatchObject({ upgraded: true, user: { id: G.user.id, kind: 'registered', ageLevel: 'phone' } });
    });
  });

  describe('multi-device presence', () => {
    it('user stays online until the LAST socket closes; chat survives a single device closing', async () => {
      const reg = await signup({ email: 'devices@example.com', password: 'long enough pw' }, { device: 'laptop-device-1' });
      const who = { token: reg.body.accessToken, deviceId: 'laptop-device-1' };
      const P = await guest(h);
      const [phone, laptop, partner] = [await connect(h, who, { deviceId: 'phone-device-22' }), await connect(h, who), await connect(h, P)];
      const uid = reg.body.user.id;
      const devices = await h.agent.get('/api/auth/devices').set('authorization', `Bearer ${who.token}`);
      expect(devices.body.devices.length).toBe(2);
      expect(await h.redis.scard(`user:${uid}:sockets`)).toBe(2);

      const found = waitFor(laptop, 'match:found');
      const foundPhone = waitFor(phone, 'match:found');
      await call(laptop, 'match:start');
      await call(partner, 'match:start');
      const { chatId } = await found;
      await foundPhone; // BOTH devices of the user are told about the chat

      const fromPartner = waitFor(phone, 'chat:msg');
      await call(partner, 'chat:send', { chatId, clientMsgId: mid(), text: 'hello both devices' });
      expect((await fromPartner).text).toBe('hello both devices');

      const mirrored = waitFor(phone, 'chat:msg', (m) => m.from === 'me');
      await call(laptop, 'chat:send', { chatId, clientMsgId: mid(), text: 'sent from laptop' });
      expect((await mirrored).text).toBe('sent from laptop'); // sender's other device sees own message

      laptop.close();
      await sleep(200);
      expect(await h.svc.presence.isOnline(uid)).toBe(true);
      expect(await h.redis.zscore('{mm}:disc', uid)).toBe(null); // no disconnect grace scheduled
      expect((await call(partner, 'chat:send', { chatId, clientMsgId: mid(), text: 'still there?' })).ok).toBe(true);

      phone.close();
      await sleep(200);
      expect(await h.svc.presence.isOnline(uid)).toBe(false);
      expect(await h.redis.zscore('{mm}:disc', uid)).not.toBe(null); // grace period started now
    });

    it('stale sockets from a crashed instance are swept out of presence', async () => {
      const G = await guest(h);
      const s = await connect(h, G);
      const uid = G.user.id;
      await h.redis.del(`sock:${s.id}`); // heartbeat key lost, as if the owning instance died
      const gone = await h.svc.presence.sweepStale();
      expect(gone).toContain(uid);
      expect(await h.svc.presence.isOnline(uid)).toBe(false);
    });
  });
});
