#!/usr/bin/env bash
# Platform deploy entrypoint. Runs from the bundle root on the target instance.
# stdout contract: a single SMOKE_PASS / SMOKE_FAIL sentinel on the last line.
set -uo pipefail
cd "$(dirname "$0")/.."
LOG=/tmp/zbrain-deploy.log
: > "$LOG"

fail() { echo "$1" >&2; echo "SMOKE_FAIL"; exit 1; }

# 1. Governance preflight — the backend fails closed when registration is
#    unreachable, so prove connectivity before spending time on containers.
if [ "${ZBRAIN_GOVERNANCE:-true}" != "false" ]; then
  if [ -z "${ZBRAIN_GOVERNANCE_BASE_URL:-}" ]; then
    fail "PREFLIGHT_FAIL: governance is enabled but ZBRAIN_GOVERNANCE_BASE_URL was not injected — platform configuration issue; app bundle not at fault."
  fi
  gov_code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$ZBRAIN_GOVERNANCE_BASE_URL" 2>>"$LOG") \
    || fail "PREFLIGHT_FAIL: governance service unreachable from this instance ($ZBRAIN_GOVERNANCE_BASE_URL) — egress/security-group/DNS issue; app bundle not at fault."
  case "$gov_code" in
    5??) fail "PREFLIGHT_FAIL: governance service returned HTTP $gov_code from this instance — governance-service outage; app bundle not at fault." ;;
  esac
fi

# 2. Bring up the same stack the user runs, then smoke — all noise to the log.
if { bash ./run.sh && bash .zbrain/smoke.sh; } >>"$LOG" 2>&1; then
  echo "SMOKE_PASS"
else
  # MOST IMPORTANT FIRST — only the first ~8,000 characters of stderr survive.
  {
    echo "---- compose ps ----"
    docker compose ps
    echo "---- service logs (most recent) ----"
    docker compose logs --no-color --tail=40
    echo "---- deploy log tail ----"
    tail -n 20 "$LOG"
  } >&2
  echo "SMOKE_FAIL"
  exit 1
fi
