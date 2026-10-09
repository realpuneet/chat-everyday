import { AuditLog } from '../models/AuditLog.js';
import { User } from '../models/User.js';
import { notFound } from '../utils/errors.js';

export const adminController = (svc) => ({
  stats: async (_req, res) => res.json(await svc.admin.stats()),

  reports: async (req, res) => res.json({ reports: await svc.reports.list(req.query) }),
  report: async (req, res) => res.json({ report: await svc.reports.get(req.params.id) }),
  resolveReport: async (req, res) => res.json(await svc.reports.resolve(req.params.id, req.body, req.user)),

  bans: async (req, res) => res.json({ bans: await svc.admin.listBans({ active: req.query.active !== 'false' }) }),
  ban: async (req, res) => {
    const { userId, reason, permanent, hours, category } = req.body;
    if (!(await User.exists({ _id: userId }))) throw notFound('User not found');
    const result = await svc.moderation.banAndTerminate(userId, {
      reason,
      category,
      createdBy: String(req.user._id),
      durationMs: permanent ? null : (hours || 24) * 3600_000,
    });
    res.json(result);
  },
  unban: async (req, res) => res.json(await svc.admin.unban(req.user, req.params.id)),
  user: async (req, res) => res.json({ user: await svc.admin.userSummary(req.params.id) }),

  settings: async (_req, res) => res.json(await svc.admin.getSettings()),
  updateSettings: async (req, res) => res.json({ settings: await svc.admin.updateSettings(req.user, req.body) }),

  audit: async (req, res) => {
    const q = {};
    if (req.query.action) q.action = req.query.action;
    if (req.query.before) q.createdAt = { $lt: new Date(req.query.before) };
    const rows = await AuditLog.find(q).sort({ createdAt: -1 }).limit(req.query.limit || 100).lean();
    res.json({ logs: rows.map((r) => ({ ...r, id: String(r._id) })) });
  },

  takedowns: async (req, res) => res.json({ takedowns: await svc.admin.listTakedowns(req.query) }),
  resolveTakedown: async (req, res) => res.json(await svc.admin.resolveTakedown(req.user, req.params.id, req.body)),
  hideRoom: async (req, res) => res.json(await svc.admin.hideRoom(req.user, req.params.id).then(() => ({ ok: true }))),

  evidence: async (req, res) => res.json(await svc.images.evidenceUrl(req.user, `evidence/${req.params.id}/${req.params.imageId}.jpg`)),
  addHash: async (req, res) => {
    await svc.images.hashMatch.addKnownBad(req.body);
    await svc.audit.log({ actorId: String(req.user._id), actorType: 'admin', action: 'hash.blocklist_add', severity: 'warn', meta: { phash: req.body.phash, sha256: req.body.sha256 } });
    res.json({ ok: true });
  },

  totpSetup: async (req, res) => res.json(await svc.admin.totpSetup(req.user)),
  totpEnable: async (req, res) => res.json(await svc.admin.totpEnable(req.user, req.body.code)),
});
