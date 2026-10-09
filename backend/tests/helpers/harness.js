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
    await h.redis.flushall();
  };
  h.stop = async () => {
    h.sockets.forEach((s) => s.close());
    await mongoose.connection.dropDatabase().catch(() => {});
    await h.shutdown('test');
  };
  return h;
}

export async function guest(h, { nickname, gender, deviceId } = {}) {
  const dev = deviceId || `dev_${Math.random().toString(36).slice(2, 12)}`;
  const res = await h.agent
    .post('/api/auth/guest')
    .set('x-device-id', dev)
    .send({ dob: DOB, ageConfirmed: true, ...(nickname ? { nickname } : {}), ...(gender ? { gender } : {}) });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { token: res.body.accessToken, user: res.body.user, deviceId: dev };
}

export function connect(h, who, { deviceId } = {}) {
  return new Promise((resolve, reject) => {
    const s = ioc(h.url, {
      transports: ['websocket'],
      auth: { token: who.token, deviceId: deviceId || who.deviceId },
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
