# Scaling & operations

## What scales horizontally

* **API replicas** are stateless. Run N copies behind a load balancer with WebSocket support. Socket.io is configured with the **WebSocket transport only** (no HTTP long-polling), so **no sticky sessions are required**; the Redis adapter fans events out between replicas. Set `TRUST_PROXY=1` (or the real hop count) so rate limits/bans see client IPs.
* **Worker replicas** (`npm run start:worker`, `RUN_WORKER_INLINE=false` on the API) consume the BullMQ `image-process` queue. Scale on queue depth / latency. Workers publish `image:status` back to browsers through `@socket.io/redis-emitter`.
* **Sweeper jobs** run on every instance. Fast jobs (fallback ticks, disconnect grace) use *claim semantics* (`ZREM` returns 1 for exactly one caller) and need no coordination; slower global jobs take a short Redis lock.
* **Rolling deploys:** `SIGTERM` → `/readyz` returns 503 (LB drains), clients receive `server:shutdown` and reconnect with jitter, sockets close, Redis/Mongo connections end, exit 0 (tested). Give the orchestrator a `terminationGracePeriod` ≥ 20 s.

## Redis

* Mandatory `maxmemory-policy noeviction` + AOF (`appendonly yes`); it holds queues, limits and refresh families. Size: tickets + presence ≈ 1–2 KB per online user; ring buffers ≤ 200 events × 2 h per active chat/room.
* **Matching keys all use the `{mm}` hash tag**, so each Lua script touches one slot: safe on Redis Cluster, but the matcher then lives on a single shard. It is O(candidates scanned) per join (default scan 50/tag + 100 general). Measured locally: 1000 concurrent joiners resolve in well under a second on one Redis. If matching ever becomes the bottleneck, shard the matcher by region/language by changing the tag (`{mm:hi}`, `{mm:en}`), keeping every key of one match inside one tag.
* Everything else uses ordinary keys and is cluster friendly (user-scoped keys never need multi-key atomicity). Lua scripts that take several keys receive the declared first key and address the rest under the same tag, as documented in `config/lua.js`.
* Pub/sub load for the Socket.io adapter grows with fan-out. For very large rooms use room fan-out batching (`rooms.fanoutBatchMs`, default 50 ms) and consider the sharded adapter (`@socket.io/redis-adapter` sharded mode, Redis 7).

## MongoDB

Low volume by design (no chat storage). Indexes: unique partial on `users.email/googleSub/phoneHash`, TTL on guests and saved chats, `bans(type,value,active)`, `reports(status,priority,createdAt)`. Use a replica set; reads can stay on the primary. Ban checks never hit Mongo on the hot path (Redis mirror, warmed on boot and every 5 min).

## Backpressure & abuse controls

Payload caps (HTTP JSON 32 kB, socket 64 kB, images ≤ 5 MB configurable), per-socket event bucket (60 burst / 30 per s), per-user message bucket + 10 s window, per-IP HTTP window, slow-consumer disconnect (> 300 queued packets), per-room fan-out batching, slow-mode, typing indicators suppressed in rooms > 30 members, bounded ring buffers.

## Capacity planning (rules of thumb, **to be validated by your own load test**)

| Resource | Starting point |
|---|---|
| API replica | 2 vCPU / 2 GB, ~5–10k idle WebSockets (raise `ulimit -n`, `net.core.somaxconn`) |
| Redis | 2 vCPU / 4 GB for the first ~50k concurrent users (CPU bound by Lua + pub/sub) |
| Worker | 1 vCPU per ~15 images/s (sharp re-encode + hashing) |
| coturn | bandwidth bound: budget ~1–2 Mbps per relayed video call; most calls go P2P |

## Load testing

`loadtest/` contains a k6 script (HTTP + WebSocket matching/chat) and an Artillery socket scenario. **They were written but not executed in this environment** (see README "Verification status"). Run them against a staging copy with `RATE_LIMIT_MULTIPLIER` raised, watch: match latency p95, Redis CPU, event-loop lag, socket write buffers, Mongo ops, worker queue depth.

## Observability

Structured pino logs with request ids; PII redacted. `GET /api/admin/stats` gives live online/queue/rooms/report counts. Recommended alerts: `/readyz` failures, Redis memory > 70 %, BullMQ waiting jobs, critical reports open > 15 min, takedown overdue, OTP global circuit breaker audit events (`otp.global_limit` = possible SMS pumping).
