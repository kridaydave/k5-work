#!/usr/bin/env bash
# Is this k5-work instance worth driving? Read-only. Never starts or stops anything.
#
#   scripts/doctor.sh <run-id>
#
# Exits non-zero on the first thing that would make a drive meaningless: a dead
# process, a port that belongs to somebody else, a store outside the run
# directory, or a web origin the server will refuse at /ws upgrade time.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
RUN_ID="${1:-local}"
RUN_DIR="$ROOT/.verify-k5/$RUN_ID"
fails=0

fail() { echo "  FAIL  $*"; fails=$((fails + 1)); }
ok() { echo "  ok    $*"; }

if [ ! -f "$RUN_DIR/server.pid" ] || [ ! -f "$RUN_DIR/web.pid" ]; then
  echo "doctor.sh: no instance for run '$RUN_ID' at $RUN_DIR. Run scripts/launch.sh $RUN_ID." >&2
  exit 1
fi

source "$RUN_DIR/env.sh"
PORT="${K5_VERIFY_SERVER_URL##*:}"
WEB_PORT="${K5_VERIFY_WEB_URL##*:}"
server_pid="$(cat "$RUN_DIR/server.pid")"
web_pid="$(cat "$RUN_DIR/web.pid")"

# AGENTS.md rule 1: prove a pid is ours by its cwd, never by its name. A pattern
# kill or a name match here would take the operator's own dev server with it.
check_pid() {
  local pid="$1" want="$2" what="$3"
  if [ ! -d "/proc/$pid" ]; then
    fail "$what pid $pid is not running"
    return
  fi
  local cwd
  cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || echo '?')"
  case "$cwd" in
    "$want"*) ok "$what pid $pid, cwd $cwd" ;;
    *) fail "$what pid $pid cwd is $cwd, expected under $want" ;;
  esac
}

port_owner() { ss -H -ltnp "sport = :$1" 2>/dev/null | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2; }

echo "doctor: run $RUN_ID"
check_pid "$server_pid" "$ROOT" "server"
check_pid "$web_pid" "$ROOT/apps/web" "web"

owner="$(port_owner "$PORT")"
if [ "$owner" = "$server_pid" ]; then
  ok "server port $PORT is owned by our pid $server_pid"
elif [ -z "$owner" ]; then
  fail "server port $PORT has no listener"
else
  fail "server port $PORT is owned by pid $owner, not by our $server_pid"
fi

owner="$(port_owner "$WEB_PORT")"
if [ "$owner" = "$web_pid" ]; then
  ok "web port $WEB_PORT is owned by our pid $web_pid"
elif [ -z "$owner" ]; then
  fail "web port $WEB_PORT has no listener"
else
  fail "web port $WEB_PORT is owned by pid $owner, not by our $web_pid"
fi

health="$(curl -fsS --max-time 3 "$K5_VERIFY_SERVER_URL/health" 2>/dev/null || true)"
if [ "$health" = '{"status":"ok"}' ]; then
  ok "/health answered {\"status\":\"ok\"}"
else
  fail "/health answered '${health:-nothing}'"
fi

store_line="$(grep -m1 'k5 session store at' "$RUN_DIR/server.log" 2>/dev/null || true)"
case "$store_line" in
  *"$K5_VERIFY_RUN_DIR/data/k5-work"*) ok "session store is inside the run directory" ;;
  *) fail "session store line is '${store_line:-missing}'; transcripts are landing outside the run directory" ;;
esac

html="$(curl -fsS --max-time 3 "$K5_VERIFY_WEB_URL/" 2>/dev/null || true)"
case "$html" in
  *'<div id="root">'*) ok "web origin serves the app shell" ;;
  *) fail "web origin at $WEB_PORT did not serve the app shell" ;;
esac

if grep -q 'K5_ALLOWED_ORIGINS is unset' "$RUN_DIR/server.log" 2>/dev/null; then
  fail "server logged that K5_ALLOWED_ORIGINS is unset; /ws upgrades will be refused"
else
  ok "K5_ALLOWED_ORIGINS was accepted"
fi

# Same-origin by construction: the browser talks to the web origin only and vite
# forwards /api and /ws. A drive that hits the server origin directly is not
# exercising the proxy the app actually ships behind.
api="$(curl -fsS --max-time 3 "$K5_VERIFY_WEB_URL/api/projects" 2>/dev/null || true)"
case "$api" in
  *'"projects"'*) ok "/api/projects answers through the vite proxy" ;;
  *) fail "/api/projects through the proxy answered '${api:-nothing}'" ;;
esac

if grep -q 'k5-work server listening' "$RUN_DIR/server.log" 2>/dev/null; then
  ok "server booted: $(grep -m1 'k5-work server listening' "$RUN_DIR/server.log")"
else
  fail "server never logged its listening line"
fi

# A seat that still holds a session from an interrupted run refuses the next
# browser, so its prompt silently never runs and the answer never arrives. The
# symptom lands on the flow, not on the instance, which makes it read as a
# regression in the app. Caught here instead.
if grep -q 'seat-busy' "$RUN_DIR/server.log" 2>/dev/null; then
  fail "a seat is stuck holding a session from an interrupted run; the next prompt will never run. Relaunch with a fresh run id"
else
  ok "no seat is stuck holding a session"
fi

echo "  info  harness: $K5_VERIFY_HARNESS"

if [ "$fails" -gt 0 ]; then
  echo "doctor: $fails check(s) failed. Do not drive this instance."
  exit 1
fi
echo "doctor: all checks passed. Drive it."
