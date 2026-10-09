import { Router } from 'express';
import { z } from 'zod';
import { asyncH, validate } from '../middlewares/common.js';
import { adminController } from '../controllers/adminController.js';
import { idParam } from '../validators/httpSchemas.js';
import { settingsSchema } from '../services/settingsService.js';

const num = (d) => z.coerce.number().int().min(1).max(500).default(d);
const patchBody = z.record(z.string(), z.record(z.string(), z.any())).refine((o) => Object.keys(o).every((k) => k in settingsSchema.shape), 'Unknown settings group');

export function adminRoutes(svc, mw) {
  const r = Router();
  const c = adminController(svc);
  r.use(mw.requireAuth, mw.requireAdmin);

  r.get('/stats', asyncH(c.stats));
  r.get('/reports', validate({ query: z.object({ status: z.enum(['open', 'actioned', 'dismissed']).default('open'), priority: z.enum(['critical', 'high', 'normal']).optional(), limit: num(50), before: z.string().optional() }) }), asyncH(c.reports));
  r.get('/reports/:id', validate({ params: idParam }), asyncH(c.report));
  r.post(
    '/reports/:id/resolve',
    validate({ params: idParam, body: z.object({ action: z.enum(['dismiss', 'warn', 'ban_temp', 'ban_perm', 'hide_content']), durationHours: z.number().int().min(1).max(24 * 365).optional(), note: z.string().max(1000).optional() }).strict() }),
    asyncH(c.resolveReport),
  );

  r.get('/bans', validate({ query: z.object({ active: z.enum(['true', 'false']).default('true') }) }), asyncH(c.bans));
  r.post(
    '/bans',
    validate({ body: z.object({ userId: z.string().min(1).max(64), reason: z.string().trim().min(3).max(500), category: z.string().max(32).default('other'), permanent: z.boolean().default(false), hours: z.number().int().min(1).max(24 * 365).optional() }).strict() }),
    asyncH(c.ban),
  );
  r.delete('/bans/:id', validate({ params: idParam }), asyncH(c.unban));
  r.get('/users/:id', validate({ params: idParam }), asyncH(c.user));

  r.get('/settings', asyncH(c.settings));
  r.put('/settings', validate({ body: patchBody }), asyncH(c.updateSettings));

  r.get('/audit', validate({ query: z.object({ action: z.string().max(64).optional(), before: z.string().optional(), limit: num(100) }) }), asyncH(c.audit));

  r.get('/takedowns', validate({ query: z.object({ status: z.enum(['open', 'actioned', 'rejected']).default('open') }) }), asyncH(c.takedowns));
  r.post('/takedowns/:id/resolve', validate({ params: idParam, body: z.object({ action: z.enum(['actioned', 'rejected']), note: z.string().max(1000).optional() }).strict() }), asyncH(c.resolveTakedown));
  r.post('/rooms/:id/hide', validate({ params: idParam }), asyncH(c.hideRoom));

  r.get('/evidence/:id/:imageId', asyncH(c.evidence));
  r.post('/hashes', validate({ body: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), phash: z.string().regex(/^[a-f0-9]{16}$/).optional() }).strict().refine((v) => v.sha256 || v.phash, 'sha256 or phash required') }), asyncH(c.addHash));
  r.post('/2fa/setup', asyncH(c.totpSetup));
  r.post('/2fa/enable', validate({ body: z.object({ code: z.string().regex(/^\d{6}$/) }).strict() }), asyncH(c.totpEnable));
  return r;
}
