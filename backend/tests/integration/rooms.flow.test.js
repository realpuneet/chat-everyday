import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { boot, guest, connect, call, waitFor, collect, sleep, mid, HAS_MONGO, DOB } from '../helpers/harness.js';
import { Room } from '../../src/models/Room.js';

const age = { dob: DOB, ageConfirmed: true };

describe.skipIf(!HAS_MONGO)('group rooms', () => {
  let h;
  const dev = () => `dev_${Math.random().toString(36).slice(2, 12)}`;
  beforeAll(async () => {
    h = await boot();
  });
  afterEach(async () => h.reset());
  afterAll(async () => h?.stop());

  const registered = async (email, extra = {}) => {
    const device = dev();
    const r = await h.agent.post('/api/auth/signup').set('x-device-id', device).set('x-session-slot', 'roomslot').send({ ...age, email, password: 'long enough pw', ...extra });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return { token: r.body.accessToken, user: r.body.user, deviceId: device };
  };
  const google = async (email) => {
    const device = dev();
    const r = await h.agent.post('/api/auth/google').set('x-device-id', device).send({ ...age, idToken: `dryrun:${email}` });
    return { token: r.body.accessToken, user: r.body.user, deviceId: device };
  };
  const roomBySlug = async (who, slug) => {
    const r = await h.agent.get('/api/rooms').set('authorization', `Bearer ${who.token}`);
    return r.body.rooms.find((x) => x.slug === slug);
  };
  const patchMe = (who, body) => h.agent.patch('/api/auth/me').set('authorization', `Bearer ${who.token}`).send(body);

  it('lists seeded system rooms with live member counts', async () => {
    const A = await guest(h);
    const rooms = (await h.agent.get('/api/rooms').set('authorization', `Bearer ${A.token}`)).body.rooms;
    const slugs = rooms.map((r) => r.slug);
    expect(slugs).toEqual(expect.arrayContaining(['identity-men', 'identity-women', 'identity-lgbtq', 'identity-everyone', 'interest-cricket', 'adult-lounge']));
    expect(rooms.find((r) => r.slug === 'adult-lounge').adult).toBe(true);
    const everyone = rooms.find((r) => r.slug === 'identity-everyone');
    const s = await connect(h, A);
    await call(s, 'room:join', { roomId: everyone.id });
    expect((await roomBySlug(A, 'identity-everyone')).members).toBe(1);
  });

  it('join -> snapshot with per-room alias; messages fan out WITHOUT leaking user ids', async () => {
    const [A, B] = [await guest(h), await guest(h)];
    const [a, b] = [await connect(h, A), await connect(h, B)];
    const room = await roomBySlug(A, 'interest-cricket');
    const ja = await call(a, 'room:join', { roomId: room.id });
    expect(ja.ok).toBe(true);
    expect(ja.me).toMatchObject({ role: 'member' });
    expect(ja.me.alias).toMatch(/^[A-Z][a-z]+[A-Z][a-z]+\d{3}$/);
    const presence = waitFor(a, 'room:presence', (p) => p.joined.length > 0);
    const jb = await call(b, 'room:join', { roomId: room.id });
    expect(jb.me.alias).not.toBe(ja.me.alias);
    expect(jb.members.length).toBe(2);
    expect((await presence).joined.map((m) => m.memberId)).toContain(jb.me.memberId);

    const got = waitFor(b, 'room:msgs');
    const ack = await call(a, 'room:send', { roomId: room.id, clientMsgId: mid(), text: 'who is winning?' });
    expect(ack.ok).toBe(true);
    const batch = await got;
    expect(batch.msgs[0]).toMatchObject({ memberId: ja.me.memberId, alias: ja.me.alias, text: 'who is winning?', role: 'member' });
    const wire = JSON.stringify(batch) + JSON.stringify(jb);
    expect(wire).not.toContain(A.user.id);
    expect(wire).not.toContain(B.user.id);
  });

  it('alias is stable per room across reconnects/devices and differs between rooms', async () => {
    const A = await guest(h);
    const s1 = await connect(h, A);
    const cricket = await roomBySlug(A, 'interest-cricket');
    const music = await roomBySlug(A, 'interest-music');
    const j1 = await call(s1, 'room:join', { roomId: cricket.id });
    const j2 = await call(s1, 'room:join', { roomId: music.id });
    expect(j1.me.alias).not.toBe(j2.me.alias);
    const s2 = await connect(h, A, { deviceId: 'second-device-01' });
    const again = await call(s2, 'room:join', { roomId: cricket.id });
    expect(again.me.alias).toBe(j1.me.alias);
    expect(again.me.memberId).toBe(j1.me.memberId);
  });

  it('identity rooms use the SELF-DECLARED profile (courtesy gate, not verification)', async () => {
    const A = await guest(h);
    const a = await connect(h, A);
    const women = await roomBySlug(A, 'identity-women');
    expect(women.description).toMatch(/self-declared/i);
    const denied = await call(a, 'room:join', { roomId: women.id });
    expect(denied).toMatchObject({ ok: false, error: { code: 'IDENTITY_MISMATCH' } });
    await patchMe(A, { gender: 'male' });
    expect((await call(a, 'room:join', { roomId: women.id })).error.code).toBe('IDENTITY_MISMATCH');
    await patchMe(A, { gender: 'female' });
    expect((await call(a, 'room:join', { roomId: women.id })).ok).toBe(true);
    const lgbtq = await roomBySlug(A, 'identity-lgbtq');
    expect((await call(a, 'room:join', { roomId: lgbtq.id })).error.code).toBe('IDENTITY_MISMATCH');
    await patchMe(A, { lgbtq: true });
    expect((await call(a, 'room:join', { roomId: lgbtq.id })).ok).toBe(true);
  });

  it('adult rooms: guests blocked, email-only accounts need phone/Google, verified accounts allowed', async () => {
    const G = await guest(h);
    const adult = await roomBySlug(G, 'adult-lounge');
    const g = await connect(h, G);
    expect((await call(g, 'room:join', { roomId: adult.id })).error.code).toBe('SIGNUP_REQUIRED');
    const E = await registered('adult-email@example.com');
    const e = await connect(h, E);
    expect((await call(e, 'room:join', { roomId: adult.id })).error.code).toBe('AGE_LEVEL_TOO_LOW');
    const V = await google('adult-google@example.com');
    const v = await connect(h, V);
    expect((await call(v, 'room:join', { roomId: adult.id })).ok).toBe(true);
    // the stricter-provider hook can be switched on from settings
    await h.svc.settings.update({ rooms: { requireStrictForAdult: true } }, 'test');
    const v2 = await connect(h, V, { deviceId: 'dev-two-xyz' });
    await call(v2, 'room:leave', { roomId: adult.id });
    expect((await call(v2, 'room:join', { roomId: adult.id })).error.details.need).toBe('strict');
    await h.svc.settings.update({ rooms: { requireStrictForAdult: false } }, 'test');
  });

  describe('custom rooms', () => {
    it('guests cannot create; registered users create public/private rooms with invite codes', async () => {
      const G = await guest(h);
      const denied = await h.agent.post('/api/rooms').set('authorization', `Bearer ${G.token}`).send({ name: 'Guest Room' });
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe('SIGNUP_REQUIRED');

      const O = await registered('owner@example.com');
      const created = await h.agent.post('/api/rooms').set('authorization', `Bearer ${O.token}`).send({ name: 'Night Owls', visibility: 'private', rules: 'be kind' });
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const room = created.body.room;
      expect(room.inviteCode).toMatch(/^[A-Z0-9]{6,}$/);

      const M = await guest(h);
      const m = await connect(h, M);
      expect((await call(m, 'room:join', { roomId: room.id })).error.code).toBe('PRIVATE_ROOM');
      expect((await call(m, 'room:join', { inviteCode: 'WRONGCODE' })).error.code).toBe('NOT_FOUND');
      expect((await h.agent.get(`/api/rooms/preview?code=${room.inviteCode}`).set('authorization', `Bearer ${M.token}`)).body.room.name).toBe('Night Owls');
      const joined = await call(m, 'room:join', { inviteCode: room.inviteCode });
      expect(joined.ok).toBe(true);
      expect(joined.room.rules).toBe('be kind');
      // private rooms never show up in the public directory
      const list = (await h.agent.get('/api/rooms').set('authorization', `Bearer ${M.token}`)).body.rooms;
      expect(list.find((r) => r.id === room.id)).toBeUndefined();
    });

    it('limits how many rooms one user can own and how fast they can be created', async () => {
      const O = await registered('limit@example.com');
      for (let i = 0; i < 3; i++) {
        const r = await h.agent.post('/api/rooms').set('authorization', `Bearer ${O.token}`).send({ name: `Room number ${i}` });
        expect(r.status).toBe(201);
      }
      const over = await h.agent.post('/api/rooms').set('authorization', `Bearer ${O.token}`).send({ name: 'One too many' });
      expect([403, 429]).toContain(over.status);
    });

    it('owner can delete the room; members are ejected', async () => {
      const O = await registered('del@example.com');
      const r = (await h.agent.post('/api/rooms').set('authorization', `Bearer ${O.token}`).send({ name: 'Temporary' })).body.room;
      const G = await guest(h);
      const g = await connect(h, G);
      await call(g, 'room:join', { roomId: r.id });
      const closed = waitFor(g, 'room:closed');
      expect((await h.agent.delete(`/api/rooms/${r.id}`).set('authorization', `Bearer ${G.token}`)).status).toBe(403);
      expect((await h.agent.delete(`/api/rooms/${r.id}`).set('authorization', `Bearer ${O.token}`)).status).toBe(200);
      await closed;
      expect(await Room.findById(r.id)).toBe(null);
    });
  });

  describe('moderation tools', () => {
    async function setup() {
      const O = await registered(`mod-owner-${Math.random().toString(36).slice(2, 7)}@example.com`);
      const room = (await h.agent.post('/api/rooms').set('authorization', `Bearer ${O.token}`).send({ name: 'Mod Room' })).body.room;
      const [M, X] = [await guest(h), await guest(h)];
      const [o, m, x] = [await connect(h, O), await connect(h, M), await connect(h, X)];
      const jo = await call(o, 'room:join', { roomId: room.id });
      const jm = await call(m, 'room:join', { roomId: room.id });
      const jx = await call(x, 'room:join', { roomId: room.id });
      return { O, M, X, o, m, x, room, jo, jm, jx };
    }

    it('owner role is visible; plain members cannot use mod tools', async () => {
      const { m, x, room, jo, jx } = await setup();
      expect(jo.me.role).toBe('owner');
      const r = await call(m, 'room:mod', { roomId: room.id, action: 'kick', memberId: jx.me.memberId });
      expect(r.error.code).toBe('NOT_MODERATOR');
      expect(x.connected).toBe(true);
    });

    it('kick removes the member and blocks immediate rejoin', async () => {
      const { o, m, room, jm } = await setup();
      const kicked = waitFor(m, 'room:kicked');
      expect((await call(o, 'room:mod', { roomId: room.id, action: 'kick', memberId: jm.me.memberId })).ok).toBe(true);
      await kicked;
      expect((await call(m, 'room:send', { roomId: room.id, clientMsgId: mid(), text: 'hi' })).error.code).toBe('NOT_IN_ROOM');
      expect((await call(m, 'room:join', { roomId: room.id })).error.code).toBe('KICKED');
    });

    it('mute silences a member until unmuted', async () => {
      const { o, m, room, jm } = await setup();
      await call(o, 'room:mod', { roomId: room.id, action: 'mute', memberId: jm.me.memberId, minutes: 5 });
      const blocked = await call(m, 'room:send', { roomId: room.id, clientMsgId: mid(), text: 'let me talk' });
      expect(blocked).toMatchObject({ ok: false, error: { code: 'MUTED' } });
      await call(o, 'room:mod', { roomId: room.id, action: 'unmute', memberId: jm.me.memberId });
      expect((await call(m, 'room:send', { roomId: room.id, clientMsgId: mid(), text: 'thanks' })).ok).toBe(true);
    });

    it('slow mode throttles members but not the owner; rules update is broadcast', async () => {
      const { o, m, room } = await setup();
      await call(o, 'room:mod', { roomId: room.id, action: 'slow', seconds: 5 });
      expect((await call(m, 'room:send', { roomId: room.id, clientMsgId: mid(), text: 'first' })).ok).toBe(true);
      const second = await call(m, 'room:send', { roomId: room.id, clientMsgId: mid(), text: 'second' });
      expect(second).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED' } });
      expect((await call(o, 'room:send', { roomId: room.id, clientMsgId: mid(), text: 'owner one' })).ok).toBe(true);
      expect((await call(o, 'room:send', { roomId: room.id, clientMsgId: mid(), text: 'owner two' })).ok).toBe(true);
      const rules = waitFor(m, 'room:rules');
      await call(o, 'room:mod', { roomId: room.id, action: 'rules', rules: 'No spoilers' });
      expect((await rules).rules).toBe('No spoilers');
    });

    it('moderators can be promoted, cannot moderate the owner or peers; only owner promotes', async () => {
      const { o, m, x, room, jm, jx, jo } = await setup();
      expect((await call(m, 'room:mod', { roomId: room.id, action: 'promote', memberId: jx.me.memberId })).error.code).toBe('NOT_MODERATOR');
      expect((await call(o, 'room:mod', { roomId: room.id, action: 'promote', memberId: jm.me.memberId })).ok).toBe(true);
      expect((await call(m, 'room:mod', { roomId: room.id, action: 'mute', memberId: jx.me.memberId, minutes: 1 })).ok).toBe(true);
      expect((await call(m, 'room:mod', { roomId: room.id, action: 'kick', memberId: jo.me.memberId })).error.code).toBe('RANK');
      expect((await call(m, 'room:mod', { roomId: room.id, action: 'promote', memberId: jx.me.memberId })).error.code).toBe('NOT_OWNER');
      expect(x.connected).toBe(true);
    });
  });

  describe('filters and delivery', () => {
    it('room filters: links + phone numbers blocked, repeated identical text allowed, custom bad words honoured', async () => {
      const O = await registered('filters@example.com');
      const room = (await h.agent.post('/api/rooms').set('authorization', `Bearer ${O.token}`).send({ name: 'Filtered', filters: { badWords: ['spoilerword'] } })).body.room;
      const o = await connect(h, O);
      await call(o, 'room:join', { roomId: room.id });
      const send = (text) => call(o, 'room:send', { roomId: room.id, clientMsgId: mid(), text });
      expect((await send('look at https://example.com')).error.code).toBe('LINK_BLOCKED');
      expect((await send('call me 9876543210')).error.code).toBe('PII_BLOCKED');
      expect((await send('that spoilerword ruined it')).error.code).toBe('BAD_WORD');
      expect((await send('same')).ok).toBe(true);
      await sleep(250);
      expect((await send('same')).ok).toBe(true);
    });

    it('batches fanout: a burst arrives in fewer socket events than messages', async () => {
      const [A, B] = [await registered('burst-a@example.com'), await guest(h)];
      const [a, b] = [await connect(h, A), await connect(h, B)];
      const room = await roomBySlug(A, 'interest-music');
      await call(a, 'room:join', { roomId: room.id });
      await call(b, 'room:join', { roomId: room.id });
      const batches = collect(b, 'room:msgs', 700);
      await Promise.all([1, 2, 3, 4, 5].map((i) => call(a, 'room:send', { roomId: room.id, clientMsgId: mid(), text: `m${i}` })));
      const got = await batches;
      const total = got.reduce((n, p) => n + p.msgs.length, 0);
      expect(total).toBe(5);
      expect(got.length).toBeLessThan(5);
    });

    it('idempotent room sends deliver once', async () => {
      const [A, B] = [await guest(h), await guest(h)];
      const [a, b] = [await connect(h, A), await connect(h, B)];
      const room = await roomBySlug(A, 'interest-books');
      await call(a, 'room:join', { roomId: room.id });
      await call(b, 'room:join', { roomId: room.id });
      const id = mid();
      const got = collect(b, 'room:msgs', 500);
      const r1 = await call(a, 'room:send', { roomId: room.id, clientMsgId: id, text: 'once only' });
      const r2 = await call(a, 'room:send', { roomId: room.id, clientMsgId: id, text: 'once only' });
      expect(r2).toMatchObject({ seq: r1.seq, duplicate: true });
      expect((await got).reduce((n, p) => n + p.msgs.length, 0)).toBe(1);
    });

    it('reconnect: sockets re-attach to joined rooms and resume replays missed messages', async () => {
      const [A, B] = [await guest(h), await guest(h)];
      const [a, b] = [await connect(h, A), await connect(h, B)];
      const room = await roomBySlug(A, 'interest-food');
      await call(a, 'room:join', { roomId: room.id });
      const jb = await call(b, 'room:join', { roomId: room.id });
      await call(a, 'room:send', { roomId: room.id, clientMsgId: mid(), text: 'before' });
      await sleep(100);
      b.close();
      await sleep(100);
      await call(a, 'room:send', { roomId: room.id, clientMsgId: mid(), text: 'while you were away' });
      const b2 = await new Promise((resolve, reject) => {
        connect(h, B).then(resolve, reject);
      });
      const resumed = await call(b2, 'room:resume', { roomId: room.id, lastSeq: jb.seq });
      expect(resumed.state).toBe('member');
      expect(resumed.events.map((e) => e.text)).toEqual(expect.arrayContaining(['before', 'while you were away']));
      const live = waitFor(b2, 'room:msgs', (p) => p.msgs.some((m) => m.text === 'live again')); // clients dedupe by seq
      await call(a, 'room:send', { roomId: room.id, clientMsgId: mid(), text: 'live again' });
      expect((await live).msgs.at(-1).text).toBe('live again');
    });

    it('offline users are removed from rooms only after the grace period', async () => {
      const [A, B] = [await guest(h), await guest(h)];
      const [a, b] = [await connect(h, A), await connect(h, B)];
      const room = await roomBySlug(A, 'interest-travel');
      await call(a, 'room:join', { roomId: room.id });
      await call(b, 'room:join', { roomId: room.id });
      expect((await roomBySlug(A, 'interest-travel')).members).toBe(2);
      b.close();
      await sleep(200);
      expect((await roomBySlug(A, 'interest-travel')).members).toBe(2); // still within grace
      await h.redis.zadd('room:disc', Date.now() - 1, B.user.id); // fast-forward
      await h.svc.rooms.processDisconnects(h.svc.presence);
      expect((await roomBySlug(A, 'interest-travel')).members).toBe(1);
    });

    it('rooms enforce max members', async () => {
      const O = await registered('full@example.com');
      const room = (await h.agent.post('/api/rooms').set('authorization', `Bearer ${O.token}`).send({ name: 'Tiny Room', maxMembers: 2 })).body.room;
      const [g1, g2] = [await guest(h), await guest(h)];
      const [o, a, b] = [await connect(h, O), await connect(h, g1), await connect(h, g2)];
      expect((await call(o, 'room:join', { roomId: room.id })).ok).toBe(true);
      expect((await call(a, 'room:join', { roomId: room.id })).ok).toBe(true);
      expect((await call(b, 'room:join', { roomId: room.id })).error.code).toBe('ROOM_FULL');
    });

    it('blocking a room member returns their memberId on the next join snapshot', async () => {
      const [A, B] = [await guest(h), await guest(h)];
      const [a, b] = [await connect(h, A), await connect(h, B)];
      const room = await roomBySlug(A, 'interest-anime');
      await call(a, 'room:join', { roomId: room.id });
      const jb = await call(b, 'room:join', { roomId: room.id });
      expect((await call(a, 'block:add', { roomId: room.id, memberId: jb.me.memberId })).ok).toBe(true);
      const again = await call(a, 'room:join', { roomId: room.id });
      expect(again.blockedMemberIds).toEqual([jb.me.memberId]);
    });
  });
});
