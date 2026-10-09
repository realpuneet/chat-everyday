import { Router } from 'express';
import { z } from 'zod';
import { asyncH, validate } from '../middlewares/common.js';
import { ipLimit } from '../middlewares/ipLimit.js';
import { savedController, blocksController, reportController, takedownController, ageController } from '../controllers/safetyControllers.js';
import { idParam } from '../validators/httpSchemas.js';
import { reportCreate } from '../validators/socketSchemas.js';

const takedownBody = z
  .object({
    requesterName: z.string().trim().max(100).optional(),
    requesterContact: z.string().trim().min(5).max(200),
    category: z.enum(['nonconsensual', 'csam', 'impersonation', 'privacy', 'copyright', 'grievance', 'other']),
    reference: z.string().trim().max(500).optional(),
    description: z.string().trim().min(10).max(2000),
  })
  .strict();

export function safetyRoutes(svc, mw) {
  const r = Router();
  const lim = (name, limit, windowMs = 3600_000) => ipLimit(svc.limiter, name, { limit, windowMs });

  // Public (no login): takedown + grievance intake. IP-limited to deter abuse.
  r.post('/takedown', lim('takedown', 10), validate({ body: takedownBody }), asyncH(takedownController(svc).create));

  const auth = mw.requireAuth;
  r.post('/reports', auth, validate({ body: reportCreate }), asyncH(reportController(svc).create));

  const saved = savedController(svc);
  r.get('/saved', auth, mw.requireRegistered, asyncH(saved.list));
  r.delete('/saved', auth, mw.requireRegistered, asyncH(saved.removeAll));
  r.get('/saved/:id', auth, mw.requireRegistered, validate({ params: idParam }), asyncH(saved.read));
  r.delete('/saved/:id', auth, mw.requireRegistered, validate({ params: idParam }), asyncH(saved.remove));

  const blocks = blocksController(svc);
  r.get('/blocks', auth, asyncH(blocks.count));
  r.delete('/blocks', auth, asyncH(blocks.clear));

  const age = ageController(svc);
  r.post('/age/start', auth, mw.requireRegistered, asyncH(age.start));
  r.post('/age/dryrun-complete', auth, mw.requireRegistered, asyncH(age.completeDryRun));
  return r;
}
