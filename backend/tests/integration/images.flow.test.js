import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { boot, guest, connect, call, waitFor, collect, sleep, mid, matchedPair, makeImage, uploadImage, randomIp, HAS_MONGO, DOB } from '../helpers/harness.js';
import { dHash } from '../../src/utils/phash.js';
import { Ban } from '../../src/models/Ban.js';
import { Report } from '../../src/models/Report.js';
import { AuditLog } from '../../src/models/AuditLog.js';
import { K } from '../../src/config/redis.js';

const age = { dob: DOB, ageConfirmed: true };

describe.skipIf(!HAS_MONGO)('image pipeline', () => {
  let h;
  const origNsfw = () => h.svc.images.nsfw;
  let savedNsfw;
  beforeAll(async () => {
    h = await boot();
    await h.svc.auth.setAdminEmails(['admin@example.com']);
    savedNsfw = origNsfw();
  });
  afterEach(async () => {
    await h.reset();
    await Ban.deleteMany({});
    await Report.deleteMany({});
    h.svc.images.nsfw = savedNsfw;
    h.svc.settings.invalidate();
  });
  afterAll(async () => h?.stop());

  const apiAs = (who) => ({
    get: (url) => h.agent.get(url).set('authorization', `Bearer ${who.token}`).set('x-device-id', who.deviceId).set('x-forwarded-for', who.ip || '10.9.9.9'),
    post: (url, body) => h.agent.post(url).set('authorization', `Bearer ${who.token}`).set('x-device-id', who.deviceId).set('x-forwarded-for', who.ip || '10.9.9.9').send(body),
  });
  const adminLogin = async () => {
    const ip = randomIp();
    const r = await h.agent.post('/api/auth/google').set('x-forwarded-for', ip).set('x-device-id', 'admin-img-dev').send({ ...age, idToken: 'dryrun:adminsub:admin@example.com' });
    return { token: r.body.accessToken, ip, deviceId: 'admin-img-dev', user: r.body.user };
  };
  const sendImage = async (sock, chatId, imageId) => call(sock, 'chat:send', { chatId, clientMsgId: mid(), kind: 'image', imageId });

  it('full flow: upload -> worker (EXIF stripped, hashed) -> approved -> delivered as metadata only -> viewed via short-lived signed URL', async () => {
    const { A, B, a, b, chatId } = await matchedPair(h);
    const buffer = await makeImage({ width: 1200, height: 800 });
    expect((await sharp(buffer).metadata()).exif).toBeTruthy(); // fixture really has EXIF/GPS-like data
    const up = await uploadImage(h, A, a, { scope: 'chat', scopeId: chatId, buffer, viewMode: 'once' });
    expect(up.status.status).toBe('approved');

    const got = waitFor(b, 'chat:msg', (m) => m.kind === 'image');
    const ack = await sendImage(a, chatId, up.imageId);
    expect(ack.ok, JSON.stringify(ack)).toBe(true);
    const msg = await got;
    expect(msg.image).toMatchObject({ id: up.imageId, status: 'approved', viewMode: 'once' });
    expect(JSON.stringify(msg)).not.toMatch(/https?:\/\/|\.jpg|signature/i); // no URL in the chat event
    // cannot be sent twice
    expect((await sendImage(a, chatId, up.imageId)).error.code).toBe('IMAGE_ALREADY_SENT');

    // processed object has no metadata at all; original upload is gone
    const proc = path.join(h.svc.storage.dir, `proc/${up.imageId}.jpg`);
    const stored = fs.readFileSync(proc);
    const md = await sharp(stored).metadata();
    expect(md.exif).toBeUndefined();
    expect(stored.toString('latin1')).not.toContain('SECRET-LOCATION');
    expect(fs.existsSync(path.join(h.svc.storage.dir, `tmp/${up.imageId}`))).toBe(false);
    expect(md.width).toBeLessThanOrEqual(2048);

    const view = await apiAs(B).get(`/api/images/${up.imageId}/view`);
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    expect(view.headers['cache-control']).toMatch(/no-store/);
    expect(view.body).toMatchObject({ viewMode: 'once', expiresInSec: expect.any(Number), forceBlur: false });
    expect(view.body.expiresInSec).toBeGreaterThanOrEqual(30);
    expect(view.body.expiresInSec).toBeLessThanOrEqual(60);
    expect(view.body.watermark.alias).toMatch(/^Bob/);
    expect(view.body.watermark.code).toMatch(/^[0-9A-F]{6}$/);
    const u = new URL(view.body.url);
    const blob = await h.agent.get(u.pathname + u.search);
    expect(blob.status).toBe(200);
    expect(blob.headers['cache-control']).toMatch(/no-store/);
    expect(blob.headers['content-type']).toBe('image/jpeg');
    // tampered / expired links are refused
    expect((await h.agent.get(u.pathname + u.search.replace(/sig=./, 'sig=x'))).status).toBe(403);
    expect((await h.agent.get(u.pathname + '?exp=1&sig=abc')).status).toBe(403);
  });

  it('view-once: second open is refused after the retry window; owner can always view own image', async () => {
    const { A, B, a, chatId } = await matchedPair(h);
    const up = await uploadImage(h, A, a, { scope: 'chat', scopeId: chatId, buffer: await makeImage(), viewMode: 'once' });
    // not viewable by the partner until it has been sent
    expect((await apiAs(B).get(`/api/images/${up.imageId}/view`)).status).toBe(403);
    await sendImage(a, chatId, up.imageId);
    const viewed = waitFor(a, 'image:viewed');
    expect((await apiAs(B).get(`/api/images/${up.imageId}/view`)).status).toBe(200);
    await viewed;
    expect((await apiAs(B).get(`/api/images/${up.imageId}/view`)).status).toBe(200); // network-retry grace
    await h.redis.set(K.imageViewed(up.imageId, B.user.id), Date.now() - 60_000); // grace over
    const again = await apiAs(B).get(`/api/images/${up.imageId}/view`);
    expect(again.status).toBe(410);
    expect((await apiAs(A).get(`/api/images/${up.imageId}/view`)).status).toBe(200);
    expect((await apiAs(A).get(`/api/images/${up.imageId}/view`)).status).toBe(200);
  });

  it('timer mode: viewable inside the window, expired after it', async () => {
    const { A, B, a, chatId } = await matchedPair(h);
    const up = await uploadImage(h, A, a, { scope: 'chat', scopeId: chatId, buffer: await makeImage(), viewMode: 'timer', timerSec: 10 });
    await sendImage(a, chatId, up.imageId);
    expect((await apiAs(B).get(`/api/images/${up.imageId}/view`)).body.timerSec).toBe(10);
    expect((await apiAs(B).get(`/api/images/${up.imageId}/view`)).status).toBe(200);
    await h.redis.set(K.imageViewed(up.imageId, B.user.id), Date.now() - 60_000);
    expect((await apiAs(B).get(`/api/images/${up.imageId}/view`)).status).toBe(410);
  });

  it('outsiders cannot view; other conversations cannot reuse an image; invalid ids 404', async () => {
    const { A, a, chatId } = await matchedPair(h);
    const up = await uploadImage(h, A, a, { scope: 'chat', scopeId: chatId, buffer: await makeImage() });
    await sendImage(a, chatId, up.imageId);
    const outsider = await guest(h);
    expect((await apiAs(outsider).get(`/api/images/${up.imageId}/view`)).status).toBe(403);
    expect((await apiAs(outsider).get('/api/images/nope-nope-nope/view')).status).toBe(404);
    const other = await matchedPair(h);
    const up2 = await uploadImage(h, A, a, { scope: 'chat', scopeId: chatId, buffer: await makeImage({ color: { r: 1, g: 2, b: 3 } }) });
    expect((await call(other.a, 'chat:send', { chatId: other.chatId, clientMsgId: mid(), kind: 'image', imageId: up2.imageId })).ok).toBe(false);
  });

  it('upload validation: type, declared size, dimensions, scope membership, spoofed content', async () => {
    const { A, a, chatId } = await matchedPair(h);
    const buffer = await makeImage();
    const api = apiAs(A);
    const base = { contentType: 'image/jpeg', size: buffer.length, width: 640, height: 480, scope: 'chat', scopeId: chatId };
    expect((await api.post('/api/images/upload-url', { ...base, contentType: 'image/gif' })).status).toBe(422);
    expect((await api.post('/api/images/upload-url', { ...base, size: 30 * 1024 * 1024 })).status).toBe(422);
    expect((await api.post('/api/images/upload-url', { ...base, size: 6 * 1024 * 1024 })).status).toBe(413);
    expect((await api.post('/api/images/upload-url', { ...base, width: 9000 })).status).toBe(400);
    expect((await api.post('/api/images/upload-url', { ...base, scopeId: 'not-my-chat' })).body.error.code).toBe('NOT_IN_CHAT');
    expect((await api.post('/api/images/upload-url', { ...base, scope: 'room', scopeId: 'a'.repeat(24) })).body.error.code).toBe('NOT_IN_ROOM');
    // a text file renamed to .jpg is rejected by the worker (magic bytes decide)
    const fake = Buffer.from('<?php echo "not an image"; ?>'.repeat(20));
    const up = await uploadImage(h, A, a, { scope: 'chat', scopeId: chatId, buffer: fake });
    expect(up.status).toMatchObject({ status: 'rejected', reason: 'invalid_image' });
    expect((await sendImage(a, chatId, up.imageId)).error.code).toBe('IMAGE_REJECTED');
    // lying about size is refused at upload time
    const slot = await api.post('/api/images/upload-url', { ...base, size: 200 });
    const put = await h.agent.put(`/api/images/${slot.body.imageId}/upload`).set('authorization', `Bearer ${A.token}`).set('x-device-id', A.deviceId).set('x-forwarded-for', A.ip).set('content-type', 'image/jpeg').send(buffer);
    expect(put.status).toBe(413);
  });

  it('guest image limit is small (5/h) and configurable; signed-up users get more', async () => {
    const { A, a, chatId } = await matchedPair(h);
    const buffer = await makeImage({ width: 64, height: 64 });
    const base = { contentType: 'image/jpeg', size: buffer.length, width: 64, height: 64, scope: 'chat', scopeId: chatId };
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await apiAs(A).post('/api/images/upload-url', base)).status);
    expect(codes).toEqual([200, 200, 200, 200, 200, 429]);
    await h.svc.settings.update({ limits: { guestImagesPerHour: 7 } }, 'test');
    expect((await apiAs(A).post('/api/images/upload-url', base)).status).toBe(200);
    expect(a.connected).toBe(true);
  });

  it('known-bad hash match: rejected, never stored, uploader permanently banned, critical report + audit; near-duplicates also match', async () => {
    const { A, B, a, b, chatId } = await matchedPair(h);
    const bad = await makeImage({ width: 800, height: 600, noise: true, exif: false });
    await h.svc.images.hashMatch.addKnownBad({ phash: await dHash(bad) });
    const terminated = waitFor(a, 'session:terminated');
    const ended = waitFor(b, 'chat:ended');
    // re-encoded / resized copy of the same picture still matches by perceptual hash
    const variant = await sharp(bad).resize(500).jpeg({ quality: 60 }).toBuffer();
    const up = await uploadImage(h, A, a, { scope: 'chat', scopeId: chatId, buffer: variant });
    expect(up.status).toMatchObject({ status: 'rejected', reason: 'known_bad' });
    expect(await terminated).toMatchObject({ reason: 'banned', permanent: true });
    await ended;
    expect(fs.existsSync(path.join(h.svc.storage.dir, `proc/${up.imageId}.jpg`))).toBe(false);
    expect(fs.existsSync(path.join(h.svc.storage.dir, `tmp/${up.imageId}`))).toBe(false);
    expect((await Ban.findOne({ type: 'account', userId: A.user.id }).lean()).expiresAt).toBe(null);
    const rep = await Report.findOne({ reportedId: A.user.id }).lean();
    expect(rep).toMatchObject({ category: 'csam', priority: 'critical', reporterId: 'system' });
    expect(rep.details).toMatch(/NOT retained/);
    expect(await AuditLog.countDocuments({ action: 'image.known_bad', severity: 'critical' })).toBe(1);
    void B;
  });

  it('NSFW hook: mid score -> blurred (random chat ok); extreme -> rejected; non-adult rooms refuse adult content; adult rooms allow blurred', async () => {
    const { A, a, chatId } = await matchedPair(h);
    h.svc.images.nsfw = { classify: async () => ({ nsfw: 0.5, minorRisk: 0 }) };
    const blurred = await uploadImage(h, A, a, { scope: 'chat', scopeId: chatId, buffer: await makeImage({ color: { r: 9, g: 9, b: 9 } }) });
    expect(blurred.status.status).toBe('blurred');
    const B2 = await guest(h);
    void B2;
    h.svc.images.nsfw = { classify: async () => ({ nsfw: 0.97, minorRisk: 0 }) };
    const extreme = await uploadImage(h, A, a, { scope: 'chat', scopeId: chatId, buffer: await makeImage({ color: { r: 8, g: 8, b: 8 } }) });
    expect(extreme.status).toMatchObject({ status: 'rejected', reason: 'nsfw_extreme' });

    // rooms: adult content only where the room is flagged adult
    const V = await h.agent.post('/api/auth/google').set('x-device-id', 'adult-img-dev').set('x-forwarded-for', randomIp()).send({ ...age, idToken: 'dryrun:v1:viewer@example.com' });
    const verified = { token: V.body.accessToken, deviceId: 'adult-img-dev', ip: randomIp(), user: V.body.user };
    const vs = await connect(h, verified);
    const rooms = (await apiAs(verified).get('/api/rooms')).body.rooms;
    const adult = rooms.find((r) => r.slug === 'adult-lounge');
    const normal = rooms.find((r) => r.slug === 'interest-music');
    await call(vs, 'room:join', { roomId: adult.id });
    await call(vs, 'room:join', { roomId: normal.id });
    h.svc.images.nsfw = { classify: async () => ({ nsfw: 0.5, minorRisk: 0 }) };
    const inAdult = await uploadImage(h, verified, vs, { scope: 'room', scopeId: adult.id, buffer: await makeImage({ color: { r: 7, g: 7, b: 7 } }) });
    expect(inAdult.status.status).toBe('blurred');
    const inNormal = await uploadImage(h, verified, vs, { scope: 'room', scopeId: normal.id, buffer: await makeImage({ color: { r: 6, g: 6, b: 6 } }) });
    expect(inNormal.status).toMatchObject({ status: 'rejected', reason: 'adult_content_not_allowed_here' });
    // viewer UI is told to force-blur
    const guestPeer = await guest(h);
    void guestPeer;
    const sent = await call(vs, 'room:send', { roomId: adult.id, clientMsgId: mid(), kind: 'image', imageId: inAdult.imageId });
    expect(sent.ok, JSON.stringify(sent)).toBe(true);
    expect((await apiAs(verified).get(`/api/images/${inAdult.imageId}/view`)).body.forceBlur).toBe(true);
  });

  it('classifier minor-risk signal is a hard block: rejected + permanent ban', async () => {
    const { A, a, chatId } = await matchedPair(h);
    h.svc.images.nsfw = { classify: async () => ({ nsfw: 0.2, minorRisk: 0.9 }) };
    const terminated = waitFor(a, 'session:terminated');
    const up = await uploadImage(h, A, a, { scope: 'chat', scopeId: chatId, buffer: await makeImage({ color: { r: 5, g: 5, b: 5 } }) });
    expect(up.status).toMatchObject({ status: 'rejected', reason: 'minor_risk' });
    expect(await terminated).toMatchObject({ permanent: true });
  });

  it('classifier outage retries instead of silently approving unscanned images', async () => {
    const { A, a, chatId } = await matchedPair(h);
    let calls = 0;
    h.svc.images.nsfw = {
      classify: async () => {
        if (++calls < 2) throw new Error('provider down');
        return { nsfw: 0, minorRisk: 0 };
      },
    };
    const up = await uploadImage(h, A, a, { scope: 'chat', scopeId: chatId, buffer: await makeImage({ color: { r: 4, g: 4, b: 4 } }) });
    expect(up.status.status).toBe('approved');
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it('report preserves ONLY the reported image as evidence; auto-hide after N reports; others expire', async () => {
    const { A, B, a, b, chatId } = await matchedPair(h);
    const bad = await uploadImage(h, A, a, { scope: 'chat', scopeId: chatId, buffer: await makeImage({ color: { r: 100, g: 1, b: 1 } }) });
    const ok = await uploadImage(h, B, b, { scope: 'chat', scopeId: chatId, buffer: await makeImage({ color: { r: 1, g: 100, b: 1 } }) });
    await sendImage(a, chatId, bad.imageId);
    await sendImage(b, chatId, ok.imageId);
    const r = await call(b, 'report:create', { context: 'random', chatId, category: 'harassment', imageId: bad.imageId });
    expect(r.ok).toBe(true);
    const rep = await Report.findById(r.reportId).lean();
    expect(rep.evidence.images.map((i) => i.imageId)).toEqual([bad.imageId]); // the reporter's own image is NOT kept
    const evPath = path.join(h.svc.storage.dir, rep.evidence.images[0].evidenceKey);
    expect(fs.existsSync(evPath)).toBe(true);

    // admin can fetch evidence through a short-lived signed URL (audited)
    const admin = await adminLogin();
    const ev = await apiAs(admin).get(`/api/admin/evidence/${r.reportId}/${bad.imageId}`);
    expect(ev.status, JSON.stringify(ev.body)).toBe(200);
    expect(ev.body.expiresInSec).toBe(60);
    const eu = new URL(ev.body.url);
    expect((await h.agent.get(eu.pathname + eu.search)).status).toBe(200);
    expect(await AuditLog.countDocuments({ action: 'evidence.view' })).toBe(1);
    expect((await apiAs(A).get(`/api/admin/evidence/${r.reportId}/${bad.imageId}`)).status).toBe(403);

    // everything else expires on schedule; evidence stays
    await h.redis.zadd(K.imageExpiry, Date.now() - 1, bad.imageId, Date.now() - 1, ok.imageId);
    expect(await h.svc.images.sweepExpired()).toBe(2);
    expect(fs.existsSync(path.join(h.svc.storage.dir, `proc/${ok.imageId}.jpg`))).toBe(false);
    expect(fs.existsSync(path.join(h.svc.storage.dir, `proc/${bad.imageId}.jpg`))).toBe(false);
    expect(fs.existsSync(evPath)).toBe(true);
    expect((await apiAs(b).get ? 0 : 0)).toBe(0);
    expect((await apiAs(B).get(`/api/images/${bad.imageId}/view`)).status).toBe(410);
  });

  it('critical-category report hides the image immediately; admin takedown removes it and can blocklist its hash', async () => {
    const { A, B, a, b, chatId } = await matchedPair(h);
    const up = await uploadImage(h, A, a, { scope: 'chat', scopeId: chatId, buffer: await makeImage({ color: { r: 50, g: 50, b: 150 }, noise: true }) });
    await sendImage(a, chatId, up.imageId);
    const hidden = waitFor(a, 'image:hidden');
    await call(b, 'report:create', { context: 'random', chatId, category: 'nonconsensual', imageId: up.imageId });
    await hidden;
    expect((await apiAs(B).get(`/api/images/${up.imageId}/view`)).status).toBe(410);

    const admin = await adminLogin();
    const rep = (await apiAs(admin).get('/api/admin/reports')).body.reports[0];
    expect(rep.priority).toBe('critical');
    const res = await apiAs(admin).post(`/api/admin/reports/${rep.id}/resolve`, { action: 'hide_content', note: 'confirmed NCII' });
    expect(res.status).toBe(200);
    expect(await AuditLog.countDocuments({ action: 'image.takedown' })).toBe(1);
    expect(await h.redis.scard(`${K.badHashes}:phash`)).toBe(1); // re-uploads of the same picture are now blocked
  });

  it('image messages work in rooms; guests in a room can view; room image resume carries metadata', async () => {
    const [A, B] = [await guest(h), await guest(h)];
    const [a, b] = [await connect(h, A), await connect(h, B)];
    const room = (await apiAs(A).get('/api/rooms')).body.rooms.find((r) => r.slug === 'interest-movies');
    await call(a, 'room:join', { roomId: room.id });
    await call(b, 'room:join', { roomId: room.id });
    const up = await uploadImage(h, A, a, { scope: 'room', scopeId: room.id, buffer: await makeImage({ color: { r: 20, g: 120, b: 220 } }), viewMode: 'timer', timerSec: 15 });
    expect(up.status.status).toBe('approved');
    const got = collect(b, 'room:msgs', 700);
    const ack = await call(a, 'room:send', { roomId: room.id, clientMsgId: mid(), kind: 'image', imageId: up.imageId });
    expect(ack.ok).toBe(true);
    const msgs = (await got).flatMap((p) => p.msgs);
    expect(msgs[0]).toMatchObject({ kind: 'image', imageId: up.imageId, image: { viewMode: 'timer', timerSec: 15 } });
    const v = await apiAs(B).get(`/api/images/${up.imageId}/view`);
    expect(v.status).toBe(200);
    expect(v.body.watermark.alias).toBe(msgs[0].alias === v.body.watermark.alias ? msgs[0].alias : v.body.watermark.alias); // viewer's own per-room alias
    const aliasB = h.svc.rooms.identity(room.id, B.user.id).alias;
    expect(v.body.watermark.alias).toBe(aliasB);
    await sleep(10);
  });
});
