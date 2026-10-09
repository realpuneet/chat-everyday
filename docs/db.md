# Data model

## MongoDB (only what must persist)

| Collection | Purpose | Key fields / indexes |
|---|---|---|
| `users` | guests (auto-expire) and registered users | `kind`, `role`, `nickname`, `avatar`, **self-declared** `gender`/`lgbtq`, `email` (unique, partial), `passwordHash` (argon2id), `googleSub` (unique, partial), `phoneHash` + `phoneLast4` (unique, partial; the number itself is never stored), `ageLevel` (`declared`<`phone`/`google`<`strict`), `blocked[]`, `ipHashes[]`/`deviceHashes[]` (HMAC), `strikes`, `banCount`, TOTP fields, `expiresAt` (guests, TTL) |
| `reports` | moderation queue + evidence | `reporterId`, `reportedId`, `context`, `category`, `priority`, `evidence.messages[]` (last N from the Redis ring buffer), `evidence.images[]` (copied keys, **only the reported image**), `status`, `action` |
| `bans` | enforcement records | `type` (`account`/`ip`/`device`/`identity`), `value` (userId or HMAC hash), `category`, `level`, `expiresAt` (null = permanent), `active`; mirrored into Redis for O(1) checks |
| `settings` | runtime configuration overrides | `key` (group), `value` |
| `rooms` | system, interest and custom rooms | `slug`, `type`, `identity` (self-declared gate), `visibility`, `inviteCode`, `adult`, `ownerId`, `moderators[]`, `rules`, `slowModeSec`, `filters`, `hidden` |
| `savedchats` | opt-in saved chats (two-sided consent) | one document per participant: `ownerId`, `chatId`, `messages[]` of `{ts,from,iv,tag,ct}` (AES-256-GCM, per-doc HKDF key, AAD = owner:chat), `expiresAt` (TTL, default 30 days) |
| `auditlogs` | immutable-style action log | `actorType`, `actorId`, `action`, `targetType/Id`, `severity`, `meta` |
| `takedowns` | public takedown / grievance intake | `category`, `requesterContact` (PII, admin only), `dueAt` (statutory target), `status` |

Chat **messages are never stored in MongoDB** except (a) inside `reports.evidence` and (b) encrypted in `savedchats` after both people consent. A test (`tests/integration/safety.flow.test.js`) scans every collection for a unique message marker to prove this.

> TTL / partial-filter indexes are created with `createIndexes()` but index creation never blocks boot (Mongo-compatible servers such as FerretDB lack them). The app therefore also enforces uniqueness in code and runs sweeper jobs to delete expired guests / saved chats.

## Redis (ephemeral + coordination)

| Key pattern | Type | TTL | Purpose |
|---|---|---|---|
| `{mm}:t:<uid>` | hash | ~2.5 min | matching ticket (tags, lang, gender, pref, enqueued, fallbackAt) |
| `{mm}:q:g`, `{mm}:q:t:<tag>`, `{mm}:q:fb`, `{mm}:tags` | zset/set | | general + per-tag waiting queues (score = enqueue time), fallback due times |
| `{mm}:uc:<uid>`, `{mm}:c:<chatId>`, `{mm}:cp:<chatId>`, `{mm}:chats` | string/hash/set | `cp` 2 h | active chat pointers, participants (report authorisation), active chat set |
| `{mm}:cd:<a>:<b>` | string | cooldown (default 10 min) | recently-matched pair exclusion |
| `{mm}:blk:<uid>` | set | | block list mirror used by the matcher |
| `{mm}:disc` | zset | | disconnect grace deadlines |
| `user:<id>:sockets`, `sock:<socketId>`, `online:users` | set/hash/set | socket 90 s heartbeat | multi-device presence (online while the set is non-empty) |
| `chat:<id>:ev`, `chat:<id>:seq`, `room:<id>:ev`, `room:<id>:seq` | list/string | 2 h (1 h after chat end) | event ring buffer (max 200) for resume + report evidence |
| `room:<id>:members`, `room:<id>:userset`, `user:<id>:rooms`, `room:<id>:mute:<u>`, `room:<id>:slow:<u>`, `room:<id>:cfg`, `room:disc` | hash/set/string | | room membership, mutes, slow mode, config cache, offline grace |
| `idem:<user>:<clientMsgId>` | string | 5 min | send idempotency (stores the ack) |
| `rl:<name>:<id>` | hash/zset | window | token buckets + sliding windows |
| `ban:<type>:<hash>` | string | ban duration | O(1) ban checks |
| `rtf:<family>`, `rtu:<user>` | hash/set | refresh TTL | rotating refresh token families (hash of current + previous for reuse detection) |
| `otp:*`, `otpcd:*`, `otpips:*`, `otplock:*`, `otpfail:*` | | 5 min - 1 h | OTP codes (HMAC only), cooldowns, anti-pumping counters |
| `img:<id>`, `img:expiry`, `img:pending`, `img:<id>:v:<user>`, `img:badhashes`(+`:phash`) | hash/zset/set | retention hours | image metadata, expiry queue, per-viewer view-once marker, local blocklist |
| `save:<chatId>`, `rtc:<chatId>` | hash | 4 h / 60 s | saved-chat consent state, video call state |
| `bull:image-process:*` | BullMQ | | image processing queue |

All `{mm}` keys share one Redis hash tag, so every multi-key Lua script touches a single cluster slot. See `docs/scaling.md`.
