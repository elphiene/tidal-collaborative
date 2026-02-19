# Deploying to CasaOS

This guide walks through running **Tidal Collaborative** as a Docker container on CasaOS (or any home-lab Linux host).

---

## Prerequisites

| Requirement | Version | Check |
|-------------|---------|-------|
| Docker Engine | 24+ | `docker --version` |
| Docker Compose plugin | v2+ | `docker compose version` |
| Git | any | `git --version` |
| curl | any | `curl --version` |
| Free RAM | ≥ 128 MB | — |
| Free disk | ≥ 100 MB | — |

> **CasaOS note:** Docker and Docker Compose come pre-installed on CasaOS.
> If in doubt, open the CasaOS web UI → **App Store** → verify Docker is running.

---

## Step-by-step deployment

### 1 — Clone the repository onto CasaOS

SSH into your CasaOS machine (or open a terminal in the CasaOS web UI):

```bash
# Replace with wherever you keep your projects
cd /DATA/AppData
git clone https://github.com/yourname/tidal-collaborative.git
cd tidal-collaborative
```

### 2 — Enter the docker directory

All build and run scripts live here:

```bash
cd docker
```

### 3 — Build the Docker image

```bash
chmod +x build.sh run.sh
./build.sh
```

The build process:
1. Pulls `node:20-alpine` from Docker Hub (≈ 130 MB)
2. Installs only production dependencies (`npm ci --omit=dev`)
3. Copies the server and web UI into the image
4. Tags the image as `tidal-collaborative:latest` + a timestamped version

Expected output:
```
✓ Build complete!
  tidal-collaborative:latest   (95MB)
  tidal-collaborative:20260201-1430   (95MB)
```

> **First build takes 1–3 minutes** depending on download speed.
> Subsequent builds are much faster due to Docker layer caching.

### 4 — Start the server

```bash
./run.sh
```

The script:
1. Creates `docker/data/` for the SQLite database
2. Stops any running container
3. Starts the container in detached mode
4. Waits for the health check to pass
5. Tails the logs (press **Ctrl + C** to detach — the container keeps running)

### 5 — Verify the server is running

Open a browser or run:

```bash
curl http://192.168.100.31:3000/api/ping
# → {"ok":true,"ts":1706800000000}
```

Then open the **admin panel** at:

```
http://192.168.100.31:3000
```

### 6 — Load the Chrome extension

1. Open Chrome/Edge/Brave
2. Navigate to `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked**
5. Select the `extension/` folder from the cloned repo
6. Click the extension icon — enter `http://192.168.100.31:3000` and click **Connect**

---

## Configuration

All configuration is done through environment variables in `docker/docker-compose.yml`:

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP/WS server port |
| `NODE_ENV` | `production` | Runtime mode |
| `DB_PATH` | `/app/data/db.sqlite` | SQLite database path (inside container) |

To change the port, edit `docker-compose.yml`:
```yaml
ports:
  - "8080:3000"   # host:container — access on port 8080
```

Then restart: `docker compose down && docker compose up -d`

---

## Viewing logs

```bash
# Follow live logs
cd /DATA/AppData/tidal-collaborative/docker
docker compose logs -f

# Last 100 lines only
docker compose logs --tail=100

# Logs for a specific time range
docker compose logs --since="2026-02-01T10:00:00"
```

---

## Updating to a new version

```bash
cd /DATA/AppData/tidal-collaborative

# 1. Pull latest code
git pull

# 2. Rebuild the image
cd docker && ./build.sh --no-cache

# 3. Restart the container (data is preserved in docker/data/)
./run.sh --no-logs
```

The SQLite database in `docker/data/` is mounted as a Docker volume and is **never overwritten** by image rebuilds.

---

## Backing up the database

The entire database is a single file:

```bash
# Copy to a backup location
cp /DATA/AppData/tidal-collaborative/docker/data/db.sqlite \
   /DATA/Backups/tidal-collaborative-$(date +%Y%m%d).sqlite
```

To restore:
```bash
# Stop the container first
cd /DATA/AppData/tidal-collaborative/docker
docker compose down

# Replace the database
cp /DATA/Backups/tidal-collaborative-20260201.sqlite ./data/db.sqlite

# Start again
./run.sh
```

---

## Stopping and removing the container

```bash
cd /DATA/AppData/tidal-collaborative/docker

# Stop (data preserved)
docker compose down

# Stop + remove the image (full cleanup — data still preserved in ./data/)
docker compose down --rmi all
```

---

## Troubleshooting

### Container exits immediately

Check the logs:
```bash
docker compose logs tidal-collaborative
```

Common causes:
- **Port 3000 already in use** — change the host port in `docker-compose.yml`
- **Permission error on data dir** — `chmod 777 docker/data/` then restart

### "Could not reach server" in extension popup

- Confirm the container is running: `docker ps | grep tidal`
- Confirm you're connected to the home network or VPN
- Test from the browser: `http://192.168.100.31:3000/api/ping`
- Check firewall: `sudo ufw status` — port 3000 should be allowed

### Health check failing

```bash
# Manual check
docker exec tidal-collaborative curl -s http://localhost:3000/api/ping

# Inspect container health history
docker inspect tidal-collaborative --format='{{json .State.Health}}' | python3 -m json.tool
```

### Database is locked or corrupted

SQLite in WAL mode is robust, but if the container was force-killed:

```bash
docker compose down
sqlite3 docker/data/db.sqlite "PRAGMA integrity_check;"
# Should output: ok
docker compose up -d
```

### Out of disk space

```bash
# Check container and image sizes
docker system df

# Remove old versioned images (keeps latest)
docker images tidal-collaborative --format "{{.Tag}}" | grep -v latest | \
  xargs -I{} docker rmi tidal-collaborative:{}
```

---

## CasaOS app integration (optional)

If you want Tidal Collaborative to appear in the CasaOS dashboard:

1. Open CasaOS web UI → **Apps** → **Install a customized app**
2. Paste the contents of `docker/docker-compose.yml`
3. Set the icon URL and app name
4. Click **Submit**

CasaOS will manage the container lifecycle alongside your other apps.

---

## Network diagram

```
Your devices (VPN / home network)
         │
         │  http://192.168.100.31:3000
         ▼
  ┌──────────────────────────────────┐
  │   Docker container               │
  │   tidal-collaborative            │
  │                                  │
  │   ┌─────────────────────────┐   │
  │   │  Node.js + Express       │   │  ← serves admin panel
  │   │  WebSocket server        │   │  ← real-time sync
  │   └────────────┬────────────┘   │
  │                │                 │
  │   ┌────────────▼────────────┐   │
  │   │  SQLite DB               │   │
  │   │  /app/data/db.sqlite     │   │
  │   └─────────────────────────┘   │
  │              ▲                   │
  │    bind-mounted to               │
  │    docker/data/db.sqlite         │
  └──────────────────────────────────┘
         │  (mounted volume persists)
         ▼
  docker/data/db.sqlite  ←  backup this file!
```
