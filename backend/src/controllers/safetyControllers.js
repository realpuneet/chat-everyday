import { User } from '../models/User.js';
import { forbidden } from '../utils/errors.js';

export const savedController = (svc) => ({
  list: async (req, res) => res.json({ chats: await svc.saved.list(String(req.user._id)) }),
  read: async (req, res) => res.json(await svc.saved.read(String(req.user._id), req.params.id)),
  remove: async (req, res) => res.json(await svc.saved.remove(String(req.user._id), req.params.id)),
  removeAll: async (req, res) => res.json(await svc.saved.removeAll(String(req.user._id))),
});

export const blocksController = (svc) => ({
  count: async (req, res) => res.json({ count: req.user.blocked.length }),
  clear: async (req, res) => {
    await User.updateOne({ _id: req.user._id }, { $set: { blocked: [] } });
    await svc.matching.setBlocked(String(req.user._id), []);
    res.json({ ok: true });
  },
});

export const reportController = (svc) => ({
  create: async (req, res) => res.json(await svc.reports.create(req.user, req.body)),
});

export const takedownController = (svc) => ({
  create: async (req, res) => res.status(201).json(await svc.admin.createTakedown(req.body)),
});

export const ageController = (svc) => ({
  start: async (req, res) => res.json(await svc.ageVerifier.start(String(req.user._id))),
  // Dry-run completion: lets developers exercise the strict-verification path. Impossible in production.
  completeDryRun: async (req, res) => {
    if (!svc.ageVerifier.dryRun || svc.cfg.isProd) throw forbidden('Not available');
    await User.updateOne({ _id: req.user._id }, { $set: { ageLevel: 'strict' } });
    res.json({ ageLevel: 'strict' });
  },
  webhook: async (req, res) => {
    const body = svc.ageVerifier.verifyWebhook(req.body, req.headers['x-signature']);
    if (body.verified && body.userRef) await User.updateOne({ _id: body.userRef }, { $set: { ageLevel: 'strict' } });
    await svc.audit.log({ action: 'age.webhook', targetType: 'user', targetId: body.userRef, meta: { verified: !!body.verified } });
    res.json({ ok: true });
  },
});
