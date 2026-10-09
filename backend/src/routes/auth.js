import { Router } from 'express';
import { asyncH, validate } from '../middlewares/common.js';
import { ipLimit } from '../middlewares/ipLimit.js';
import { authController } from '../controllers/authController.js';
import * as S from '../validators/httpSchemas.js';

export function authRoutes(svc, mw) {
  const r = Router();
  const c = authController(svc);
  const lim = (name, limit, windowMs = 3600_000) => ipLimit(svc.limiter, name, { limit, windowMs });

  r.post('/guest', lim('guest', 20), validate({ body: S.guestBody }), asyncH(c.guest));
  r.post('/guest/refresh', mw.requireAuth, asyncH(c.guestRefresh));
  r.get('/me', mw.requireAuth, asyncH(c.me));
  r.patch('/me', mw.requireAuth, validate({ body: S.profileBody }), asyncH(c.updateMe));
  return r;
}
