import pino from 'pino';
import crypto from 'node:crypto';
import { config } from './env.js';

export function hashPii(value) {
  if (!value) return value;
  return crypto.createHmac('sha256', config.PEPPER).update(String(value)).digest('hex').slice(0, 16);
}

export const logger = pino({
  level: config.isTest ? 'silent' : config.LOG_LEVEL,
  base: { svc: 'chat-api', inst: config.INSTANCE_ID },
  redact: {
    paths: [
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
    ],
    censor: '[redacted]',
  },
  transport: !config.isProd && !config.isTest ? { target: 'pino-pretty', options: { colorize: true } } : undefined,
});
