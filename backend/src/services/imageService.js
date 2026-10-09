import sharp from 'sharp';
import crypto from 'node:crypto';
import { K } from '../config/redis.js';
import { randomId, hmac, sha256 } from '../utils/crypto.js';
import { dHash } from '../utils/phash.js';
import { AppError, badRequest, forbidden, gone, notFound } from '../utils/errors.js';
import { CRITICAL_REPORT_CATEGORIES } from './contentPolicy.js';
import { logger } from '../config/logger.js';

const ALLOWED = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' };
const OK_STATUS = new Set(['approved', 'blurred']);
const DEAD_STATUS = new Set(['rejected', 'removed', 'hidden', 'expired']);
const RETRY_GRACE_MS = 15_000;

/**
 * Image pipeline: signed upload -> BullMQ worker (EXIF strip, perceptual hash, known-bad hash hook,
 * NSFW hook) -> approved / blurred / rejected -> short-lived signed view URLs.
 * Metadata lives in Redis with a TTL; nothing about images is stored in MongoDB.
 */
export class ImageService {
  constructor({ redis, settings, limiter, storage, matching, rooms, moderation, reports, audit, emit, hashMatch, nsfw }) {
    Object.assign(this, { redis, settings, limiter, storage, matching, rooms, moderation, reports, audit, emit, hashMatch, nsfw });
    this.queue = null; // set by jobs/queue.js
  }

  #key = (id) => K.image(id);
  procKey = (id) => `proc/${id}.jpg`;
  tmpKey = (id) => `tmp/${id}`;

  async #meta(id) {
    if (!/^[A-Za-z0-9_-]{8,40}$/.test(id || '')) throw notFound('Image not found');
    const m = await this.redis.hgetall(this.#key(id));
    if (!m.owner) throw notFound('Image not found');
    return m;
  }

  // ----------------------------------------------------------------- upload

  async createUpload(user, body) {
    const uid = String(user._id || user.id);
    const s = await this.settings.get();
    const cfg = s.images;
    if (!ALLOWED[body.contentType]) throw badRequest('Only JPEG, PNG or WebP images are allowed', { code: 'BAD_TYPE' });
    if (body.size > cfg.maxBytes) throw new AppError(413, 'IMAGE_TOO_LARGE', `Image must be at most ${Math.round(cfg.maxBytes / 1024 / 1024)} MB`);
    if (body.width > cfg.maxDimension || body.height > cfg.maxDimension) throw badRequest(`Image is larger than ${cfg.maxDimension}px`, { code: 'IMAGE_TOO_BIG_DIMENSIONS' });

    // Scope authorisation: the sender must be inside the conversation the image is for.
    if (body.scope === 'chat') {
      if (!cfg.allowInRandomChat) throw forbidden('Images are disabled in random chat');
      const active = await this.matching.activeChat(uid);
      if (!active || active.chatId !== body.scopeId) throw forbidden('You are not in this chat', { code: 'NOT_IN_CHAT' });
    } else if (!(await this.rooms.isMember(body.scopeId, uid))) {
      throw forbidden('Join the room first', { code: 'NOT_IN_ROOM' });
    }

    const limit = user.kind === 'guest' ? s.limits.guestImagesPerHour : s.limits.userImagesPerHour;
    await this.limiter.assertWindow('img-up', uid, { limit, windowMs: 3600_000 }, user.kind === 'guest' ? 'Guest image limit reached. Sign up to send more.' : 'Image upload limit reached. Try again later.');

    const id = randomId(12);
    const now = Date.now();
    const timerSec = Math.min(Math.max(body.timerSec ?? cfg.viewTimerSec, 3), 120);
    await this.redis
      .multi()
      .hset(this.#key(id), {
        owner: uid,
        status: 'created',
        scope: body.scope,
        scopeId: body.scopeId,
        viewMode: body.viewMode || cfg.defaultViewMode,
        timerSec,
        contentType: body.contentType,
        size: body.size,
        createdAt: now,
        reportCount: 0,
      })
      .expire(this.#key(id), cfg.retentionHours * 3600 + 3600)
      .zadd(K.imageExpiry, now + cfg.retentionHours * 3600_000, id)
      .exec();

    const direct = await this.storage.createDirectUpload(this.tmpKey(id), { contentType: body.contentType, size: body.size, ttlSec: 300 });
    return {
      imageId: id,
      upload: direct ? { ...direct, proxied: false } : { url: `/api/images/${id}/upload`, method: 'PUT', headers: { 'content-type': body.contentType }, proxied: true },
      viewMode: body.viewMode || cfg.defaultViewMode,
      timerSec,
    };
  }

