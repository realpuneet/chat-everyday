# syntax=docker/dockerfile:1.7
# ---- dependencies (production only) ----
FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- runtime ----
FROM node:20-bookworm-slim
ENV NODE_ENV=production \
    PORT=4000
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
# uploads (dry-run storage) must be writable by the unprivileged user
RUN mkdir -p /app/.data && chown -R node:node /app/.data
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# tini forwards SIGTERM so the app can drain sockets and exit cleanly
ENTRYPOINT ["tini", "--"]
CMD ["node", "src/server.js"]
