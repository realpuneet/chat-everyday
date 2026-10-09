// All Lua scripts. Registered as ioredis custom commands (EVALSHA, falling back to EVAL on NOSCRIPT).

const MATCH_COMMON = String.raw`
local P = '{mm}:'

local function split(s)
  local out = {}
  if s and s ~= '' then for w in string.gmatch(s, '[^,]+') do out[#out + 1] = w end end
  return out
end

local function remove_ticket(uid)
  local tk = P .. 't:' .. uid
  local tags = redis.call('HGET', tk, 'tags')
  redis.call('ZREM', P .. 'q:g', uid)
  redis.call('ZREM', P .. 'q:fb', uid)
  for _, tag in ipairs(split(tags)) do redis.call('ZREM', P .. 'q:t:' .. tag, uid) end
  redis.call('DEL', tk)
end

local function pair_key(a, b)
  if a < b then return P .. 'cd:' .. a .. ':' .. b end
  return P .. 'cd:' .. b .. ':' .. a
end

-- Evaluate whether candidate c may be matched with me. Mirrors src/services/matchingRules.js.
local function compatible(uid, me, cid, c, overlap, now)
  if c[1] == false or c[5] == false then return false end
  if redis.call('SISMEMBER', P .. 'blk:' .. uid, cid) == 1 then return false end
  if redis.call('SISMEMBER', P .. 'blk:' .. cid, uid) == 1 then return false end
  if redis.call('EXISTS', pair_key(uid, cid)) == 1 then return false end
  if me.lang ~= '' and c[2] ~= '' and me.lang ~= c[2] then return false end
  if me.pref ~= 'any' and me.pref ~= c[3] then return false end
  if c[4] ~= 'any' and c[4] ~= me.gender then return false end
  if overlap > 0 then return true end
  local cFallback = (c[1] == '') or (now >= tonumber(c[6]))
  return me.fallback and cFallback
end

-- ticket fields: tags, lang, gender, pref, at, fb  (HMGET order)
local function try_match(uid, now, chatId, cooldownSec, scan)
  local tk = P .. 't:' .. uid
  local t = redis.call('HMGET', tk, 'tags', 'lang', 'gender', 'pref', 'at', 'fb')
  if t[5] == false then return nil end
  local myTags = split(t[1])
  local me = {
    lang = t[2], gender = t[3], pref = t[4],
    fallback = (#myTags == 0) or (now >= tonumber(t[6])),
  }
  local seen, order, overlap = {}, {}, {}
  for _, tag in ipairs(myTags) do
    for _, cid in ipairs(redis.call('ZRANGE', P .. 'q:t:' .. tag, 0, scan - 1)) do
      if cid ~= uid then
        if not seen[cid] then seen[cid] = true; order[#order + 1] = cid; overlap[cid] = 0 end
        overlap[cid] = overlap[cid] + 1
      end
    end
  end
  if me.fallback then
    for _, cid in ipairs(redis.call('ZRANGE', P .. 'q:g', 0, scan * 2 - 1)) do
      if cid ~= uid and not seen[cid] then seen[cid] = true; order[#order + 1] = cid; overlap[cid] = 0 end
    end
  end
  local best, bestOv, bestAt = nil, -1, nil
  for _, cid in ipairs(order) do
    local c = redis.call('HMGET', P .. 't:' .. cid, 'tags', 'lang', 'gender', 'pref', 'at', 'fb')
    if c[5] == false then
      -- orphan queue entry (ticket expired): clean lazily
      redis.call('ZREM', P .. 'q:g', cid)
      for _, tag in ipairs(myTags) do redis.call('ZREM', P .. 'q:t:' .. tag, cid) end
    elseif compatible(uid, me, cid, c, overlap[cid], now) then
      local at = tonumber(c[5])
      if overlap[cid] > bestOv or (overlap[cid] == bestOv and at < bestAt) then
        best, bestOv, bestAt = cid, overlap[cid], at
      end
    end
  end
  if not best then return nil end

  local bt = redis.call('HGET', P .. 't:' .. best, 'tags')
  local shared = {}
  local bset = {}
  for _, tag in ipairs(split(bt)) do bset[tag] = true end
  for _, tag in ipairs(myTags) do if bset[tag] then shared[#shared + 1] = tag end end

  remove_ticket(uid)
  remove_ticket(best)
  redis.call('SET', P .. 'uc:' .. uid, chatId)
  redis.call('SET', P .. 'uc:' .. best, chatId)
  redis.call('HSET', P .. 'c:' .. chatId, 'a', uid, 'b', best, 'at', now, 'tags', table.concat(shared, ','))
  redis.call('SADD', P .. 'cp:' .. chatId, uid, best)
  redis.call('SADD', P .. 'chats', chatId)
  redis.call('EXPIRE', P .. 'cp:' .. chatId, 7200)
  if cooldownSec > 0 then redis.call('SET', pair_key(uid, best), '1', 'EX', cooldownSec) end
  return { 'matched', chatId, best, table.concat(shared, ',') }
end
`;

