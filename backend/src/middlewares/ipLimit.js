import { tooMany } from '../utils/errors.js';
import { config } from '../config/env.js';

/** Per-IP sliding-window limiter for HTTP routes. */
export const ipLimit = (limiter, name, { limit, windowMs }) => async (req, res, next) => {
  try {
    const r = await limiter.window(`ip:${name}`, req.client?.ipHash || req.ip, { limit: limit * config.RATE_LIMIT_MULTIPLIER, windowMs });
    if (!r.allowed) throw tooMany('Too many requests', Math.ceil(r.retryAfterMs / 1000));
    next();
  } catch (e) {
    next(e);
  }
};
