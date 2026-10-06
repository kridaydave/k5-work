#!/usr/bin/env bash
# Count harness children the server still owns. Read-only.
#
#   scripts/check-seats.sh <run-id>
#
# The server registers every ACP child it spawns and reaps them on shutdown. An
# orphan is invisible in the UI and shows up on the operator's machine an hour
# later as a stray node process eating a core. Run this after a drive, before
# calling the run clean.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
RUN_ID="${1:-local}"
RUN_DIR="$ROOT/.verify-k5/$RUN_ID"

if [ ! -f "$RUN_DIR/server.pid" ]; then
  echo "check-seats: no instance for run '$RUN_ID'"
  exit 1
fi
server_pid="$(cat "$RUN_DIR/server.pid")"
if [ ! -d "/proc/$server_pid" ]; then
  echo "check-seats: server pid $server_pid is not running, so it owns nothing"
  exit 0
fi

# shellcheck source=/dev/null
source "$RUN_DIR/env.sh"

# The child pids come from the server's own registry via its audit log, not from
# a process scan. A scan would match this agent, the operator's dev server, and
# every other node process on the box.
children="$(pgrep -P "$server_pid" 2>/dev/null | tr '\n' ' ')"
count="$(echo "$children" | wc -w | tr -d ' ')"

echo "check-seats: server $server_pid owns $count child process(es)"
if [ "$count" -gt 0 ]; then
  for pid in $children; do
    echo "  child $pid  $(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | cut -c1-90)"
  done
fi

# The store is the other thing that must not have leaked. It is SQLite, not a
# directory of files, so the count comes from the API the app itself reads.
sessions="unreadable"
if [ -f "$RUN_DIR/data/k5-work/k5.db" ]; then
  sessions="$(curl -fsS --max-time 3 "$K5_VERIFY_SERVER_URL/api/sessions" 2>/dev/null \
    | grep -oE '"storeId":' | wc -l | tr -d ' ')"
fi
echo "check-seats: $sessions stored task(s) in $RUN_DIR/data/k5-work/k5.db"

if [ "$count" -gt 1 ]; then
  echo "check-seats: more than one harness child. Each seat is one child; investigate before reporting a pass."
  exit 1
fi
echo "check-seats: ok"
