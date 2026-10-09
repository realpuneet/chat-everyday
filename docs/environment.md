# Environment reference

All backend configuration comes from environment variables (validated with Zod at boot; the process refuses to start on invalid values). Frontend variables are `VITE_*` and are baked in at build time (see `frontend/.env.example`).

**Dry-run rule:** every external service (Google, OTP/SMS, storage, moderation, hash-match, age verification, IP risk) runs in a safe local DRY-RUN mode when its credentials are blank. `GET /readyz` is unaffected; the boot log prints a `dryRun` object listing which integrations are simulated. **Never launch with dry-run integrations you rely on for safety** (see the launch checklist in the README).

## Core

| Variable | Default | Prod | Notes |
|---|---|---|---|
| `NODE_ENV` | `development` | `production` | `production` makes secrets mandatory, cookies `Secure`, hides dev OTP codes. |
| `PORT` | `4000` | | HTTP + WebSocket port. |
| `INSTANCE_ID` | random | | Shown in logs and socket metadata; set per replica. |
| `LOG_LEVEL` | `info` | | pino level. Logs redact phone, email, IP, tokens, passwords, OTPs. |
| `PUBLIC_URL` | `http://localhost:4000` | ✅ | Used to build local signed image URLs. |
| `CORS_ORIGINS` | `http://localhost:5173` | ✅ | Comma separated allow-list. Anything else gets no CORS headers. |
| `TRUST_PROXY` | `0` | ✅ | Number of reverse proxies in front (nginx / load balancer = `1`). Needed for correct client IPs (rate limits, bans). |

## Data stores

| Variable | Default | Notes |
|---|---|---|
| `MONGO_URI` | `mongodb://127.0.0.1:27017/chat_everyday` | Use a replica set in production (`?replicaSet=rs0`). Only users, reports, bans, settings, rooms, savedChats, auditLogs, takedowns live here. |
| `REDIS_URL` | `redis://127.0.0.1:6379` | **`maxmemory-policy noeviction`** is required: matching queues, rate limits, BullMQ and refresh families live here. Enable AOF. |

## Secrets (required in production)

Generate with `openssl rand -hex 32` (`ENCRYPTION_KEY`: `openssl rand -base64 32`). In development/test deterministic per-purpose dev secrets are derived; **they are public and must never be used in production**.

| Variable | Notes |
|---|---|
| `JWT_ACCESS_SECRET` | Signs registered-user access tokens (15 min). |
| `JWT_GUEST_SECRET` | Signs guest session tokens. A token only verifies with the secret that matches its `knd` claim. |
| `PEPPER` | HMAC key for hashing IPs, device ids, phone numbers, emails (ban lists). **Rotating it invalidates existing IP/device/identity bans.** |
| `URL_SIGNING_SECRET` | Signs local image delivery links. |
| `ENCRYPTION_KEY` | base64 of exactly 32 bytes. AES-256-GCM master key for saved chats (per-document keys are HKDF-derived). Losing it makes saved chats unreadable; rotating needs a re-encryption job. |

## Sessions & cookies

| Variable | Default | Notes |
|---|---|---|
| `ACCESS_TTL_SEC` | `900` | Access token lifetime (registered). Kept in memory by the SPA. |
| `GUEST_TTL_SEC` | `21600` | Guest token lifetime; extendable via `/auth/guest/refresh`. |
| `GUEST_MAX_SESSION_SEC` | `86400` | Hard cap of a guest session; guests are deleted afterwards. |
| `REFRESH_TTL_SEC` | `2592000` | Rotating refresh cookie lifetime. |
| `COOKIE_SECURE` | auto | Blank => `true` in production. |
| `COOKIE_SAMESITE` | `lax` | `none` needs HTTPS + `COOKIE_SECURE`. Refresh also requires the custom `x-session-slot` header (CSRF defence). |

## Auth providers

| Variable | Default | Dry-run behaviour |
|---|---|---|
| `ADMIN_EMAILS` | empty | Comma list. Promoted to admin **only** through Google sign-in with `email_verified`. Use `npm run seed:admin` otherwise. |
| `GOOGLE_CLIENT_ID` | blank | Blank => dry-run (non-production): token `dryrun:<email>`. |
| `OTP_PROVIDER` | `console` | `console` logs the code and returns it as `devCode` (never in production). `twilio`, `msg91`, `firebase` are real. |
| `OTP_ALLOWED_COUNTRY_CODES` | `+91` | Initial allow-list (also editable in admin settings). Prevents SMS-pumping to premium destinations. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | blank | Needed for `OTP_PROVIDER=twilio`. |
| `MSG91_AUTH_KEY`, `MSG91_TEMPLATE_ID` | blank | Needed for `OTP_PROVIDER=msg91`. India requires DLT registration of sender id + template. |
| `FIREBASE_PROJECT_ID` | blank | `OTP_PROVIDER=firebase`: the client does phone auth, the server verifies the ID token. |

