#!/usr/bin/env bash
# R-55 refusals, second run, from the worktree $1 (evidence harness, not repo tooling). Each case
# must stop before it seeds anything or serves anything. Cases 3 and 4 need a sentinel holding
# port 3990 (node C:/Temp/r55-port3000-sentinel.js 3990), which logs any HTTP request it receives.
# Writes /c/Temp/r55-refusals2.log.
set -u
W="$1"
LOG=/c/Temp/r55-refusals2.log
: > "$LOG"
run() {
  local title="$1"; shift
  echo "=== $title" >> "$LOG"
  echo "command: $*" >> "$LOG"
  local t=$(date +%s)
  (cd "$W" && env "$@") 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -vE "^\s*$" | tail -6 >> "$LOG"
  echo "exit=${PIPESTATUS[0]} seconds=$(( $(date +%s) - t ))" >> "$LOG"
}
echo "worktree $W at $(git -C "$W" rev-parse HEAD)" >> "$LOG"
run "1. the demo database is refused" ACCEPTANCE_DATABASE_URL=postgres://postgres@127.0.0.1:54333/revenue_signal npm run acceptance:b09
run "2. port 3000 is refused" ACCEPTANCE_PORT=3000 npm run acceptance:b09
echo "=== port 3990 is held by a sentinel for 3 and 4" >> "$LOG"
run "3. a busy port is refused by the documented command, before seeding" npm run acceptance:b09
run "4. a busy port is refused by Playwright alone (reuseExistingServer: false)" npx playwright test -c tests/acceptance/b09/playwright.config.ts
echo "=== HTTP requests that reached the port 3990 sentinel: $(wc -l < /c/Temp/r55-port3990-hits.log)" >> "$LOG"
cat "$LOG"
