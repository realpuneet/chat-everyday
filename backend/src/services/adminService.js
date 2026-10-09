import { Takedown } from '../models/Takedown.js';
import { Room } from '../models/Room.js';
import { Report } from '../models/Report.js';
import { Ban } from '../models/Ban.js';
import { User } from '../models/User.js';
import { badRequest, notFound } from '../utils/errors.js';
import { newTotpSecret, verifyTotp } from '../utils/crypto.js';
import { DEFAULT_SETTINGS } from './settingsService.js';

const DAY = 86400_000;
const DUE = { nonconsensual: 1, csam: 1, privacy: 2, impersonation: 3, copyright: 7, grievance: 15, other: 15 }; // days (see docs/legal.md)

export class AdminService {
  constructor({ redis, settings, audit, matching, presence, bans, rooms, images, emit }) {
    Object.assign(this, { redis, settings, audit, matching, presence, bans, rooms, images, emit });
  }

  async stats() {
    const [online, queue, openReports, criticalReports, openTakedowns, activeBans, roomsTotal, pendingImages] = await Promise.all([
      this.presence.onlineCount(),
      this.matching.queueStats(),
      Report.countDocuments({ status: 'open' }),
      Report.countDocuments({ status: 'open', priority: 'critical' }),
      Takedown.countDocuments({ status: 'open' }),
      Ban.countDocuments({ active: true, type: 'account', $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] }),
      Room.countDocuments({ hidden: false }),
      this.images ? this.images.pendingCount() : 0,
    ]);
    const roomDirectory = await this.rooms.list({});
    return {
      online,
      waiting: queue.waiting,
      activeChats: queue.activeChats,
      roomsTotal,
      activeRooms: roomDirectory.filter((r) => r.members > 0).length,
      usersInRooms: roomDirectory.reduce((n, r) => n + (r.members || 0), 0),
      openReports,
      criticalReports,
      openTakedowns,
      activeBans,
      pendingImages,
      at: Date.now(),
    };
  }

  // -------------------------------------------------------------- bans
  async listBans(opts) {
    return (await this.bans.list(opts)).map((b) => ({ ...b, id: String(b._id) }));
  }

  async unban(admin, banId) {
    const n = await this.bans.lift(banId, String(admin._id));
    if (!n) throw notFound('Active ban not found');
    return { lifted: n };
  }

  async userSummary(userId) {
    const u = await User.findById(userId).select('-passwordHash -totpSecret').lean();
    if (!u) throw notFound('User not found');
    const [reportsAgainst, bans] = await Promise.all([Report.countDocuments({ reportedId: userId }), Ban.find({ userId }).sort({ createdAt: -1 }).limit(20).lean()]);
    return {
      id: String(u._id),
      kind: u.kind,
      role: u.role,
      nickname: u.nickname,
      createdAt: u.createdAt,
      ageLevel: u.ageLevel,
      strikes: u.strikes,
      banCount: u.banCount,
      hasEmail: !!u.email,
      hasPhone: !!u.phoneHash,
      hasGoogle: !!u.googleSub,
      online: await this.presence.isOnline(userId),
      reportsAgainst,
      bans: bans.map((b) => ({ id: String(b._id), type: b.type, reason: b.reason, category: b.category, active: b.active, expiresAt: b.expiresAt })),
    };
  }

  // -------------------------------------------------------------- settings
  async getSettings() {
    return { current: await this.settings.get(), defaults: DEFAULT_SETTINGS };
  }
  async updateSettings(admin, patch) {
    const before = await this.settings.get();
    const after = await this.settings.update(patch, String(admin._id));
    await this.audit.log({ actorId: String(admin._id), actorType: 'admin', action: 'settings.update', meta: { groups: Object.keys(patch), before: pick(before, patch), after: pick(after, patch) } });
    return after;
  }

  // -------------------------------------------------------------- takedowns
  async createTakedown(body) {
    const days = DUE[body.category] ?? 15;
    const t = await Takedown.create({ ...body, dueAt: new Date(Date.now() + days * DAY) });
    await this.audit.log({ action: 'takedown.received', targetType: 'takedown', targetId: String(t._id), severity: ['csam', 'nonconsensual'].includes(body.category) ? 'critical' : 'info', meta: { category: body.category } });
    this.emit.toAdmins('admin:takedown', { id: String(t._id), category: t.category, dueAt: t.dueAt });
    return { ticket: String(t._id), dueAt: t.dueAt };
  }

  async listTakedowns({ status = 'open' } = {}) {
    const rows = await Takedown.find({ status }).sort({ dueAt: 1 }).limit(200).lean();
    const now = Date.now();
    return rows.map((r) => ({ ...r, id: String(r._id), overdue: r.status === 'open' && +r.dueAt < now }));
  }

  async resolveTakedown(admin, id, { action, note }) {
    const t = await Takedown.findById(id);
    if (!t) throw notFound('Takedown not found');
    if (t.status !== 'open') throw badRequest('Already resolved');
    if (action === 'actioned') {
      // Best effort content removal when the reference is a known image / room id.
      const ref = (t.reference || '').trim();
      if (ref && this.images) await this.images.adminTakedown(ref, String(admin._id)).catch(() => {});
      if (/^[a-f0-9]{24}$/i.test(ref)) await this.rooms.hide(ref, 'admin_takedown').catch(() => {});
    }
    t.status = action;
    t.resolvedBy = String(admin._id);
    t.resolvedAt = new Date();
    t.note = note;
    await t.save();
    await this.audit.log({ actorId: String(admin._id), actorType: 'admin', action: `takedown.${action}`, targetType: 'takedown', targetId: id, severity: 'warn', meta: { category: t.category } });
    return { ok: true };
  }

  async hideRoom(admin, roomId) {
    await this.rooms.hide(roomId, 'admin_takedown');
    await this.audit.log({ actorId: String(admin._id), actorType: 'admin', action: 'room.hide', targetType: 'room', targetId: roomId, severity: 'warn' });
  }

  // -------------------------------------------------------------- admin 2FA hook (TOTP)
  async totpSetup(admin) {
    const secret = newTotpSecret();
    await this.redis.set(`totp:pending:${admin._id}`, secret, 'EX', 600);
    return { secret, otpauth: `otpauth://totp/ChatEveryday:${admin._id}?secret=${secret}&issuer=ChatEveryday` };
  }
  async totpEnable(admin, code) {
    const secret = await this.redis.get(`totp:pending:${admin._id}`);
    if (!secret || !verifyTotp(secret, code)) throw badRequest('Invalid code');
    await User.updateOne({ _id: admin._id }, { $set: { totpSecret: secret, totpEnabled: true } });
    await this.redis.del(`totp:pending:${admin._id}`);
    await this.audit.log({ actorId: String(admin._id), actorType: 'admin', action: 'admin.2fa_enabled' });
    return { enabled: true };
  }
}

const pick = (obj, patch) => Object.fromEntries(Object.keys(patch).map((k) => [k, obj[k]]));
