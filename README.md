# Tidal Collaborative

Self-hosted real-time collaborative playlist sync for [Tidal](https://tidal.com). Sign in with your Tidal account in any browser, link a playlist, and every change — adds, removes — propagates to all collaborators automatically. No browser extension required.

---

## How it works

```
Any browser (phone, desktop, tablet)
  └── Web UI  at http://your-server:3000
        ├── Sign in with Tidal (OAuth 2.1 PKCE)
        └── Link your Tidal playlist to a shared playlist

Server (Docker / home lab)
  ├── Polls each linked Tidal playlist every 60 seconds
  ├── Detects added / removed tracks via set-difference
  ├── Writes changes to SQLite
  ├── Propagates changes to all other linked playlists via Tidal API
  └── Pushes real-time notifications over WebSocket
```

### Sync flow

1. User adds a track to their Tidal playlist
2. Server detects the change on the next poll (≤ 60 s)
3. Track is written to the shared playlist in SQLite
4. Server calls the Tidal API to add the track to every other linked user's playlist
5. All open browser tabs receive a WebSocket notification instantly

---

## System requirements

| Component | Requirement |
|-----------|-------------|
| Server OS | Linux (CasaOS, Debian, Ubuntu, etc.) |
| Docker | Engine 24+ with Compose plugin v2+ |
| RAM | ≥ 128 MB free |
| Disk | ≥ 100 MB (image + DB) |
| Browser | Any modern browser (no extension needed) |
| Network | Users must be on the home LAN or connected via VPN |
| Tidal | Account registered at [developer.tidal.com](https://developer.tidal.com) |

---

## Tidal developer app setup

Before running the server you need a free Tidal developer app:

1. Go to [developer.tidal.com](https://developer.tidal.com) and create an application
2. Add the following **Redirect URIs**:
   - `http://localhost:3000/api/auth/callback`
   - `http://<your-server-ip>:3000/api/auth/callback`
3. Copy the **Client ID** — it goes in `server/src/tidal.js` as `TIDAL_CLIENT_ID`

---

## Quick start — Docker (recommended)

### Option A — Pull from Docker Hub (no build needed)

```bash
# 1. Download the compose file
curl -O https://raw.githubusercontent.com/elphiene/tidal-collaborative/main/docker/docker-compose.yml

# 2. Generate secrets (run each once, copy the output)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  # ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  # SESSION_SECRET

# 3. Paste the values into docker-compose.yml:
#    ENCRYPTION_KEY=<64-char hex>
#    SESSION_SECRET=<64-char hex>

# 4. Pull image and start
docker compose up -d
```

### Option B — Self-build from source

```bash
# 1. Clone the repo onto your home server
git clone https://github.com/elphiene/tidal-collaborative.git
cd tidal-collaborative/docker

# 2. Generate secrets (run each once, copy the output)
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  # ENCRYPTION_KEY
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  # SESSION_SECRET

# 3. Paste the values into docker-compose.yml:
#    ENCRYPTION_KEY=<64-char hex>
#    SESSION_SECRET=<64-char hex>

# 4. Make scripts executable, build, and start
chmod +x build.sh run.sh publish.sh
./build.sh
./run.sh
```

Open `http://<your-server-ip>:3000` in any browser and sign in with Tidal.

> Full CasaOS deployment guide: **[docs/CASAOS_DEPLOY.md](docs/CASAOS_DEPLOY.md)**

---

## Quick start — Development (no Docker)

```bash
cd server
npm install
cp .env.example .env   # fill in ENCRYPTION_KEY and SESSION_SECRET
npm start              # http://localhost:3000
```

Generate the secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## Project layout

```
tidal-collaborative/
├── server/                    ← Node.js backend
│   ├── src/
│   │   ├── index.js           ← Express + WebSocket bootstrap
│   │   ├── config.js          ← Environment variables
│   │   ├── crypto.js          ← AES-256-GCM token encryption
│   │   ├── tidal.js           ← Tidal v2 API client
│   │   ├── poller.js          ← 60-second polling loop + propagation
│   │   ├── db.js              ← SQLite wrapper (better-sqlite3)
│   │   └── routes/
│   │       ├── api.js         ← REST endpoints
│   │       └── ws.js          ← WebSocket handler
│   ├── db/
│   │   └── init.sql           ← Schema (idempotent)
│   └── .env.example
├── web-ui/                    ← User-facing web app (vanilla JS)
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── docker/
│   ├── Dockerfile             ← Multi-stage, node:20-alpine
│   ├── docker-compose.yml     ← Pulls image from Docker Hub
│   ├── docker-compose.build.yml ← Override to build locally
│   ├── build.sh               ← Build + tag + push image
│   ├── publish.sh             ← Multi-platform build + push (amd64 + arm64)
│   └── run.sh                 ← Start + health-check + follow logs
└── docs/
    ├── ARCHITECTURE.md        ← System design + data flow
    └── CASAOS_DEPLOY.md       ← CasaOS step-by-step guide
```

---

## REST API

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/api/ping` | — | Health check |
| `GET` | `/api/auth/start` | — | Begin OAuth flow → returns `authUrl` |
| `GET` | `/api/auth/callback` | — | OAuth redirect handler |
| `POST` | `/api/auth/logout` | session | Sign out |
| `GET` | `/api/me` | session | Current user info |
| `GET` | `/api/tidal/playlists` | session | User's Tidal playlists |
| `GET` | `/api/admin/status` | — | PIN status |
| `POST` | `/api/admin/setup` | — | Set admin PIN (first use only) |
| `POST` | `/api/admin/auth` | — | Verify admin PIN |
| `GET` | `/api/shared-playlists` | — | List shared playlists |
| `POST` | `/api/shared-playlists` | — | Create shared playlist |
| `DELETE` | `/api/shared-playlists/:id` | — | Delete shared playlist |
| `GET` | `/api/shared-playlists/:id/tracks` | — | List active tracks |
| `GET` | `/api/shared-playlists/:id/linked-users` | — | Users linked to playlist |
| `GET` | `/api/links` | session | Current user's links |
| `POST` | `/api/links` | session | Link a Tidal playlist |
| `DELETE` | `/api/links/:id` | session | Unlink |
| `GET` | `/api/users` | — | Active users (presence) |
| `WS` | `/ws` | session cookie | Real-time sync channel |

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP/WS listen port |
| `DB_PATH` | `./data/db.sqlite` | SQLite file path |
| `ENCRYPTION_KEY` | — | **Required.** 64 hex chars (32 bytes). Encrypts stored Tidal tokens. |
| `SESSION_SECRET` | — | **Required** in production. Signs session cookies. |

Set these in `server/.env` (development) or `docker-compose.yml` (Docker).

---

## Security model

- **OAuth PKCE** — authentication handled entirely server-side; no token ever touches the browser
- **AES-256-GCM encryption** — Tidal access and refresh tokens are encrypted at rest using `ENCRYPTION_KEY`; a stolen database file is not enough to access Tidal accounts
- **Session cookies** — `httpOnly`, 30-day expiry; WebSocket connections authenticated via the same session
- **Admin PIN** — 4-digit PIN gates the admin panel; stored in the database and set on first access

---

## Backup

```bash
# The entire state is one file
cp docker/data/db.sqlite backups/tidal-$(date +%Y%m%d).sqlite
```

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| Server runtime | Node.js 20 LTS |
| HTTP / WS | Express 4 + `ws` |
| Database | SQLite via `better-sqlite3` |
| Encryption | Node.js built-in `crypto` (AES-256-GCM) |
| Sessions | `express-session` |
| Tidal API | Official `openapi.tidal.com/v2` (JSON:API) |
| Container | Docker on `node:20-alpine` |
| Web UI | Vanilla HTML / CSS / JS |

---

## Roadmap

- [ ] Track reorder sync
- [ ] Granular permissions (view-only collaborators)
- [ ] Configurable poll interval per playlist
- [ ] Pagination for very large playlists (> 500 tracks)
