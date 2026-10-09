# TODO / Status

Updated at the end of every phase. See README "Verification status" for what was actually run.

## Decisions taken (sensible defaults, change freely)
- Matching keys all use the `{mm}` Redis hash tag so each Lua script touches a single cluster slot.
- Refresh cookies are namespaced per browser tab ("slot", `rt_<slot>`) so several accounts in one browser never clobber each other.
- Chat text lives only in a Redis ring buffer (TTL) for resume + report evidence. MongoDB never stores chats except opt-in saved chats and report evidence.
- DOB is validated server-side and then discarded; only `ageDeclaredAt` + `ageLevel` are stored (data minimisation).
- Image metadata lives in Redis (TTL) – there is no `images` collection. Extra Mongo collection: `takedowns` (public takedown requests).
- Admin bootstrap through `ADMIN_EMAILS` (those emails become `admin` on signup/login).
- Dev/test Mongo: FerretDB (Mongo wire-compatible) is used when no real mongod is available; it lacks TTL/partial indexes, so the app also enforces uniqueness/expiry in code (sweeper).

## P1 – core chat + matching  ✅
- [x] Config (zod env), logger with PII redaction, typed errors
- [x] Redis Lua matcher (atomic, cluster-safe keys), fallback ticks, stale sweeper, disconnect grace
- [x] Presence from socket-count, resume via event log, idempotent sends, token-bucket + sliding-window limiters
- [x] Hard content policy module + text filters (links/PII/bad-words/flood; repeated text allowed)
- [x] Unit tests (59) + integration tests (matching incl. 1000-concurrent race, socket flow)
- Known gaps: none blocking.

## P2 – auth + multi-device  ✅
- [x] Guest (signed short-lived token, capped session), email+password (argon2id), Google (server-verified ID token), phone OTP (console/Twilio/MSG91/Firebase adapters)
- [x] OTP abuse controls: country allow-list, resend cooldown, per-phone/IP/device caps, distinct-numbers-per-IP, global circuit breaker, attempt limits
- [x] Guest -> registered upgrade in place (same userId; live chat survives; socket `auth:refresh`)
- [x] Rotating httpOnly refresh cookie with reuse detection; per-tab cookie slots (multi account / multi tab safe)
- [x] Multi-device presence (`user:{id}:sockets`), stale-socket sweeper, mirrored messages to sender's other devices
- Known gaps: no email verification / password reset flow (documented in security.md); ADMIN_EMAILS only honoured for Google-verified emails or the seed script.
## P3 – group rooms  ⏳
## P4 – safety + admin  ⏳
## P5 – images  ⏳
## P6 – video + PWA polish  ⏳
## P7 – docs + CI + zip  ⏳
