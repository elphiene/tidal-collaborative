# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

**Development (from `server/` directory):**
```bash
npm install          # Install dependencies
npm start            # Start server at http://localhost:3000
npm run dev          # Start with file watching (--watch mode)
```

**Docker (from repo root):**
```bash
DOCKER_BUILDKIT=0 docker build -f docker/Dockerfile -t elphiene/tidal-collaborative:latest .
docker push elphiene/tidal-collaborative:latest
cd docker && ./run.sh             # Start container + follow logs
```

**Health check:** `GET /api/ping` returns `{"ok":true,"ts":...,"version":"..."}`. There are no automated tests or linters configured.

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

DB-backed, per-user polling:
1. Staggered per-user polling: users spread evenly across the poll interval
2. Per-user lock (`pollingUsers` Set) — prevents overlapping polls per user
3. Diff against `db.getActiveTrackIds()` (DB query, not in-memory state) to find new tracks
4. `INSERT OR IGNORE` + partial unique index enforces deduplication atomically
5. Propagate new tracks to all other users' linked Tidal playlists
6. Broadcast `track_added` / `sync_status` over WebSocket
7. Pagination cursor persisted to `playlist_links.scan_cursor` (survives restarts)
8. Rate limit (429) and token revocation handled per-user with WS broadcast to UI

Key state:
- `pollingUsers: Set<userId>` — per-user poll lock
- `tokenRefreshLocks: Map<userId, Promise>` — prevents concurrent token refresh per user
- No in-memory track cache — diff is always against DB

Key exported functions:
- `startPoller(broadcastFn)` — starts the scheduler; reads interval from DB each tick
- `pollNow(userId?)` — trigger immediate poll (all users or specific user)
- `initNewLink(link)` — called when a user links their Tidal playlist: pushes all existing shared tracks to their Tidal first, then runs a normal poll to pull any Tidal-only tracks they already had
- `syncPlaylistForLink(link, accessToken)` — full bidirectional sync: merges Tidal-only tracks into DB, pushes server-only tracks to Tidal, removes Tidal duplicates
- `propagateRemoveToAllUsers(sharedPlaylistId, trackId)` — called by REST delete endpoint

Deletions are **webapp-only**: removing a track via the UI deletes it from all members' Tidal playlists. Tidal-side removals are intentionally ignored.

### Playlist Access Model

Shared playlists have an `is_public` flag:
- **Public** (`is_public=1`): any authenticated user can join directly via `POST /api/links` with `sharedPlaylistId`
- **Private** (`is_public=0`): joining requires a valid invite code; owner generates codes via `POST /api/shared-playlists/:id/invites`

Only the playlist creator (`created_by`) or an admin can update visibility, generate invites, or delete the playlist.

### Admin Auth

A 4-digit PIN stored in the `settings` table gates admin access. Session marks `adminAuthed = true` after correct PIN entry. Admins bypass ownership checks and see all playlists/users. The PIN is set once via `POST /api/admin/setup`; subsequent auth uses `POST /api/admin/auth`.

### Auth Flow (`server/src/routes/api.js` + `server/src/tidal.js`)

OAuth 2.1 PKCE — tokens never touch the browser:
- Server exchanges code, stores encrypted tokens in `users` table
- Required OAuth scopes: `user.read playlists.read playlists.write`
- Token refresh uses a per-user Promise lock to prevent race conditions
- WebSocket connections authenticated via the same session cookie
- `TIDAL_CLIENT_ID` can be supplied via env var or saved through the setup wizard (stored in `settings` table)

### Token Encryption (`server/src/crypto.js`)

AES-256-GCM. Format stored in SQLite: `<iv>:<ciphertext>:<authtag>`. Key is `ENCRYPTION_KEY` (64 hex chars, auto-generated on first run and stored in `settings` table if not provided via env).

### Database (`server/db/init.sql`, `server/src/db.js`)

SQLite in WAL mode, foreign keys enabled. `db.runMigrations()` runs on every startup to add new columns and indexes safely (ALTER TABLE errors are swallowed — already-exists is expected).

