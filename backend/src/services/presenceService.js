import { K } from '../config/redis.js';

const SOCKET_TTL_SEC = 90;

/**
 * Presence is derived from socket count: a user is online while `user:{id}:sockets` is non-empty,
 * so closing one device/tab never takes the user offline while another is still connected.
 */
export class PresenceService {
  constructor({ redis, instanceId }) {
    this.redis = redis;
    this.instanceId = instanceId;
  }

  /** @returns {{count:number, wasOffline:boolean}} */
  async addSocket(userId, socketId, deviceId) {
    const [count, wasOffline] = await this.redis.sockAdd(K.userSockets(userId), K.onlineUsers, socketId, userId);
    await this.redis
      .multi()
      .hset(K.socketMeta(socketId), { uid: userId, did: deviceId || '', inst: this.instanceId, at: Date.now() })
      .expire(K.socketMeta(socketId), SOCKET_TTL_SEC)
      .exec();
    return { count, wasOffline: wasOffline === 1 };
  }

  /** @returns {number} remaining sockets for the user */
  async removeSocket(userId, socketId) {
    const remaining = await this.redis.sockRemove(K.userSockets(userId), K.onlineUsers, socketId, userId);
    await this.redis.del(K.socketMeta(socketId));
    return remaining;
  }

  async heartbeat(socketId) {
    await this.redis.expire(K.socketMeta(socketId), SOCKET_TTL_SEC);
  }

  onlineCount() {
    return this.redis.scard(K.onlineUsers);
  }

  async isOnline(userId) {
    return (await this.redis.scard(K.userSockets(userId))) > 0;
  }

  async devicesOf(userId) {
    const ids = await this.redis.smembers(K.userSockets(userId));
    if (!ids.length) return [];
    const p = this.redis.pipeline();
    ids.forEach((id) => p.hgetall(K.socketMeta(id)));
    const res = await p.exec();
    return ids.map((id, i) => ({ socketId: id, ...(res[i][1] || {}) }));
  }

  /**
   * Drop socket ids whose heartbeat key expired (e.g. the owning instance crashed).
   * @returns {string[]} users that became offline because of the cleanup
   */
  async sweepStale(batch = 500) {
    const wentOffline = [];
    let cursor = '0';
    let scanned = 0;
    do {
      const [next, users] = await this.redis.sscan(K.onlineUsers, cursor, 'COUNT', 200);
      cursor = next;
      for (const uid of users) {
        const sockets = await this.redis.smembers(K.userSockets(uid));
        const p = this.redis.pipeline();
        sockets.forEach((s) => p.exists(K.socketMeta(s)));
        const alive = (await p.exec()).map((r) => r[1] === 1);
        let remaining = sockets.length;
        for (let i = 0; i < sockets.length; i++) {
          if (!alive[i]) remaining = await this.redis.sockRemove(K.userSockets(uid), K.onlineUsers, sockets[i], uid);
        }
        if (sockets.length && remaining === 0) wentOffline.push(uid);
        if (!sockets.length) {
          await this.redis.srem(K.onlineUsers, uid);
          wentOffline.push(uid);
        }
      }
      scanned += users.length;
    } while (cursor !== '0' && scanned < batch);
    return wentOffline;
  }
}
