#!/usr/bin/env bash
# One honest measurement run (RELEASE-DESIGN.md §4): the same seeded data, a server that has
# served nothing yet, then measure.cjs. Usage (Git Bash):
#
#   bash measure-cold.sh <builtWorktree> <port> <label> <outJson> [databaseName]
#
# The worktree must already be built (`next build`). The database defaults to
# revenue_signal_measure on the local Postgres; it is reseeded here, never the demo database.
set -euo pipefail

TREE="${1:?built worktree}"
PORT="${2:?port}"
LABEL="${3:?label}"
OUT="${4:?out json}"
DB="${5:-revenue_signal_measure}"
case "$DB" in revenue_signal|revenue_signal_rc) echo "refusing to reseed $DB" >&2; exit 2 ;; esac

URL="postgres://postgres@127.0.0.1:54333/$DB"
HERE="$(cd "$(dirname "$0")" && pwd)"
LOG="$(mktemp)"

stop_port() {
  local pids
  pids="$(netstat -ano | awk -v p=":$PORT" '$2 ~ p"$" && $4 == "LISTENING" {print $5}' | sort -u)"
  for pid in $pids; do taskkill //PID "$pid" //F >/dev/null 2>&1 || true; done
}

stop_port
(cd "$TREE" && DATABASE_URL="$URL" npx tsx scripts/seed.ts | tail -1)
(cd "$TREE" && DATABASE_URL="$URL" DEMO_MODE=1 \
  FIELDROUTES_MOCK_BASE_URL="http://localhost:$PORT/api/mock/fieldroutes" \
  npx next start -p "$PORT" >"$LOG" 2>&1) &
for i in $(seq 1 60); do grep -q "Ready" "$LOG" && break; sleep 1; done
grep -q "Ready" "$LOG" || { echo "server did not start:"; cat "$LOG"; stop_port; exit 1; }

set +e
node "$HERE/measure.cjs" "http://localhost:$PORT" "$LABEL" "$OUT" "$TREE/node_modules"
STATUS=$?
set -e
stop_port
rm -f "$LOG"
exit $STATUS
