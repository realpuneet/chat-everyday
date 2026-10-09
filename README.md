# Chat Everyday

Production-oriented, mobile-first **18+ anonymous random chat + anonymous group rooms**, built on the MERN stack.

* **Random 1-to-1** with interest tags, language / gender-preference filters, an 8 s tag-to-general fallback, Next / Leave, typing, reconnect + resume.
* **Anonymous rooms**: gender/identity rooms (Men, Women, LGBTQ+, Everyone), interest rooms, user-created public/private rooms with invite codes, per-room random alias + avatar, owner/moderator tools (kick, mute, slow-mode, rules).
* **Photos** for guests and members through a private-bucket pipeline (EXIF/GPS strip, perceptual hash, known-bad-hash + NSFW hooks), blur + tap-to-reveal, view-once/timer, canvas rendering, dynamic watermark.
* **Optional video** (WebRTC, Socket.io signalling, coturn TURN).
* **Safety**: report/block, evidence capture, bans (account + device + IP), escalation, auto-hide, admin dashboard, audit log, takedown queue.
* **Privacy**: chats are **not stored**; only report evidence and opt-in, two-sided-consent, AES-256-GCM encrypted "Save chat" for signed-up users.
* PWA, dark theme, 360 px → desktop, `100dvh` + safe-area layout, virtualized message lists.

> **Gender in rooms is self-declared and not verified.** The product never claims otherwise.
> **Screenshots cannot be reliably blocked on the web.** The UI and Terms say so (Android wrapper: `FLAG_SECURE`, see `docs/android-capacitor.md`).
> **Legal/compliance material in this repo is a starting checklist and placeholder text, not legal advice.** See `docs/legal.md`.

## Quick start

### Docker (everything: web, api, worker, Mongo replica set, Redis `noeviction`, coturn)

```bash
cp .env.example .env            # put real secrets in (openssl rand -hex 32 ...)
docker compose up --build       # http://localhost:8080
# optional local S3-compatible storage: docker compose --profile minio up
```

### Local development

```bash
# prerequisites: Node 20+, Redis 7, MongoDB 7 (a replica set is recommended but not required for dev)
cd backend  && cp .env.example .env && npm ci && npm run dev        # API + inline image worker on :4000
cd frontend && cp .env.example .env && npm ci && npm run dev        # Vite on :5173, proxies /api and /socket.io
# create an admin (or set ADMIN_EMAILS and sign in with a verified Google account)
cd backend && ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a long passphrase' ADMIN_2FA=1 npm run seed:admin
```

With every external credential blank the app runs fully in **dry-run mode**: Google sign-in accepts `dryrun:<email>`, OTP codes are printed/returned in dev, images live on local disk, moderation hooks approve everything (the local hash blocklist and text heuristics still apply).

| Integration | Blank/default behaviour | To go live |
|---|---|---|
| Google Sign-In | dry-run token `dryrun:<email>` (never in production) | `GOOGLE_CLIENT_ID` (+ `VITE_GOOGLE_CLIENT_ID`) |
| Phone OTP | `console` provider logs the code | `OTP_PROVIDER=twilio|msg91|firebase` + keys (India: DLT) |
| Image storage | local disk + signed local URLs | `STORAGE_PROVIDER=s3` (R2/S3/MinIO) or `imagekit` |
| NSFW classifier / hash-match / strict age verification / VPN risk | dry-run | `*_PROVIDER=http` + URL/key (contracts in `docs/environment.md`) |
| TURN | STUN only | `TURN_URLS` + `TURN_SECRET` (coturn service in compose) |

## Scripts

| Where | Command | What |
|---|---|---|
| backend | `npm test` | unit + integration tests (real Redis + Mongo; see "Verification status") |
| backend | `npm run check` | `node --check` on every file + eslint (`no-unused-vars`, `no-undef`) |
| backend | `node scripts/gen-openapi.mjs` | regenerate `docs/openapi.json` from the Zod validators |
| backend | `node scripts/loadtest.mjs --users 400 --seconds 25` | quick socket load generator |
| frontend | `npm run check` / `npm test` / `npm run build` | esbuild bundle + eslint / unit tests / production build |
| frontend | `npm run e2e` | Playwright browser smoke test (needs API on :4000 and `npm run preview`) |

## Repository layout

```
backend/src/{config,models,services,controllers,routes,validators,middlewares,sockets,jobs,integrations,utils}
backend/tests/{unit,integration,fixtures,helpers}      frontend/src/{app,pages,components,hooks,lib,styles}
docs/{architecture,db,environment,scaling,security,legal}.md, openapi.json, android-capacitor.md
docker-compose.yml  .github/workflows/ci.yml  loadtest/  TODO.md
```

Start with `docs/architecture.md` (event catalogue, matching design), then `docs/security.md` and `docs/legal.md`.

## How the key requirements are met

| Requirement | Where / how |
|---|---|
| Atomic matching, no double match | Lua scripts (`config/lua.js`), `{mm}` hash-tag keys, 1000-concurrent-joiner test |
| Same message may repeat; only retries/speed limited | `clientMsgId` idempotency + token bucket (5 burst) + 20 / 10 s window; no content dedupe anywhere |
| Multi-device / multi-account | `user:{id}:sockets` set, per-socket `deviceId`; per-tab refresh-cookie "slots" |
| No chat storage | Redis ring buffer (TTL) only; Mongo scan test proves it; saved chats need both users + registration |
| Hard content blocks | `services/contentPolicy.js` (frozen constants, not settings), enforced in text, image and report flows |
| Age layers | checkbox + DOB (server validated, never stored) + phone/Google age level + strict-provider hook for adult rooms |
| Dry-run everywhere | `config/env.js` derives `dryRun` flags; production refuses dev secrets |