  /** Proxied upload (local / ImageKit): bytes arrive through the API. */
  async receiveUpload(user, id, buffer, contentType) {
    const m = await this.#meta(id);
    if (m.owner !== String(user._id || user.id)) throw forbidden('Not your upload');
    if (m.status !== 'created') throw badRequest('Upload already received');
    const cfg = (await this.settings.get()).images;
    if (contentType !== m.contentType) throw badRequest('Content-Type does not match the declared type');
    if (!buffer?.length || buffer.length > cfg.maxBytes || buffer.length > Number(m.size)) throw new AppError(413, 'IMAGE_TOO_LARGE', 'Image larger than declared size');
    await this.storage.putObject(this.tmpKey(id), buffer, { contentType });
    await this.redis.hset(this.#key(id), { status: 'uploaded', size: buffer.length });
    return { status: 'uploaded' };
  }

  async complete(user, id) {
    const m = await this.#meta(id);
    if (m.owner !== String(user._id || user.id)) throw forbidden('Not your upload');
    if (!['created', 'uploaded'].includes(m.status)) return { status: m.status };
    const head = await this.storage.headObject(this.tmpKey(id));
    if (!head) throw new AppError(409, 'UPLOAD_MISSING', 'The file has not been uploaded yet');
    await this.redis.multi().hset(this.#key(id), { status: 'processing' }).sadd(K.imagePending, id).exec();
    await this.queue.add('process', { id }, { attempts: 3, backoff: { type: 'exponential', delay: 1000 }, removeOnComplete: 200, removeOnFail: 200 });
    return { status: 'processing' };
  }

  // ----------------------------------------------------------------- worker

  async #finish(id, status, extra = {}) {
    const m = await this.redis.hgetall(this.#key(id));
    await this.redis.multi().hset(this.#key(id), { status, ...extra }).srem(K.imagePending, id).exec();
    if (m.owner) this.emit.toUser(m.owner, 'image:status', { imageId: id, status, reason: extra.reason, width: extra.w ? Number(extra.w) : undefined, height: extra.h ? Number(extra.h) : undefined });
    return status;
  }

  /** Called by the BullMQ worker. Idempotent: a retried job re-reads state. */
  async process(id) {
    const m = await this.#meta(id);
    if (m.status !== 'processing') return m.status;
    const cfg = (await this.settings.get()).images;
    const raw = await this.storage.getObject(this.tmpKey(id));
    const reject = async (reason, extra = {}) => {
      await this.storage.deleteObject(this.tmpKey(id)).catch(() => {});
      return this.#finish(id, 'rejected', { reason, ...extra });
    };

    if (raw.length > cfg.maxBytes) return reject('too_large');
    let info;
    try {
      info = await sharp(raw, { limitInputPixels: cfg.maxDimension * cfg.maxDimension }).metadata();
    } catch {
      return reject('invalid_image');
    }
    if (!['jpeg', 'png', 'webp'].includes(info.format)) return reject('invalid_image'); // magic bytes decide, not the client's claim
    if (info.width > cfg.maxDimension || info.height > cfg.maxDimension) return reject('too_big_dimensions');

    const fingerprint = { sha256: sha256(raw), phash: await dHash(raw) };
    const match = await this.hashMatch.check(fingerprint, cfg.hashMatchMaxDistance);
    if (match.match) {
      await reject('known_bad', { phash: fingerprint.phash });
      await this.#onKnownBad(m, id, fingerprint, match);
      return 'rejected';
    }

    // Re-encode: strips EXIF / GPS / ICC / XMP. Never use .withMetadata().
    const clean = await sharp(raw, { limitInputPixels: cfg.maxDimension * cfg.maxDimension })
      .rotate()
      .resize({ width: Math.min(cfg.maxDimension, 2048), height: Math.min(cfg.maxDimension, 2048), fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });

    const verdict = await this.nsfw.classify(clean.data).catch((e) => {
      logger.error({ err: e.message }, 'nsfw classifier failed');
      throw e; // retry the job rather than silently approving unscanned content
    });
    if (verdict.minorRisk >= 0.5) {
      await reject('minor_risk');
      await this.#onKnownBad(m, id, fingerprint, { source: 'classifier-minor-risk' });
      return 'rejected';
    }
    let status = 'approved';
    if (verdict.nsfw >= cfg.nsfwRejectThreshold) return reject('nsfw_extreme');
    if (verdict.nsfw >= cfg.nsfwBlurThreshold) {
      // Adult content is allowed between consenting adults, but never in rooms that are not flagged adult.
      if (m.scope === 'room' && !(await this.rooms.isAdultRoom(m.scopeId))) return reject('adult_content_not_allowed_here');
      status = 'blurred';
    }

    await this.storage.putObject(this.procKey(id), clean.data, { contentType: 'image/jpeg' });
    await this.storage.deleteObject(this.tmpKey(id)).catch(() => {});
    return this.#finish(id, status, { w: clean.info.width, h: clean.info.height, phash: fingerprint.phash, size: clean.data.length, nsfw: verdict.nsfw.toFixed(3), scanned: verdict.dryRun ? 'dryrun' : 'yes' });
  }

  async #onKnownBad(m, id, fingerprint, match) {
    // We do NOT keep a copy of the material. Only hashes + metadata are retained for law-enforcement liaison.
    await this.audit.log({ action: 'image.known_bad', targetType: 'user', targetId: m.owner, severity: 'critical', meta: { imageId: id, source: match.source, sha256: fingerprint.sha256, phash: fingerprint.phash, scope: m.scope } });
    await this.hashMatch.addKnownBad(fingerprint).catch(() => {});
    if (this.reports) {
      await this.reports
        .createSystemReport({
          reportedId: m.owner,
          category: 'csam',
          details: `Automatic image hash/classifier match (${match.source}). sha256=${fingerprint.sha256} phash=${fingerprint.phash}. Image NOT retained; follow docs/legal.md escalation.`,
          evidenceRef: m.scope === 'room' ? { kind: 'room', roomId: m.scopeId } : { kind: 'random', chatId: m.scopeId },
        })
        .catch(() => {});
    }
    await this.moderation.banAndTerminate(m.owner, { reason: 'Automatic: prohibited image match', category: 'csam', createdBy: 'system' });
  }

  async markFailed(id, err) {
    logger.error({ id, err: err?.message }, 'image processing failed permanently');
    await this.storage.deleteObject(this.tmpKey(id)).catch(() => {});
    await this.#finish(id, 'rejected', { reason: 'processing_failed' });
  }

  // ----------------------------------------------------------------- sending + viewing

  /** Claim an approved image for a single message. Call releaseSend() if the message later fails. */
  async assertSendable(user, imageId, { chatId, roomId }) {
    const m = await this.#meta(imageId);
    if (m.owner !== String(user._id || user.id)) throw forbidden('Not your image');
    if (!OK_STATUS.has(m.status)) throw badRequest(m.status === 'processing' ? 'Image is still being checked' : 'This image cannot be sent', { code: m.status === 'processing' ? 'IMAGE_PROCESSING' : 'IMAGE_REJECTED', reason: m.reason });
    if (m.scope === 'chat' ? m.scopeId !== chatId : m.scopeId !== roomId) throw forbidden('Image was prepared for a different conversation');
    if (!(await this.redis.hsetnx(this.#key(imageId), 'sentAt', Date.now()))) throw badRequest('Image was already sent', { code: 'IMAGE_ALREADY_SENT' });
  }
  async releaseSend(imageId) {
    await this.redis.hdel(this.#key(imageId), 'sentAt');
  }

  async publicMeta(imageId) {
    const m = await this.redis.hgetall(this.#key(imageId));
    if (!m.owner) return null;
    return { id: imageId, status: m.status, viewMode: m.viewMode, timerSec: Number(m.timerSec), w: Number(m.w) || undefined, h: Number(m.h) || undefined };
  }

  async view(user, imageId) {
    const uid = String(user._id || user.id);
    const m = await this.#meta(imageId);
    if (DEAD_STATUS.has(m.status)) throw gone('This image is no longer available');
    if (!OK_STATUS.has(m.status)) throw badRequest('Image is not ready', { code: 'IMAGE_PROCESSING' });
    const owner = m.owner === uid;
    if (!owner) {
      if (!m.sentAt) throw forbidden('Not available');
      const member = m.scope === 'chat' ? await this.matching.isParticipant(m.scopeId, uid) : await this.rooms.isMember(m.scopeId, uid);
      if (!member) throw forbidden('You cannot view this image');
      const vk = K.imageViewed(imageId, uid);
      const first = await this.redis.set(vk, Date.now(), 'EX', 24 * 3600, 'NX');
      if (!first) {
        const t0 = Number(await this.redis.get(vk));
        const age = Date.now() - t0;
        const allowed = m.viewMode === 'once' ? age < RETRY_GRACE_MS : age < (Number(m.timerSec) + 30) * 1000;
        if (!allowed) throw gone(m.viewMode === 'once' ? 'This image was view-once and has already been opened' : 'The viewing time for this image has ended');
      } else {
        this.emit.toUser(m.owner, 'image:viewed', { imageId });
      }
    }
    const cfg = (await this.settings.get()).images;
    const url = await this.storage.getSignedGetUrl(this.procKey(imageId), cfg.urlTtlSec);
    const alias = m.scope === 'room' ? this.rooms.identity(m.scopeId, uid).alias : user.nickname;
    return {
      url,
      expiresInSec: cfg.urlTtlSec,
      viewMode: m.viewMode,
      timerSec: Number(m.timerSec),
      forceBlur: m.status === 'blurred',
      width: Number(m.w),
      height: Number(m.h),
      // Deterrent only: drawn over the canvas by the client so a leaked screenshot points at the viewer.
      watermark: { alias, code: hmac(`wm:${uid}:${imageId}`).slice(0, 6).toUpperCase(), ts: Date.now() },
      own: owner,
    };
  }

  // ----------------------------------------------------------------- reports / takedowns

  async preserveEvidence(imageId, reportId, { reportedId }) {
    const m = await this.redis.hgetall(this.#key(imageId));
    if (!m.owner || m.owner !== reportedId) return null; // only the reported user's own images are preserved
    if (!(OK_STATUS.has(m.status) || m.status === 'hidden')) return null;
    const evidenceKey = `evidence/${reportId}/${imageId}.jpg`;
    await this.storage.copyObject(this.procKey(imageId), evidenceKey);
    await this.redis.hset(this.#key(imageId), { evidence: '1' });
    return { imageId, evidenceKey, phash: m.phash };
  }

  async registerReport(imageId, threshold, category) {
    const m = await this.redis.hgetall(this.#key(imageId));
    if (!m.owner) return;
    const n = await this.redis.hincrby(this.#key(imageId), 'reportCount', 1);
    if (n >= threshold || CRITICAL_REPORT_CATEGORIES.includes(category)) {
      await this.redis.hset(this.#key(imageId), { status: 'hidden' });
      this.emit.toUser(m.owner, 'image:hidden', { imageId });
      if (m.scope === 'room') this.emit.toRoom(m.scopeId, 'image:hidden', { imageId });
      else this.emit.toUser(m.owner, 'image:hidden', { imageId });
      await this.audit.log({ action: 'image.auto_hidden', targetType: 'image', targetId: imageId, severity: 'warn', meta: { reports: n, category } });
    }
  }

  async adminTakedown(imageId, adminId, { blocklist = false } = {}) {
    const m = await this.redis.hgetall(this.#key(imageId));
    if (!m.owner) return false;
    await this.storage.deleteObject(this.procKey(imageId)).catch(() => {});
    await this.storage.deleteObject(this.tmpKey(imageId)).catch(() => {});
    await this.redis.hset(this.#key(imageId), { status: 'removed' });
    if (blocklist && m.phash) await this.hashMatch.addKnownBad({ phash: m.phash });
    await this.audit.log({ actorId: adminId, actorType: 'admin', action: 'image.takedown', targetType: 'image', targetId: imageId, severity: 'warn', meta: { blocklisted: blocklist } });
    if (m.scope === 'room') this.emit.toRoom(m.scopeId, 'image:hidden', { imageId });
    return true;
  }

  async evidenceUrl(admin, key) {
    if (!/^evidence\/[a-f0-9]{24}\/[A-Za-z0-9_-]+\.jpg$/.test(key)) throw badRequest('Bad evidence key');
    await this.audit.log({ actorId: String(admin._id), actorType: 'admin', action: 'evidence.view', targetType: 'evidence', targetId: key });
    return { url: await this.storage.getSignedGetUrl(key, 60), expiresInSec: 60 };
  }

  // ----------------------------------------------------------------- housekeeping

  async sweepExpired() {
    const due = await this.redis.zClaimDue(K.imageExpiry, Date.now(), 200);
    for (const id of due) {
      const m = await this.redis.hgetall(this.#key(id));
      await this.storage.deleteObject(this.procKey(id)).catch(() => {});
      await this.storage.deleteObject(this.tmpKey(id)).catch(() => {});
      if (m.owner) await this.redis.multi().hset(this.#key(id), { status: 'expired' }).expire(this.#key(id), 3600).srem(K.imagePending, id).exec();
    }
    return due.length;
  }

  pendingCount() {
    return this.redis.scard(K.imagePending);
  }

  static fingerprint(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }
}
