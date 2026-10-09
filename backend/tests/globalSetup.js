import { spawn } from 'node:child_process';
import net from 'node:net';
import Redis from 'ioredis';
import mongoose from 'mongoose';

let redisProc;

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on('error', reject);
  });

async function waitRedis(url) {
  for (let i = 0; i < 50; i++) {
    const r = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 0, retryStrategy: () => null });
    r.on('error', () => {});
    try {
      await r.connect();
      await r.ping();
      r.disconnect();
      return true;
    } catch {
      r.disconnect();
      await new Promise((res) => setTimeout(res, 100));
    }
  }
  return false;
}

async function mongoReachable(uri) {
  try {
    const c = await mongoose.createConnection(uri, { serverSelectionTimeoutMS: 2500 }).asPromise();
    await c.close();
    return true;
  } catch {
    return false;
  }
}

export async function setup() {
  // ---- Redis (real server, never a mock: the matcher relies on Lua semantics) ----
  if (!process.env.TEST_REDIS_URL) {
    const port = await freePort();
    redisProc = spawn('redis-server', ['--port', String(port), '--save', '', '--appendonly', 'no', '--bind', '127.0.0.1'], { stdio: 'ignore' });
    process.env.TEST_REDIS_URL = `redis://127.0.0.1:${port}`;
  }
  if (!(await waitRedis(process.env.TEST_REDIS_URL))) throw new Error('Test Redis is not reachable. Install redis-server or set TEST_REDIS_URL.');

  // ---- MongoDB: TEST_MONGO_URI, else mongodb-memory-server if installed, else local probes ----
  let uri = process.env.TEST_MONGO_URI;
  if (!uri) {
    try {
      const { MongoMemoryServer } = await import('mongodb-memory-server');
      globalThis.__mms = await MongoMemoryServer.create();
      uri = globalThis.__mms.getUri();
    } catch {
      for (const cand of ['mongodb://127.0.0.1:27017', 'mongodb://127.0.0.1:27018']) {
        if (await mongoReachable(cand)) {
          uri = cand;
          break;
        }
      }
    }
  }
  if (uri && (await mongoReachable(uri))) process.env.TEST_MONGO_URI = uri;
  else {
    delete process.env.TEST_MONGO_URI;
    console.warn('\n[tests] MongoDB not available: Mongo-backed integration tests will be SKIPPED.\n');
  }
}

export async function teardown() {
  redisProc?.kill('SIGTERM');
  await globalThis.__mms?.stop?.();
}
