import crypto from 'node:crypto';
import { hashIp, hashDevice } from '../utils/crypto.js';
import { toErrorPayload, validation, notFound } from '../utils/errors.js';
import { logger } from '../config/logger.js';

export function requestId(req, res, next) {
  const id = String(req.headers['x-request-id'] || '').slice(0, 64) || crypto.randomUUID();
  req.id = id;
  res.setHeader('x-request-id', id);
  next();
}

/** Resolve caller identity hints: IP hash and device hash (client supplied, so only ever used for abuse signals). */
export function clientInfo(req, _res, next) {
  const deviceId = String(req.headers['x-device-id'] || '').slice(0, 64);
  const fp = String(req.headers['x-fp'] || '').slice(0, 64);
  req.client = {
    ip: req.ip,
    ipHash: hashIp(req.ip),
    deviceId: /^[A-Za-z0-9_-]{8,64}$/.test(deviceId) ? deviceId : '',
    deviceHash: deviceId ? hashDevice(deviceId) : '',
    fpHash: fp ? hashDevice(`fp:${fp}`) : '',
    ua: String(req.headers['user-agent'] || '').slice(0, 200),
  };
  next();
}

/** Zod validation for body/query/params. Replaces values with parsed output. */
export const validate =
  (schemas) =>
  (req, _res, next) => {
    try {
      for (const part of ['params', 'query', 'body']) {
        if (!schemas[part]) continue;
        const r = schemas[part].safeParse(req[part] ?? {});
        if (!r.success) throw validation(r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
        if (part === 'query') Object.defineProperty(req, 'query', { value: r.data, writable: true });
        else req[part] = r.data;
      }
      next();
    } catch (e) {
      next(e);
    }
  };

export const asyncH = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export const notFoundHandler = (_req, _res, next) => next(notFound('Route not found'));

export function errorHandler(err, req, res, _next) {
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Payload too large' } });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Malformed JSON' } });
  }
  const { status, error } = toErrorPayload(err);
  if (status >= 500) logger.error({ err: err?.message, stack: err?.stack, reqId: req.id, path: req.path }, 'unhandled error');
  if (err?.details?.retryAfterSec) res.setHeader('Retry-After', String(err.details.retryAfterSec));
  res.status(status).json({ error: { ...error, requestId: req.id } });
}