## Image storage

| Variable | Default | Notes |
|---|---|---|
| `STORAGE_PROVIDER` | `local` | `local` (dry-run, disk), `s3`, `imagekit`. Missing credentials fall back to local with a warning. |
| `LOCAL_STORAGE_DIR` | `./.data/uploads` | Dry-run only. |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` | | S3-compatible: AWS S3, Cloudflare R2, MinIO, Backblaze. **Bucket must be private.** Add a lifecycle rule expiring `tmp/` and `proc/` after 1-2 days as a backstop. |
| `IMAGEKIT_PUBLIC_KEY`, `IMAGEKIT_PRIVATE_KEY`, `IMAGEKIT_URL_ENDPOINT` | blank | Optional provider. Files are uploaded private and served with signed URLs. |

> Read the storage / CDN provider's **adult-content policy** before enabling it. Many providers prohibit hosting adult material; some prohibit it unless the account is configured for it. This is a launch blocker (README checklist).

## Moderation hooks

| Variable | Default | Contract |
|---|---|---|
| `MODERATION_PROVIDER` | `dryrun` | `http`: `POST MODERATION_HTTP_URL` with image bytes -> `{nsfw:0..1, minorRisk?:0..1}`. |
| `MODERATION_HTTP_URL`, `MODERATION_HTTP_KEY` | blank | |
| `HASHMATCH_PROVIDER` | `dryrun` | `http`: `POST` `{sha256, phash}` -> `{match:boolean, source?}`. A **local blocklist** (admin takedowns) is always checked as well. |
| `HASHMATCH_HTTP_URL`, `HASHMATCH_HTTP_KEY` | blank | |
| `AGE_VERIFY_PROVIDER` | `dryrun` | `http`: `POST {url}/sessions` -> `{sessionId,url}`, signed webhook `/api/age/webhook`. |
| `AGE_VERIFY_HTTP_URL`, `AGE_VERIFY_HTTP_KEY` | blank | |
| `IP_RISK_PROVIDER` | `dryrun` | `http`: `GET {url}?ip=` -> `{vpn?,datacenter?|hosting?}` feeding the ban-evasion risk score. |
| `IP_RISK_HTTP_URL`, `IP_RISK_HTTP_KEY` | blank | |

## Video (WebRTC)

| Variable | Default | Notes |
|---|---|---|
| `STUN_URLS` | Google STUN | Comma list. |
| `TURN_URLS` | empty | e.g. `turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349`. Empty => STUN only (some networks will fail to connect). |
| `TURN_SECRET` | blank | Must equal coturn `static-auth-secret`. Credentials are time-limited (`use-auth-secret`). |
| `TURN_TTL_SEC` | `3600` | |

## Process behaviour

| Variable | Default | Notes |
|---|---|---|
| `RUN_WORKER_INLINE` | `true` | Run the BullMQ image worker inside the API process. Set `false` and run `npm run start:worker` (compose does this). |
| `DISABLE_SWEEPER` | `false` | Background maintenance loops (fallback ticks, disconnect grace, stale queues, presence, expiry). Disable only in tests. |
| `DEMO_MODE` | `false` | Demo/staging switch for a deployed `NODE_ENV=production` instance: the dry-run OTP code is returned in the response, Google accepts `dryrun:<email>`, instant age-verification works, and `ENCRYPTION_KEY` may be any string. **Never enable for real users** (anyone could log in as any email). |
| `RATE_LIMIT_MULTIPLIER` | `1` | Multiplies per-IP HTTP limits. **Only for load tests / CI.** |

## Runtime settings (admin dashboard, stored in MongoDB)

Limits (message burst/refill/10s window, matches/min, reports/hour, image quotas), matching (fallback 8 s, cooldown, max wait, disconnect grace), images (max bytes/dimensions, view timer, NSFW thresholds, retention), moderation (auto-hide N, evidence N, link/PII filters, bad words, ban ladder), rooms (guest creation, adult age level, fan-out batching), saved chats (retention days), auth toggles. All validated by a strict schema (`backend/src/services/settingsService.js`). **Hard content-policy blocks and the 18+ floor are deliberately not settings.**
