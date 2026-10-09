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
  // signup / google / phone accept an optional guest bearer token => the guest session is upgraded in place
  r.post('/signup', lim('signup', 10), mw.optionalAuth, validate({ body: S.emailSignupBody }), asyncH(c.signup));
  r.post('/login', lim('login', 40), validate({ body: S.emailLoginBody }), asyncH(c.login));
  r.post('/google', lim('google', 40), mw.optionalAuth, validate({ body: S.googleBody }), asyncH(c.google));
  r.post('/phone/request', lim('phone-req', 15), validate({ body: S.phoneRequestBody }), asyncH(c.phoneRequest));
  r.post('/phone/verify', lim('phone-verify', 40), mw.optionalAuth, validate({ body: S.phoneVerifyBody }), asyncH(c.phoneVerify));
  r.post('/refresh', lim('refresh', 600), asyncH(c.refresh));
  r.post('/logout', asyncH(c.logout));
  r.post('/logout-all', mw.requireAuth, asyncH(c.logoutAll));
  r.get('/devices', mw.requireAuth, asyncH(c.devices));
  r.get('/me', mw.requireAuth, asyncH(c.me));
  r.patch('/me', mw.requireAuth, validate({ body: S.profileBody }), asyncH(c.updateMe));
  return r;
}
