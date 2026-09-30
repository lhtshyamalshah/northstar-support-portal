#!/usr/bin/env bash
# Smoke test against the running compose stack. Exit 0 = healthy.
# SMOKE_BASE_URL lets the platform point these same checks at a load balancer
# (ECS deploys run this script from outside the task); default is the local stack.
set -uo pipefail
BASE="${SMOKE_BASE_URL:-http://localhost:${APP_PORT:-3000}}"
FAIL=0

check() { # label, url, expected-substring (optional)
  local label="$1" url="$2" want="${3:-}"
  local body code
  body=$(curl -sS --max-time 10 "$url" 2>&1)
  code=$?
  if [ $code -ne 0 ]; then echo "SMOKE: $label FAILED (curl exit $code): $body"; FAIL=1; return; fi
  if [ -n "$want" ] && ! grep -q "$want" <<<"$body"; then
    echo "SMOKE: $label FAILED (missing '$want'): ${body:0:200}"; FAIL=1; return
  fi
  echo "SMOKE: $label ok"
}

# The Express process serves both the API and the built SPA, so everything is
# same-origin on APP_PORT.
check "backend health" "$BASE/api/health" '"ok":true'
# SPA shell served from dist/. <div id="root"> is the mount point in index.html.
check "SPA shell" "$BASE/" 'id="root"'
# Read-only API route that proves the order data is reachable.
check "orders API" "$BASE/api/orders" '"orders"'

exit $FAIL
