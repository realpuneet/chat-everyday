// Standalone worker process: image processing + image housekeeping. Run with `npm run start:worker`.
import { Emitter } from '@socket.io/redis-emitter';
import { config } from './config/env.js';
import { logger } from './config/logger.js';
import { createRedis } from './config/redis.js';
import { connectMongo, disconnectMongo } from './config/mongo.js';
import { createServices } from './services/index.js';
import { startImageWorker } from './jobs/imageWorker.js';
import { startSweeper } from './jobs/sweeper.js';

await connectMongo();
const redis = createRedis(config.REDIS_URL);
const svc = createServices({ redis });
// No Socket.io server here: events are published through the Redis adapter's emitter.
svc.emit.attach(new Emitter(redis));
const worker = startImageWorker(svc.images);
const stopSweeper = startSweeper(svc, [{ name: 'image-expiry', ms: 60_000, lock: true, fn: () => svc.images.sweepExpired() }]);
logger.info({ inst: config.INSTANCE_ID }, 'worker started');

let closing = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    if (closing) return;
    closing = true;
    logger.info('worker shutting down');
    stopSweeper();
    await worker.close(); // waits for in-flight jobs
    await svc.imageQueue.close();
    await redis.quit().catch(() => {});
    await disconnectMongo();
    process.exit(0);
  });
}
