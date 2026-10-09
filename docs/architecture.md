# Architecture

```
                         ┌──────────────┐        ┌────────────────────────────┐
 Browser / PWA ──HTTPS──▶│ nginx (web)  │──/api─▶│ API replicas (Express +     │──▶ MongoDB (replica set)
  React SPA              │ static + CSP │ /socket│ Socket.io, stateless)       │
  Socket.io (WebSocket)  └──────────────┘  .io ─▶│  • auth, rooms, reports…    │──▶ Redis (noeviction, AOF)
                                                  │  • sweeper (claim-based)    │      ├ matching queues (Lua)
 Browser ◀── WebRTC (P2P / TURN) ──▶ Browser      └──────────┬─────────────────┘      ├ presence / rate limits
                         ▲                                   │ BullMQ                 ├ ring buffers / idempotency
                   coturn (TURN)                    ┌────────▼────────┐               └ Socket.io adapter pub/sub
                                                    │ worker replicas │──▶ Object storage (private S3/R2/MinIO/ImageKit)
                                                    │ image pipeline  │──▶ moderation / hash-match hooks
                                                    └─────────────────┘
```

* **Stateless API.** All shared state is in Redis/Mongo, so replicas scale horizontally; Socket.io uses the Redis adapter (WebSocket transport only), so a message sent through instance A reaches a socket on instance B.
* **Layers:** routes → thin controllers → services (all logic) → models/integrations. Services never import each other: `services/index.js` is the single composition root. Every HTTP input and every socket payload is validated with Zod; errors are typed (`AppError`) and rendered by one error handler / one socket ack path.
* **Socket event contract** (each handler: token-authenticated connection, schema validation, per-socket token bucket, ack `{ok,...}` or `{ok:false,error}`):

| Event (client → server) | Purpose |
|---|---|
| `match:start` / `match:next` / `match:leave` | join queue (tags, language, gender preference) / skip / leave |
| `chat:send` `{chatId, clientMsgId, kind, text\|imageId}` | idempotent send (`clientMsgId` de-dupes retries; **identical text is allowed**) |
| `chat:typing`, `chat:resume {chatId,lastSeq}` | typing indicator, replay missed events after reconnect |
| `block:add`, `report:create` | safety tools |
| `save:request` / `save:respond` / `save:stop` | two-sided saved-chat consent |
| `room:join` / `room:leave` / `room:resume` / `room:send` / `room:typing` / `room:mod` | rooms and moderator tools (kick, mute, slow, rules, promote) |
| `rtc:request` / `rtc:respond` / `rtc:signal` / `rtc:end` | consent-gated video signalling |
| `auth:refresh {token}`, `presence:ping` | swap token without reconnecting, heartbeat |

| Event (server → client) | Purpose |
|---|---|
| `session:ready`, `presence:online`, `server:shutdown`, `session:terminated` | lifecycle (`terminated` carries `banned` / `token_expired`) |
| `match:queued/fallback/timeout/cancelled/found`, `chat:msg/typing/partner_status/ended` | random chat |
| `room:msgs` (batched), `room:presence` (batched), `room:typing/rules/role/kicked/muted/unmuted/closed/rejoined` | rooms |
| `image:status/viewed/hidden`, `save:prompt/state`, `rtc:*`, `moderation:warning`, `admin:report/takedown` | images, saved chats, video, admin |

## Matching (the critical path)

* One Lua script per operation (`mmJoin`, `mmRetry`, `mmLeave`, `mmSweepStale`) executed with `EVALSHA`. A join enqueues the ticket and tries to pair **inside the same atomic script**; pairing removes both tickets from every queue, writes both `uc:` pointers, the chat hash, the participants set and the cooldown key in one step, so a user can never be matched with two people (proved by the 1000-concurrent-joiner integration test, which also checks every pair for mutual consistency).
* Candidate order: highest tag overlap, then longest waiting. Rules (mirrored in `matchingRules.js` and verified against the *same fixtures* in both implementations): not self, not blocked either way, not in cooldown, language compatible, gender preferences mutually satisfied, and either a shared tag **or** both sides in fallback mode.
* **Fallback:** tag users get a `fallbackAt = now + 8 s`. A claim-based sweeper (`ZRANGEBYSCORE` + `ZREM`, so exactly one instance wins each user) retries them against the general pool; users without tags are fallback-eligible immediately.
* **Cleanup:** leave/next/disconnect dequeue; a 10 s disconnect grace lets a reconnect keep its chat; stale tickets (default 2 min) are swept and the client gets `match:timeout`.

## Presence, reconnect, multi-device

`user:{id}:sockets` holds every live socket (per-socket heartbeat key, 90 s). A user is online while the set is non-empty. Messages go to the user room `u:{id}`, i.e. **all** of a user's devices; the sending socket's other devices get a `from:'me'` mirror. After a reconnect the client calls `chat:resume {chatId,lastSeq}` / `room:resume`; a page reload with no state asks the server for the active chat, so reload keeps the conversation.

## Images

`upload-url` (limits + scope authorisation) → upload (presigned PUT for S3-compatible, proxied otherwise) → `complete` → BullMQ job: magic-byte validation, re-encode (strips EXIF/GPS), dHash, known-bad hash hook, NSFW hook → `approved` / `blurred` / `rejected`. Receivers never get a URL in the chat event; they call `GET /images/:id/view`, which enforces membership and view-once/timer rules and returns a 30-60 s signed URL (`Cache-Control: no-store`) plus watermark data. The client renders into a `<canvas>`. Reports copy only the reported image to `evidence/`; everything else expires.

## Moderation pipeline

Text: sanitise → hard-block scanner (minor/CSAM/sextortion/threat/doxxing/trafficking) → length/link/PII/bad-word/flood filters → rate limits. Consequences: block message, audit, system report with evidence, strike ladder or immediate permanent ban + session end for minor/CSAM signals. Reports: evidence from the ring buffer, auto-block, auto-hide after N reports, short reviewable auto-suspension on many distinct reporters, admin queue (critical first). Bans hit account + device + IP (+ linked identities) with escalation 24 h → 7 d → permanent.
