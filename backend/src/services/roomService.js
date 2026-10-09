import mongoose from 'mongoose';
import { Room } from '../models/Room.js';
import { User } from '../models/User.js';
import { K } from '../config/redis.js';
import { hmac, randomId } from '../utils/crypto.js';
import { generateIdentity } from '../utils/nickname.js';
import { AppError, badRequest, forbidden, notFound, tooMany } from '../utils/errors.js';
import { sanitizeText } from './filters.js';
import { logger } from '../config/logger.js';

const AGE_RANK = { declared: 0, phone: 1, google: 1, strict: 2 };
const KICK_LOCKOUT_SEC = 600;
const ROOM_DISC_KEY = 'room:disc';
const CFG_TTL_SEC = 3600;

export const SYSTEM_ROOMS = [
  { slug: 'identity-everyone', name: 'Everyone', type: 'identity', identity: 'everyone', description: 'Open to all adults.' },
  { slug: 'identity-men', name: 'Men', type: 'identity', identity: 'men', description: 'Room for people who declare themselves as men (self-declared, not verified).' },
  { slug: 'identity-women', name: 'Women', type: 'identity', identity: 'women', description: 'Room for people who declare themselves as women (self-declared, not verified).' },
  { slug: 'identity-lgbtq', name: 'LGBTQ+', type: 'identity', identity: 'lgbtq', description: 'Room for LGBTQ+ people and allies who self-identify (not verified).' },
  ...['cricket', 'music', 'movies', 'gaming', 'tech', 'books', 'travel', 'food', 'anime', 'fitness'].map((t) => ({
    slug: `interest-${t}`,
    name: t[0].toUpperCase() + t.slice(1),
    type: 'interest',
    identity: 'everyone',
    description: `Chat about ${t}.`,
  })),
  { slug: 'adult-lounge', name: 'Adults 18+ Lounge', type: 'interest', identity: 'everyone', adult: true, description: 'Mature (18+) conversation between consenting adults. Images are blurred by default. Hard content rules still apply.' },
];

const slugify = (s) => s.toLowerCase().normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'room';

/** Batches room fanout: one socket write per room per tick instead of one per message. */
export class RoomFanout {
  constructor({ emit, settings }) {
    this.emit = emit;
    this.settings = settings;
    this.msgBuf = new Map();
    this.presBuf = new Map();
    this.msgTimer = null;
    this.presTimer = null;
  }

  async pushMessage(roomId, msg) {
    const ms = (await this.settings.get()).rooms.fanoutBatchMs;
    if (!ms) return this.emit.toRoom(roomId, 'room:msgs', { roomId, msgs: [msg] });
    if (!this.msgBuf.has(roomId)) this.msgBuf.set(roomId, []);
    this.msgBuf.get(roomId).push(msg);
    if (!this.msgTimer) this.msgTimer = setTimeout(() => this.flushMessages(), ms);
  }

  flushMessages() {
    this.msgTimer = null;
    for (const [roomId, msgs] of this.msgBuf) this.emit.toRoom(roomId, 'room:msgs', { roomId, msgs });
    this.msgBuf.clear();
  }

  pushPresence(roomId, kind, member, count) {
    const b = this.presBuf.get(roomId) || { joined: [], left: [] };
    (kind === 'join' ? b.joined : b.left).push(kind === 'join' ? member : member.memberId);
    b.count = count;
    this.presBuf.set(roomId, b);
    if (!this.presTimer) this.presTimer = setTimeout(() => this.flushPresence(), 1000);
  }

  flushPresence() {
    this.presTimer = null;
    for (const [roomId, b] of this.presBuf) this.emit.toRoom(roomId, 'room:presence', { roomId, ...b });
    this.presBuf.clear();
  }

  flushAll() {
    clearTimeout(this.msgTimer);
    clearTimeout(this.presTimer);
    this.flushMessages();
    this.flushPresence();
  }
}

export class RoomService {
  constructor({ redis, settings, events, limiter, moderation, emit, audit, fanout }) {
    Object.assign(this, { redis, settings, events, limiter, moderation, emit, audit, fanout });
  }

  // ---------------------------------------------------------------- identity helpers

  memberId(roomId, userId) {
    return hmac(`member:${roomId}:${userId}`).slice(0, 12);
  }
  /** Per-room alias + avatar: stable across devices/reconnects, unlinkable across rooms. */
  identity(roomId, userId) {
    return generateIdentity(hmac(`alias:${roomId}:${userId}`));
  }

