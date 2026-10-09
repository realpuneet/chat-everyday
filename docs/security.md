# Security notes

## Threat model → controls

| Threat | Controls (code) | Verified by |
|---|---|---|
| Minors using the service | 18+ gate (checkbox + DOB validated **server side**, device lock for 24 h after a failed attempt, DOB never stored); phone/Google raise the age level; strict-verification hook for adult rooms; minor-signal scanner → immediate session end + permanent ban; classifier `minorRisk` hook | `auth.flow`, `contentPolicy` unit + `safety.flow` |
| CSAM / non-consensual imagery | image pipeline never stores rejected material, known-bad hash hook + local blocklist, NSFW hook, report → hide, admin takedown (+hash blocklist), critical priority, audit log, escalation steps in `legal.md` | `images.flow`, `safety.flow` |
| Account takeover | argon2id, per-account + per-IP login limits, no account enumeration (uniform error, dummy hash timing), rotating refresh tokens with **reuse detection** (family revoked), short access tokens in memory, logout-all, optional TOTP for admins | `auth.flow` |
| CSRF | refresh cookie is `httpOnly`, `SameSite=Lax`, path-scoped to `/api/auth`, **and** requires the custom `x-session-slot` header (cannot be sent cross-site without a CORS preflight, which the allow-list refuses); access token is a bearer header | `auth.flow`, `http.misc` |
| XSS | React escapes all text; the API never returns HTML; server strips control/zero-width/bidi-override characters and zalgo; CSP `default-src 'none'` on the API, strict CSP in `nginx.conf` | `filters` unit |
| Abuse / spam / floods | token bucket + sliding window per user, per-IP limits, char-flood filter, link/PII/bad-word filters, slow mode; **repeating identical text is allowed by design** (only speed is limited) | `socket.flow`, `limiter`, `filters` |
| SMS pumping / OTP abuse | country allow-list, resend cooldown, per-phone/IP/device caps, distinct-numbers-per-IP, global circuit breaker, attempt + lockout limits, HMAC-stored codes | `auth.flow` |
| Ban evasion | bans on account + device + IP (+ linked email/phone/Google identity hashes), IP bans capped at 7 d (shared NAT), churn + linked-banned-device risk score, optional VPN hook | `safety.flow` |
| Brigading via mass reports | auto-suspension is short (1 h), reviewable, needs N distinct reporters; admin decides | `safety.flow` |
| Data leakage | chats not persisted; saved chats AES-256-GCM per document with HKDF keys and AAD; logs redact PII; IPs/devices/phones stored only as HMACs; opaque `memberId`s in rooms (userIds never reach clients); bucket private + short signed URLs | `safety.flow`, `rooms.flow`, `images.flow`, `http.misc` |
| Identity claims | gender/LGBTQ+ are **self-declared**; UI and API copy never say "verified" | `rooms.flow` |
| Secrets | env only; production refuses to boot without them; dev secrets are derived and public | `env` unit |

## Image viewer: honest limits

The viewer (canvas rendering, tap-to-reveal, view-once/timer, watermark, blur on tab hide, no right-click/drag/download, hidden for print) is a **deterrent, not a guarantee**. Browsers cannot reliably block screenshots or screen recording; a second camera always works. The UI and Terms say so. For the Android wrapper use `FLAG_SECURE` (README).

## WebRTC video

Media is end-to-end between peers (DTLS-SRTP) and is not recorded or inspected, so there is **no server-side moderation of video** and no video evidence in reports. Mitigations: explicit acceptance per call, rate-limited requests, report/block remain available, ICE through TURN (with time-limited credentials) only when direct connectivity fails. Consider disabling video for guests or behind phone verification (setting change in `rtcService`/UI) if abuse appears.

## Dependency / supply chain

Lockfiles are committed; CI runs `npm audit --omit=dev` (non-blocking, review results). Keep Node, Redis, Mongo and base images patched; pin Docker image digests for production.

## Known gaps / not implemented (be explicit before launch)

* No email verification or password-reset flow (email login is optional; Google/phone are the stronger options).
* Moderation providers (NSFW classifier, hash matching, VPN detection, strict age verification) are **hooks with dry-run defaults**: until configured, only the local blocklist, heuristics and human review protect you. The text scanners are keyword heuristics, not a classifier; expect false positives/negatives.
* No Redis TLS/ACL configuration is shipped; configure it in your environment.
* Reports against video are not possible; saved chats do not include images by design.
* The access token for guests is stored in `sessionStorage` (per tab) so reloads keep the session; registered users keep it in memory only.
* A professional penetration test and a privacy/DPIA review are still required.

## Reporting a vulnerability

Document a security contact in your Terms/`security.txt` before launch (placeholder: `security@your-domain.example`).
