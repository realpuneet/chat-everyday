import { forbidden, badRequest } from '../utils/errors.js';

const key = (chatId) => `rtc:${chatId}`;

/**
 * WebRTC signalling for optional video chat. The server only relays SDP/ICE between the two
 * participants of an ACTIVE random chat, after the partner explicitly accepted. Media is peer-to-peer
 * (or through coturn when NAT traversal fails) and is never recorded or inspected by us.
 */
export class RtcService {
  constructor({ redis, matching, emit, limiter, tokens, cfg }) {
    Object.assign(this, { redis, matching, emit, limiter, tokens, cfg });
  }

  iceServers(userId) {
    const servers = this.cfg.STUN_URLS.length ? [{ urls: this.cfg.STUN_URLS }] : [];
    if (this.cfg.TURN_URLS.length && this.cfg.TURN_SECRET) {
      servers.push({ urls: this.cfg.TURN_URLS, ...this.tokens.turnCredentials(userId, { secret: this.cfg.TURN_SECRET, ttlSec: this.cfg.TURN_TTL_SEC }) });
    }
    return { iceServers: servers, ttlSec: this.cfg.TURN_TTL_SEC, relay: !!(this.cfg.TURN_URLS.length && this.cfg.TURN_SECRET) };
  }

  async #ctx(userId, chatId) {
    const active = await this.matching.activeChat(userId);
    if (!active || active.chatId !== chatId) throw forbidden('You are not in this chat', { code: 'NOT_IN_CHAT' });
    return active;
  }

  async request(userId, chatId) {
    const { partnerId } = await this.#ctx(userId, chatId);
    await this.limiter.assertWindow('rtc-req', userId, { limit: 10, windowMs: 10 * 60_000 }, 'Too many video requests');
    const st = await this.redis.hgetall(key(chatId));
    if (st.state === 'active') throw badRequest('Video call already active', { code: 'RTC_ACTIVE' });
    await this.redis.multi().hset(key(chatId), { state: 'requested', requester: userId }).expire(key(chatId), 60).exec();
    this.emit.toUser(partnerId, 'rtc:incoming', { chatId });
    return { state: 'requested' };
  }

  async respond(userId, chatId, accept) {
    const { partnerId } = await this.#ctx(userId, chatId);
    const st = await this.redis.hgetall(key(chatId));
    if (st.state !== 'requested' || st.requester === userId) throw badRequest('No pending video request');
    if (!accept) {
      await this.redis.del(key(chatId));
      this.emit.toUser(partnerId, 'rtc:declined', { chatId });
      return { state: 'declined' };
    }
    await this.redis.multi().hset(key(chatId), { state: 'active' }).expire(key(chatId), 4 * 3600).exec();
    // The requester creates the SDP offer.
    this.emit.toUser(partnerId, 'rtc:accepted', { chatId, role: 'caller' });
    this.emit.toUser(userId, 'rtc:accepted', { chatId, role: 'callee' });
    return { state: 'active' };
  }

  async signal(userId, { chatId, type, data }) {
    const { partnerId } = await this.#ctx(userId, chatId);
    if ((await this.redis.hget(key(chatId), 'state')) !== 'active') throw forbidden('Video call not accepted', { code: 'RTC_NOT_ACTIVE' });
    await this.limiter.assertBucket('rtc-sig', userId, { capacity: 80, refillPerSec: 40 }, 'Signalling too fast');
    this.emit.toUser(partnerId, 'rtc:signal', { chatId, type, data });
  }

  async end(userId, chatId) {
    const { partnerId } = await this.#ctx(userId, chatId);
    await this.redis.del(key(chatId));
    this.emit.toUser(partnerId, 'rtc:ended', { chatId });
    this.emit.toUser(userId, 'rtc:ended', { chatId });
  }

  /** Chat ended (leave / disconnect / ban): tear the call down too. */
  async onChatEnded(chatId, userIds = []) {
    if (await this.redis.del(key(chatId))) for (const u of userIds.filter(Boolean)) this.emit.toUser(u, 'rtc:ended', { chatId });
  }
}
