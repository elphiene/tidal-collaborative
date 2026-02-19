## ─── Stage 1: dependency install ─────────────────────────────────────────
##  Copy only the package manifests first so that `npm ci` is cached as long
##  as package.json / package-lock.json don't change.
## ──────────────────────────────────────────────────────────────────────────
FROM node:20-alpine AS deps

WORKDIR /app

# curl is needed for the HEALTHCHECK in the final stage
RUN apk add --no-cache curl

COPY server/package.json server/package-lock.json ./server/
RUN cd server && npm ci --omit=dev

## ─── Stage 2: final image ─────────────────────────────────────────────────
FROM node:20-alpine

# curl for the health check (keep the image lean — no dev tooling)
RUN apk add --no-cache curl

WORKDIR /app

# Copy pre-built node_modules from the deps stage
COPY --from=deps /app/server/node_modules ./server/node_modules

# Copy application source
COPY server/ ./server/

# web-ui is served as static files by Express.
# server/src/index.js resolves the path as:
#   path.join(__dirname, '../../web-ui')   →  /app/web-ui
COPY web-ui/ ./web-ui/

# Persistent SQLite storage (mount a volume over this path)
RUN mkdir -p /app/data

# ── Runtime environment ──────────────────────────────────────────────────
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/app/data/db.sqlite

EXPOSE 3000

# ── Health check ─────────────────────────────────────────────────────────
# Hits /api/ping every 30 s; gives the server 15 s to warm up on first start.
HEALTHCHECK \
  --interval=30s \
  --timeout=5s \
  --start-period=15s \
  --retries=3 \
  CMD curl -fs http://localhost:3000/api/ping | grep -q '"ok":true' || exit 1

CMD ["node", "server/src/index.js"]
