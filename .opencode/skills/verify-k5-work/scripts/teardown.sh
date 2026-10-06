#!/usr/bin/env bash
# Stop the instance scripts/launch.sh started. Nothing else.
#
#   scripts/teardown.sh <run-id>
#
# Kills only the pids recorded in the run directory, after confirming each one
# still belongs to this checkout. Never matches on process name: this agent's own
# argv contains the worktree path, so a pattern kill would take out the operator's
# own dev server and this session with it.
#
# Evidence survives. Screenshots, the ui-verify report, and the logs stay in
# .verify-k5/<run-id>/. Only the disposable session store is deleted.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
RUN_ID="${1:-local}"
RUN_DIR="$ROOT/.verify-k5/$RUN_ID"

if [ ! -d "$RUN_DIR" ]; then
  echo "teardown: nothing at $RUN_DIR"
  exit 0
fi

stop_one() {
  local pid="$1" want="$2" what="$3"
  [ -n "$pid" ] || return 0
  if [ ! -d "/proc/$pid" ]; then
    echo "  $what pid $pid already gone"
    rm -f "$RUN_DIR/$what.pid"
    return 0
  fi
  local cwd
  cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || echo '?')"
  case "$cwd" in
    "$want"*) ;;
    *)
      echo "  $what pid $pid cwd is $cwd, not under $want. Left running on purpose."
      return 0
      ;;
  esac
  kill -TERM "$pid" 2>/dev/null || true
  local tries=0
  while [ -d "/proc/$pid" ] && [ "$tries" -lt 40 ]; do
    sleep 0.25
    tries=$((tries + 1))
  done
  if [ -d "/proc/$pid" ]; then
    echo "  $what pid $pid ignored SIGTERM, sending SIGKILL"
    kill -KILL "$pid" 2>/dev/null || true
    sleep 0.5
  fi
  rm -f "$RUN_DIR/$what.pid"
  echo "  $what pid $pid stopped"
}

echo "teardown: run $RUN_ID"
stop_one "$(cat "$RUN_DIR/server.pid" 2>/dev/null || echo '')" "$ROOT" "server"
stop_one "$(cat "$RUN_DIR/web.pid" 2>/dev/null || echo '')" "$ROOT/apps/web" "web"

# The vite proxy holds an open child vite process when the wrapper is killed, so
# confirm the web port is actually free before declaring the run clean.
web_port="$(grep -oE 'K5_VERIFY_WEB_URL="http://127.0.0.1:[0-9]+"' "$RUN_DIR/env.sh" 2>/dev/null | grep -oE '[0-9]+$' || echo '')"
if [ -n "$web_port" ] && ss -H -ltn "sport = :$web_port" | grep -q .; then
  owner="$(ss -H -ltnp "sport = :$web_port" 2>/dev/null | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2 || true)"
  cwd="$(readlink -f "/proc/$owner/cwd" 2>/dev/null || echo '?')"
  case "$cwd" in
    "$ROOT"*) kill -KILL "$owner" 2>/dev/null || true; echo "  web port $web_port still held by pid $owner under $ROOT, killed" ;;
    *) echo "  web port $web_port held by pid $owner (cwd $cwd), left alone" ;;
  esac
fi

rm -rf "$RUN_DIR/data"
echo "  disposable store removed"
echo "  evidence kept in $RUN_DIR"
