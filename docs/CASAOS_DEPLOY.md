# Deploying to CasaOS

This guide walks through installing **Tidal Collaborative** via the CasaOS web UI. No cloning or building required — the image is pulled directly from Docker Hub.

---

## Prerequisites

| Requirement | Version | Check |
|-------------|---------|-------|
| CasaOS | any recent | — |
| Docker Engine | 24+ (pre-installed on CasaOS) | `docker --version` |
| Free RAM | ≥ 128 MB | — |
| Free disk | ≥ 100 MB | — |

Node.js is only needed to generate secrets. You can run the commands below on any machine that has it — your laptop, a phone terminal app, etc.

---

## Before you start — Tidal developer app

You need a free Tidal developer application:

1. Go to [developer.tidal.com](https://developer.tidal.com) and sign in
2. Create a new application
3. Add this **Redirect URI**:
   - `http://<your-server-ip>:3000/api/auth/callback`
4. Copy the **Client ID** — you'll need it later

---

## Step 1 — Generate secrets

Run the following command **twice** (once for `ENCRYPTION_KEY`, once for `SESSION_SECRET`). This can be done on any machine with Node.js:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Save both 64-character hex strings — you'll paste them into the compose config in the next step.

> **Keep these safe.** `ENCRYPTION_KEY` encrypts stored Tidal tokens at rest. If it changes, all users must sign in again.

---

## Step 2 — Install via CasaOS UI

1. Open the CasaOS web UI
2. Go to **Apps** → **Install a customized app**
3. Click **Import** (or the compose/YAML tab)
4. Paste the following, replacing the two placeholder values with your generated secrets:

```yaml
services:
  tidal-collaborative:
    image: elphiene/tidal-collaborative:latest
    container_name: tidal-collaborative
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - /DATA/AppData/tidal-collaborative:/app/data
    environment:
      - NODE_ENV=production
      - PORT=3000
      - DB_PATH=/app/data/db.sqlite
      - ENCRYPTION_KEY=<paste-your-first-64-char-hex-here>
      - SESSION_SECRET=<paste-your-second-64-char-hex-here>
    networks:
      - tidal-network
    healthcheck:
      test: ["CMD", "curl", "-fs", "http://localhost:3000/api/ping"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 15s
    deploy:
      resources:
        limits:
          memory: 256M

networks:
  tidal-network:
    driver: bridge
```

5. Click **Submit** — CasaOS will pull the image and start the container

---

## Step 3 — Verify

```bash
curl http://<your-server-ip>:3000/api/ping
# → {"ok":true,"ts":...}
```

Then open `http://<your-server-ip>:3000` in any browser, click **Sign in with Tidal**, and complete the OAuth flow.

---

## Configuration

All configuration lives in the environment block of the compose above:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP/WS listen port |
| `NODE_ENV` | `production` | Runtime mode |
| `DB_PATH` | `/app/data/db.sqlite` | SQLite path inside the container |
| `ENCRYPTION_KEY` | — | **Required.** 64 hex chars. Encrypts stored Tidal tokens. |
| `SESSION_SECRET` | — | **Required.** Signs session cookies. Any long random string. |

To change the host port, edit the `ports:` line before submitting (or update the app in CasaOS):
```yaml
ports:
  - "8080:3000"   # access on port 8080
```

---

## Admin panel

The admin panel is at `http://<your-server-ip>:3000` under the **Admin** tab.

The first user to click **Admin** sets a 4-digit PIN. After that, the PIN is required to access admin features (create/delete shared playlists, view all users).

---

## Viewing logs

In the CasaOS UI, open the app card and click the **Logs** button.

Or via SSH:

```bash
docker logs tidal-collaborative -f

# Last 100 lines
docker logs tidal-collaborative --tail=100
```

---

## Updating to a new version

In the CasaOS UI, open the app card and click **Update** when a new version is available.

Or via SSH:

```bash
docker pull elphiene/tidal-collaborative:latest
docker compose -p tidal-collaborative up -d
```

The SQLite database in `/DATA/AppData/tidal-collaborative/` is a bind-mounted volume and is never touched by image updates.

---

## Backing up the database

The entire state is one file:

```bash
cp /DATA/AppData/tidal-collaborative/db.sqlite \
   /DATA/Backups/tidal-$(date +%Y%m%d).sqlite
```

To restore:

```bash
docker stop tidal-collaborative
cp /DATA/Backups/tidal-20260201.sqlite /DATA/AppData/tidal-collaborative/db.sqlite
docker start tidal-collaborative
```

> After restoring a backup, all users will need to sign in again only if the
> `ENCRYPTION_KEY` is different from when the backup was made.

---

## Stopping and removing the container

Use the CasaOS UI app card to stop or uninstall the container.

Or via SSH:

```bash
# Stop (data preserved)
docker stop tidal-collaborative

# Remove container (data still preserved in /DATA/AppData/tidal-collaborative/)
docker rm tidal-collaborative
docker rmi elphiene/tidal-collaborative
```

---

## Troubleshooting

### Container exits immediately

```bash
docker logs tidal-collaborative
```

Common causes:
- **`ENCRYPTION_KEY` not set or wrong length** — must be exactly 64 hex characters
- **Port 3000 already in use** — change the host port in the compose config
- **Permission error on data dir** — `chmod 777 /DATA/AppData/tidal-collaborative/` then restart

### Sign-in fails with "invalid_state" or "11102"

- Confirm the redirect URI registered in [developer.tidal.com](https://developer.tidal.com) exactly matches `http://<your-server-ip>:3000/api/auth/callback`
- Check for trailing slashes or `https` vs `http` mismatches

### Users signed out after restart

If the `ENCRYPTION_KEY` changed (or was not set) since users last signed in, their stored tokens are unreadable and they must sign in again. Keep the key stable across restarts.

### Health check failing

```bash
docker exec tidal-collaborative curl -s http://localhost:3000/api/ping
docker inspect tidal-collaborative --format='{{json .State.Health}}' | python3 -m json.tool
```

### Database locked or corrupted

SQLite in WAL mode is robust, but if the container was force-killed:

```bash
docker stop tidal-collaborative
sqlite3 /DATA/AppData/tidal-collaborative/db.sqlite "PRAGMA integrity_check;"
# Should output: ok
docker start tidal-collaborative
```

---

## Optional — Build the image from source

If you prefer to build locally instead of pulling from Docker Hub, clone the repo and use the provided scripts:

```bash
cd /DATA/AppData
git clone https://github.com/elphiene/tidal-collaborative.git
cd tidal-collaborative/docker

# Single-platform local build
chmod +x build.sh
./build.sh

# Multi-platform build + push to Docker Hub (maintainers only)
chmod +x publish.sh
./publish.sh
```

One-time buildx setup required for `publish.sh`:
```bash
docker buildx create --name mybuilder --use
docker buildx inspect --bootstrap
```

---

## Network layout

```
Your devices (home LAN or VPN)
         │
         │  http://<server-ip>:3000
         ▼
  ┌──────────────────────────────────┐
  │   Docker container               │
  │   tidal-collaborative            │
  │                                  │
  │   Node.js + Express              │
  │   ├── Serves web UI              │
  │   ├── REST API  /api/*           │
  │   ├── WebSocket /ws              │
  │   └── Polling loop (60s)         │
  │         └── openapi.tidal.com ──►│── Tidal API (outbound)
  │                                  │
  │   SQLite  /app/data/db.sqlite    │
  └──────────────────────────────────┘
         │  (bind-mounted volume)
         ▼
  /DATA/AppData/tidal-collaborative/db.sqlite  ← back this up
```
