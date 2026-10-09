import { io as ioc } from 'socket.io-client';
import request from 'supertest';
import mongoose from 'mongoose';
import { expect } from 'vitest';

export const HAS_MONGO = !!process.env.TEST_MONGO_URI;
export const DOB = '1995-03-04';

let counter = 0;

/** Boot the full stack (HTTP + Socket.io + real Redis + real Mongo-compatible DB). */
export async function boot({ sweeper = false, settings } = {}) {
  const { startServer } = await import('../../src/bootstrap.js');
  const dbName = `ce_test_${process.pid}_${Date.now()}_${counter++}`;
  const u = new URL(process.env.TEST_MONGO_URI);
  u.pathname = `/${dbName}`;
  const h = await startServer({ port: 0, mongoUri: u.toString(), sweeper });
  h.dbName = dbName;
  h.url = `http://127.0.0.1:${h.port}`;
  h.agent = request(h.app);
  h.sockets = [];
  if (settings) await h.svc.settings.update(settings, 'test');
  /** Call from afterEach: drop sockets and wipe all Redis state so tests cannot leak users into each other's queues. */
  h.reset = async () => {
    h.sockets.splice(0).forEach((s) => s.close());
    await sleep(80);
    const keys = (await h.redis.keys('*')).filter((k) => !k.startsWith('bull:')); // keep BullMQ's own state
    if (keys.length) await h.redis.del(...keys);
  };
  h.stop = async () => {
    h.sockets.forEach((s) => s.close());
    await mongoose.connection.dropDatabase().catch(() => {});
    await h.shutdown('test');
  };
  return h;
}

export const randomIp = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${1 + Math.floor(Math.random() * 250)}`;

export async function guest(h, { nickname, gender, deviceId, ip } = {}) {
  const dev = deviceId || `dev_${Math.random().toString(36).slice(2, 12)}`;
  const clientIp = ip || randomIp();
  const res = await h.agent
    .post('/api/auth/guest')
    .set('x-device-id', dev)
    .set('x-forwarded-for', clientIp)
    .send({ dob: DOB, ageConfirmed: true, ...(nickname ? { nickname } : {}), ...(gender ? { gender } : {}) });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { token: res.body.accessToken, user: res.body.user, deviceId: dev, ip: clientIp };
}

export function connect(h, who, { deviceId } = {}) {
  return new Promise((resolve, reject) => {
    const s = ioc(h.url, {
      transports: ['websocket'],
      auth: { token: who.token, deviceId: deviceId || who.deviceId },
      extraHeaders: who.ip ? { 'x-forwarded-for': who.ip } : {},
      reconnection: false,
      forceNew: true,
    });
    s.once('session:ready', () => resolve(s));
    s.once('connect_error', (e) => reject(Object.assign(new Error(e.message), { data: e.data })));
    h.sockets.push(s);
  });
}

export const call = (s, event, data = {}) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`ack timeout: ${event}`)), 5000);
    s.emit(event, data, (res) => {
      clearTimeout(t);
      resolve(res);
    });
  });

export const waitFor = (s, event, pred = () => true, ms = 5000) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      s.off(event, on);
      reject(new Error(`timeout waiting for ${event}`));
    }, ms);
    const on = (payload) => {
      if (!pred(payload)) return;
      clearTimeout(t);
      s.off(event, on);
      resolve(payload);
    };
    s.on(event, on);
  });

/** Collect events for `ms` and return them (used to assert something does NOT arrive). */
export const collect = (s, event, ms = 300) =>
  new Promise((resolve) => {
    const out = [];
    const on = (p) => out.push(p);
    s.on(event, on);
    setTimeout(() => {
      s.off(event, on);
      resolve(out);
    }, ms);
  });

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const mid = () => `m_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

/** Two connected guests that have been matched into a random chat. */
export async function matchedPair(h, opts = {}) {
  const [A, B] = [await guest(h, { nickname: 'Alice' + counter }), await guest(h, { nickname: 'Bob' + counter })];
  const [a, b] = [await connect(h, A), await connect(h, B)];
  const fa = waitFor(a, 'match:found');
  const fb = waitFor(b, 'match:found');
  await call(a, 'match:start', opts.a || {});
  await call(b, 'match:start', opts.b || {});
  const [ma, mb] = await Promise.all([fa, fb]);
  return { A, B, a, b, ma, mb, chatId: ma.chatId };
}

// ---------------------------------------------------------------- images
import sharp from 'sharp';

/** Create a real JPEG (optionally with EXIF/GPS metadata that the pipeline must strip). */
export async function makeImage({ width = 640, height = 480, color = { r: 200, g: 80, b: 40 }, exif = true, format = 'jpeg', noise = false } = {}) {
  let img = sharp({ create: { width, height, channels: 3, background: color } });
  if (noise) {
    // structured "picture" (shapes + gradient) so perceptual hashing behaves like it does on real photos
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#102030"/><stop offset="1" stop-color="#e0d0a0"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="${width * 0.3}" cy="${height * 0.35}" r="${height * 0.22}" fill="#f03030"/><rect x="${width * 0.55}" y="${height * 0.5}" width="${width * 0.35}" height="${height * 0.4}" fill="#2060e0"/><polygon points="${width * 0.1},${height * 0.9} ${width * 0.3},${height * 0.55} ${width * 0.45},${height * 0.9}" fill="#30c050"/></svg>`;
    img = sharp(Buffer.from(svg));
  }
  if (exif) img = img.withExif({ IFD0: { ImageDescription: 'SECRET-LOCATION-42.36,-71.05', Copyright: 'someone' } });
  return img[format]().toBuffer();
}

/** Request an upload slot, PUT the bytes, complete, and wait for the worker verdict. */
export async function uploadImage(h, who, sock, { scope, scopeId, buffer, contentType = 'image/jpeg', viewMode, timerSec, wait = true, claim } = {}) {
  const meta = await sharp(buffer).metadata().catch(() => ({ width: 100, height: 100 }));
  const api = (m, url) => h.agent[m](url).set('authorization', `Bearer ${who.token}`).set('x-device-id', who.deviceId).set('x-forwarded-for', who.ip || '10.9.9.9');
  const slot = await api('post', '/api/images/upload-url').send({ contentType, size: claim?.size ?? buffer.length, width: meta.width || 100, height: meta.height || 100, scope, scopeId, ...(viewMode ? { viewMode } : {}), ...(timerSec ? { timerSec } : {}) });
  if (slot.status !== 200) return { slot };
  const { imageId } = slot.body;
  const verdict = wait ? waitFor(sock, 'image:status', (p) => p.imageId === imageId && p.status !== 'processing', 15000) : null;
  const put = await api('put', `/api/images/${imageId}/upload`).set('content-type', contentType).send(buffer);
  if (put.status !== 200) return { slot, put, imageId };
  const done = await api('post', `/api/images/${imageId}/complete`).send({});
  return { slot, put, done, imageId, status: wait ? await verdict : undefined };
}