export const luaScripts = {
  // KEYS[1] = ticket key (declares the slot). ARGV: uid, tagsCsv, lang, gender, pref, now, fallbackMs,
  // chatId, cooldownSec, ticketTtlSec, scan
  mmJoin: {
    keys: 1,
    lua: `${MATCH_COMMON}
local uid = ARGV[1]
local now = tonumber(ARGV[6])
local existing = redis.call('GET', P .. 'uc:' .. uid)
if existing then
  local a = redis.call('HGET', P .. 'c:' .. existing, 'a')
  local b = redis.call('HGET', P .. 'c:' .. existing, 'b')
  local partner = (a == uid) and b or a
  return { 'in_chat', existing, partner or '' }
end
remove_ticket(uid)
local tags = split(ARGV[2])
local fbAt = now + tonumber(ARGV[7])
if #tags == 0 then fbAt = now end
redis.call('HSET', KEYS[1], 'uid', uid, 'tags', ARGV[2], 'lang', ARGV[3], 'gender', ARGV[4], 'pref', ARGV[5], 'at', now, 'fb', fbAt)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[10]))
redis.call('ZADD', P .. 'q:g', now, uid)
for _, tag in ipairs(tags) do
  redis.call('ZADD', P .. 'q:t:' .. tag, now, uid)
  redis.call('SADD', P .. 'tags', tag)
end
if #tags > 0 then redis.call('ZADD', P .. 'q:fb', fbAt, uid) end
local res = try_match(uid, now, ARGV[8], tonumber(ARGV[9]), tonumber(ARGV[11]))
if res then return res end
return { 'queued', tostring(fbAt) }
`,
  },
  // Re-attempt a match for an already-queued user (fallback tick). KEYS[1] = ticket key.
  // ARGV: uid, now, chatId, cooldownSec, scan
  mmRetry: {
    keys: 1,
    lua: `${MATCH_COMMON}
local res = try_match(ARGV[1], tonumber(ARGV[2]), ARGV[3], tonumber(ARGV[4]), tonumber(ARGV[5]))
if res then return res end
return { 'queued' }
`,
  },
  // KEYS[1] = ticket key. ARGV: uid
  mmLeave: {
    keys: 1,
    lua: `${MATCH_COMMON}
local uid = ARGV[1]
local cid = redis.call('GET', P .. 'uc:' .. uid)
local was = redis.call('EXISTS', KEYS[1])
remove_ticket(uid)
if cid then
  local a = redis.call('HGET', P .. 'c:' .. cid, 'a')
  local b = redis.call('HGET', P .. 'c:' .. cid, 'b')
  local partner = (a == uid) and b or a
  redis.call('DEL', P .. 'uc:' .. uid)
  if partner and redis.call('GET', P .. 'uc:' .. partner) == cid then redis.call('DEL', P .. 'uc:' .. partner) end
  redis.call('DEL', P .. 'c:' .. cid)
  redis.call('SREM', P .. 'chats', cid)
  return { 'left_chat', cid, partner or '' }
end
if was == 1 then return { 'dequeued' } end
return { 'noop' }
`,
  },
  // Remove entries older than maxWait from every queue. KEYS[1] = general queue. ARGV: cutoffMs
  mmSweepStale: {
    keys: 1,
    lua: `${MATCH_COMMON}
local cutoff = tonumber(ARGV[1])
local old = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', cutoff)
for _, uid in ipairs(old) do remove_ticket(uid) end
for _, tag in ipairs(redis.call('SMEMBERS', P .. 'tags')) do
  local qk = P .. 'q:t:' .. tag
  redis.call('ZREMRANGEBYSCORE', qk, '-inf', cutoff)
  if redis.call('EXISTS', qk) == 0 then redis.call('SREM', P .. 'tags', tag) end
end
return old
`,
  },
  // Claim due members of a ZSET (each claimed by exactly one caller). KEYS[1] = zset. ARGV: now, limit
  zClaimDue: {
    keys: 1,
    lua: `
local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
local claimed = {}
for _, m in ipairs(due) do
  if redis.call('ZREM', KEYS[1], m) == 1 then claimed[#claimed + 1] = m end
end
return claimed
`,
  },
  // Token bucket. KEYS[1] bucket. ARGV: capacity, refillPerSec, nowMs, cost  -> {allowed, tokensLeft, retryMs}
  tokenBucket: {
    keys: 1,
    lua: `
local cap = tonumber(ARGV[1]); local rate = tonumber(ARGV[2]); local now = tonumber(ARGV[3]); local cost = tonumber(ARGV[4])
local d = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(d[1]); local ts = tonumber(d[2])
if tokens == nil then tokens = cap; ts = now end
tokens = math.min(cap, tokens + (math.max(0, now - ts) / 1000) * rate)
local allowed = 0; local retry = 0
if tokens >= cost then tokens = tokens - cost; allowed = 1 else retry = math.ceil(((cost - tokens) / rate) * 1000) end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.ceil((cap / rate) * 1000) + 1000)
return { allowed, math.floor(tokens), retry }
`,
  },
  // Sliding window log. KEYS[1] zset. ARGV: limit, windowMs, nowMs, member -> {allowed, count, retryMs}
  slidingWindow: {
    keys: 1,
    lua: `
local limit = tonumber(ARGV[1]); local win = tonumber(ARGV[2]); local now = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - win)
local count = redis.call('ZCARD', KEYS[1])
if count < limit then
  redis.call('ZADD', KEYS[1], now, ARGV[4])
  redis.call('PEXPIRE', KEYS[1], win + 1000)
  return { 1, count + 1, 0 }
end
local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
local retry = win - (now - tonumber(oldest[2]))
return { 0, count, math.max(retry, 1) }
`,
  },
  // Remove socket from user's set; if set is empty, take user offline. Returns remaining count.
  // KEYS[1] user sockets set, KEYS[2] online set. ARGV: socketId, userId
  sockRemove: {
    keys: 2,
    lua: `
redis.call('SREM', KEYS[1], ARGV[1])
local n = redis.call('SCARD', KEYS[1])
if n == 0 then redis.call('SREM', KEYS[2], ARGV[2]) end
return n
`,
  },
  // Add socket; returns {count, wasOffline}. KEYS[1] user sockets set, KEYS[2] online set. ARGV: socketId, userId
  sockAdd: {
    keys: 2,
    lua: `
local before = redis.call('SCARD', KEYS[1])
redis.call('SADD', KEYS[1], ARGV[1])
redis.call('SADD', KEYS[2], ARGV[2])
return { before + 1, before == 0 and 1 or 0 }
`,
  },
};
