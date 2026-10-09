import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';
import { createRedis } from '../config/redis.js';
import { rooms } from './emitter.js';
import { toErrorPayload, unauthorized } from '../utils/errors.js';
import { hashIp, hashDevice } from '../utils/crypto.js';
import { User } from '../models/User.js';
import * as S from '../validators/socketSchemas.js';
import { registerRandomHandlers } from './random.js';
import { registerRoomHandlers } from './rooms.js';
import { registerExtraHandlers } from './extras.js';

const MAX_WRITE_BUFFER = 300; // packets queued for a slow consumer before we cut it off

export function createSocketServer(httpServer, svc) {
  const io = new Server(httpServer, {
    transports: ['websocket'],
    cors: { origin: config.CORS_ORIGINS, credentials: true },
    maxHttpBufferSize: 64 * 1024,
    pingInterval: 20_000,
    pingTimeout: 20_000,
    connectionStateRecovery: undefined, // we use explicit, app-level resume (works across instances)
  });

  const pub = createRedis(config.REDIS_URL);
  const sub = pub.duplicate();
  io.adapter(createAdapter(pub, sub));
  io._adapterClients = [pub, sub];
  svc.emit.attach(io);

  io.use(async (socket, next) => {
    try {
      const { token, deviceId, fp } = socket.handshake.auth || {};
      const claims = svc.tokens.verifyAccess(token);
      const ip = socket.handshake.headers['x-forwarded-for']?.split(',')[0]?.trim() || socket.handshake.address;
      const ipHash = hashIp(config.TRUST_PROXY ? ip : socket.handshake.address);
      const dev = typeof deviceId === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(deviceId) ? deviceId : '';
      const deviceHash = dev ? hashDevice(dev) : '';
      const user = await User.findById(claims.userId).lean();
      if (!user) throw unauthorized('Account not found');
      await svc.bans.assertNotBanned({ userId: String(user._id), ipHash, deviceHash });
      socket.data.user = {
        id: String(user._id),
        _id: String(user._id),
        kind: user.kind,
        role: user.role,
        nickname: user.nickname,
        avatar: user.avatar,
        gender: user.gender,
        lang: user.lang,
        ageLevel: user.ageLevel,
        ipHash,
        deviceHash,
        fpHash: typeof fp === 'string' && fp ? hashDevice(`fp:${fp}`) : '',
      };
      socket.data.deviceId = dev;
      socket.data.exp = claims.exp;
      next();
    } catch (e) {
      const p = toErrorPayload(e);
      const err = new Error(p.error.message);
      err.data = p.error;
      next(err);
    }
  });

  io.on('connection', (socket) => onConnection(io, socket, svc));

  // Slow-consumer protection: drop sockets whose outbound buffer keeps growing.
  const slowTimer = setInterval(() => {
    for (const s of io.sockets.sockets.values()) {
      if ((s.conn?.writeBuffer?.length ?? 0) > MAX_WRITE_BUFFER) {
        logger.warn({ sid: s.id }, 'disconnecting slow consumer');
        s.emit('session:terminated', { reason: 'slow_consumer' });
        s.disconnect(true);
      }
    }
  }, 5000);
  slowTimer.unref();

  // Live online count: one broadcast every few seconds per instance (cheap, coalesced).
  const onlineTimer = setInterval(async () => {
    try {
      io.emit('presence:online', { count: await svc.presence.onlineCount() });
    } catch {
      /* ignore */
    }
  }, 5000);
  onlineTimer.unref();

  io._timers = [slowTimer, onlineTimer];
  return io;
}

async function onConnection(io, socket, svc) {
  const user = socket.data.user;
  const userId = user.id;
  socket.join(rooms.user(userId));
  if (user.role === 'admin') socket.join(rooms.admin);

  const { wasOffline } = await svc.presence.addSocket(userId, socket.id, socket.data.deviceId);
  if (wasOffline) await svc.chat.onUserOnline(userId);
  await svc.rooms?.onSocketConnected?.(socket, user);

  // Expire the connection when the access token lapses unless the client refreshed it.
  let expTimer;
  const armExpiry = () => {
    clearTimeout(expTimer);
    const ms = Math.max(1000, socket.data.exp * 1000 - Date.now() + 60_000);
    expTimer = setTimeout(() => {
      socket.emit('session:terminated', { reason: 'token_expired' });
      socket.disconnect(true);
    }, Math.min(ms, 2 ** 31 - 1));
    expTimer.unref?.();
  };
  armExpiry();

  const ctx = {
    io,
    svc,
    on(event, schema, handler) {
      socket.on(event, async (payload, ack) => {
        const cb = typeof ack === 'function' ? ack : () => {};
        try {
          const data = schema ? schema.parse(payload ?? {}) : {};
          await svc.limiter.assertBucket('sockev', socket.id, { capacity: 60, refillPerSec: 30 }, 'Too many events');
          const result = await handler(data, socket);
          cb({ ok: true, ...(result || {}) });
        } catch (e) {
          const p = toErrorPayload(e);
          if (p.status >= 500) logger.error({ err: e?.message, stack: e?.stack, event }, 'socket handler error');
          cb({ ok: false, error: p.error });
        }
      });
    },
  };

  ctx.on('auth:refresh', S.authRefresh, async ({ token }) => {
    const claims = svc.tokens.verifyAccess(token);
    if (claims.userId !== userId) throw unauthorized('Token belongs to another account');
    socket.data.exp = claims.exp;
    // A guest -> registered upgrade keeps the same userId; reflect the new kind without reconnecting.
    socket.data.user.kind = claims.kind;
    socket.data.user.role = claims.role;
    const fresh = await User.findById(userId).select('ageLevel gender nickname').lean();
    if (fresh) Object.assign(socket.data.user, { ageLevel: fresh.ageLevel, gender: fresh.gender, nickname: fresh.nickname });
    armExpiry();
    return { kind: claims.kind };
  });
  ctx.on('presence:ping', null, async () => {
    await svc.presence.heartbeat(socket.id);
    return { online: await svc.presence.onlineCount() };
  });

  registerRandomHandlers(ctx, socket);
  registerRoomHandlers(ctx, socket);
  registerExtraHandlers(ctx, socket);

  socket.emit('session:ready', {
    user: { id: userId, nickname: user.nickname, avatar: user.avatar, kind: user.kind, role: user.role },
    online: await svc.presence.onlineCount(),
    deviceId: socket.data.deviceId,
  });

  socket.on('disconnect', async () => {
    clearTimeout(expTimer);
    try {
      const remaining = await svc.presence.removeSocket(userId, socket.id);
      if (remaining === 0) {
        await svc.chat.onUserOffline(userId);
        await svc.rooms?.onUserOffline?.(userId);
      }
    } catch (e) {
      logger.error({ err: e.message }, 'disconnect cleanup failed');
    }
  });
}
