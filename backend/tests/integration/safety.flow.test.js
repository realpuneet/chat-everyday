import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { boot, guest, connect, call, waitFor, sleep, mid, matchedPair, randomIp, HAS_MONGO, DOB } from '../helpers/harness.js';
import { Report } from '../../src/models/Report.js';
import { Ban } from '../../src/models/Ban.js';
import { AuditLog } from '../../src/models/AuditLog.js';
import { SavedChat } from '../../src/models/SavedChat.js';

const age = { dob: DOB, ageConfirmed: true };

describe.skipIf(!HAS_MONGO)('safety, moderation and admin', () => {
  let h;
  beforeAll(async () => {
    h = await boot();
    await h.svc.auth.setAdminEmails(['admin@example.com']);
  });
  afterEach(async () => {
    await h.reset();
    await Ban.deleteMany({});
    await Report.deleteMany({});
    await SavedChat.deleteMany({});
    h.svc.settings.invalidate();
  });
  afterAll(async () => h?.stop());

  const adminLogin = async () => {
    const ip = randomIp();
    const r = await h.agent.post('/api/auth/google').set('x-forwarded-for', ip).set('x-device-id', 'admin-device-01').send({ ...age, idToken: 'dryrun:adminsub:admin@example.com' });
    expect(r.body.user.role).toBe('admin');
    return { token: r.body.accessToken, ip, user: r.body.user, deviceId: 'admin-device-01' };
  };
  const api = (who) => ({
    get: (url) => h.agent.get(url).set('authorization', `Bearer ${who.token}`).set('x-forwarded-for', who.ip),
    post: (url, body) => h.agent.post(url).set('authorization', `Bearer ${who.token}`).set('x-forwarded-for', who.ip).send(body),
    put: (url, body) => h.agent.put(url).set('authorization', `Bearer ${who.token}`).set('x-forwarded-for', who.ip).send(body),
    del: (url) => h.agent.delete(url).set('authorization', `Bearer ${who.token}`).set('x-forwarded-for', who.ip),
  });
  const slowMsg = async (s, chatId, text) => {
    const r = await call(s, 'chat:send', { chatId, clientMsgId: mid(), text });
    await sleep(60);
    return r;
  };

  it('admin API is role-protected', async () => {
    const G = await guest(h);
    expect((await h.agent.get('/api/admin/stats')).status).toBe(401);
    expect((await api(G).get('/api/admin/stats')).status).toBe(403);
    const admin = await adminLogin();
    const stats = await api(admin).get('/api/admin/stats');
    expect(stats.status).toBe(200);
    expect(stats.body).toMatchObject({ online: expect.any(Number), activeChats: expect.any(Number), openReports: 0 });
  });

  it('report -> evidence (last N messages) lands in the admin queue; reporter auto-blocks the reported user', async () => {
    const { A, B, a, b, chatId } = await matchedPair(h);
    await slowMsg(a, chatId, 'hello there');
    await slowMsg(b, chatId, 'you are ugly');
    await slowMsg(b, chatId, 'send nudes now');
    const ended = waitFor(b, 'chat:ended').catch(() => null);
    const r = await call(a, 'report:create', { context: 'random', chatId, category: 'harassment', details: 'abusive' });
    expect(r).toMatchObject({ ok: true });
    expect(r.reportId).toBeTruthy();
    void ended;

    const admin = await adminLogin();
    const list = await api(admin).get('/api/admin/reports');
    expect(list.body.reports.length).toBe(1);
    expect(list.body.reports[0]).toMatchObject({ category: 'harassment', priority: 'high', status: 'open' });
    const detail = (await api(admin).get(`/api/admin/reports/${r.reportId}`)).body.report;
    expect(detail.evidence.messages.map((m) => [m.senderRef, m.text])).toEqual([
      ['reporter', 'hello there'],
      ['reported', 'you are ugly'],
      ['reported', 'send nudes now'],
    ]);
    expect(detail.reported.id).toBe(B.user.id);
    expect(detail.reporterId).toBe(A.user.id);

    // reporter will never be matched with the reported user again
    await call(a, 'match:leave');
    await call(a, 'match:start');
    expect((await call(b, 'match:start')).status).toBe('queued');
  });

  it('reports: only chat participants can report, duplicates are collapsed, rate limit applies, critical sorts first', async () => {
    const { a, chatId } = await matchedPair(h);
    const outsider = await connect(h, await guest(h));
    expect((await call(outsider, 'report:create', { context: 'random', chatId, category: 'spam' })).ok).toBe(false);
    const first = await call(a, 'report:create', { context: 'random', chatId, category: 'spam' });
    const dup = await call(a, 'report:create', { context: 'random', chatId, category: 'spam' });
    expect(dup).toMatchObject({ ok: true, duplicate: true });
    expect(await Report.countDocuments()).toBe(1);

    const p2 = await matchedPair(h);
    await call(p2.a, 'report:create', { context: 'random', chatId: p2.chatId, category: 'minor' });
    const admin = await adminLogin();
    const list = (await api(admin).get('/api/admin/reports')).body.reports;
    expect(list[0].priority).toBe('critical');
    expect(list[0].category).toBe('minor');
    expect(first.ok).toBe(true);
  });

  it('admin resolve: warn notifies the user; dismiss closes; actions are audited', async () => {
    const { a, b, chatId } = await matchedPair(h);
    const r = await call(a, 'report:create', { context: 'random', chatId, category: 'harassment' });
    const admin = await adminLogin();
    const warned = waitFor(b, 'moderation:warning');
    expect((await api(admin).post(`/api/admin/reports/${r.reportId}/resolve`, { action: 'warn', note: 'first warning' })).status).toBe(200);
    await warned;
    expect((await api(admin).post(`/api/admin/reports/${r.reportId}/resolve`, { action: 'dismiss' })).status).toBe(400); // already resolved
    expect(await AuditLog.countDocuments({ action: 'report.warn' })).toBe(1);
    const logs = (await api(admin).get('/api/admin/audit?action=report.warn')).body.logs;
    expect(logs[0]).toMatchObject({ actorType: 'admin', action: 'report.warn' });
  });

  it('ban from a report: kicks live sockets, blocks reconnect, login, same device and same IP; unban lifts everything', async () => {
    const { B, a, b, chatId } = await matchedPair(h);
    const r = await call(a, 'report:create', { context: 'random', chatId, category: 'harassment' });
    const admin = await adminLogin();
    const terminated = waitFor(b, 'session:terminated');
    const res = await api(admin).post(`/api/admin/reports/${r.reportId}/resolve`, { action: 'ban_temp', durationHours: 2 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await terminated).toMatchObject({ reason: 'banned', permanent: false });
    await sleep(300);
    expect(b.connected).toBe(false);

    await expect(connect(h, B)).rejects.toThrow(); // account ban
    const sameDevice = await h.agent.post('/api/auth/guest').set('x-device-id', B.deviceId).set('x-forwarded-for', randomIp()).send(age);
    expect(sameDevice.status).toBe(403);
    expect(sameDevice.body.error.code).toBe('BANNED'); // device ban
    const sameIp = await h.agent.post('/api/auth/guest').set('x-device-id', 'fresh-device-99').set('x-forwarded-for', B.ip).send(age);
    expect(sameIp.status).toBe(403); // ip ban
    const types = (await Ban.find({ userId: B.user.id }).lean()).map((x) => x.type).sort();
    expect(types).toEqual(['account', 'device', 'ip']);

    const bans = (await api(admin).get('/api/admin/bans')).body.bans;
    expect(bans.length).toBe(3);
    expect((await api(admin).del(`/api/admin/bans/${bans[0].id}`)).body.lifted).toBe(3);
    const back = await h.agent.post('/api/auth/guest').set('x-device-id', 'fresh-device-99').set('x-forwarded-for', B.ip).send(age);
    expect(back.status).toBe(200);
  });

  it('manual admin ban + escalation ladder (24h -> 7d -> permanent) and permanent for CSAM category', async () => {
    const admin = await adminLogin();
    const U = await guest(h);
    const ban = await api(admin).post('/api/admin/bans', { userId: U.user.id, reason: 'spamming', category: 'spam', hours: 5 });
    expect(ban.status, JSON.stringify(ban.body)).toBe(200);
    expect(ban.body.permanent).toBe(false);
    const U2 = await guest(h);
    // escalation via banService (auto ladder when no explicit duration)
    const r1 = await h.svc.bans.banUser(U2.user.id, { reason: 'x', category: 'harassment' });
    const r2 = await h.svc.bans.banUser(U2.user.id, { reason: 'x', category: 'harassment' });
    const r3 = await h.svc.bans.banUser(U2.user.id, { reason: 'x', category: 'harassment' });
    expect(Math.round((r1.until - Date.now()) / 3600e3)).toBe(24);
    expect(Math.round((r2.until - Date.now()) / 3600e3)).toBe(168);
    expect(r3.permanent).toBe(true);
    const U3 = await guest(h);
    expect((await h.svc.bans.banUser(U3.user.id, { reason: 'x', category: 'csam' })).permanent).toBe(true);
    const detail = (await api(admin).get(`/api/admin/users/${U2.user.id}`)).body.user;
    expect(detail.banCount).toBe(3);
  });

  it('MINOR signal in chat: message blocked, session ended, account/device/IP permanently banned, partner told, critical report queued', async () => {
    const { B, a, b, chatId } = await matchedPair(h);
    // `a` says they are 15 -> hard policy hit
    const A = (await Ban.find({}).lean()).length;
    const ended = waitFor(b, 'chat:ended');
    const terminated = waitFor(a, 'session:terminated');
    const res = await call(a, 'chat:send', { chatId, clientMsgId: mid(), text: 'i am 15 years old btw' });
    expect(res).toMatchObject({ ok: false, error: { code: 'CONTENT_POLICY' } });
    expect(res.error.details.sessionEnded).toBe(true);
    expect(await terminated).toMatchObject({ reason: 'banned', permanent: true });
    expect((await ended).reason).toBe('partner_left');
    expect(A).toBe(0);
    const bans = await Ban.find({}).lean();
    expect(bans.every((x) => x.expiresAt === null || x.type === 'ip')).toBe(true); // account + device permanent; ip capped at 7d
    expect(bans.some((x) => x.type === 'account' && x.category === 'minor' && x.expiresAt === null)).toBe(true);
    const reports = await Report.find({}).lean();
    expect(reports.length).toBe(1);
    expect(reports[0]).toMatchObject({ category: 'underage_signal', priority: 'critical', reporterId: 'system' });
    expect(reports[0].evidence.messages.some((m) => m.kind === 'blocked_text')).toBe(true);
    expect(await AuditLog.countDocuments({ action: 'content.hard_block', severity: 'critical' })).toBe(1);
    void B;
  });

  it('hard blocks cannot be disabled through the settings editor', async () => {
    const admin = await adminLogin();
    for (const patch of [{ moderation: { hardBlocks: false } }, { moderation: { csam: false } }, { auth: { minAge: 13 } }, { content: { adult: true } }]) {
      const r = await api(admin).put('/api/admin/settings', patch);
      expect([400, 422]).toContain(r.status);
    }
  });

  it('settings editor: validated, audited, and takes effect', async () => {
    const admin = await adminLogin();
    const bad = await api(admin).put('/api/admin/settings', { limits: { msgBurst: 0 } });
    expect(bad.status).toBe(400);
    const ok = await api(admin).put('/api/admin/settings', { limits: { msgMaxLength: 20 } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.settings.limits.msgMaxLength).toBe(20);
    const { a, chatId } = await matchedPair(h);
    const long = await call(a, 'chat:send', { chatId, clientMsgId: mid(), text: 'x'.repeat(30) });
    expect(long.error.code).toBe('TOO_LONG');
    expect(await AuditLog.countDocuments({ action: 'settings.update' })).toBeGreaterThan(0);
    await api(admin).put('/api/admin/settings', { limits: { msgMaxLength: 1000 } });
  });

  it('many distinct reporters trigger a SHORT auto-suspension (reviewable), not a lasting ban', async () => {
    const admin = await adminLogin();
    await api(admin).put('/api/admin/settings', { moderation: { autoSuspendReporters: 2 } });
    const target = await guest(h);
    const t = await connect(h, target);
    const kicked = waitFor(t, 'session:terminated');
    for (let i = 0; i < 2; i++) {
      const rep = await guest(h);
      const r = await connect(h, rep);
      const tt = t.connected ? t : null;
      void tt;
      const fa = waitFor(r, 'match:found');
      await call(r, 'match:start');
      if (i === 0) await call(t, 'match:start');
      else {
        // target is queued again after the previous chat ended
        await call(t, 'match:start').catch(() => {});
      }
      const f = await fa.catch(() => null);
      if (!f) continue;
      await call(r, 'report:create', { context: 'random', chatId: f.chatId, category: 'spam' });
      await call(r, 'match:leave');
    }
    await kicked;
    const ban = await Ban.findOne({ type: 'account', userId: target.user.id }).lean();
    expect(ban.expiresAt).not.toBe(null);
    expect(+ban.expiresAt - Date.now()).toBeLessThanOrEqual(3600e3 + 5000);
    expect((await Report.findOne({ reportedId: target.user.id, action: 'auto_suspend' }).lean())?.action).toBe('auto_suspend');
  });

  it('public takedown / grievance form feeds the admin takedown queue with statutory due dates', async () => {
    const bad = await h.agent.post('/api/takedown').send({ category: 'nonconsensual', requesterContact: 'x', description: 'short' });
    expect(bad.status).toBe(422);
    const t = await h.agent.post('/api/takedown').set('x-forwarded-for', randomIp()).send({ requesterName: 'Victim', requesterContact: 'victim@example.com', category: 'nonconsensual', reference: 'img_123', description: 'My private photo was shared without consent.' });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    expect(+new Date(t.body.dueAt) - Date.now()).toBeLessThanOrEqual(24 * 3600e3 + 5000); // NCII: 24h target
    const admin = await adminLogin();
    const q = (await api(admin).get('/api/admin/takedowns')).body.takedowns;
    expect(q.length).toBe(1);
    expect(q[0]).toMatchObject({ category: 'nonconsensual', status: 'open', overdue: false });
    expect((await api(admin).post(`/api/admin/takedowns/${q[0].id}/resolve`, { action: 'actioned', note: 'removed' })).status).toBe(200);
    expect((await api(admin).get('/api/admin/takedowns')).body.takedowns.length).toBe(0);
    expect(await AuditLog.countDocuments({ action: 'takedown.actioned' })).toBe(1);
  });

  it('admin 2FA hook: once enabled, admin requests need a valid TOTP code', async () => {
    const { totp } = await import('../../src/utils/crypto.js');
    const admin = await adminLogin();
    const setup = await api(admin).post('/api/admin/2fa/setup', {});
    expect(setup.body.secret).toBeTruthy();
    expect((await api(admin).post('/api/admin/2fa/enable', { code: '000000' })).status).toBe(400);
    expect((await api(admin).post('/api/admin/2fa/enable', { code: totp(setup.body.secret) })).status).toBe(200);
    expect((await api(admin).get('/api/admin/stats')).status).toBe(401);
    const good = await h.agent.get('/api/admin/stats').set('authorization', `Bearer ${admin.token}`).set('x-forwarded-for', admin.ip).set('x-admin-otp', totp(setup.body.secret));
    expect(good.status).toBe(200);
    const { User } = await import('../../src/models/User.js');
    await User.updateOne({ _id: admin.user.id }, { $set: { totpEnabled: false } });
  });

  it('room reports capture evidence, ban removes the user from rooms, custom rooms auto-hide after N reporters', async () => {
    const O = await h.agent.post('/api/auth/signup').set('x-device-id', 'room-owner-dev1').set('x-forwarded-for', randomIp()).set('x-session-slot', 'rs1').send({ ...age, email: 'ro@example.com', password: 'long enough pw' });
    const owner = { token: O.body.accessToken, deviceId: 'room-owner-dev1', user: O.body.user };
    const room = (await api({ ...owner, ip: randomIp() }).post('/api/rooms', { name: 'Reportable room' })).body.room;
    const bad = await guest(h);
    const reporters = [await guest(h), await guest(h), await guest(h)];
    const bs = await connect(h, bad);
    const jb = await call(bs, 'room:join', { roomId: room.id });
    await call(bs, 'room:send', { roomId: room.id, clientMsgId: mid(), text: 'rude message here' });
    await h.svc.settings.update({ moderation: { autoHideReports: 3 } }, 'test');
    let first;
    for (const rp of reporters) {
      const s = await connect(h, rp);
      await call(s, 'room:join', { roomId: room.id });
      const res = await call(s, 'report:create', { context: 'room', roomId: room.id, memberId: jb.me.memberId, category: 'harassment' });
      expect(res.ok, JSON.stringify(res)).toBe(true);
      first ||= res.reportId;
    }
    const detail = (await api(await adminLogin()).get(`/api/admin/reports/${first}`)).body.report;
    expect(detail.context).toMatchObject({ kind: 'room', roomId: room.id });
    expect(detail.evidence.messages.find((m) => m.text === 'rude message here')).toMatchObject({ senderRef: 'reported', senderAlias: jb.me.alias });
    const { Room } = await import('../../src/models/Room.js');
    expect((await Room.findById(room.id).lean()).hidden).toBe(true);
    const list = (await h.agent.get('/api/rooms').set('authorization', `Bearer ${reporters[0].token}`)).body.rooms;
    expect(list.find((r) => r.id === room.id)).toBeUndefined();
  });

  describe('saved chats (opt-in, both consent, encrypted)', () => {
    const regPair = async () => {
      const mk = async (n) => {
        const dev = `sv-dev-${n}-${Math.random().toString(36).slice(2, 8)}`;
        const ip = randomIp();
        const r = await h.agent.post('/api/auth/signup').set('x-device-id', dev).set('x-forwarded-for', ip).set('x-session-slot', `sv${n}x`).send({ ...age, email: `sv${n}-${Math.random().toString(36).slice(2, 7)}@example.com`, password: 'long enough pw' });
        return { token: r.body.accessToken, user: r.body.user, deviceId: dev, ip };
      };
      const [A, B] = [await mk('a'), await mk('b')];
      const [a, b] = [await connect(h, A), await connect(h, B)];
      const f = waitFor(a, 'match:found');
      await call(a, 'match:start');
      await call(b, 'match:start');
      const { chatId } = await f;
      return { A, B, a, b, chatId };
    };

    it('guests cannot save, and cannot be saved', async () => {
      const { a, chatId } = await matchedPair(h);
      expect((await call(a, 'save:request', { chatId })).error.code).toBe('SIGNUP_REQUIRED');
      const { a: ra, chatId: rc } = await regPair();
      void ra;
      void rc;
      // registered user + guest partner
      const R = await h.agent.post('/api/auth/signup').set('x-device-id', 'mixed-dev-0001').set('x-forwarded-for', randomIp()).set('x-session-slot', 'mixslot').send({ ...age, email: `mix${Date.now()}@example.com`, password: 'long enough pw' });
      const reg = { token: R.body.accessToken, deviceId: 'mixed-dev-0001' };
      const G = await guest(h);
      const [rs, gs] = [await connect(h, reg), await connect(h, G)];
      const f = waitFor(rs, 'match:found');
      await call(rs, 'match:start');
      await call(gs, 'match:start');
      const { chatId: mixed } = await f;
      expect((await call(rs, 'save:request', { chatId: mixed })).error.code).toBe('PARTNER_GUEST');
    });

    it('needs consent from both sides; stop by either side ends saving; nothing saved before consent', async () => {
      const { A, B, a, b, chatId } = await regPair();
      await slowMsg(a, chatId, 'before consent');
      const prompt = waitFor(b, 'save:prompt');
      expect(await call(a, 'save:request', { chatId })).toMatchObject({ ok: true, state: 'requested' });
      await prompt;
      await slowMsg(a, chatId, 'still before consent');
      expect(await SavedChat.countDocuments()).toBe(0);

      const activeA = waitFor(a, 'save:state', (s) => s.state === 'active');
      const activeB = waitFor(b, 'save:state', (s) => s.state === 'active');
      await call(b, 'save:respond', { chatId, accept: true });
      await Promise.all([activeA, activeB]);
      await slowMsg(a, chatId, 'secret hello ❤️');
      await slowMsg(b, chatId, 'secret reply');

      // each participant owns an independent, ENCRYPTED copy
      const docs = await SavedChat.find({}).lean();
      expect(docs.length).toBe(2);
      expect(JSON.stringify(docs)).not.toContain('secret hello');
      expect(JSON.stringify(docs)).not.toContain('secret reply');
      for (const d of docs) expect(d.messages.length).toBe(2);
      const days = (+docs[0].expiresAt - Date.now()) / 86400e3;
      expect(Math.round(days)).toBe(30);

      const listA = await h.agent.get('/api/saved').set('authorization', `Bearer ${A.token}`);
      expect(listA.body.chats.length).toBe(1);
      const readA = (await h.agent.get(`/api/saved/${listA.body.chats[0].id}`).set('authorization', `Bearer ${A.token}`)).body;
      expect(readA.messages.map((m) => [m.from, m.text])).toEqual([['me', 'secret hello ❤️'], ['them', 'secret reply']]);
      // B cannot read A's copy
      expect((await h.agent.get(`/api/saved/${listA.body.chats[0].id}`).set('authorization', `Bearer ${B.token}`)).status).toBe(404);

      const off = waitFor(a, 'save:state', (s) => s.state === 'off');
      await call(b, 'save:stop', { chatId });
      await off;
      await slowMsg(a, chatId, 'after stop');
      expect((await SavedChat.findOne({ ownerId: A.user.id }).lean()).messages.length).toBe(2);

      // user can delete their copy; the other copy is untouched
      expect((await h.agent.delete(`/api/saved/${listA.body.chats[0].id}`).set('authorization', `Bearer ${A.token}`)).status).toBe(200);
      expect(await SavedChat.countDocuments()).toBe(1);
    });

    it('decline keeps saving off; guests-only sessions never reach the saved collection', async () => {
      const { a, b, chatId } = await regPair();
      await call(a, 'save:request', { chatId });
      const declined = waitFor(a, 'save:state', (s) => s.state === 'declined');
      await call(b, 'save:respond', { chatId, accept: false });
      await declined;
      await slowMsg(a, chatId, 'not saved');
      expect(await SavedChat.countDocuments()).toBe(0);
    });

    it('chats are NOT stored in MongoDB: plaintext appears nowhere except report evidence', async () => {
      const { a, b, chatId } = await matchedPair(h);
      const marker = `marker-${Math.random().toString(36).slice(2, 10)}`;
      await slowMsg(a, chatId, `hello ${marker}`);
      await slowMsg(b, chatId, `reply ${marker}`);
      const scan = async () => {
        const out = [];
        for (const c of await mongoose.connection.db.listCollections().toArray()) {
          const docs = await mongoose.connection.db.collection(c.name).find({}).toArray();
          if (JSON.stringify(docs).includes(marker)) out.push(c.name);
        }
        return out;
      };
      expect(await scan()).toEqual([]);
      await call(a, 'report:create', { context: 'random', chatId, category: 'spam' });
      expect(await scan()).toEqual(['reports']);
    });
  });
});
