import { User } from '../models/User.js';
import { badRequest, forbidden } from '../utils/errors.js';
import { K } from '../config/redis.js';
import { logger } from '../config/logger.js';

const PUBLIC_FIELDS = 'nickname avatar kind';

/** Random 1:1 chat orchestration: queueing, messaging, typing, resume, disconnect handling. */
export class ChatService {
  constructor({ redis, settings, matching, events, limiter, moderation, emit, presence }) {
    Object.assign(this, { redis, settings, matching, events, limiter, moderation, emit, presence });
    this.hooks = { onMessage: null, onChatEnded: null }; // saved chat plugs in here
  }

  async #partnerCard(userId) {
    const u = await User.findById(userId).select(PUBLIC_FIELDS).lean();
    return u ? { nickname: u.nickname, avatar: u.avatar } : { nickname: 'Stranger', avatar: null };
  }

  async #announceMatch(m) {
    const [mine, theirs] = await Promise.all([this.#partnerCard(m.userId), this.#partnerCard(m.partnerId)]);
    const base = { chatId: m.chatId, sharedTags: m.sharedTags || [], startedAt: Date.now(), seq: 0 };
    this.emit.toUser(m.userId, 'match:found', { ...base, partner: theirs });
    this.emit.toUser(m.partnerId, 'match:found', { ...base, partner: mine });
  }

  async start(user, prefs = {}) {
    const userId = String(user._id || user.id);
    const cfg = await this.settings.get();
    await this.limiter.assertWindow('match', userId, { limit: cfg.limits.matchPerMin, windowMs: 60_000 }, 'Too many match attempts, wait a moment');
    await this.matching.cancelDisconnect(userId);
    const res = await this.matching.join(userId, {
      tags: prefs.tags,
      lang: prefs.lang,
      gender: user.gender,
      pref: prefs.genderPref,
    });
    if (res.status === 'matched') {
      await this.#announceMatch(res);
    } else if (res.status === 'in_chat') {
      const partner = await this.#partnerCard(res.partnerId);
      this.emit.toUser(userId, 'match:found', { chatId: res.chatId, partner, sharedTags: [], startedAt: Date.now(), seq: 0, resumed: true });
    } else {
      this.emit.toUser(userId, 'match:queued', { fallbackAt: res.fallbackAt });
    }
    return res;
  }

  /** Leave queue and/or chat; the partner is told. */
  async leave(userId, { reason = 'partner_left' } = {}) {
    const res = await this.matching.leave(userId);
    if (res.kind === 'left_chat') {
      await this.events.shorten('chat', res.chatId);
      if (res.partnerId) this.emit.toUser(res.partnerId, 'chat:ended', { chatId: res.chatId, reason });
      this.emit.toUser(userId, 'chat:ended', { chatId: res.chatId, reason: 'left' });
      this.hooks.onChatEnded?.(res.chatId, [userId, res.partnerId]);
    } else if (res.kind === 'dequeued') {
      this.emit.toUser(userId, 'match:cancelled', {});
    }
    return res;
  }

  async next(user, prefs) {
    await this.leave(String(user._id || user.id));
    return this.start(user, prefs);
  }

  async #activeFor(userId, chatId) {
    const active = await this.matching.activeChat(userId);
    if (!active || (chatId && active.chatId !== chatId)) throw forbidden('You are not in this chat', { code: 'NOT_IN_CHAT' });
    return active;
  }

  /**
   * Send a message. Order matters: cheap checks first, idempotency before rate limiting so a client
   * retry of an already-delivered message is never penalised or re-delivered.
   */
  async send(user, { chatId, clientMsgId, text, kind = 'text', imageId }, socketId) {
    const userId = String(user._id || user.id);
    const active = await this.#activeFor(userId, chatId);
    const idem = await this.events.beginIdempotent(userId, clientMsgId);
    if (!idem.first) return { ...(idem.ack || {}), duplicate: true };
    try {
      const cfg = await this.settings.get();
      await this.limiter.assertBucket('msg', userId, { capacity: cfg.limits.msgBurst, refillPerSec: cfg.limits.msgRefillPerSec }, 'You are sending too fast');
      await this.limiter.assertWindow('msg10', userId, { limit: cfg.limits.msgPer10s, windowMs: 10_000 }, 'You are sending too fast');

      let body = '';
      let image;
      if (kind === 'text') {
        body = await this.moderation.screenText(user, text, {
          scope: 'random',
          evidenceRef: { kind: 'random', chatId: active.chatId },
          sender: { id: userId, ipHash: user.ipHash, deviceHash: user.deviceHash },
        });
      } else if (kind === 'image') {
        if (!imageId) throw badRequest('imageId required');
        body = ''; // eligibility was claimed by images.assertSendable (see sockets/random.js)
        image = await this.images.publicMeta(imageId);
      }
      const ev = await this.events.append('chat', active.chatId, { from: userId, kind, text: body, imageId, image, clientMsgId });
      const wire = (from) => ({ chatId: active.chatId, seq: ev.seq, ts: ev.ts, from, kind, text: body, imageId, image, clientMsgId });
      this.emit.toUser(active.partnerId, 'chat:msg', wire('them'));
      this.emit.toUserExcept(userId, socketId, 'chat:msg', wire('me'));
      await this.hooks.onMessage?.(active.chatId, userId, active.partnerId, ev);
      const ack = { ok: true, seq: ev.seq, ts: ev.ts, text: body };
      await this.events.completeIdempotent(userId, clientMsgId, ack);
      return ack;
    } catch (e) {
      await this.events.abortIdempotent(userId, clientMsgId); // allow a corrected retry with same id
      throw e;
    }
  }

  async typing(userId, { chatId, on }) {
    const active = await this.#activeFor(userId, chatId);
    const r = await this.limiter.bucket('typing', userId, { capacity: 4, refillPerSec: 2 });
    if (!r.allowed) return;
    this.emit.toUser(active.partnerId, 'chat:typing', { chatId: active.chatId, on: !!on });
  }

  /** After a reconnect: replay missed events and report current state. */
  async resume(user, { chatId, lastSeq = 0 }) {
    const userId = String(user._id || user.id);
    await this.matching.cancelDisconnect(userId);
    const active = await this.matching.activeChat(userId);
    if (!active) {
      const queued = await this.matching.isQueued(userId);
      return { state: queued ? 'queued' : 'idle', chatEnded: !!chatId && !queued };
    }
    if (chatId && chatId !== active.chatId) return { state: 'idle', chatEnded: true };
    const missed = await this.events.after('chat', active.chatId, lastSeq);
    const partner = await this.#partnerCard(active.partnerId);
    return {
      state: 'chatting',
      chatId: active.chatId,
      partner,
      startedAt: active.startedAt,
      sharedTags: active.sharedTags,
      events: missed.map((e) => ({
        chatId: active.chatId,
        seq: e.seq,
        ts: e.ts,
        from: e.from === userId ? 'me' : 'them',
        kind: e.kind,
        text: e.text,
        imageId: e.imageId,
        image: e.image,
        clientMsgId: e.clientMsgId,
      })),
    };
  }

  // ---- lifecycle hooks (called by socket layer + sweeper) ----

  async onUserOffline(userId) {
    const cfg = await this.settings.get();
    const queued = await this.matching.isQueued(userId);
    if (queued) {
      const res = await this.matching.leave(userId);
      logger.debug({ kind: res.kind }, 'dequeued on disconnect');
    }
    const active = await this.matching.activeChat(userId);
    if (active) {
      await this.matching.scheduleDisconnect(userId, cfg.matching.disconnectGraceMs);
      this.emit.toUser(active.partnerId, 'chat:partner_status', { chatId: active.chatId, status: 'reconnecting' });
    }
  }

  async onUserOnline(userId) {
    const cancelled = await this.matching.cancelDisconnect(userId);
    if (cancelled) {
      const active = await this.matching.activeChat(userId);
      if (active) this.emit.toUser(active.partnerId, 'chat:partner_status', { chatId: active.chatId, status: 'online' });
    }
  }

  /** Sweeper: users whose reconnect grace expired and are still offline lose their chat. */
  async processDisconnects() {
    const due = await this.matching.claimDueDisconnects();
    for (const userId of due) {
      if (await this.presence.isOnline(userId)) continue;
      await this.leave(userId, { reason: 'partner_disconnected' });
    }
    return due.length;
  }

  /** Sweeper: give users whose strict-tag wait is over a second chance against the general pool. */
  async processFallbacks() {
    const due = await this.matching.claimDueFallbacks();
    let matched = 0;
    for (const userId of due) {
      const res = await this.matching.retry(userId);
      if (res.status === 'matched') {
        matched++;
        await this.#announceMatch(res);
      } else if (await this.matching.isQueued(userId)) {
        this.emit.toUser(userId, 'match:fallback', {});
      }
    }
    return matched;
  }

  async processStale() {
    const stale = await this.matching.sweepStale();
    for (const uid of stale) this.emit.toUser(uid, 'match:timeout', {});
    return stale.length;
  }

  async block(userId, targetId) {
    if (userId === targetId) throw badRequest('Cannot block yourself');
    await this.matching.addBlock(userId, targetId);
  }

  /** Block someone seen in a room (by opaque memberId). Effects: never matched in random chat; hidden client-side in rooms. */
  async blockRoomMember(userId, roomId, memberId, rooms) {
    if (!(await rooms.isMember(roomId, userId))) throw forbidden('Join the room first');
    const target = await rooms.resolveMember(roomId, memberId);
    if (!target) throw badRequest('Member not found');
    await this.block(userId, target);
    await User.updateOne({ _id: userId }, { $addToSet: { blocked: target } });
    return { blocked: true, memberId };
  }

  /** Block the partner of a chat the caller took part in, then end the chat. */
  async blockPartner(userId, chatId) {
    if (!(await this.matching.isParticipant(chatId, userId))) throw forbidden('You are not part of this chat');
    const active = await this.matching.activeChat(userId);
    let partnerId = active?.chatId === chatId ? active.partnerId : null;
    if (!partnerId) {
      const members = await this.redis.smembers(K.chatParticipants(chatId));
      partnerId = members.find((m) => m !== userId) || null;
    }
    if (!partnerId) throw badRequest('Nobody to block');
    await this.block(userId, partnerId);
    await User.updateOne({ _id: userId }, { $addToSet: { blocked: partnerId } });
    if (active?.chatId === chatId) await this.leave(userId, { reason: 'partner_left' });
    return { blocked: true };
  }
}

export const _keys = K;