Tables:
- `users` — Tidal user records with encrypted tokens + sync health fields (`sync_status`: `ok|rate_limited|token_revoked|error`, `sync_error_msg`, `sync_retry_after`, `token_dead`)
- `shared_playlists` — collaboration containers; `is_public` controls open vs. invite-only join
- `playlist_links` — maps (user, local Tidal playlist UUID) → shared playlist; holds `scan_cursor` and `last_polled_at`
- `tracks` — shared playlist track membership (soft-deleted via `removed_at`); partial unique index `idx_tracks_active_unique` on `(shared_playlist_id, tidal_track_id) WHERE removed_at IS NULL` prevents duplicates; created in `runMigrations()` after dedup, not in `init.sql`
- `playlist_invites` — invite codes for private playlists (`code` TEXT UNIQUE, `revoked_at` for revocation)
- `active_users` — WebSocket presence tracking (upserted on WS connect/auth)
- `settings` — key/value config (`admin_pin`, `encryption_key`, `session_secret`, `poll_interval_ms`, `tidal_client_id`)

### WebSocket (`server/src/routes/ws.js`)

**Receive-only from the client** — all mutations go through REST. One connection per user (newer connection replaces stale). The server pushes:

| Event | Trigger |
|-------|---------|
| `auth_ok` | Connection established or `auth` message sent |
| `track_added` | Poller detects new track |
| `track_removed` | REST delete endpoint |
| `tracks_reordered` | REST reorder endpoint |
| `sync_status` | Rate limit, token revocation, or recovery |
| `settings_updated` | Admin changes poll interval |

Client can send `{ type: "auth", payload: { user_id, shared_playlist_ids } }` as a fallback auth (for clients that connect before cookie session resolves). All other client message types return an error.

`broadcast(sharedPlaylistId, message)`: `null` → all connected clients; number → clients linked to that playlist.

### REST API

**Auth & session**
| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/auth/start` | Begin PKCE flow — returns `authUrl` |
| `GET` | `/api/auth/callback` | OAuth callback — sets session, redirects to `/?auth=ok` |
| `POST` | `/api/auth/logout` | Destroy session |
| `GET` | `/api/me` | Current user info |

**Setup wizard** (first-run config)
| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/setup/status` | Whether `TIDAL_CLIENT_ID` and `admin_pin` are set |
| `POST` | `/api/setup/tidal-client-id` | Save Tidal client ID to DB |
| `GET` | `/api/setup/redirect-uri` | Derive redirect URI from request headers |

**Admin PIN**
| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/admin/status` | PIN set? Admin authed in this session? |
| `POST` | `/api/admin/setup` | Set PIN (one-time; 4 digits) |
| `POST` | `/api/admin/auth` | Authenticate with PIN |

**Admin operations** (require `adminAuthed`)
| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/admin/settings` | Get `poll_interval_ms` |
| `PATCH` | `/api/admin/settings` | Update poll interval (15–300s), broadcasts `settings_updated` |
| `POST` | `/api/admin/force-poll` | Trigger immediate poll cycle |
| `POST` | `/api/admin/users/:id/reset-sync` | Clear error/revoked status, re-enable polling |
| `POST` | `/api/admin/dedup-playlists` | Remove duplicate tracks from all users' Tidal playlists |

**Sync status**
| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/sync/status` | Per-user sync health (authed user or admin) |

**Tidal pass-through**
| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/tidal/playlists` | List current user's Tidal playlists |

