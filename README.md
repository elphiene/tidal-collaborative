# Tidal Collaborative

Self-hosted real-time collaborative playlist sync for [Tidal](https://tidal.com). Sign in with your Tidal account in any browser, link a playlist, and every change — adds and removes — propagates to all collaborators automatically.

---

## How it works

```
Any browser (phone, desktop, tablet)
  └── Web UI  at http://your-server:3000
        ├── Sign in with Tidal (OAuth 2.1 PKCE)
        └── Link your Tidal playlist to a shared playlist

Server (Docker / home lab)
  ├── Polls each linked Tidal playlist every 30 seconds
  ├── Detects added / removed tracks via per-user journal
  ├── Writes changes to SQLite and propagates to all collaborators
  └── Pushes real-time notifications over WebSocket
```

### Sync flow

1. User adds or removes a track in their Tidal app
2. Server detects the change on the next poll (≤ 30 s)
3. Change is written to the shared journal in SQLite
4. Server pushes the change to every other collaborator's Tidal playlist
5. All open browser tabs receive a WebSocket notification instantly

---

## Features

- **Real-time sync** — adds and removes propagate to all collaborators within one poll cycle
- **Activity log** — full audit trail of every change with who, what, and when
- **Invite system** — invite-code links for private shared playlists
- **Admin panel** — manage playlists, users, sync settings, and force-sync individual links
- **Track deletion** — remove a track from the shared playlist and all linked Tidal playlists at once
- **Sync status** — per-user health indicator; surfaces rate limits and expired sessions
- **Prometheus metrics** — `/metrics` endpoint for Grafana or any compatible scraper
- **Browser-guided setup** — first-run wizard generates secrets and walks through Tidal app registration

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
curl -O https://raw.githubusercontent.com/elphiene/tidal-collaborative/master/docker/docker-compose.yml

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
npm run dev            # auto-restart on file change
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
│   │   ├── poller.js          ← Polling loop + journal sync engine
│   │   ├── db.js              ← SQLite wrapper (better-sqlite3)
│   │   ├── metrics.js         ← Prometheus metrics
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
│   ├── Dockerfile             ← node:20-alpine
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
| `GET` | `/api/auth/start` | — | Begin OAuth flow |
| `GET` | `/api/auth/callback` | — | OAuth redirect handler |
| `POST` | `/api/auth/logout` | session | Sign out |
| `GET` | `/api/me` | session | Current user info |
| `GET` | `/api/tidal/playlists` | session | User's Tidal playlists |
| `GET` | `/api/sync/status` | session | Per-user sync health |
| `GET` | `/api/shared-playlists` | — | List shared playlists |
| `GET` | `/api/shared-playlists/discover` | session | Discoverable public playlists |
| `POST` | `/api/shared-playlists` | admin | Create shared playlist |
| `PATCH` | `/api/shared-playlists/:id` | admin | Update shared playlist |
| `DELETE` | `/api/shared-playlists/:id` | admin | Delete shared playlist |
| `GET` | `/api/shared-playlists/:id/tracks` | — | List active tracks |
| `DELETE` | `/api/shared-playlists/:id/tracks/:trackId` | session | Remove track from all playlists |
| `POST` | `/api/shared-playlists/:id/tracks/reorder` | session | Reorder tracks |
| `GET` | `/api/shared-playlists/:id/linked-users` | — | Users linked to playlist |
| `POST` | `/api/shared-playlists/:id/invites` | admin | Create invite code |
| `GET` | `/api/shared-playlists/:id/invites` | admin | List invite codes |
| `DELETE` | `/api/invites/:id` | admin | Revoke invite |
| `GET` | `/api/invites/:code` | — | Look up invite |
| `GET` | `/api/links` | session | Current user's links |
| `POST` | `/api/links` | session | Link a Tidal playlist |
| `DELETE` | `/api/links/:id` | session | Unlink |
| `POST` | `/api/links/:id/sync` | session | Force full bidirectional sync |
| `GET` | `/api/users` | — | Active users (presence) |
| `GET` | `/api/journal` | session | Activity log (paginated) |
| `GET` | `/api/journal/stats` | session | Journal entry counts |
| `GET` | `/api/admin/status` | — | Admin PIN status |
| `POST` | `/api/admin/setup` | — | Set admin PIN (first use only) |
| `POST` | `/api/admin/auth` | — | Verify admin PIN |
| `GET` | `/api/admin/settings` | admin | Get server settings |
| `PATCH` | `/api/admin/settings` | admin | Update server settings |
| `POST` | `/api/admin/force-poll` | admin | Trigger immediate poll |
| `POST` | `/api/admin/users/:id/reset-sync` | admin | Clear sync error for a user |
| `WS` | `/ws` | session cookie | Real-time sync channel |
| `GET` | `/metrics` | — | Prometheus metrics |

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
- **AES-256-GCM encryption** — Tidal access and refresh tokens are encrypted at rest; a stolen `db.sqlite` is not enough to access Tidal accounts
- **Session cookies** — `httpOnly`, 30-day expiry; WebSocket connections authenticated via the same session cookie
- **Admin PIN** — gates the admin panel; set on first access and stored in the database

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
| Metrics | `prom-client` (Prometheus) |
