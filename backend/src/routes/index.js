import { Router } from 'express';
import { authRoutes } from './auth.js';
import { roomRoutes } from './rooms.js';
import { safetyRoutes } from './safety.js';
import { adminRoutes } from './admin.js';
import { imageRoutes, imageRawRoutes } from './images.js';
import { asyncH } from '../middlewares/common.js';
import { ageController } from '../controllers/safetyControllers.js';

export function buildRoutes(svc, mw, { json, express }) {
  const r = Router();

  // Raw-body routes are mounted BEFORE the JSON parser.
  r.post('/age/webhook', express.raw({ type: '*/*', limit: '16kb' }), asyncH(ageController(svc).webhook));

  r.use('/images', imageRawRoutes(svc, mw, express));

  r.use(json);
  r.use('/auth', authRoutes(svc, mw));
  r.use('/rooms', roomRoutes(svc, mw));
  r.use('/images', imageRoutes(svc, mw));
  r.use('/admin', adminRoutes(svc, mw));

  r.get(
    '/stats/public',
    asyncH(async (_req, res) => {
      res.json({ online: await svc.presence.onlineCount() });
    }),
  );
  r.use('/', safetyRoutes(svc, mw));
  return r;
}
