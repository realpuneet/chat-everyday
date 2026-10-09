import { startServer } from './bootstrap.js';
import { logger } from './config/logger.js';

const handle = await startServer();

let forced = false;
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    if (forced) process.exit(1);
    forced = true;
    const t = setTimeout(() => {
      logger.error('shutdown timed out, forcing exit');
      process.exit(1);
    }, 15_000);
    t.unref();
    await handle.shutdown(sig);
    process.exit(0);
  });
}
process.on('unhandledRejection', (e) => logger.error({ err: String(e) }, 'unhandledRejection'));
process.on('uncaughtException', (e) => {
  logger.fatal({ err: e.message, stack: e.stack }, 'uncaughtException');
  process.exit(1);
});
