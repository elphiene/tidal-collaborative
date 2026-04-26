# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

**Development (from `server/` directory):**
```bash
npm install          # Install dependencies
npm start            # Start server at http://localhost:3000
npm run dev          # Start with file watching (--watch mode)
```

**Docker:**
```bash
cd docker && ./build.sh           # Build and push Docker image
cd docker && ./build.sh --no-cache
cd docker && ./run.sh             # Start container + follow logs
cd docker && ./publish.sh         # Multi-platform build (amd64 + arm64)
```

**Health check:** `GET /api/ping` returns `{"ok":true}`. There are no automated tests or linters configured.

## Architecture

Tidal Collaborative is a self-hosted real-time collaborative playlist sync service for Tidal. It is a **monolithic Node.js application** (Express + WebSocket + SQLite) with a vanilla JS frontend, deployed as a single Docker container.

### Entry Point & Startup Order

`server/src/index.js` bootstraps the app in this sequence:
1. Initialize SQLite schema (`db/init.sql` — idempotent)
2. Load or generate `ENCRYPTION_KEY` and `SESSION_SECRET` (stored in `settings` table)
3. Register middleware (session, CORS, JSON)
4. Mount REST API at `/api/*` and static web UI (SPA fallback)
5. Attach WebSocket server to HTTP upgrade handler
6. Start 60-second polling loop (`startPoller`)
7. Register SIGTERM/SIGINT graceful shutdown

### Core Sync Loop (`server/src/poller.js`)

The polling loop is the heart of the system:
1. Every 60 seconds, fetch each linked Tidal playlist
2. Diff against `knownTracks` in-memory Map to find new/removed tracks
3. Write changes to `tracks` table (`db.addTrack` is idempotent via `removed_at` soft-delete)
4. Propagate new tracks to all other users' linked playlists via Tidal API
5. Broadcast `track_added` / `track_removed` events over WebSocket to all clients

Key in-memory state in the poller:
- `knownTracks: Map<tidalPlaylistId, Set<trackId>>` — cached playlist state
- `scanOffsets` — pagination cursors for large playlists
- `initializingPlaylists: Set` — blocks polling during initial playlist seeding
- `pollInProgress: boolean` — prevents concurrent poll runs

### Auth Flow (`server/src/routes/api.js` + `server/src/tidal.js`)

OAuth 2.1 PKCE — tokens never touch the browser:
- Server exchanges code, stores encrypted tokens in `users` table
- Tokens refreshed inline during polls (5 minutes before expiry)
- WebSocket connections authenticated via the same session cookie

### Token Encryption (`server/src/crypto.js`)

AES-256-GCM. Format stored in SQLite: `<iv>:<ciphertext>:<authtag>`. Key is `ENCRYPTION_KEY` (64 hex chars, auto-generated on first run).

### Database (`server/db/init.sql`, `server/src/db.js`)

SQLite in WAL mode, foreign keys enabled. Six tables:
- `users` — Tidal user records with encrypted tokens
- `shared_playlists` — collaboration containers
- `playlist_links` — maps (user, local Tidal playlist UUID) → shared playlist
- `tracks` — shared playlist track membership (soft-deleted via `removed_at`)
- `active_users` — WebSocket presence tracking
- `settings` — key/value config (admin PIN, encryption key, session secret)

### Frontend (`web-ui/app.js`)

~1400 LOC vanilla JS. No build tooling — served as static files by Express. Manages auth state, playlist UI, and a WebSocket connection that receives `track_added`/`track_removed` broadcasts and updates the UI in real time.

### Key Files

| File | Role |
|------|------|
| `server/src/index.js` | App entry point, startup sequence |
| `server/src/poller.js` | 60s sync loop, diff logic, propagation |
| `server/src/routes/api.js` | REST endpoints (OAuth, links, playlists, admin) |
| `server/src/routes/ws.js` | WebSocket handler + broadcast |
| `server/src/tidal.js` | Tidal API v2 client (JSON:API) |
| `server/src/db.js` | SQLite wrapper |
| `server/src/crypto.js` | AES-256-GCM encrypt/decrypt |
| `server/db/init.sql` | Schema (idempotent) |
| `web-ui/app.js` | SPA frontend |
| `docs/ARCHITECTURE.md` | Detailed system design reference |

### Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | HTTP/WS listen port |
| `DB_PATH` | `./data/db.sqlite` | SQLite file path |
| `ENCRYPTION_KEY` | auto-generated | 64 hex chars, AES-256-GCM key |
| `SESSION_SECRET` | auto-generated | Session cookie signing |
| `TIDAL_CLIENT_ID` | set via wizard | Tidal app client ID |
