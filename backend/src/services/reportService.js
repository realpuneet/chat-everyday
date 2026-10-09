import { Report } from '../models/Report.js';
import { User } from '../models/User.js';
import { K } from '../config/redis.js';
import { CRITICAL_REPORT_CATEGORIES } from './contentPolicy.js';
import { badRequest, forbidden, notFound } from '../utils/errors.js';
import { logger } from '../config/logger.js';

const HIGH = new Set(['threat', 'doxxing', 'harassment']);
const priorityOf = (category) => (CRITICAL_REPORT_CATEGORIES.includes(category) ? 'critical' : HIGH.has(category) ? 'high' : 'normal');

/**
 * Reports: capture evidence from the Redis ring buffer (last N messages), queue for admins, apply
 * protective automation (block, auto-hide, short auto-suspend on many distinct reporters).
 */
export class ReportService {
  constructor({ redis, settings, limiter, matching, events, rooms, moderation, audit, emit, chat }) {
    Object.assign(this, { redis, settings, limiter, matching, events, rooms, moderation, audit, emit, chat });
    this.images = null; // wired by the container when the image module exists
  }

  async #target({ reporterId, context, chatId, roomId, memberId }) {
    if (context === 'random') {
      if (!chatId) throw badRequest('chatId required');
      if (!(await this.matching.isParticipant(chatId, reporterId))) throw forbidden('You were not part of this chat');
      const members = await this.redis.smembers(K.chatParticipants(chatId));
      const reportedId = members.find((m) => m !== reporterId);
      if (!reportedId) throw badRequest('Nobody to report');
      return { reportedId, scope: 'chat', scopeId: chatId };
    }
    if (!roomId || !memberId) throw badRequest('roomId and memberId required');
    if (!(await this.rooms.isMember(roomId, reporterId))) throw forbidden('Join the room first');
    let reportedId = await this.rooms.resolveMember(roomId, memberId);
    if (!reportedId) {
      // The member may have just left: recover the user from the evidence buffer.
      const ev = (await this.events.recent('room', roomId, 100)).find((e) => e.memberId === memberId && e.from && e.from !== 'system');
      reportedId = ev?.from;
    }
    if (!reportedId) throw notFound('Member not found');
    if (reportedId === reporterId) throw badRequest('You cannot report yourself');
    return { reportedId, scope: 'room', scopeId: roomId };
  }

  async #evidence(scope, scopeId, reporterId, reportedId, n) {
    const events = await this.events.recent(scope, scopeId, n);
    return events.map((e) => ({
      seq: e.seq,
      ts: e.ts,
      senderRef: e.from === reportedId ? 'reported' : e.from === reporterId ? 'reporter' : e.from === 'system' ? 'system' : 'other',
      senderAlias: e.alias,
      kind: e.kind,
      text: e.text,
      imageId: e.imageId,
    }));
  }

  async create(reporter, { context, chatId, roomId, memberId, imageId, category, details }) {
    const reporterId = String(reporter._id || reporter.id);
    const cfg = await this.settings.get();
    await this.limiter.assertWindow('report', reporterId, { limit: cfg.limits.reportPerHour, windowMs: 3600_000 }, 'You are reporting too quickly');
    const { reportedId, scope, scopeId } = await this.#target({ reporterId, context, chatId, roomId, memberId });

    // Same reporter + same target within 10 minutes is a duplicate: acknowledge without double counting.
    const dupKey = `report:dup:${reporterId}:${reportedId}`;
    if (!(await this.redis.set(dupKey, '1', 'EX', 600, 'NX'))) return { ok: true, duplicate: true };

    const messages = await this.#evidence(scope, scopeId, reporterId, reportedId, cfg.moderation.evidenceMessages);
    const report = await Report.create({
      reporterId,
      reportedId,
      context: { kind: context, chatId, roomId },
      category,
      details,
      priority: priorityOf(category),
      evidence: { messages, images: [] },
    });

    // Preserve ONLY the reported image(s); everything else keeps expiring on schedule.
    const imageIds = new Set(messages.filter((m) => m.senderRef === 'reported' && m.imageId).map((m) => m.imageId));
    if (imageId) imageIds.add(imageId);
    if (this.images) {
      for (const id of imageIds) {
        const kept = await this.images.preserveEvidence(id, String(report._id), { reporterId, reportedId }).catch((e) => {
          logger.warn({ err: e.message }, 'evidence preserve failed');
          return null;
        });
        if (kept) report.evidence.images.push(kept);
      }
      if (report.evidence.images.length) await report.save();
    }

    // Protective automation
    await this.chat.block(reporterId, reportedId).catch(() => {});
    await User.updateOne({ _id: reporterId }, { $addToSet: { blocked: reportedId } }).catch(() => {});
    await this.#autoActions({ report, reportedId, reporterId, category, roomId, imageIds, cfg });

    await this.audit.log({
      actorId: reporterId,
      actorType: 'user',
      action: 'report.create',
      targetType: 'user',
      targetId: reportedId,
      severity: report.priority === 'critical' ? 'critical' : 'info',
      meta: { reportId: String(report._id), category, context },
    });
    this.emit.toAdmins('admin:report', { id: String(report._id), category, priority: report.priority });
    return { ok: true, reportId: String(report._id) };
  }

  async #autoActions({ report, reportedId, reporterId, category, roomId, imageIds, cfg }) {
    const m = cfg.moderation;
    // user-level: distinct reporters in 24h
    const key = K.reportersFor(reportedId);
    await this.redis.sadd(key, reporterId);
    await this.redis.expire(key, 24 * 3600);
    const distinct = await this.redis.scard(key);
    const need = CRITICAL_REPORT_CATEGORIES.includes(category) ? Math.max(2, Math.ceil(m.autoSuspendReporters / 2)) : m.autoSuspendReporters;
    if (distinct >= need && !(await this.redis.exists(`autosusp:${reportedId}`))) {
      await this.redis.set(`autosusp:${reportedId}`, '1', 'EX', 3600);
      // Short, reviewable suspension: brigading must not be able to cause lasting harm on its own.
      await this.moderation.banAndTerminate(reportedId, { reason: `Auto-suspended: ${distinct} distinct reports in 24h`, category, durationMs: 3600_000, createdBy: 'system' });
      report.action = 'auto_suspend';
      await report.save();
    }
    // image-level: auto-hide after N reports
    if (this.images) {
      for (const id of imageIds) await this.images.registerReport(id, m.autoHideReports, category).catch(() => {});
    }
    // room-level (custom rooms only)
    if (roomId) {
      const rk = `reporters:room:${roomId}`;
      await this.redis.sadd(rk, reporterId);
      await this.redis.expire(rk, 24 * 3600);
      if ((await this.redis.scard(rk)) >= m.autoHideReports && (await this.rooms.isCustom(roomId))) {
        await this.rooms.hide(roomId, 'auto_hidden_after_reports');
        await this.audit.log({ action: 'room.auto_hidden', targetType: 'room', targetId: roomId, severity: 'warn' });
      }
    }
  }

  /** Reports raised by our own detectors (hard-block text scanner etc.). */
  async createSystemReport({ reportedId, category, details, evidenceRef, triggerText }) {
    const cfg = await this.settings.get();
    const scope = evidenceRef.kind === 'room' ? 'room' : 'chat';
    const scopeId = evidenceRef.roomId || evidenceRef.chatId;
    const messages = await this.#evidence(scope, scopeId, 'system', reportedId, cfg.moderation.evidenceMessages);
    if (triggerText) messages.push({ seq: 0, ts: Date.now(), senderRef: 'reported', kind: 'blocked_text', text: triggerText });
    const report = await Report.create({
      reporterId: 'system',
      reportedId,
      context: { kind: evidenceRef.kind, chatId: evidenceRef.chatId, roomId: evidenceRef.roomId },
      category,
      details,
      priority: priorityOf(category),
      evidence: { messages, images: [] },
    });
    this.emit.toAdmins('admin:report', { id: String(report._id), category, priority: report.priority });
    return report;
  }

  // ------------------------------------------------------------ admin

  async list({ status = 'open', priority, limit = 50, before } = {}) {
    const q = { status };
    if (priority) q.priority = priority;
    if (before) q.createdAt = { $lt: new Date(before) };
    const rows = await Report.find(q).sort({ priority: 1, createdAt: 1 }).limit(Math.min(limit, 200)).lean();
    return rows.map((r) => ({ ...r, id: String(r._id), evidence: { messages: r.evidence?.messages?.length || 0, images: r.evidence?.images?.length || 0 } }));
  }

  async get(id) {
    const r = await Report.findById(id).lean();
    if (!r) throw notFound('Report not found');
    const reported = r.reportedId ? await User.findById(r.reportedId).select('nickname kind createdAt banCount strikes ageLevel').lean().catch(() => null) : null;
    const reportCount = await Report.countDocuments({ reportedId: r.reportedId });
    return { ...r, id: String(r._id), reported: reported && { id: r.reportedId, ...reported }, priorReports: reportCount - 1 };
  }

  async resolve(id, { action, durationHours, note }, admin) {
    const r = await Report.findById(id);
    if (!r) throw notFound('Report not found');
    if (r.status !== 'open') throw badRequest('Report already resolved');
    const adminId = String(admin._id);
    if (action === 'ban_temp' || action === 'ban_perm') {
      if (!r.reportedId) throw badRequest('No target user');
      await this.moderation.banAndTerminate(r.reportedId, {
        reason: `Report ${id}: ${r.category}`,
        category: r.category,
        createdBy: adminId,
        durationMs: action === 'ban_perm' ? null : (durationHours || 24) * 3600_000,
      });
    } else if (action === 'hide_content') {
      if (r.context?.roomId) await this.rooms.hide(r.context.roomId, 'admin_takedown');
      for (const img of r.evidence?.images || []) await this.images?.adminTakedown(img.imageId, adminId, { blocklist: ['csam', 'nonconsensual', 'minor'].includes(r.category) });
    } else if (action === 'warn' && r.reportedId) {
      this.emit.toUser(r.reportedId, 'moderation:warning', { category: r.category, message: 'A moderator reviewed a report about you. Please follow the community rules.' });
    }
    r.status = action === 'dismiss' ? 'dismissed' : 'actioned';
    r.action = action;
    r.resolvedBy = adminId;
    r.resolvedAt = new Date();
    r.resolutionNote = note;
    await r.save();
    await this.audit.log({ actorId: adminId, actorType: 'admin', action: `report.${action}`, targetType: 'report', targetId: id, meta: { category: r.category, reportedId: r.reportedId, note } });
    return { ok: true };
  }
}
