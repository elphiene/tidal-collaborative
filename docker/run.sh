#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# run.sh — Start (or restart) the Tidal Collaborative container
#
# Usage:  ./run.sh [--no-logs]
#
# Run from the docker/ directory:
#   cd docker && ./run.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FOLLOW_LOGS=true
SERVER_IP="${SERVER_IP:-192.168.100.31}"
SERVER_PORT="${PORT:-3000}"

for arg in "$@"; do
  case "$arg" in
    --no-logs) FOLLOW_LOGS=false ;;
    *) echo "Unknown argument: $arg" && exit 1 ;;
  esac
done

echo "╔══════════════════════════════════════════╗"
echo "║  Tidal Collaborative — Start Server      ║"
echo "╚══════════════════════════════════════════╝"
echo ""

cd "$SCRIPT_DIR"

# ── Ensure data directory exists (Docker will create it, but explicit is better)
mkdir -p ./data

# ── Stop any existing container gracefully ───────────────────────────────────
if docker ps -q --filter "name=tidal-collaborative" | grep -q .; then
  echo "→ Stopping existing container…"
  docker compose down
  echo ""
fi

# ── Start the container ──────────────────────────────────────────────────────
echo "→ Starting container…"
docker compose up -d

echo ""
echo "✓ Tidal Collaborative is running!"
echo ""
echo "  Admin panel  : http://${SERVER_IP}:${SERVER_PORT}"
echo "  Health check : http://${SERVER_IP}:${SERVER_PORT}/api/ping"
echo "  Data dir     : $(pwd)/data/"
echo ""

# ── Wait for health check to pass ───────────────────────────────────────────
echo "→ Waiting for server to become healthy…"
TRIES=0
MAX=20
until curl -fs "http://localhost:${SERVER_PORT}/api/ping" | grep -q '"ok"' 2>/dev/null; do
  TRIES=$((TRIES + 1))
  if [ "$TRIES" -ge "$MAX" ]; then
    echo ""
    echo "⚠  Server did not respond in time — check logs:"
    docker compose logs --tail=30
    exit 1
  fi
  printf "."
  sleep 1
done
echo ""
echo "✓ Server is healthy"
echo ""

# ── Follow logs (optional) ──────────────────────────────────────────────────
if [ "$FOLLOW_LOGS" = "true" ]; then
  echo "Following logs — press Ctrl+C to detach (container keeps running)"
  echo "────────────────────────────────────────────────────────────────"
  docker compose logs -f
fi
