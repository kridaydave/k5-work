#!/usr/bin/env bash
# Start one isolated k5-work instance for verification and print how to drive it.
#
#   scripts/launch.sh <run-id>
#
# Isolation is the whole point of this script. The ports sit next to the
# documented dev defaults so a running `npm run dev` is never touched, and the
# session store is redirected with XDG_DATA_HOME so a verification run cannot
# read or overwrite the transcripts in ~/.local/share/k5-work.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
RUN_ID="${1:-local}"
RUN_DIR="$ROOT/.verify-k5/$RUN_ID"

PORT="${K5_VERIFY_PORT:-8788}"
WEB_PORT="${K5_VERIFY_WEB_PORT:-5174}"
# The deterministic in-repo ACP agent. Deterministic means the answer text and
# the tool card are known in advance, so a failed assertion names a real
# regression instead of "the model said something else". Swap in a real harness
# with K5_VERIFY_ACP_COMMAND when the thing under test is harness behavior.
HARNESS="${K5_VERIFY_ACP_COMMAND:-node $ROOT/server/dist/acp/fake-agent.js ok}"

if [ -e "$RUN_DIR/server.pid" ] || [ -e "$RUN_DIR/web.pid" ]; then
  echo "launch.sh: run '$RUN_ID' already exists at $RUN_DIR." >&2
  echo "Pick another run id, or run scripts/teardown.sh $RUN_ID first." >&2
  exit 1
fi
if [ ! -f "$ROOT/server/dist/index.js" ]; then
  echo "launch.sh: server/dist is missing. Build it first:" >&2
  echo "  npm run build -w shared && npm run build -w server" >&2
  exit 1
fi
if [ ! -f "$ROOT/server/dist/acp/fake-agent.js" ] && [ "$HARNESS" = "node $ROOT/server/dist/acp/fake-agent.js ok" ]; then
  echo "launch.sh: server/dist/acp/fake-agent.js is missing. Rebuild the server." >&2
  exit 1
fi
if [ ! -d "$ROOT/node_modules/vite" ]; then
  echo "launch.sh: node_modules is missing. Run npm install at the repo root." >&2
  exit 1
fi

for p in "$PORT" "$WEB_PORT"; do
  if ss -H -ltn "sport = :$p" | grep -q .; then
    echo "launch.sh: port $p is already in use. Set K5_VERIFY_PORT / K5_VERIFY_WEB_PORT." >&2
    exit 1
  fi
done

mkdir -p "$RUN_DIR/data"

# setsid so the instance is its own process group. An agent shell that is
# interrupted mid-run takes its children down with it otherwise, and a half-dead
# instance is worse than no instance: doctor will pass and the drive will fail on
# something that has nothing to do with the change under test.
#
# No --env-file flag on purpose: a developer's .env in the repo root must not
# decide which harness or which ports a verification run uses.
setsid env -u ACP_COMMAND \
  XDG_DATA_HOME="$RUN_DIR/data" \
  PORT="$PORT" \
  HOST=127.0.0.1 \
  K5_ALLOWED_ORIGINS="http://127.0.0.1:$WEB_PORT" \
  ACP_COMMAND="$HARNESS" \
  node "$ROOT/server/dist/index.js" >"$RUN_DIR/server.log" 2>&1 &
server_pid=$!
echo "$server_pid" >"$RUN_DIR/server.pid"

setsid env K5_SERVER_ORIGIN="http://127.0.0.1:$PORT" \
  bash -c 'cd "$1" && exec node "$2/node_modules/vite/bin/vite.js" --host 127.0.0.1 --port "$3" --strictPort' \
  _ "$ROOT/apps/web" "$ROOT" "$WEB_PORT" >"$RUN_DIR/web.log" 2>&1 &
web_pid=$!
echo "$web_pid" >"$RUN_DIR/web.pid"

# disown on top of setsid. setsid detaches the session, but the job is still a
# child of the invoking shell, and an agent harness that tears down the shell's
# children takes the instance with it. The failure looks like the app crashing:
# one of the two processes survives and the other does not, and the next flow
# fails on a "Failed to fetch" that has nothing to do with the change under test.
disown "$server_pid" "$web_pid" 2>/dev/null || true

wait_for() {
  local url="$1" what="$2" tries=0
  until curl -fsS -o /dev/null --max-time 2 "$url" 2>/dev/null; do
    tries=$((tries + 1))
    if [ "$tries" -ge 60 ]; then
      echo "launch.sh: $what never answered at $url." >&2
      echo "--- server.log" >&2; tail -20 "$RUN_DIR/server.log" >&2 || true
      echo "--- web.log" >&2; tail -20 "$RUN_DIR/web.log" >&2 || true
      exit 1
    fi
    sleep 0.5
  done
}

wait_for "http://127.0.0.1:$PORT/health" "the server"
wait_for "http://127.0.0.1:$WEB_PORT/" "the web dev server"

cat >"$RUN_DIR/env.sh" <<EOF
export K5_VERIFY_RUN_ID="$RUN_ID"
export K5_VERIFY_RUN_DIR="$RUN_DIR"
export K5_VERIFY_SERVER_URL="http://127.0.0.1:$PORT"
export K5_VERIFY_WEB_URL="http://127.0.0.1:$WEB_PORT"
export K5_VERIFY_HARNESS="$HARNESS"
EOF

echo "run id      $RUN_ID"
echo "web         http://127.0.0.1:$WEB_PORT"
echo "server      http://127.0.0.1:$PORT  (/health)"
echo "store       $RUN_DIR/data/k5-work"
echo "harness     $HARNESS"
echo "logs        $RUN_DIR/server.log  $RUN_DIR/web.log"
echo
echo "source $RUN_DIR/env.sh   then run scripts/doctor.sh $RUN_ID"