**Shared playlists**
| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/shared-playlists` | Playlists the user owns or is linked to (admin: all) |
| `GET` | `/api/shared-playlists/discover` | Public playlists the user hasn't joined |
| `POST` | `/api/shared-playlists` | Create; optionally link a Tidal playlist in the same request |
| `PATCH` | `/api/shared-playlists/:id` | Toggle `isPublic` (owner or admin) |
| `DELETE` | `/api/shared-playlists/:id` | Delete (owner or admin) |
| `GET` | `/api/shared-playlists/:id/tracks` | Track list (position-ordered, active only) |
| `DELETE` | `/api/shared-playlists/:id/tracks/:trackId` | Soft-delete + remove from all Tidal playlists |
| `POST` | `/api/shared-playlists/:id/tracks/reorder` | Bulk-update track positions |
| `GET` | `/api/shared-playlists/:id/linked-users` | Users linked to this playlist |
| `POST` | `/api/shared-playlists/:id/invites` | Generate invite code (owner or admin) |
| `GET` | `/api/shared-playlists/:id/invites` | List active invite codes |

**Invites**
| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/invites/:code` | Validate invite code, return playlist name |
| `DELETE` | `/api/invites/:id` | Revoke invite |

**Playlist links**
| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/links` | Current user's links |
| `GET` | `/api/links/:userId` | Links for any user ID (unauthenticated) |
| `POST` | `/api/links` | Join a shared playlist (requires `tidalPlaylistId` + `inviteCode` or `sharedPlaylistId`) |
| `DELETE` | `/api/links/:id` | Unlink (owner only) |
| `POST` | `/api/links/:id/sync` | Full bidirectional sync for one link |

**Users / presence**
| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/users` | Recently active users (last seen, per playlist) |
| `GET` | `/api/users/all` | All users with link count + sync status (authed) |

### Frontend (`web-ui/app.js`)

Vanilla JS SPA, no build tooling — served as static files by Express. Key features:
- WebSocket handles `sync_status`, `settings_updated`, `track_added`, `track_removed`, `tracks_reordered`
- Sync status banner shown on rate limit or token revocation
- Track delete via REST with two-click confirm (removes from all linked playlists)
- Admin settings panel: poll interval (15–300s) + Force Poll Now button
- Admin users table: sync status badges + per-user Reset button
- Mobile hamburger nav (≤700px): fixed dropdown, animated X/hamburger transition

### Key Files

| File | Role |
|------|------|
| `server/src/index.js` | App entry point, startup sequence |
| `server/src/poller.js` | Per-user sync loop, DB-backed diff, cursor persistence, bidirectional sync |
| `server/src/routes/api.js` | All REST endpoints |
| `server/src/routes/ws.js` | WebSocket handler + broadcast (receive-only from client) |
| `server/src/tidal.js` | Tidal API v2 client (JSON:API), PKCE helpers |
| `server/src/db.js` | SQLite wrapper + migrations |
| `server/src/crypto.js` | AES-256-GCM encrypt/decrypt |
| `server/src/config.js` | Env var defaults; `DB_PATH` resolves to `<repo_root>/data/db.sqlite` |
| `server/db/init.sql` | Schema (idempotent CREATE IF NOT EXISTS) |
| `web-ui/app.js` | SPA frontend |
| `docker/Dockerfile` | Production image (node:20-alpine, wget health check) |
| `docker/docker-compose.yml` | CasaOS-compatible compose with volume + env config |

### Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3000` | HTTP/WS listen port |
| `DB_PATH` | `<repo_root>/data/db.sqlite` | SQLite file path |
| `ENCRYPTION_KEY` | auto-generated + stored in DB | 64 hex chars, AES-256-GCM key |
| `SESSION_SECRET` | auto-generated + stored in DB | Session cookie signing |
| `TIDAL_CLIENT_ID` | set via env or setup wizard | Tidal app client ID (stored in `settings` table if wizard-set) |

### Deployment (CasaOS)

Image: `elphiene/tidal-collaborative:latest` on Docker Hub.

To rebuild and publish:
```bash
cd ~/Documents/El-Projects/tidal-collaborative
DOCKER_BUILDKIT=0 docker build -f docker/Dockerfile -t elphiene/tidal-collaborative:latest .
docker push elphiene/tidal-collaborative:latest
```

Then in CasaOS: pull the new image and recreate the container. Data persists in `/DATA/AppData/tidal-collaborative`.
