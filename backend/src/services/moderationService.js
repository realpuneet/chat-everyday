import { EventEmitter } from 'node:events';
import { AppError } from '../utils/errors.js';
import { K } from '../config/redis.js';
import { User } from '../models/User.js';
import { scanHardBlocks, CRITICAL_REPORT_CATEGORIES } from './contentPolicy.js';
import { evaluateMessage, sanitizeText } from './filters.js';
import { logger } from '../config/logger.js';

const STRIKE_WINDOW_SEC = 24 * 3600;
// Categories where the first confirmed hit already results in a ban (escalation ladder).
const BAN_ON_FIRST = new Set(['sextortion', 'trafficking', 'threat', 'nonconsensual']);

/**
 * Text moderation + consequences. Emits `user:banned` ({userId, category}) so conversation services
 * can clean up (leave chat, leave rooms) without a circular dependency.
 */
export class ModerationService extends EventEmitter {
  constructor({ redis, settings, bans, audit, emit, reports }) {
    super();
    this.redis = redis;
    this.settings = settings;
    this.bans = bans;
    this.audit = audit;
    this.emit_ = emit;
    this.reports = reports; // optional, wired in app.js to avoid import cycles
  }

  /**
   * Validate + sanitise outgoing text. Returns the cleaned text or throws AppError.
   * @param {object} ctx { scope:'random'|'room', roomId, roomFilters, evidenceRef, sender:{id, ipHash, deviceHash} }
   */
  async screenText(user, raw, ctx = {}) {
    const cfg = await this.settings.get();
    const clean = sanitizeText(raw);
    const hard = scanHardBlocks(clean);
    if (hard) {
      await this.#onHardBlock(user, hard, clean, ctx);
      throw new AppError(403, 'CONTENT_POLICY', 'This message violates our content policy and was blocked', {
        category: hard.category,
        sessionEnded: hard.immediateBan,
      });
    }
    const room = ctx.roomFilters || {};
    const res = evaluateMessage(clean, {
      maxLength: cfg.limits.msgMaxLength,
      blockLinks: ctx.scope === 'room' ? (room.blockLinks ?? cfg.moderation.blockLinks) : cfg.moderation.blockLinks,
      blockPii: ctx.scope === 'room' ? (room.blockPii ?? cfg.moderation.blockPiiInRooms) : false,
      badWords: [...cfg.moderation.badWords, ...(room.badWords || [])],
    });
    if (!res.ok) throw new AppError(422, res.code, res.message);
    return res.text;
  }

  async #onHardBlock(user, hard, text, ctx) {
    const userId = String(user._id || user.id);
    const { category, immediateBan } = hard;
    await this.audit.log({
      actorType: 'system',
      action: 'content.hard_block',
      targetType: 'user',
      targetId: userId,
      severity: immediateBan ? 'critical' : 'warn',
      meta: { category, scope: ctx.scope, roomId: ctx.roomId, snippetLength: text.length },
    });
    // Evidence for the admin queue (last N messages are captured from the ring buffer).
    if (this.reports && ctx.evidenceRef) {
      await this.reports
        .createSystemReport({
          reportedId: userId,
          category: category === 'minor' ? 'underage_signal' : category,
          details: `Auto-detected (${category}) in ${ctx.scope}`,
          evidenceRef: ctx.evidenceRef,
          triggerText: text.slice(0, 300),
        })
        .catch((e) => logger.error({ err: e.message }, 'system report failed'));
    }
    const strikes = await this.redis.incr(K.strikes(userId));
    await this.redis.expire(K.strikes(userId), STRIKE_WINDOW_SEC);
    await User.updateOne({ _id: userId }, { $inc: { strikes: 1 } }).catch(() => {});

    if (immediateBan || BAN_ON_FIRST.has(category) || strikes >= 2) {
      await this.banAndTerminate(userId, {
        reason: `Automatic: ${category}`,
        category,
        ipHashes: ctx.sender?.ipHash ? [ctx.sender.ipHash] : [],
        deviceHashes: ctx.sender?.deviceHash ? [ctx.sender.deviceHash] : [],
      });
    }
  }

  async banAndTerminate(userId, { reason, category, createdBy = 'system', durationMs, ipHashes, deviceHashes, identities }) {
    const user = await User.findById(userId).lean();
    const ids = [...(identities || [])];
    const result = await this.bans.banUser(userId, { reason, category, createdBy, durationMs, ipHashes, deviceHashes, identities: ids });
    await this.terminateUser(userId, { reason: 'banned', until: result.until, permanent: result.permanent, category });
    this.emit('user:banned', { userId, category, user });
    return result;
  }

  /** Tell all of a user's devices the session is over and drop their sockets (works across instances). */
  async terminateUser(userId, payload) {
    this.emit_.toUser(userId, 'session:terminated', payload);
    // Allow the event to flush before disconnecting.
    setTimeout(() => this.emit_.disconnectUser?.(userId), 150);
  }

  isCritical = (category) => CRITICAL_REPORT_CATEGORIES.includes(category);
}
