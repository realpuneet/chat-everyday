import { Router } from 'express';
import { authRoutes } from './auth.js';
import { asyncH } from '../middlewares/common.js';

export function buildRoutes(svc, mw, { json }) {
  const r = Router();
  // (raw-body routes such as image upload are mounted above this line)
  r.use(json);
  r.use('/auth', authRoutes(svc, mw));

  r.get(
    '/stats/public',
    asyncH(async (_req, res) => {
      res.json({ online: await svc.presence.onlineCount() });
    }),
  );
  return r;
}
