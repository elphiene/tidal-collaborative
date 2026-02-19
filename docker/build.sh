#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# build.sh — Build the Tidal Collaborative Docker image
#
# Usage:  ./build.sh [--no-cache]
#
# Run from the docker/ directory:
#   cd docker && ./build.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
VERSION="$(date +%Y%m%d-%H%M)"
NO_CACHE=""

# ── Parse args ───────────────────────────────────────────────────────────────
for arg in "$@"; do
  case "$arg" in
    --no-cache) NO_CACHE="--no-cache" ;;
    *) echo "Unknown argument: $arg" && exit 1 ;;
  esac
done

echo "╔══════════════════════════════════════════╗"
echo "║  Tidal Collaborative — Docker Build      ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "  Project root : $PROJECT_ROOT"
echo "  Build tag    : tidal-collaborative:$VERSION"
echo "  No-cache     : ${NO_CACHE:-off}"
echo ""

# ── Sanity checks ────────────────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  echo "✗ Docker not found — install Docker first." && exit 1
fi

if ! docker info &>/dev/null; then
  echo "✗ Docker daemon not running — start it first." && exit 1
fi

# ── Build ────────────────────────────────────────────────────────────────────
cd "$SCRIPT_DIR"

echo "→ Building image…"
docker compose build $NO_CACHE

# Tag with a timestamped version for easy rollback
docker tag tidal-collaborative:latest "tidal-collaborative:$VERSION"

echo ""
echo "✓ Build complete!"
echo ""
echo "  Images:"
docker images tidal-collaborative --format "  {{.Repository}}:{{.Tag}}  ({{.Size}})"
echo ""
echo "  Next step:"
echo "    cd docker && ./run.sh"
