# CLAUDE.md

## Project overview

Self-hosted real-time collaborative playlist sync for Tidal. Chrome extension detects track changes via DOM observation, syncs through a Node.js/WebSocket server, and each user's extension writes to their own Tidal account via the Tidal API.

**Target deployment**: CasaOS home server at `192.168.100.31:3000`, LAN/VPN access only.

## Quick start (development)

```bash
cd server && npm install && npm start
# Server + admin panel at http://localhost:3000
# Load extension/ as unpacked in chrome://extensions
```

## Architecture

```
extension/          Chrome MV3 extension (service worker + content script + popup)
server/             Node.js backend (Express + ws + better-sqlite3)
web-ui/             Admin panel (vanilla HTML/CSS/JS, served as static files)
docker/             Dockerfile, compose, build/run scripts
docs/               ARCHITECTURE.md, CASAOS_DEPLOY.md
```

### Server (server/)

- **Entry**: `src/index.js` — Express app, static file serving, graceful shutdown
- **Config**: `src/config.js` — PORT, NODE_ENV, DB_PATH from env vars
- **Database**: `src/db.js` — all SQLite queries (better-sqlite3, synchronous), `db/init.sql` for schema
- **REST API**: `src/routes/api.js` — 9 endpoints under `/api`
- **WebSocket**: `src/routes/ws.js` — real-time sync, `clients` Map (userId → ws), broadcast to linked users

### Extension (extension/)

- **Service worker** (`background/worker.js`): WebSocket connection, Tidal API calls, state in `chrome.storage.local`, keepalive alarm
- **Content script** (`content/content.js`): Token capture (XHR/fetch intercept), MutationObserver for playlist DOM, 5-strategy track ID extraction
- **Popup** (`popup/`): 3-view flow (setup → main → linking), server connection, playlist linking

### Web UI (web-ui/)

- Single-page admin panel, vanilla JS, dark theme
- Polls every 6s + WebSocket for instant updates
- Connects as `admin-panel` user (no playlist link)

## Key conventions

- **CommonJS** throughout server (`require`/`module.exports`)
- **No modules in extension** — service worker uses plain scripts (no `"type": "module"` in manifest)
- **snake_case** for DB columns and WebSocket message fields
- **camelCase** for JS variables and function names
- **kebab-case** for URL paths (`/shared-playlists`, `/api/links`)
- **Log prefixes**: `[server]`, `[db]`, `[api]`, `[ws]` for easy grep
- **Soft-delete**: tracks have `removed_at` (NULL = active), never hard-deleted

## Critical rules

- **Tokens stay client-side** — the server NEVER receives Tidal access tokens; only numeric user IDs
- **Idempotent writes** — `addTrack()` returns null if already active (no duplicate broadcast)
- **ETag required** — Tidal API writes need current ETag fetched first
- **Last-write-wins** — no CRDT or OT; conflicts resolved by order of arrival + toast notification
- **Set-difference diffing** — track changes detected by comparing ID sets, not DOM events (ignores reorder noise)

## Database (SQLite, WAL mode)

4 tables: `shared_playlists`, `playlist_links`, `tracks`, `active_users`

Schema is idempotent (`CREATE TABLE IF NOT EXISTS`). Applied on every server start via `db/init.sql`.

## Docker

- Build context is repo root (`.dockerignore` at root)
- Multi-stage build: `deps` stage for `npm ci`, final copies `node_modules`
- Volume: `./data:/app/data` (SQLite persists across restarts)
- Path resolution: `__dirname` = `/app/server/src` → `../../web-ui` = `/app/web-ui`

## Testing

```bash
# Server smoke test
cd server && npm start
curl http://localhost:3000/api/ping
# Extension: load unpacked, open listen.tidal.com, check popup
```

## Common tasks

- **Add a REST endpoint**: `server/src/routes/api.js` + add DB function in `server/src/db.js` if needed
- **Add a WebSocket message type**: handler in `server/src/routes/ws.js`, extension handler in `extension/background/worker.js`
- **Change DB schema**: `server/db/init.sql` (keep idempotent), update `server/src/db.js` wrapper functions
- **Update admin panel**: `web-ui/app.js` (logic), `web-ui/index.html` (structure), `web-ui/styles.css` (styles)
