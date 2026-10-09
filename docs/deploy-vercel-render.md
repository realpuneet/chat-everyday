# Deploy: frontend on Vercel, backend on Render

1. **MongoDB Atlas** (Render has no Mongo): create a cluster, a DB user, allow Render's outbound IPs (or 0.0.0.0/0 for a demo). Copy the `mongodb+srv://…/chat_everyday` URI.
2. **Render**: New → Blueprint → select this repo (`render.yaml`). Set `MONGO_URI`, `ENCRYPTION_KEY` (`openssl rand -base64 32`), `ADMIN_EMAILS` (optional). After the first deploy note the API URL (e.g. `https://chat-everyday-api.onrender.com`) and set `PUBLIC_URL` to it. Check `GET /readyz`.
3. **Vercel**: Import the repo, **Root Directory = `frontend`**. Env vars: `VITE_SOCKET_URL=https://<render-api-url>` (WebSockets cannot go through Vercel rewrites), `VITE_DRYRUN=true` while dry-run integrations are on, optional `VITE_GOOGLE_CLIENT_ID`.
4. Edit the `/api` rewrite destination in `frontend/vercel.json` to your real Render URL (it is a literal; Vercel rewrites cannot read env vars) and redeploy. REST calls stay same-origin, so the refresh cookie remains first-party.
5. Back on Render set `CORS_ORIGINS=https://<your-app>.vercel.app` (needed for the direct Socket.io connection) and redeploy.

Notes: local-disk image storage is ephemeral on Render (use S3/R2 for real use); the free Render tier sleeps and would break WebSockets/sweepers; with `TRUST_PROXY=2` the first `X-Forwarded-For` hop is trusted, so for strict IP bans put Cloudflare/your own proxy in front of the API.
