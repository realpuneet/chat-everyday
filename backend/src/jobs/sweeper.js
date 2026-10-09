import { logger } from '../config/logger.js';
import { K } from '../config/redis.js';
import { User } from '../models/User.js';

/**
 * Background maintenance. Fast, idempotent claim-based tasks run on every instance; slower global
 * tasks take a short Redis lock so only one instance does the work per tick.
 */
export function startSweeper(svc, extraTasks = []) {
  const timers = [];
  const every = (ms, name, fn) => {
    let running = false;
    const t = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        await fn();
      } catch (e) {
        logger.error({ err: e.message, task: name }, 'sweeper task failed');
      } finally {
        running = false;
      }
    }, ms);
    t.unref();
    timers.push(t);
  };
  const locked = (name, ttlMs, fn) => async () => {
    const ok = await svc.redis.set(`${K.sweeperLock}:${name}`, svc.cfg.INSTANCE_ID, 'PX', ttlMs, 'NX');
    if (ok) await fn();
  };

  every(1000, 'fallbacks', () => svc.chat.processFallbacks());
  every(1000, 'disconnects', () => svc.chat.processDisconnects());
  every(10_000, 'stale-queue', locked('stale', 9000, () => svc.chat.processStale()));
  every(30_000, 'presence', locked('presence', 29_000, async () => {
    const offline = await svc.presence.sweepStale();
    for (const uid of offline) {
      await svc.chat.onUserOffline(uid);
      await svc.rooms?.onUserOffline?.(uid);
    }
  }));
  every(5 * 60_000, 'ban-cache', locked('bans', 4 * 60_000, () => svc.bans.warmCache()));
  every(10 * 60_000, 'guest-cleanup', locked('guests', 9 * 60_000, async () => {
    await User.deleteMany({ kind: 'guest', expiresAt: { $lt: new Date() } });
  }));
  for (const t of extraTasks) every(t.ms, t.name, t.lock ? locked(t.name, t.ms - 500, t.fn) : t.fn);

  return () => timers.forEach(clearInterval);
}
