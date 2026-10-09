import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';
import { config } from './config/env.js';
import { logger } from './config/logger.js';
import { requestId, clientInfo, errorHandler, notFoundHandler } from './middlewares/common.js';
import { makeAuth } from './middlewares/auth.js';
import { buildRoutes } from './routes/index.js';

/** Build the Express app. `health` exposes readiness state so /readyz can reflect shutdown. */
export function createApp(svc, { health = { ready: true, shuttingDown: false }, mongoose } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY);

  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => req.id,
      autoLogging: { ignore: (req) => req.url === '/healthz' || req.url === '/readyz' },
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      serializers: {
        req: (req) => ({ id: req.id, method: req.method, url: req.url.split('?')[0], ip: undefined }),
        res: (res) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(
    helmet({
      contentSecurityPolicy: { useDefaults: false, directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"], baseUri: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );
  const origins = new Set(config.CORS_ORIGINS);
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || origins.has(origin)),
      credentials: true,
      allowedHeaders: ['content-type', 'authorization', 'x-device-id', 'x-fp', 'x-session-slot', 'x-admin-otp', 'x-request-id'],
      maxAge: 600,
    }),
  );
  app.use(cookieParser());

  app.get('/healthz', (_req, res) => res.json({ ok: true }));
  app.get('/readyz', async (_req, res) => {
    if (health.shuttingDown) return res.status(503).json({ ready: false, reason: 'shutting_down' });
    try {
      await svc.redis.ping();
      if (mongoose && mongoose.connection.readyState !== 1) throw new Error('mongo not ready');
      res.json({ ready: true });
    } catch (e) {
      res.status(503).json({ ready: false, reason: e.message });
    }
  });

  app.use(clientInfo);
  const mw = makeAuth({ tokens: svc.tokens, authService: svc.auth, bans: svc.bans });
  // Routes that need raw bodies (image upload) are mounted before the JSON parser inside buildRoutes.
  app.use('/api', buildRoutes(svc, mw, { json: express.json({ limit: '32kb' }), express }));

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
