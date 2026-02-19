# Tidal Collaborative

Self-hosted real-time collaborative playlist sync for [Tidal](https://tidal.com).
When any collaborator adds or removes a track, every linked user sees the change instantly.

---

## How it works

```
 listen.tidal.com                 Your Home Server (CasaOS)
 ┌─────────────────┐              ┌──────────────────────────────┐
 │   Tidal Web App  │              │   Docker container           │
 │                  │   WebSocket  │                              │
 │  ┌────────────┐  │◄────────────►│  Node.js + Express + ws     │
 │  │  Chrome    │  │              │  ┌────────────────────────┐  │
 │  │ Extension  │  │              │  │  SQLite DB             │  │
 │  │            │  │   REST API   │  │  shared_playlists      │  │
 │  │ • captures │  │◄────────────►│  │  playlist_links        │  │
 │  │   token    │  │              │  │  tracks (soft-delete)  │  │
 │  │ • detects  │  │              │  │  active_users          │  │
 │  │   changes  │  │              │  └────────────────────────┘  │
 │  └────────────┘  │              │                              │
 └─────────────────┘              │  Web UI (admin panel)        │
                                   │  http://192.168.100.31:3000  │
 Other users' browsers ───────────►│                              │
 (same real-time loop)             └──────────────────────────────┘
```

### Sync flow

1. User adds a track in Tidal → content script detects the DOM change
2. Extension sends `track_added` over WebSocket to the server
3. Server writes to SQLite and broadcasts to all other users in the playlist
4. Each recipient's extension calls the Tidal API to add the track locally
5. Toast notification appears: *"Track added by alice"*

---

## System requirements

| Component | Requirement |
|-----------|-------------|
| Server OS | Linux (CasaOS, Debian, Ubuntu, etc.) |
| Docker | Engine 24+ with Compose plugin v2+ |
| RAM | ≥ 128 MB free |
| Disk | ≥ 100 MB (image + DB) |
| Browser | Chrome, Edge, or Brave (MV3) |
| Network | Users must be on home LAN or connected via VPN |

---

## Quick start — Docker (recommended)

```bash
# 1. Clone the repo onto your CasaOS / home server
git clone https://github.com/yourname/tidal-collaborative.git
cd tidal-collaborative/docker

# 2. Make scripts executable
chmod +x build.sh run.sh

# 3. Build the image (~1–3 min on first run)
./build.sh

# 4. Start the container
./run.sh

# Admin panel is now at http://192.168.100.31:3000
```

> Full CasaOS deployment guide: **[docs/CASAOS_DEPLOY.md](docs/CASAOS_DEPLOY.md)**

---

## Quick start — Extension

1. Open `chrome://extensions` in Chrome / Edge / Brave
2. Enable **Developer mode**
3. Click **Load unpacked** → select the `extension/` folder
4. Click the extension icon
5. Enter your server URL (`http://192.168.100.31:3000`) → **Connect**
6. Open [listen.tidal.com](https://listen.tidal.com) (the extension captures your token automatically)
7. In the popup → **Link** → choose a Tidal playlist → choose a shared playlist → **Link & Sync**

---

## Quick start — Development (no Docker)

```bash
# Server
cd server
npm install
cp .env.example .env   # edit if needed
npm start              # http://localhost:3000

# The web UI is served automatically from ../web-ui/
```

---

## Project layout

```
tidal-collaborative/
├── .dockerignore              ← Docker build exclusions (repo root)
├── server/                    ← Node.js backend
│   ├── src/
│   │   ├── index.js           ← Express + WebSocket bootstrap
│   │   ├── config.js          ← Environment variables
│   │   ├── db.js              ← SQLite wrapper (better-sqlite3)
│   │   └── routes/
│   │       ├── api.js         ← REST endpoints
│   │       └── ws.js          ← WebSocket handler
│   └── db/
│       └── init.sql           ← Schema (idempotent)
├── web-ui/                    ← Admin panel (vanilla JS)
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── extension/                 ← Chrome extension (MV3)
│   ├── manifest.json
│   ├── background/worker.js   ← Service worker (WS + Tidal API)
│   ├── content/content.js     ← Token capture + DOM observation
│   └── popup/                 ← Configuration UI
├── docker/
│   ├── Dockerfile             ← Multi-stage, node:20-alpine
│   ├── docker-compose.yml
│   ├── build.sh               ← Build + tag image
│   ├── run.sh                 ← Start + health-check + follow logs
│   └── data/                  ← SQLite database (git-ignored)
└── docs/
    ├── ARCHITECTURE.md        ← System design + data flow
    └── CASAOS_DEPLOY.md       ← CasaOS step-by-step guide
```

---

## REST API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/ping` | Health check → `{"ok":true}` |
| `GET` | `/api/shared-playlists` | List shared playlists (with counts) |
| `POST` | `/api/shared-playlists` | Create shared playlist |
| `DELETE` | `/api/shared-playlists/:id` | Delete shared playlist |
| `GET` | `/api/shared-playlists/:id/tracks` | List active tracks |
| `GET` | `/api/links/:userId` | Get user's linked playlists |
| `POST` | `/api/links` | Link + return tracks for initial sync |
| `DELETE` | `/api/links/:id` | Unlink |
| `GET` | `/api/users` | Recent active users (admin panel) |
| `WS` | `/ws` | Real-time sync channel |

## WebSocket messages

| Direction | Type | Payload |
|-----------|------|---------|
| Client → Server | `auth` | `{ user_id }` |
| Client → Server | `track_added` | `{ shared_playlist_id, tidal_track_id }` |
| Client → Server | `track_removed` | `{ shared_playlist_id, tidal_track_id }` |
| Client → Server | `tracks_reordered` | `{ shared_playlist_id, positions[] }` |
| Server → Client | `track_added` | `{ shared_playlist_id, tidal_track_id, added_by, position, timestamp }` |
| Server → Client | `track_removed` | `{ shared_playlist_id, tidal_track_id, removed_by, timestamp }` |

---

## Configuration

| Setting | Where | Default |
|---------|-------|---------|
| Server URL | Extension popup | `http://192.168.100.31:3000` |
| Port | `docker-compose.yml` / `.env` | `3000` |
| Database path | `docker-compose.yml` / `.env` | `/app/data/db.sqlite` |
| Tidal token | Extension `chrome.storage.local` | auto-captured |

Tokens are **never sent to the server** — the server only sees numeric Tidal user IDs.

---

## Backup

```bash
# One-liner backup of the entire database
cp docker/data/db.sqlite backups/tidal-$(date +%Y%m%d).sqlite
```

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| Server runtime | Node.js 20 LTS |
| HTTP / WS framework | Express 4 + `ws` |
| Database | SQLite via `better-sqlite3` |
| Container | Docker on `node:20-alpine` |
| Browser extension | Chrome MV3, Service Worker |
| Admin panel | Vanilla HTML / CSS / JS |

---

## Roadmap

- [ ] Firefox extension (MV2 → MV3 polyfill)
- [ ] Track reorder sync (Tidal index-based move API)
- [ ] Granular permissions (view-only collaborators)
- [ ] Chrome Web Store distribution
- [ ] Pagination for large playlists (> 100 tracks)
- [ ] Offline queue (sync when reconnected)
