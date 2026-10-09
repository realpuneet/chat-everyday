# Basic (demo) deploy: frontend on Vercel, backend on Render

> This is a **demo/staging** setup (`DEMO_MODE=true`, dry-run integrations, free tiers). It is deliberately not production-grade: anyone can sign in as any email through the dry-run Google login, OTP codes are shown on screen, images live on an ephemeral disk, and free instances sleep. Do not use it for real users.

## 1. MongoDB Atlas (Render has no Mongo)
Create a free cluster → Database Access: add a user → Network Access: allow `0.0.0.0/0` → copy the connection string and put `/chat_everyday` as the database name, e.g. `mongodb+srv://USER:PASS@cluster0.xxxxx.mongodb.net/chat_everyday`.

## 2. Render (backend + Redis)
New → **Blueprint** → pick this repo (`render.yaml`). When asked, fill:
| Variable | Value |
|---|---|
| `MONGO_URI` | the Atlas string from step 1 |
| `PUBLIC_URL` | `https://chat-everyday-api.onrender.com` (your service URL) |
| `CORS_ORIGINS` | your Vercel URL, e.g. `https://chat-everyday.vercel.app` (fill after step 3, then redeploy) |
| `ADMIN_EMAILS` | optional, e.g. `you@gmail.com` (becomes admin via the dry-run Google login) |

Everything else (secrets, `DEMO_MODE`, Redis URL) is pre-set. Check `https://<service>.onrender.com/readyz` → `{"ready":true}`.

## 3. Vercel (frontend)
Import the repo → **Root Directory: `frontend`** (framework Vite is auto-detected). Environment variables:
| Variable | Value |
|---|---|
| `VITE_SOCKET_URL` | your Render URL, e.g. `https://chat-everyday-api.onrender.com` (WebSockets cannot pass through Vercel rewrites) |
| `VITE_DRYRUN` | `true` |

`frontend/vercel.json` already forwards `/api/*` to `https://chat-everyday-api.onrender.com`. **If your Render service got a different URL**, edit that one line and redeploy (Vercel rewrites cannot read env vars). REST stays same-origin so the refresh cookie works.

## 4. Local development (no deploy needed)
```bash
npm run setup      # installs backend + frontend
npm run db:up      # MongoDB + Redis via Docker (or run mongod / redis-server yourself)
npm run dev        # API :4000 + web http://localhost:5173
```
`backend/.env` and `frontend/.env` are already filled for this (dry-run, no accounts needed). Sign in as admin: Google (dry-run) tab → email `admin@example.com`.

## Known limits of the demo deploy
Free Render sleeps after ~15 min (cold start ≈ 30-60 s; sockets reconnect), uploaded images vanish on redeploy, only one instance, no real SMS/Google/moderation providers.