## Verification status

What was **actually run** while building this (Linux sandbox, Node 22, Redis 7.0.15):

| Check | Result |
|---|---|
| Backend `npm test` | **207 tests passing** in 18 files: unit (matching rules, filters, content policy, crypto/TOTP/HKDF/AES-GCM, ban ladder, age, settings, validators, tokens, env, storage adapters, perceptual hash, docs-in-sync) + integration against a **real Redis server** and a Mongo-compatible server (matching incl. 1000 concurrent joiners / races / cooldown / fallback timing / disconnect, auth flows, OTP abuse limits, rotating-refresh reuse detection, multi-device presence, rooms + mod tools, reports → admin queue, bans + escalation, hard policy, saved chats + "not in Mongo" scan, image pipeline with real JPEGs, video signalling, rate limiters, HTTP hardening, graceful SIGTERM shutdown) |
| Backend `npm run check` | `node --check` 105/105 files, eslint clean |
| Frontend `npm run check` / `npm test` / `npm run build` | esbuild bundle OK, eslint clean, 7 unit tests, production build + PWA precache OK |
| **Real-browser E2E** (Playwright + Chromium, 390 px mobile + 1280 px desktop, two isolated browser contexts) | **17/17 steps**: age gate lock, guest entry, matching with tags, two-way messaging, repeated text, typing, photo upload → blurred card → canvas reveal with watermark, right-click blocked, blur on tab hide, reload resumes chat, offline banner + auto-reconnect, report dialog, partner-left, rooms, adult-room refusal for guests, settings/legal pages, PWA manifest + service worker, desktop rail. Screenshots: `docs/screenshots/` |
| Load smoke (`scripts/loadtest.mjs`, single laptop-class sandbox, 1 Redis, 1 Mongo-compatible) | 400 concurrent sockets: 100 % matched, ~213 msg/s, match p95 ≈ 150 ms, send-ack p95 ≈ 13 ms, end-to-end p95 ≈ 11 ms. Also 300 sockets split over **two API instances** sharing Redis: 100 % matched, every message delivered across instances |
| `docker compose config` | validates |

What was **NOT verified** (be honest with yourself before launch):

* **Mongo:** the integration suite ran against **FerretDB 1.24 (Mongo wire-compatible, SQLite backend)** because a `mongod` binary could not be downloaded in the sandbox. FerretDB has no TTL/partial indexes or transactions; the code does not rely on them (it enforces uniqueness and expiry itself) but you must run the suite against real MongoDB 7 (CI does: `.github/workflows/ci.yml`).
* **Docker images were not built** (no Docker daemon) and the **GitHub Actions workflow has not been executed** (only YAML-parsed). coturn was not run.
* **Real third-party providers were never called:** Google, Twilio, MSG91, Firebase, S3/R2/MinIO, ImageKit, and any NSFW / hash-matching / age-verification / VPN service. S3 presigning and ImageKit signing are unit-tested only. The Firebase adapter and every `http` moderation adapter are untested against real services.
* **WebRTC media** (camera/mic, ICE/TURN traversal) was not exercised in a browser; only the signalling layer is tested.
* **Redis Cluster** was not run (keys are designed for it, scripts use one hash tag). **k6 / Artillery scripts were written but not executed.**
* No penetration test, no accessibility audit with assistive tech (semantics/aria/focus handled, not screen-reader tested), no real-device iOS/Android testing, no PWA install test on a phone.
* The text safety scanners are keyword heuristics, not a moderation model.

## Known gaps

No email verification / password reset; no light theme; no full account-deletion endpoint (saved-chat deletion exists); admin UI lacks a user-search page (API exists); video cannot be moderated or evidenced; room-level permanent bans (only 10-minute kick lock-outs plus global admin bans). See `TODO.md`.

## Launch checklist

- [ ] **Lawyer review** (cyber-law + data protection): Terms, Privacy, Grievance Officer setup, takedown SOP, `docs/legal.md` items (IT Act 67/67A/67B, IT Rules 2021 timelines, DPDP Act 2023).
- [ ] **Hosting / storage / CDN / SMS / app-store adult-content policies** read and satisfied for *every* provider (many prohibit adult content). Decide whether adult rooms are allowed at all on your stack.
- [ ] **DLT registration** (India): entity, sender ID, OTP template, consent templates; then switch `OTP_PROVIDER`.
- [ ] **Real moderation provider keys:** NSFW/minor-risk classifier, known-bad hash matching (CSAM), VPN/datacenter risk, strict age verification (if required). Test each in staging; dry-run is **not** a launch configuration.
- [ ] **Load test** (k6/Artillery on staging, multi-instance, Redis sized, `ulimit`s tuned) and a soak test.
- [ ] **Security audit / pentest**, dependency audit, secrets in a vault, Redis TLS/ACL, Mongo auth + TLS, backups, `PEPPER`/`ENCRYPTION_KEY` custody and rotation plan.
- [ ] Staff the moderation queue (critical reports < 1 h), name a Grievance Officer, publish contacts, rehearse the CSAM escalation in `docs/legal.md`.
- [ ] Replace placeholder pages, set `CORS_ORIGINS`, `PUBLIC_URL`, `TRUST_PROXY`, HTTPS + HSTS, `security.txt`.
