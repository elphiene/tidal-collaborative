# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

**Development (from `server/` directory):**
```bash
npm install          # Install dependencies
npm start            # Start server at http://localhost:3000
npm run dev          # Start with file watching (--watch mode)
```

**Docker (from `docker/` directory):**
```bash
DOCKER_BUILDKIT=0 docker build -f docker/Dockerfile -t elphiene/tidal-collaborative:latest .
docker push elphiene/tidal-collaborative:latest
cd docker && ./run.sh             # Start container + follow logs
```

**Health check:** `GET /api/ping` returns `{"ok":true}`. There are no automated tests or linters configured.

## Architecture

Tidal Collaborative is a self-hosted real-time collaborative playlist sync service for Tidal. It is a **monolithic Node.js application** (Express + WebSocket + SQLite) with a vanilla JS frontend, deployed as a single Docker container.

### Entry Point & Startup Order

`server/src/index.js` bootstraps the app in this sequence:
1. Initialize SQLite schema (`db/init.sql` — idempotent) + run migrations (`db.runMigrations()`)
2. Load or generate `ENCRYPTION_KEY` and `SESSION_SECRET` (stored in `settings` table)
3. Register middleware (session, CORS, JSON)
4. Mount REST API at `/api/*` and static web UI (SPA fallback)
5. Attach WebSocket server to HTTP upgrade handler
6. Start polling loop (`startPoller`) — interval configurable via admin panel (default 30s)
7. Register SIGTERM/SIGINT graceful shutdown

### Core Sync Loop (`server/src/poller.js`)

DB-backed, per-user polling — the `knownTracks` in-memory Map has been eliminated entirely:
1. Staggered per-user polling: users spread evenly across the poll interval
2. Per-user lock (`pollingUsers` Set) — missed cycles never silently dropped
3. Diff against `db.getActiveTrackIds()` (DB query, not in-memory state) to find new tracks
4. `INSERT OR IGNORE` + partial unique index enforces deduplication atomically
5. Propagate new tracks to all other users' linked Tidal playlists
6. Broadcast `track_added` / `sync_status` / `settings_updated` over WebSocket
7. Pagination cursor persisted to `playlist_links.scan_cursor` (survives restarts)
8. Rate limit (429) and token revocation handled per-user with WS broadcast to UI

Key state:
- `pollingUsers: Set<userId>` — per-user poll lock (replaces global `pollInProgress`)
- `tokenRefreshLocks: Map<userId, Promise>` — prevents concurrent token refresh per user
- No `knownTracks` Map — diff is always against DB

Deletions are **webapp-only**: removing a track via the UI deletes it from all members' Tidal playlists. Tidal-side removals are intentionally ignored.

### Auth Flow (`server/src/routes/api.js` + `server/src/tidal.js`)

OAuth 2.1 PKCE — tokens never touch the browser:
- Server exchanges code, stores encrypted tokens in `users` table
- Token refresh uses a per-user Promise lock to prevent race conditions
- WebSocket connections authenticated via the same session cookie

### Token Encryption (`server/src/crypto.js`)

AES-256-GCM. Format stored in SQLite: `<iv>:<ciphertext>:<authtag>`. Key is `ENCRYPTION_KEY` (64 hex chars, auto-generated on first run).

### Database (`server/db/init.sql`, `server/src/db.js`)

SQLite in WAL mode, foreign keys enabled. `db.runMigrations()` runs on every startup to add new columns and indexes safely.

Tables:
- `users` — Tidal user records with encrypted tokens + sync health fields (`sync_status`, `sync_error_msg`, `sync_retry_after`, `token_dead`)
- `shared_playlists` — collaboration containers
- `playlist_links` — maps (user, local Tidal playlist UUID) → shared playlist; holds `scan_cursor` and `last_polled_at`
- `tracks` — shared playlist track membership (soft-deleted via `removed_at`); partial unique index `idx_tracks_active_unique` on `(shared_playlist_id, tidal_track_id) WHERE removed_at IS NULL` prevents duplicates
- `active_users` — WebSocket presence tracking
- `settings` — key/value config (admin PIN, encryption key, session secret, `poll_interval_ms`)

### WebSocket (`server/src/routes/ws.js`)

**Receive-only from the client** — all mutations go through REST. The server pushes:

| Event | Trigger |
|-------|---------|
| `track_added` | Poller detects new track |
| `track_removed` | REST delete endpoint |
| `sync_status` | Rate limit, token revocation, or recovery |
| `settings_updated` | Admin changes poll interval |
| `poll_tick` | Poller starts/finishes a user cycle |

### REST API — Key Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| `DELETE` | `/api/shared-playlists/:id/tracks/:trackId` | Remove track from shared playlist + all Tidal playlists |
| `GET` | `/api/admin/settings` | Get poll interval and other settings |
| `PATCH` | `/api/admin/settings` | Update poll interval (15–300s) |
| `POST` | `/api/admin/force-poll` | Trigger immediate poll cycle |
| `POST` | `/api/admin/users/:id/reset-sync` | Clear error status, re-enable polling |
| `GET` | `/api/sync/status` | Per-user sync health |

### Frontend (`web-ui/app.js`)

~2200 LOC vanilla JS. No build tooling — served as static files by Express. Key features:
- WebSocket handles `sync_status` and `settings_updated` events
- Sync status banner shown on rate limit or token revocation
- Track delete via REST with two-click confirm (removes from all linked playlists)
- Admin settings panel: poll interval (15–300s) + Force Poll Now button
- Admin users table: sync status badges + per-user Reset button
- Mobile hamburger nav (≤700px): fixed dropdown, animated X/hamburger transition

### Key Files

| File | Role |
|------|------|
| `server/src/index.js` | App entry point, startup sequence |
| `server/src/poller.js` | Per-user sync loop, DB-backed diff, cursor persistence |
| `server/src/routes/api.js` | REST endpoints (OAuth, links, playlists, tracks, admin) |
| `server/src/routes/ws.js` | WebSocket handler + broadcast (receive-only from client) |
| `server/src/tidal.js` | Tidal API v2 client (JSON:API) |
| `server/src/db.js` | SQLite wrapper + migrations |
| `server/src/crypto.js` | AES-256-GCM encrypt/decrypt |
| `server/db/init.sql` | Schema (idempotent) |
| `web-ui/app.js` | SPA frontend |
| `web-ui/index.html` | App shell + modals |
| `web-ui/styles.css` | Dark theme, mobile-first responsive styles |
| `docker/Dockerfile` | Production image (node:20-alpine, wget health check) |
| `docker/docker-compose.yml` | CasaOS-compatible compose with volume + env config |

### Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | HTTP/WS listen port |
| `DB_PATH` | `./data/db.sqlite` | SQLite file path |
| `ENCRYPTION_KEY` | auto-generated | 64 hex chars, AES-256-GCM key |
| `SESSION_SECRET` | auto-generated | Session cookie signing |
| `TIDAL_CLIENT_ID` | set via wizard | Tidal app client ID |

### Deployment (CasaOS)

Image: `elphiene/tidal-collaborative:latest` on Docker Hub.

To rebuild and publish:
```bash
cd ~/Documents/El-Projects/tidal-collaborative
DOCKER_BUILDKIT=0 docker build -f docker/Dockerfile -t elphiene/tidal-collaborative:latest .
docker push elphiene/tidal-collaborative:latest
```

Then in CasaOS: pull the new image and recreate the container. Data persists in `/DATA/AppData/tidal-collaborative`.
