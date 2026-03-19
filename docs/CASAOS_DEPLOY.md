# Deploying to CasaOS

This guide walks through installing **Tidal Collaborative** via the CasaOS web UI. No cloning, building, or terminal access required — the image is pulled directly from Docker Hub and a setup wizard handles all configuration in the browser.

---

## Prerequisites

| Requirement | Version | Check |
|-------------|---------|-------|
| CasaOS | any recent | — |
| Docker Engine | 24+ (pre-installed on CasaOS) | `docker --version` |
| Free RAM | ≥ 128 MB | — |
| Free disk | ≥ 100 MB | — |

---

## Step 1 — Install via CasaOS UI

1. Open the CasaOS web UI
2. Go to **Apps** → **Install a customized app**
3. Click **Import** (or the compose/YAML tab)
4. Paste the following compose config:

```yaml
x-casaos:
  architectures:
    - amd64
    - arm64
  main: tidal-collaborative
  author: elphiene
  category: Media
  title:
    en_us: Tidal Collaborative
  tagline:
    en_us: Collaborative Tidal playlist sync
  description:
    en_us: Self-hosted server that lets multiple users share and sync Tidal playlists in real time. Changes propagate automatically — no browser extension required.
  port_map: "3000"
  scheme: http
  index: /
  tips: {}

services:
  tidal-collaborative:
    image: elphiene/tidal-collaborative:latest
    pull_policy: always
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

## Step 2 — Open the setup wizard

Navigate to `http://<your-server-ip>:3000` in any browser. The setup wizard will guide you through:

1. **Server setup** — encryption keys and session secrets are generated automatically (no terminal needed)
2. **Connect Tidal** — the wizard shows you the exact Redirect URI to register in the Tidal developer portal, then asks for your Client ID
3. **Set admin PIN** — choose a 4-digit PIN to protect the admin panel

### Registering a Tidal developer app (step 2 of the wizard)

You need a free Tidal developer application:

1. Go to [developer.tidal.com](https://developer.tidal.com) and sign in (or create an account)
2. Create a new application
3. Copy the **Redirect URI** shown in the wizard and add it exactly as-is to your app
4. Copy the **Client ID** and paste it into the wizard

> The wizard shows you the exact Redirect URI for your server — no guessing required.

---

## Step 3 — Verify

```bash
curl http://<your-server-ip>:3000/api/ping
# → {"ok":true,"ts":...}
```

Then open `http://<your-server-ip>:3000` in any browser and click **Sign in with Tidal**.

---

## Configuration

All configuration is handled via the setup wizard on first run. The data volume at `/DATA/AppData/tidal-collaborative/` stores the SQLite database which includes all settings (including the auto-generated secrets).

Optional environment variables (override wizard-set values for advanced use):

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP/WS listen port |
| `NODE_ENV` | `production` | Runtime mode |
| `DB_PATH` | `/app/data/db.sqlite` | SQLite path inside the container |
| `ENCRYPTION_KEY` | *(auto-generated)* | 64 hex chars. Encrypts stored Tidal tokens. |
| `SESSION_SECRET` | *(auto-generated)* | Signs session cookies. |
| `TIDAL_CLIENT_ID` | *(set via wizard)* | Tidal OAuth Client ID. |

To change the host port, edit the `ports:` line before submitting (or update the app in CasaOS):
```yaml
ports:
  - "8080:3000"   # access on port 8080
```

---

## Admin panel

The admin panel is at `http://<your-server-ip>:3000` under the **Admin** tab.

The 4-digit PIN is set during the setup wizard. After that, the PIN is required to access admin features (create/delete shared playlists, view all users).

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

The SQLite database in `/DATA/AppData/tidal-collaborative/` is a bind-mounted volume and is never touched by image updates. All settings (including secrets and Tidal Client ID) persist across updates.

---

## Backing up the database

The entire state (including secrets and configuration) is one file:

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
> `ENCRYPTION_KEY` is different from when the backup was made. Since keys are
> stored in the database, restoring the same backup restores the same key.

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

### CasaOS shows old version after redeploy

CasaOS caches Docker images locally and won't pull a new `latest` automatically. Force a pull via SSH:

```bash
docker pull elphiene/tidal-collaborative:latest
docker restart tidal-collaborative
```

The compose config now includes `pull_policy: always`, which ensures `docker compose up` always checks Docker Hub for a newer image. If your CasaOS install is using an older compose config without this line, update it in the CasaOS UI (**Apps → Edit** the app's compose YAML) and add:

```yaml
    pull_policy: always
```

### Container exits immediately

```bash
docker logs tidal-collaborative
```

Common causes:
- **Port 3000 already in use** — change the host port in the compose config
- **Permission error on data dir** — `chmod 777 /DATA/AppData/tidal-collaborative/` then restart

### Sign-in fails with "invalid_state" or "11102"

- Confirm the redirect URI registered in [developer.tidal.com](https://developer.tidal.com) exactly matches the one shown in the setup wizard
- Check for trailing slashes or `https` vs `http` mismatches

### Users signed out after restart

This happens only if the `ENCRYPTION_KEY` changed since users last signed in. In normal operation, the key is stored in the database and persists across restarts — so this should not happen unless the data volume was lost or replaced.

### Need to re-run the setup wizard

If you need to reconfigure (e.g. change the Tidal Client ID), you can reset setup state via the database:

```bash
docker exec -it tidal-collaborative sh
sqlite3 /app/data/db.sqlite "DELETE FROM settings WHERE key IN ('tidal_client_id', 'admin_pin');"
```

Then refresh the app in the browser — the wizard will reappear.

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
