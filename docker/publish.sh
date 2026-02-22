#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# publish.sh — Build multi-platform image and push to Docker Hub
#
# Requires: docker buildx (included in Docker Desktop and Engine 19.03+)
# Usage:    ./publish.sh
#
# One-time builder setup (run once per machine):
#   docker buildx create --name mybuilder --use
#   docker buildx inspect --bootstrap
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
VERSION="$(date +%Y%m%d-%H%M)"
IMAGE="elphiene/tidal-collaborative"

echo "╔══════════════════════════════════════════╗"
echo "║  Tidal Collaborative — Multi-platform    ║"
echo "║  Docker Hub Publish                      ║"
echo "╚══════════════════════════════════════════╝"
echo ""
echo "  Image     : $IMAGE"
echo "  Tags      : latest, $VERSION"
echo "  Platforms : linux/amd64, linux/arm64"
echo ""

# ── Sanity checks ────────────────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  echo "✗ Docker not found — install Docker first." && exit 1
fi

if ! docker info &>/dev/null; then
  echo "✗ Docker daemon not running — start it first." && exit 1
fi

if ! docker buildx version &>/dev/null; then
  echo "✗ docker buildx not available — upgrade to Docker Engine 19.03+." && exit 1
fi

# ── Build + push ─────────────────────────────────────────────────────────────
echo "→ Building $IMAGE:latest and $IMAGE:$VERSION"
echo "  Platforms: linux/amd64, linux/arm64"
echo ""

docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --file "$SCRIPT_DIR/Dockerfile" \
  --tag "$IMAGE:latest" \
  --tag "$IMAGE:$VERSION" \
  --push \
  "$PROJECT_ROOT"

echo ""
echo "✓ Published $IMAGE:latest  ($IMAGE:$VERSION)"
echo ""
echo "  Verify at: https://hub.docker.com/r/$IMAGE"
