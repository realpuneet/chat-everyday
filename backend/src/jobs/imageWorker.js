import { Queue, Worker } from 'bullmq';
import { createBullConnection } from '../config/redis.js';
import { config } from '../config/env.js';
import { logger } from '../config/logger.js';

export const IMAGE_QUEUE = 'image-process';

export function createImageQueue(url = config.REDIS_URL) {
  return new Queue(IMAGE_QUEUE, { connection: createBullConnection(url) });
}

/** Start a BullMQ worker that runs ImageService.process for each uploaded image. */
export function startImageWorker(images, { url = config.REDIS_URL, concurrency = 4 } = {}) {
  const worker = new Worker(
    IMAGE_QUEUE,
    async (job) => images.process(job.data.id),
    { connection: createBullConnection(url), concurrency },
  );
  worker.on('failed', (job, err) => {
    logger.warn({ id: job?.data?.id, attempt: job?.attemptsMade, err: err.message }, 'image job failed');
    if (job && job.attemptsMade >= (job.opts.attempts || 1)) images.markFailed(job.data.id, err);
  });
  worker.on('error', (err) => logger.error({ err: err.message }, 'image worker error'));
  return worker;
}
