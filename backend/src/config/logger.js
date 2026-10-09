import pino from 'pino';
import crypto from 'node:crypto';
import { config } from './env.js';

export function hashPii(value) {
  if (!value) return value;
  return crypto.createHmac('sha256', config.PEPPER).update(String(value)).digest('hex').slice(0, 16);
}

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.phone',
  '*.email',
  '*.ip',
  '*.idToken',
  '*.otp',
  '*.code',
  '*.token',
  '*.refreshToken',
  'phone',
  'email',
  'ip',
  'password',
  'token',
  'otp',
  'idToken',
];

/** Factory so tests can capture output; production uses the shared `logger` below. */
export function buildLogger({ level = config.LOG_LEVEL, stream, pretty = false } = {}) {
  return pino(
    {
      level,
      base: { svc: 'chat-api', inst: config.INSTANCE_ID },
      redact: { paths: REDACT_PATHS, censor: '[redacted]' },
      transport: pretty ? { target: 'pino-pretty', options: { colorize: true } } : undefined,
    },
    pretty ? undefined : stream,
  );
}

export const logger = buildLogger({ level: config.isTest ? 'silent' : config.LOG_LEVEL, pretty: !config.isProd && !config.isTest });