  roleOf(room, user) {
    const uid = String(user._id || user.id);
    if (room.ownerId === uid) return 'owner';
    if (room.moderators?.includes(uid) || user.role === 'admin') return 'moderator';
    return 'member';
  }

  #pub(room, count) {
    return {
      id: String(room._id),
      slug: room.slug,
      name: room.name,
      description: room.description,
      type: room.type,
      identity: room.identity,
      visibility: room.visibility,
      adult: room.adult,
      system: room.system,
      slowModeSec: room.slowModeSec,
      rules: room.rules,
      maxMembers: room.maxMembers,
      filters: { blockLinks: room.filters?.blockLinks, blockPii: room.filters?.blockPii },
      ...(count !== undefined ? { members: count } : {}),
    };
  }

  // ---------------------------------------------------------------- directory

  async ensureSystemRooms() {
    for (const r of SYSTEM_ROOMS) {
      await Room.updateOne(
        { slug: r.slug },
        { $setOnInsert: { ...r, system: true, visibility: 'public', adult: !!r.adult, maxMembers: 500, filters: { blockLinks: true, blockPii: true, badWords: [] } } },
        { upsert: true },
      );
    }
  }

  async list({ type } = {}) {
    const q = { hidden: false, visibility: 'public' };
    if (type) q.type = type;
    const rooms = await Room.find(q).sort({ system: -1, lastActiveAt: -1, name: 1 }).limit(200).lean();
    const p = this.redis.pipeline();
    rooms.forEach((r) => p.scard(K.roomMemberOf(String(r._id))));
    const counts = await p.exec();
    return rooms.map((r, i) => this.#pub(r, counts[i][1]));
  }

  async mine(userId) {
    const ids = await this.redis.smembers(K.userRooms(userId));
    const owned = await Room.find({ ownerId: userId, hidden: false }).lean();
    const joined = ids.length ? await Room.find({ _id: { $in: ids } }).lean() : [];
    const all = new Map([...owned, ...joined].map((r) => [String(r._id), r]));
    return [...all.values()].map((r) => this.#pub(r));
  }

  async preview(inviteCode) {
    const room = await Room.findOne({ inviteCode: String(inviteCode).toUpperCase(), hidden: false }).lean();
    if (!room) throw notFound('Invalid invite code');
    return this.#pub(room, await this.redis.scard(K.roomMemberOf(String(room._id))));
  }

  async create(user, body) {
    const cfg = (await this.settings.get()).rooms;
    if (user.kind === 'guest' && !cfg.guestsCanCreate) throw forbidden('Sign up to create a room', { code: 'SIGNUP_REQUIRED' });
    const uid = String(user._id);
    await this.limiter.assertWindow('room-create', uid, { limit: 3, windowMs: 3600_000 }, 'You are creating rooms too quickly');
    if ((await Room.countDocuments({ ownerId: uid, hidden: false })) >= cfg.maxCustomRoomsPerUser) {
      throw forbidden(`You can own at most ${cfg.maxCustomRoomsPerUser} rooms`, { code: 'ROOM_LIMIT' });
    }
    if (body.adult && AGE_RANK[user.ageLevel] < AGE_RANK[cfg.adultMinAgeLevel]) {
      throw forbidden('Verify your phone or Google account to create an adult room', { code: 'AGE_LEVEL_TOO_LOW' });
    }
    const name = sanitizeText(body.name);
    const verdict = await this.moderation.screenText(user, name, { scope: 'room', roomFilters: { blockLinks: true, blockPii: true } });
    const room = await Room.create({
      slug: `${slugify(verdict)}-${randomId(3).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`,
      name: verdict,
      description: sanitizeText(body.description || ''),
      type: 'custom',
      identity: body.identity || 'everyone',
      visibility: body.visibility,
      adult: !!body.adult,
      ownerId: uid,
      rules: sanitizeText(body.rules || ''),
      maxMembers: Math.min(body.maxMembers || 100, 500),
      filters: { blockLinks: body.filters?.blockLinks ?? true, blockPii: body.filters?.blockPii ?? true, badWords: (body.filters?.badWords || []).map((w) => w.toLowerCase()) },
      inviteCode: body.visibility === 'private' ? randomId(6).toUpperCase().replace(/[^A-Z0-9]/g, 'X') : undefined,
    });
    await this.audit.log({ actorId: uid, actorType: 'user', action: 'room.create', targetType: 'room', targetId: String(room._id), meta: { adult: room.adult, visibility: room.visibility } });
    return { ...this.#pub(room, 0), inviteCode: room.inviteCode };
  }

  async remove(user, roomId) {
    const room = mongoose.isValidObjectId(roomId) ? await Room.findById(roomId) : null;
    if (!room || room.system) throw notFound('Room not found');
    if (room.ownerId !== String(user._id) && user.role !== 'admin') throw forbidden('Only the owner can delete this room');
    await Room.deleteOne({ _id: roomId });
    this.emit.toRoom(roomId, 'room:closed', { roomId, reason: 'deleted' });
    await this.#purge(roomId);
    return { ok: true };
  }

  async #purge(roomId) {
    const uids = await this.redis.smembers(K.roomMemberOf(roomId));
    const p = this.redis.pipeline();
    uids.forEach((u) => p.srem(K.userRooms(u), roomId));
    p.del(K.roomMembers(roomId), K.roomMemberOf(roomId), K.roomEvents(roomId), K.roomSeq(roomId), `room:${roomId}:cfg`);
    await p.exec();
    uids.forEach((u) => this.emit.leaveUserSockets(u, roomId));
  }

  // ---------------------------------------------------------------- config cache

  async #cfg(roomId) {
    const key = `room:${roomId}:cfg`;
    const cached = await this.redis.get(key);
    if (cached) return JSON.parse(cached);
    const r = await Room.findById(roomId).lean();
    if (!r) throw notFound('Room not found');
    const cfg = { ownerId: r.ownerId || null, moderators: r.moderators || [], slowModeSec: r.slowModeSec || 0, filters: r.filters || {}, adult: r.adult, hidden: r.hidden, rules: r.rules };
    await this.redis.set(key, JSON.stringify(cfg), 'EX', CFG_TTL_SEC);
    return cfg;
  }
  async #invalidate(roomId) {
    await this.redis.del(`room:${roomId}:cfg`);
  }

  // ---------------------------------------------------------------- membership

  #assertEntitled(room, user, cfg) {
    if (room.hidden) throw notFound('Room not found');
    const uid = String(user._id || user.id);
    if (room.bannedUsers?.includes(uid)) throw forbidden('You are banned from this room', { code: 'ROOM_BANNED' });
    // Identity rooms use a SELF-DECLARED profile attribute. This is a courtesy gate, not verification.
    if (room.type === 'identity' && room.identity !== 'everyone') {
      const g = user.gender;
      const ok =
        (room.identity === 'men' && g === 'male') ||
        (room.identity === 'women' && g === 'female') ||
        (room.identity === 'lgbtq' && (user.lgbtq || g === 'nonbinary'));
      if (!ok) {
        throw forbidden(g === 'undisclosed' && room.identity !== 'lgbtq' ? 'Set your self-declared identity in Settings to join this room' : 'This room is for people who self-identify for it', {
          code: 'IDENTITY_MISMATCH',
        });
      }
    }
    if (room.adult) {
      if (user.kind === 'guest' && !cfg.guestsCanJoinAdult) throw forbidden('Sign in with phone or Google to join adult rooms', { code: 'SIGNUP_REQUIRED' });
      const need = cfg.requireStrictForAdult ? 'strict' : cfg.adultMinAgeLevel;
      if (AGE_RANK[user.ageLevel || 'declared'] < AGE_RANK[need]) {
        throw forbidden(need === 'strict' ? 'Stricter age verification is required for this room' : 'Verify your phone or Google account to join adult rooms', { code: 'AGE_LEVEL_TOO_LOW', need });
      }
    }
  }

  async join(socketUser, { roomId, inviteCode }) {
    const uid = String(socketUser._id || socketUser.id);
    // Entitlement attributes (gender / age level) can change mid-session, so read them fresh.
    const fresh = await User.findById(uid).select('kind role gender lgbtq ageLevel').lean();
    if (!fresh) throw forbidden('Account not found');
    const user = { ...socketUser, ...fresh, id: uid };
    const cfg = (await this.settings.get()).rooms;
    await this.limiter.assertWindow('room-join', uid, { limit: (await this.settings.get()).limits.roomJoinPerMin, windowMs: 60_000 }, 'Joining rooms too quickly');
    const room = inviteCode ? await Room.findOne({ inviteCode: String(inviteCode).toUpperCase() }) : await Room.findById(roomId).catch(() => null);
    if (!room) throw notFound('Room not found');
    const rid = String(room._id);
    if (room.visibility === 'private' && !inviteCode && room.ownerId !== uid && !(await this.redis.sismember(K.roomMemberOf(rid), uid))) {
      throw forbidden('This room is private. Use an invite code.', { code: 'PRIVATE_ROOM' });
    }
    this.#assertEntitled(room, user, cfg);
    if (await this.redis.exists(`room:${rid}:kick:${uid}`)) throw forbidden('You were removed from this room recently', { code: 'KICKED' });

    const already = await this.redis.sismember(K.roomMemberOf(rid), uid);
    if (!already && (await this.redis.scard(K.roomMemberOf(rid))) >= room.maxMembers) throw new AppError(409, 'ROOM_FULL', 'This room is full');

    const mid = this.memberId(rid, uid);
    const ident = this.identity(rid, uid);
    const role = this.roleOf(room, user);
    const member = { memberId: mid, alias: ident.alias, avatar: ident.avatar, role };
    if (!already) {
      await this.redis.multi().hset(K.roomMembers(rid), mid, uid).sadd(K.roomMemberOf(rid), uid).sadd(K.userRooms(uid), rid).exec();
    }
    await this.redis.zrem(ROOM_DISC_KEY, uid);
    this.emit.joinUserSockets(uid, rid);
    const count = await this.redis.scard(K.roomMemberOf(rid));
    if (!already) this.fanout.pushPresence(rid, 'join', member, count);
    Room.updateOne({ _id: rid }, { $set: { lastActiveAt: new Date() } }).catch(() => {});
    return this.#snapshot(room, user, member, count);
  }

  async #snapshot(room, user, me, count) {
    const rid = String(room._id);
    const mm = await this.redis.hgetall(K.roomMembers(rid));
    const members = Object.entries(mm).map(([memberId, userId]) => ({ memberId, userId }));
    const blocked = new Set((await User.findById(user._id || user.id).select('blocked').lean())?.blocked || []);
    const list = members.map(({ memberId, userId }) => {
      const id = this.identity(rid, userId);
      return { memberId, alias: id.alias, avatar: id.avatar, role: this.roleOf(room, { id: userId, role: 'user' }) };
    });
    const recent = (await this.events.recent('room', rid, 50)).map((e) => this.#wire(rid, e));
    const slow = await this.redis.ttl(K.roomSlow(rid, String(user._id || user.id)));
    return {
      room: this.#pub(room, count),
      me,
      members: list,
      recent,
      seq: recent.length ? recent[recent.length - 1].seq : 0,
      blockedMemberIds: members.filter((m) => blocked.has(m.userId)).map((m) => m.memberId),
      slowRemainingSec: Math.max(0, slow),
    };
  }

  #wire(roomId, e) {
    const { from: _from, ...rest } = e; // internal userId never leaves the server
    return { roomId, ...rest };
  }

  async leave(userId, roomId, { silent = false } = {}) {
    const mid = this.memberId(roomId, userId);
    const removed = await this.redis.multi().hdel(K.roomMembers(roomId), mid).srem(K.roomMemberOf(roomId), userId).srem(K.userRooms(userId), roomId).exec();
    this.emit.leaveUserSockets(userId, roomId);
    if (!silent && removed[0][1]) {
      const count = await this.redis.scard(K.roomMemberOf(roomId));
      this.fanout.pushPresence(roomId, 'leave', { memberId: mid }, count);
    }
  }

  async resume(user, { roomId, lastSeq }) {
    const uid = String(user._id || user.id);
    if (!(await this.redis.sismember(K.roomMemberOf(roomId), uid))) return { state: 'not_member' };
    await this.redis.zrem(ROOM_DISC_KEY, uid);
    this.emit.joinUserSockets(uid, roomId);
    const events = (await this.events.after('room', roomId, lastSeq)).map((e) => this.#wire(roomId, e));
    const count = await this.redis.scard(K.roomMemberOf(roomId));
    return { state: 'member', events, count };
  }

  // ---------------------------------------------------------------- messaging

  async #member(roomId, user) {
    const uid = String(user._id || user.id);
    if (!(await this.redis.sismember(K.roomMemberOf(roomId), uid))) throw forbidden('Join the room first', { code: 'NOT_IN_ROOM' });
    const cfg = await this.#cfg(roomId);
    if (cfg.hidden) throw forbidden('This room is unavailable', { code: 'ROOM_HIDDEN' });
    const role = cfg.ownerId === uid ? 'owner' : cfg.moderators.includes(uid) || user.role === 'admin' ? 'moderator' : 'member';
    return { uid, cfg, role };
  }

  async send(user, { roomId, clientMsgId, kind = 'text', text, imageId }) {
    const { uid, cfg, role } = await this.#member(roomId, user);
    const idem = await this.events.beginIdempotent(uid, clientMsgId);
    if (!idem.first) return { ...(idem.ack || {}), duplicate: true };
    try {
      const muteTtl = await this.redis.ttl(K.roomMute(roomId, uid));
      if (muteTtl > 0) throw forbidden('You are muted in this room', { code: 'MUTED', retryAfterSec: muteTtl });
      const s = await this.settings.get();
      await this.limiter.assertBucket('msg', uid, { capacity: s.limits.msgBurst, refillPerSec: s.limits.msgRefillPerSec }, 'You are sending too fast');
      await this.limiter.assertWindow('msg10', uid, { limit: s.limits.msgPer10s, windowMs: 10_000 }, 'You are sending too fast');
      if (cfg.slowModeSec > 0 && role === 'member') {
        const ok = await this.redis.set(K.roomSlow(roomId, uid), '1', 'EX', cfg.slowModeSec, 'NX');
        if (!ok) throw tooMany('Slow mode is on', Math.max(1, await this.redis.ttl(K.roomSlow(roomId, uid))));
      }
      let body = '';
      if (kind === 'text') {
        body = await this.moderation.screenText(user, text, {
          scope: 'room',
          roomId,
          roomFilters: cfg.filters,
          evidenceRef: { kind: 'room', roomId },
          sender: { id: uid, ipHash: user.ipHash, deviceHash: user.deviceHash },
        });
      }
      const ident = this.identity(roomId, uid);
      const mid = this.memberId(roomId, uid);
      const ev = await this.events.append('room', roomId, { from: uid, memberId: mid, alias: ident.alias, avatar: ident.avatar, role, kind, text: body, imageId, clientMsgId });
      await this.fanout.pushMessage(roomId, this.#wire(roomId, ev));
      const ack = { ok: true, seq: ev.seq, ts: ev.ts, text: body };
      await this.events.completeIdempotent(uid, clientMsgId, ack);
      return ack;
    } catch (e) {
      await this.events.abortIdempotent(uid, clientMsgId);
      throw e;
    }
  }

  async typing(user, { roomId, on }) {
    const { uid } = await this.#member(roomId, user);
    if (!(await this.limiter.bucket('rtyping', uid, { capacity: 4, refillPerSec: 1 })).allowed) return;
    if ((await this.redis.scard(K.roomMemberOf(roomId))) > 30) return; // typing noise is not worth the fanout in busy rooms
    this.emit.toRoom(roomId, 'room:typing', { roomId, memberId: this.memberId(roomId, uid), on: !!on });
  }

  async system(roomId, text, extra = {}) {
    const ev = await this.events.append('room', roomId, { from: 'system', kind: 'system', text, ...extra });
    await this.fanout.pushMessage(roomId, this.#wire(roomId, ev));
  }

  /** Resolve an opaque memberId back to the real user (server side only: reports + moderation). */
  async resolveMember(roomId, memberId) {
    return this.redis.hget(K.roomMembers(roomId), memberId);
  }

  async isMember(roomId, userId) {
    return (await this.redis.sismember(K.roomMemberOf(roomId), userId)) === 1;
  }

  // ---------------------------------------------------------------- moderation tools

  async moderate(user, { roomId, action, memberId, minutes, seconds, rules }) {
    const { uid, cfg, role } = await this.#member(roomId, user);
    if (role === 'member') throw forbidden('Moderators only', { code: 'NOT_MODERATOR' });
    const audit = (extra) => this.audit.log({ actorId: uid, actorType: 'user', action: `room.mod.${action}`, targetType: 'room', targetId: roomId, meta: extra });

    if (action === 'slow') {
      await Room.updateOne({ _id: roomId }, { $set: { slowModeSec: seconds ?? 0 } });
      await this.#invalidate(roomId);
      await this.system(roomId, seconds ? `Slow mode enabled: one message every ${seconds}s` : 'Slow mode disabled', { code: 'slow', seconds: seconds ?? 0 });
      await audit({ seconds });
      return { slowModeSec: seconds ?? 0 };
    }
    if (action === 'rules') {
      const clean = sanitizeText(rules || '');
      await Room.updateOne({ _id: roomId }, { $set: { rules: clean } });
      await this.#invalidate(roomId);
      await this.system(roomId, 'Room rules were updated', { code: 'rules' });
      this.emit.toRoom(roomId, 'room:rules', { roomId, rules: clean });
      await audit({});
      return { rules: clean };
    }

    if (!memberId) throw badRequest('memberId required');
    const targetUid = await this.resolveMember(roomId, memberId);
    if (!targetUid) throw notFound('Member not found');
    if (targetUid === uid) throw badRequest('You cannot do that to yourself');
    const targetUser = (await User.findById(targetUid).select('role').lean()) || {};
    const targetRole = cfg.ownerId === targetUid ? 'owner' : cfg.moderators.includes(targetUid) || targetUser.role === 'admin' ? 'moderator' : 'member';

    if (action === 'promote' || action === 'demote') {
      if (role !== 'owner') throw forbidden('Only the owner can change moderators', { code: 'NOT_OWNER' });
      await Room.updateOne({ _id: roomId }, action === 'promote' ? { $addToSet: { moderators: targetUid } } : { $pull: { moderators: targetUid } });
      await this.#invalidate(roomId);
      this.emit.toRoom(roomId, 'room:role', { roomId, memberId, role: action === 'promote' ? 'moderator' : 'member' });
      await audit({ memberId });
      return {};
    }
    const rank = { member: 0, moderator: 1, owner: 2 };
    if (rank[targetRole] >= rank[role]) throw forbidden('You cannot moderate someone of equal or higher rank', { code: 'RANK' });

    if (action === 'kick') {
      await this.redis.set(`room:${roomId}:kick:${targetUid}`, '1', 'EX', KICK_LOCKOUT_SEC);
      this.emit.toUser(targetUid, 'room:kicked', { roomId });
      await this.leave(targetUid, roomId);
      await this.system(roomId, 'A member was removed by a moderator', { code: 'kick' });
    } else if (action === 'mute') {
      const m = minutes ?? 10;
      await this.redis.set(K.roomMute(roomId, targetUid), '1', 'EX', m * 60);
      this.emit.toUser(targetUid, 'room:muted', { roomId, minutes: m });
      await this.system(roomId, `A member was muted for ${m} min`, { code: 'mute' });
    } else if (action === 'unmute') {
      await this.redis.del(K.roomMute(roomId, targetUid));
      this.emit.toUser(targetUid, 'room:unmuted', { roomId });
    }
    await audit({ memberId, minutes });
    return {};
  }

  // ---------------------------------------------------------------- connection lifecycle

  /** New socket for a user that is already in rooms: attach it to the socket.io rooms. */
  async onSocketConnected(socket, user) {
    const uid = user.id;
    await this.redis.zrem(ROOM_DISC_KEY, uid);
    const ids = await this.redis.smembers(K.userRooms(uid));
    for (const rid of ids) socket.join(`r:${rid}`);
    if (ids.length) socket.emit('room:rejoined', { roomIds: ids });
  }

  async onUserOffline(userId, graceMs = 15_000) {
    if ((await this.redis.scard(K.userRooms(userId))) > 0) await this.redis.zadd(ROOM_DISC_KEY, Date.now() + graceMs, userId);
  }

  /** Sweeper: drop users that stayed offline past the grace period from their rooms. */
  async processDisconnects(presence) {
    const due = await this.redis.zClaimDue(ROOM_DISC_KEY, Date.now(), 200);
    for (const uid of due) {
      if (await presence.isOnline(uid)) continue;
      for (const rid of await this.redis.smembers(K.userRooms(uid))) await this.leave(uid, rid).catch((e) => logger.warn({ err: e.message }, 'room leave failed'));
    }
    return due.length;
  }

  async removeEverywhere(userId) {
    for (const rid of await this.redis.smembers(K.userRooms(userId))) await this.leave(userId, rid);
  }

  /** Admin / report pipeline: hide a room and eject everyone. */
  async hide(roomId, reason) {
    await Room.updateOne({ _id: roomId }, { $set: { hidden: true } });
    await this.#invalidate(roomId);
    this.emit.toRoom(roomId, 'room:closed', { roomId, reason });
    await this.#purge(roomId);
  }

}
