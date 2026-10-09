import { Router } from 'express';
import { z } from 'zod';
import { asyncH, validate } from '../middlewares/common.js';
import { roomController } from '../controllers/roomController.js';
import { idParam } from '../validators/httpSchemas.js';

const createBody = z
  .object({
    name: z.string().trim().min(3).max(48),
    description: z.string().trim().max(200).optional(),
    visibility: z.enum(['public', 'private']).default('public'),
    adult: z.boolean().default(false),
    identity: z.enum(['everyone', 'men', 'women', 'lgbtq']).optional(),
    rules: z.string().trim().max(600).optional(),
    maxMembers: z.number().int().min(2).max(500).optional(),
    filters: z
      .object({ blockLinks: z.boolean().optional(), blockPii: z.boolean().optional(), badWords: z.array(z.string().trim().min(2).max(40)).max(200).optional() })
      .strict()
      .optional(),
  })
  .strict();

export function roomRoutes(svc, mw) {
  const r = Router();
  const c = roomController(svc);
  r.use(mw.requireAuth);
  r.get('/', validate({ query: z.object({ type: z.enum(['identity', 'interest', 'custom']).optional() }) }), asyncH(c.list));
  r.get('/mine', asyncH(c.mine));
  r.get('/preview', validate({ query: z.object({ code: z.string().trim().min(4).max(24) }) }), asyncH(c.preview));
  r.post('/', validate({ body: createBody }), asyncH(c.create));
  r.delete('/:id', validate({ params: idParam }), asyncH(c.remove));
  return r;
}
