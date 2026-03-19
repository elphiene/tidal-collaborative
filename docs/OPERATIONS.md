# Tidal Collaborative — Operations Guide

Terminal reference for running, monitoring, and maintaining the server.

---

## Two Ways to Run

| Mode | When to use |
|------|-------------|
| **Docker** (recommended) | Production / home-lab. Auto-restarts on crash or reboot. |
| **Node directly** | Local development. File-watching, instant restarts. |

---

## Docker (Production)

All Docker commands run from the `docker/` directory.

```bash
cd /path/to/tidal-collaborative/docker
```

### Start

```bash
./run.sh
```

Pulls the image if needed, stops any existing container, starts a new one, waits for the health check to pass, then follows logs. Press **Ctrl+C** to stop following logs — the container keeps running.

```bash
./run.sh --no-logs   # start without attaching to logs
```

### Stop

```bash
docker compose down
```

Stops and removes the container. The database is safe — it lives in the volume at `/DATA/AppData/tidal-collaborative/`.

### Restart

```bash
docker compose restart
```

Or to do a full stop/start cycle (picks up any compose changes):

```bash
docker compose down && ./run.sh --no-logs
```

### Status

```bash
docker ps --filter name=tidal-collaborative
```

Shows whether the container is running and its health status (`healthy` / `starting` / `unhealthy`).

```bash
docker inspect --format='{{.State.Health.Status}}' tidal-collaborative
```

### Logs

```bash
# Follow live logs
docker compose logs -f

# Last N lines
docker compose logs --tail=100

# Since a specific time
docker compose logs --since=1h

# Filter for a keyword (poller activity, errors, etc.)
docker compose logs -f | grep -E '\[poll\]|\[sync\]|\[api\]|ERROR'
```

### Health check

```bash
curl -s http://localhost:3000/api/ping
# Expected: {"ok":true}
```

### Update to latest image

```bash
docker compose pull
docker compose down
./run.sh --no-logs
```

---

## Node Directly (Development)

```bash
cd /path/to/tidal-collaborative/server
```

### Install dependencies (first time only)

```bash
npm install
```

### Start with auto-reload

```bash
npm run dev
```

Uses Node's built-in `--watch` flag. Any file change under `src/` restarts the server automatically. Logs print directly to the terminal. Stop with **Ctrl+C**.

### Start without auto-reload

```bash
npm start
```

### Run in background (simple, no Docker)

```bash
nohup npm start > ../server.log 2>&1 &
echo $! > ../server.pid
```

Stop it later:

```bash
kill $(cat ../server.pid)
```

---

## Data & Persistence

| What | Where |
|------|-------|
| SQLite database | Docker: `/DATA/AppData/tidal-collaborative/db.sqlite` |
| SQLite database | Node direct: `server/data/db.sqlite` (default) |
| Secrets (enc key, session secret) | Stored inside the DB, generated on first start |

The database survives container restarts and image updates as long as the volume is mounted. **Do not delete the volume** unless you want to wipe all users, playlists, and secrets.

### Backup the database

```bash
# Copy the live DB (SQLite is safe to copy-file when using WAL mode)
cp /DATA/AppData/tidal-collaborative/db.sqlite ~/tidal-backup-$(date +%Y%m%d).sqlite
```

Or use SQLite's own backup command (zero downtime, consistent):

```bash
sqlite3 /DATA/AppData/tidal-collaborative/db.sqlite ".backup ~/tidal-backup-$(date +%Y%m%d).sqlite"
```

### Inspect the database

```bash
sqlite3 /DATA/AppData/tidal-collaborative/db.sqlite

# Useful queries:
.tables
SELECT user_id, display_name FROM users;
SELECT * FROM shared_playlists;
SELECT * FROM playlist_links;
SELECT COUNT(*) FROM tracks WHERE removed_at IS NULL;
.quit
```

---

## Building a New Image

After making code changes, rebuild and redeploy:

```bash
cd docker

# Build single-platform image locally (faster)
./build.sh

# Build + push multi-platform (amd64 + arm64) to Docker Hub
./publish.sh

# Then restart the container to use the new image
./run.sh --no-logs
```

Add `--no-cache` to force a clean build:

```bash
./build.sh --no-cache
```

---

## Common Issues

### Container won't start / stays unhealthy

```bash
docker compose logs --tail=50
```

Look for startup errors. Common causes:
- Port 3000 already in use — check with `ss -tlnp | grep 3000`
- Volume path doesn't exist or has wrong permissions

### Server starts but polls fail

Check logs for `[poll]` lines. Token errors mean a user needs to sign out and back in via the web UI. The server auto-removes users with dead refresh tokens.

```bash
docker compose logs -f | grep -E '\[poll\]|\[sync\]|error|Error'
```

### Rate limit errors from Tidal

The poller has built-in delays (500ms between playlists, 150ms between pages). If 429s appear in logs, they are retried automatically with the `Retry-After` header respected. No action needed unless they persist.

### Reset everything (nuclear)

```bash
docker compose down
rm /DATA/AppData/tidal-collaborative/db.sqlite
./run.sh
```

This wipes all users, playlists, links, tracks, and secrets. The server regenerates secrets on next start.

---

## Port / Environment

Defaults (set in `docker-compose.yml`):

| Variable | Default |
|----------|---------|
| `PORT` | `3000` |
| `DB_PATH` | `/app/data/db.sqlite` |
| `NODE_ENV` | `production` |

To change the host port, edit the `ports:` line in `docker-compose.yml`:

```yaml
ports:
  - "8080:3000"   # expose on host port 8080
```
