import http from 'node:http';
import mongoose from 'mongoose';
import { config } from './config/env.js';
import { logger } from './config/logger.js';
import { createRedis } from './config/redis.js';
import { connectMongo, syncIndexes, disconnectMongo } from './config/mongo.js';
import { createServices } from './services/index.js';
import { createApp } from './app.js';
import { createSocketServer } from './sockets/index.js';
import { startSweeper } from './jobs/sweeper.js';

/**
 * Boot everything. Returns handles so tests (and graceful shutdown) can control the lifecycle.
 * @param {{port?:number, mongoUri?:string, redisUrl?:string, sweeper?:boolean}} opts
 */
export async function startServer(opts = {}) {
  const redis = createRedis(opts.redisUrl || config.REDIS_URL);
  if (mongoose.connection.readyState === 0) await connectMongo(opts.mongoUri || config.MONGO_URI);
  await syncIndexes();

  const svc = createServices({ redis });
  const health = { ready: false, shuttingDown: false };
  const app = createApp(svc, { health, mongoose });
  const server = http.createServer(app);
  const io = createSocketServer(server, svc);
  svc.io = io;

  await svc.afterBoot?.();
  await svc.bans.warmCache().catch((e) => logger.warn({ err: e.message }, 'ban cache warm failed'));
  const stopSweeper = opts.sweeper === false || config.DISABLE_SWEEPER ? () => {} : startSweeper(svc, svc.sweeperTasks || []);

  await new Promise((resolve) => server.listen(opts.port ?? config.PORT, resolve));
  health.ready = true;
  const port = server.address().port;
  logger.info({ port, inst: config.INSTANCE_ID, dryRun: config.dryRun }, 'api listening');

  let closing = null;
  async function shutdown(reason = 'manual') {
    if (closing) return closing;
    closing = (async () => {
      logger.info({ reason }, 'graceful shutdown start');
      health.ready = false;
      health.shuttingDown = true; // /readyz now returns 503 so load balancers stop routing here
      stopSweeper();
      io._timers?.forEach(clearInterval);
      io.emit('server:shutdown', { reconnectInMs: 1000 + Math.floor(Math.random() * 4000) });
      await new Promise((r) => server.close(r)); // stop accepting new connections
      await new Promise((r) => io.close(r)); // drain + close remaining sockets
      await svc.stop?.();
      for (const c of io._adapterClients || []) c.disconnect();
      await redis.quit().catch(() => redis.disconnect());
      await disconnectMongo();
      logger.info('graceful shutdown complete');
    })();
    return closing;
  }

  return { app, server, io, svc, redis, port, shutdown, health };
}
