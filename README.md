# Tidal Collaborative

Self-hosted real-time collaborative playlist sync for [Tidal](https://tidal.com). Sign in with your Tidal account in any browser, link a playlist, and every change — adds, removes — propagates to all collaborators automatically.

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
| Browser | Any modern browser |
| Network | Users must be on the home LAN or connected via VPN |
| Tidal | Account registered at [developer.tidal.com](https://developer.tidal.com) |

---

## Tidal developer app setup

You need a free Tidal developer application to enable sign-in. The setup wizard walks you through this — it shows the exact Redirect URI for your server and prompts you for the Client ID. You only need to:

1. Go to [developer.tidal.com](https://developer.tidal.com) and create an application
2. Add the Redirect URI shown by the wizard
3. Paste the **Client ID** into the wizard

---

## Quick start — Docker (recommended)

### Option A — Pull from Docker Hub (no build needed)

```bash
# 1. Download the compose file
curl -O https://raw.githubusercontent.com/elphiene/tidal-collaborative/main/docker/docker-compose.yml

# 2. Start the container (no secrets needed — generated automatically)
docker compose up -d

# 3. Open http://localhost:3000 — the setup wizard guides the rest
```

### Option B — Self-build from source

```bash
# 1. Clone the repo onto your home server
git clone https://github.com/elphiene/tidal-collaborative.git
cd tidal-collaborative/docker

# 2. Build and start
chmod +x build.sh run.sh publish.sh
./build.sh
./run.sh

# 3. Open http://localhost:3000 — the setup wizard guides the rest
```

The setup wizard handles all first-time configuration in the browser:
encryption keys and session secrets are generated automatically, and you'll
be guided through connecting your Tidal developer app and setting an admin PIN.

> Full CasaOS deployment guide: **[docs/CASAOS_DEPLOY.md](docs/CASAOS_DEPLOY.md)**

---

## Quick start — Development (no Docker)

```bash
cd server
npm install
npm start              # http://localhost:3000
```

Secrets are auto-generated on first run and stored in the SQLite database. You can optionally set them via environment variables in `server/.env` for deterministic local development.

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
| `GET` | `/api/setup/status` | — | Setup completion status |
| `POST` | `/api/setup/tidal-client-id` | — | Save Tidal Client ID |
| `GET` | `/api/setup/redirect-uri` | — | Compute OAuth redirect URI |
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
| `ENCRYPTION_KEY` | *(auto-generated)* | 64 hex chars. Encrypts stored Tidal tokens. If set in env, takes precedence over DB value. |
| `SESSION_SECRET` | *(auto-generated)* | Signs session cookies. If set in env, takes precedence over DB value. |
| `TIDAL_CLIENT_ID` | *(set via wizard)* | Tidal OAuth Client ID. If set in env, takes precedence over wizard value. |

Secrets are auto-generated on first run and stored in the database. Setting env vars overrides DB values (for existing deployments or advanced use).

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
