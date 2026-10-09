import Redis from 'ioredis';
import { config } from './env.js';
import { logger } from './logger.js';
import { luaScripts } from './lua.js';

/** Create an ioredis client with all Lua commands registered (EVALSHA with auto-load). */
export function createRedis(url = config.REDIS_URL, opts = {}) {
  const client = new Redis(url, { maxRetriesPerRequest: 3, enableReadyCheck: true, lazyConnect: false, ...opts });
  client.on('error', (e) => logger.error({ err: e.message }, 'redis error'));
  for (const [name, def] of Object.entries(luaScripts)) {
    client.defineCommand(name, { numberOfKeys: def.keys, lua: def.lua });
  }
  return client;
}

/** BullMQ needs maxRetriesPerRequest=null. */
export const createBullConnection = (url = config.REDIS_URL) =>
  new Redis(url, { maxRetriesPerRequest: null, enableReadyCheck: false });

// Central key schema. Matching keys share the {mm} hash tag so every multi-key Lua
// script touches a single cluster slot (cluster-safe; see docs/scaling.md).
export const K = {
  mm: '{mm}:',
  ticket: (u) => `{mm}:t:${u}`,
  qGeneral: '{mm}:q:g',
  qTag: (t) => `{mm}:q:t:${t}`,
  qFallback: '{mm}:q:fb',
  tags: '{mm}:tags',
  blocked: (u) => `{mm}:blk:${u}`,
  cooldown: (a, b) => (a < b ? `{mm}:cd:${a}:${b}` : `{mm}:cd:${b}:${a}`),
  userChat: (u) => `{mm}:uc:${u}`,
  chat: (c) => `{mm}:c:${c}`,
  chatParticipants: (c) => `{mm}:cp:${c}`,
  disc: '{mm}:disc',

  userSockets: (u) => `user:${u}:sockets`,
  socketMeta: (s) => `sock:${s}`,
  onlineUsers: 'online:users',
  userRooms: (u) => `user:${u}:rooms`,

  chatEvents: (c) => `chat:${c}:ev`,
  chatSeq: (c) => `chat:${c}:seq`,
  roomEvents: (r) => `room:${r}:ev`,
  roomSeq: (r) => `room:${r}:seq`,
  roomMembers: (r) => `room:${r}:members`, // memberId -> userId
  roomMemberOf: (r) => `room:${r}:userset`, // set of userIds
  roomMute: (r, u) => `room:${r}:mute:${u}`,
  roomSlow: (r, u) => `room:${r}:slow:${u}`,
  roomSlowCfg: (r) => `room:${r}:slowcfg`,
  idem: (u, id) => `idem:${u}:${id}`,
  rl: (name, id) => `rl:${name}:${id}`,

  ban: (type, hash) => `ban:${type}:${hash}`,
  deviceUsers: (d) => `dev:${d}:users`,
  churn: (kind, h) => `churn:${kind}:${h}`,

  otp: (phoneHash) => `otp:${phoneHash}`,
  otpCooldown: (phoneHash) => `otpcd:${phoneHash}`,
  refreshFamily: (f) => `rtf:${f}`,
  userFamilies: (u) => `rtu:${u}`,

  image: (id) => `img:${id}`,
  imageExpiry: 'img:expiry',
  imageViewed: (id, u) => `img:${id}:v:${u}`,
  badHashes: 'img:badhashes',
  imagePending: 'img:pending',

  settings: 'settings:cache',
  sweeperLock: 'lock:sweeper',
  strikes: (u) => `strikes:${u}`,
  reportersFor: (u) => `reporters:${u}`,
};
