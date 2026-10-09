import { AuditLog } from '../models/AuditLog.js';
import { logger } from '../config/logger.js';

export class AuditService {
  async log({ actorId, actorType = 'system', action, targetType, targetId, severity = 'info', meta }) {
    try {
      await AuditLog.create({ actorId, actorType, action, targetType, targetId: targetId && String(targetId), severity, meta });
    } catch (e) {
      logger.error({ err: e.message, action }, 'audit log write failed');
    }
    if (severity === 'critical') logger.warn({ action, targetType, targetId }, 'CRITICAL audit event');
  }

  async list({ limit = 100, before, action } = {}) {
    const q = {};
    if (before) q.createdAt = { $lt: new Date(before) };
    if (action) q.action = action;
    return AuditLog.find(q).sort({ createdAt: -1 }).limit(Math.min(limit, 500)).lean();
  }
}
