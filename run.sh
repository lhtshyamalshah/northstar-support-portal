#!/usr/bin/env bash
# One-command production run. Loads prebuilt images (*.image.tar.gz) when
# present; builds locally only as a fallback.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required but was not found. Install Docker Desktop and retry." >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "The Docker daemon is not running. Start Docker and retry." >&2
  exit 1
fi

shopt -s nullglob
tarballs=(*.image.tar.gz)
if ((${#tarballs[@]})); then
  for t in "${tarballs[@]}"; do docker load -i "$t"; done
else
  docker compose build || DOCKER_BUILDKIT=0 docker compose build
fi
docker compose up -d --no-build

BASE="http://localhost:${APP_PORT:-3000}"
HEALTH="${APP_HEALTH_PATH:-/api/health}"
for i in $(seq 1 24); do
  if curl -sf --max-time 5 "$BASE$HEALTH" >/dev/null 2>&1; then
    echo "✅ Northstar Support Portal is running at $BASE"
    exit 0
  fi
  sleep 5
done
echo "App did not become healthy at $BASE$HEALTH — inspect with: docker compose logs" >&2
exit 1
