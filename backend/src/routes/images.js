import { Router } from 'express';
import { z } from 'zod';
import { asyncH, validate } from '../middlewares/common.js';
import { ipLimit } from '../middlewares/ipLimit.js';
import { imageController } from '../controllers/imageController.js';
import { idParam } from '../validators/httpSchemas.js';

const uploadBody = z
  .object({
    contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
    size: z.number().int().min(100).max(25 * 1024 * 1024),
    width: z.number().int().min(1).max(20000),
    height: z.number().int().min(1).max(20000),
    scope: z.enum(['chat', 'room']),
    scopeId: z.string().min(1).max(64),
    viewMode: z.enum(['once', 'timer']).optional(),
    timerSec: z.number().int().min(3).max(120).optional(),
  })
  .strict();

/** Routes that must see the raw request body are exported separately and mounted before the JSON parser. */
export function imageRawRoutes(svc, mw, express) {
  const r = Router();
  const c = imageController(svc);
  r.put('/:id/upload', mw.requireAuth, express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '26mb' }), validate({ params: idParam }), asyncH(c.upload));
  r.get('/blob/*', asyncH(c.blob));
  return r;
}

export function imageRoutes(svc, mw) {
  const r = Router();
  const c = imageController(svc);
  r.use(mw.requireAuth);
  r.use(ipLimit(svc.limiter, 'images', { limit: 120, windowMs: 60_000 }));
  r.post('/upload-url', validate({ body: uploadBody }), asyncH(c.uploadUrl));
  r.post('/:id/complete', validate({ params: idParam }), asyncH(c.complete));
  r.get('/:id/status', validate({ params: idParam }), asyncH(c.status));
  r.get('/:id/view', validate({ params: idParam }), asyncH(c.view));
  return r;
}
