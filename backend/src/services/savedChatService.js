import { SavedChat } from '../models/SavedChat.js';
import { User } from '../models/User.js';
import { encrypt, decrypt, deriveKey } from '../utils/crypto.js';
import { config } from '../config/env.js';
import { forbidden, badRequest, notFound } from '../utils/errors.js';
import { logger } from '../config/logger.js';

const stateKey = (chatId) => `save:${chatId}`;
const DAY = 86400_000;

/**
 * Opt-in "Save chat" for 1:1 chats. Rules enforced here:
 *  - BOTH participants must be signed-up users (guests are never saved) and BOTH must accept
 *  - either side can stop at any time; saving stops for both immediately
 *  - text only (images are never persisted), AES-256-GCM per-message encryption with a per-document
 *    HKDF key, each user gets and can delete their own copy, retention TTL from settings
 */
export class SavedChatService {
  constructor({ redis, settings, matching, emit, audit, masterKey = config.ENCRYPTION_KEY_BUF }) {
    Object.assign(this, { redis, settings, matching, emit, audit, masterKey });
  }

  #key(ownerId, chatId) {
    return deriveKey(this.masterKey, `saved:${ownerId}:${chatId}`);
  }

  async #ctx(userId, chatId) {
    const active = await this.matching.activeChat(userId);
    if (!active || active.chatId !== chatId) throw forbidden('You are not in this chat', { code: 'NOT_IN_CHAT' });
    return active;
  }

  async #registered(userId) {
    const u = await User.findById(userId).select('kind nickname').lean();
    return u?.kind === 'registered' ? u : null;
  }

  async request(userId, chatId) {
    const { partnerId } = await this.#ctx(userId, chatId);
    if (!(await this.#registered(userId))) throw forbidden('Sign up or log in to save chats', { code: 'SIGNUP_REQUIRED' });
    if (!(await this.#registered(partnerId))) throw forbidden('Saving needs both people to have an account', { code: 'PARTNER_GUEST' });
    const st = await this.redis.hgetall(stateKey(chatId));
    if (st.active === '1') return { state: 'active' };
    await this.redis.multi().hset(stateKey(chatId), { requester: userId, active: '0' }).expire(stateKey(chatId), 4 * 3600).exec();
    this.emit.toUser(partnerId, 'save:prompt', { chatId });
    this.emit.toUser(userId, 'save:state', { chatId, state: 'requested' });
    return { state: 'requested' };
  }

  async respond(userId, chatId, accept) {
    const { partnerId } = await this.#ctx(userId, chatId);
    const st = await this.redis.hgetall(stateKey(chatId));
    if (!st.requester || st.requester === userId) throw badRequest('Nothing to respond to');
    if (!accept) {
      await this.redis.del(stateKey(chatId));
      this.emit.toUser(partnerId, 'save:state', { chatId, state: 'declined' });
      this.emit.toUser(userId, 'save:state', { chatId, state: 'off' });
      return { state: 'declined' };
    }
    if (!(await this.#registered(userId))) throw forbidden('Sign up or log in to save chats', { code: 'SIGNUP_REQUIRED' });
    await this.redis.hset(stateKey(chatId), { active: '1', a: userId, b: partnerId });
    await this.audit.log({ actorId: userId, actorType: 'user', action: 'savedchat.start', targetType: 'chat', targetId: chatId });
    for (const u of [userId, partnerId]) this.emit.toUser(u, 'save:state', { chatId, state: 'active' });
    return { state: 'active' };
  }

  async stop(userId, chatId) {
    const st = await this.redis.hgetall(stateKey(chatId));
    if (!st.a && !st.requester) return { state: 'off' };
    const members = new Set([st.a, st.b, st.requester].filter(Boolean));
    if (!members.has(userId)) throw forbidden('Not your chat');
    await this.redis.del(stateKey(chatId));
    const active = await this.matching.activeChat(userId);
    for (const u of members) this.emit.toUser(u, 'save:state', { chatId, state: 'off', by: u === userId ? 'me' : 'them' });
    void active;
    return { state: 'off' };
  }

  async currentState(chatId) {
    const st = await this.redis.hgetall(stateKey(chatId));
    return st.active === '1' ? 'active' : st.requester ? 'requested' : 'off';
  }

  /** ChatService hook: persist an encrypted copy for each participant when (and only when) both consented. */
  async onMessage(chatId, fromUserId, partnerId, event) {
    if (event.kind !== 'text' || !event.text) return;
    const st = await this.redis.hgetall(stateKey(chatId));
    if (st.active !== '1') return;
    const cfg = (await this.settings.get()).savedChats;
    // Defence in depth: re-check both sides are still registered users.
    if (!(await this.#registered(fromUserId)) || !(await this.#registered(partnerId))) {
      await this.stop(fromUserId, chatId);
      return;
    }
    const nicknames = Object.fromEntries((await User.find({ _id: { $in: [fromUserId, partnerId] } }).select('nickname').lean()).map((u) => [String(u._id), u.nickname]));
    const expiresAt = new Date(Date.now() + cfg.retentionDays * DAY);
    for (const owner of [fromUserId, partnerId]) {
      const enc = encrypt(event.text, this.#key(owner, chatId), `${owner}:${chatId}`);
      const peer = owner === fromUserId ? partnerId : fromUserId;
      try {
        const doc = await SavedChat.findOneAndUpdate(
          { ownerId: owner, chatId },
          { $setOnInsert: { peerLabel: nicknames[peer], startedAt: new Date() }, $set: { expiresAt }, $push: { messages: { ts: event.ts, from: owner === fromUserId ? 'me' : 'them', ...enc } } },
          { upsert: true, new: true },
        );
        if (doc.messages.length >= cfg.maxMessages) {
          await this.stop(fromUserId, chatId);
          this.emit.toUser(owner, 'save:state', { chatId, state: 'off', reason: 'limit' });
        }
      } catch (e) {
        logger.error({ err: e.message }, 'saved chat append failed');
      }
    }
  }

  async onChatEnded(chatId) {
    await this.redis.del(stateKey(chatId));
  }

  // ------------------------------------------------------------ user-facing API

  async list(ownerId) {
    const docs = await SavedChat.find({ ownerId, expiresAt: { $gt: new Date() } }).sort({ updatedAt: -1 }).select('chatId peerLabel startedAt expiresAt messages.ts').lean();
    return docs.map((d) => ({ id: String(d._id), peerLabel: d.peerLabel, startedAt: d.startedAt, expiresAt: d.expiresAt, count: d.messages?.length || 0 }));
  }

  async read(ownerId, id) {
    const doc = await SavedChat.findOne({ _id: id, ownerId }).lean();
    if (!doc || doc.expiresAt < new Date()) throw notFound('Saved chat not found');
    const key = this.#key(ownerId, doc.chatId);
    const messages = doc.messages.map((m) => {
      try {
        return { ts: m.ts, from: m.from, text: decrypt(m, key, `${ownerId}:${doc.chatId}`) };
      } catch {
        return { ts: m.ts, from: m.from, text: '[unreadable]' };
      }
    });
    return { id: String(doc._id), peerLabel: doc.peerLabel, startedAt: doc.startedAt, expiresAt: doc.expiresAt, messages };
  }

  async remove(ownerId, id) {
    const r = await SavedChat.deleteOne({ _id: id, ownerId });
    if (!r.deletedCount) throw notFound('Saved chat not found');
    await this.audit.log({ actorId: ownerId, actorType: 'user', action: 'savedchat.delete', targetId: id });
    return { ok: true };
  }

  async removeAll(ownerId) {
    const r = await SavedChat.deleteMany({ ownerId });
    await this.audit.log({ actorId: ownerId, actorType: 'user', action: 'savedchat.delete_all', meta: { count: r.deletedCount } });
    return { deleted: r.deletedCount };
  }

  /** Sweeper: Mongo TTL indexes may be unavailable on compatible servers, so expire explicitly too. */
  async purgeExpired() {
    const r = await SavedChat.deleteMany({ expiresAt: { $lt: new Date() } });
    return r.deletedCount;
  }
}
