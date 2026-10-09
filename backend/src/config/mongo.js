import mongoose from 'mongoose';
import { config } from './env.js';
import { logger } from './logger.js';

mongoose.set('strictQuery', true);

export async function connectMongo(uri = config.MONGO_URI) {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000, maxPoolSize: 20 });
  logger.info('mongo connected');
  return mongoose.connection;
}

/** Index creation must never block boot (some Mongo-compatible servers lack partial/TTL support). */
export async function syncIndexes() {
  const models = Object.values(mongoose.models);
  await Promise.all(
    models.map((m) =>
      m.createIndexes().catch((e) => logger.warn({ model: m.modelName, err: e.message }, 'index creation skipped')),
    ),
  );
}

export const disconnectMongo = () => mongoose.disconnect();
