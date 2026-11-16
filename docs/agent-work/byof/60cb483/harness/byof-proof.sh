#!/usr/bin/env bash
# BYOF proof from a fresh worktree ($1), following the checked-in steps (evidence harness, not
# repo tooling): npm ci, npx playwright install chromium, npm run acceptance:byof. Postgres already
# runs at 127.0.0.1:54333, so `docker compose up -d` is not needed here. The demo database is
# fingerprinted before and after. Writes /c/Temp/byof-proof.log.
set -u
W="$1"
LOG=/c/Temp/byof-proof.log
PSQL="/c/Program Files/PostgreSQL/17/bin/psql.exe"
q() { "$PSQL" -h 127.0.0.1 -p 54333 -U postgres -At -d "$1" -c "$2"; }
fingerprint() {
  q revenue_signal "select 'demo database: max run ' || (select max(id) from ingestion_runs) || ', raw events ' || (select count(*) from raw_events) || ', uploads ' || (select count(*) from onboarding_uploads) || ', audit rows ' || (select count(*) from audit_log)"
}
: > "$LOG"
{
  echo "=== $(date -u +%FT%TZ) the worktree $W"
  git -C "$W" rev-parse HEAD
  echo "tracked files changed: $(git -C "$W" status --short --untracked-files=no | wc -l); .next present: $(test -d "$W/.next" && echo yes || echo no); node_modules present: $(test -d "$W/node_modules" && echo yes || echo no)"
  fingerprint
  echo "=== step 1: npm ci"
  t=$(date +%s); (cd "$W" && npm ci) > /c/Temp/byof-npm-ci.log 2>&1; echo "npm ci exit=$? seconds=$(( $(date +%s) - t ))"
  echo "=== step 2: npx playwright install chromium"
  t=$(date +%s); (cd "$W" && npx playwright install chromium) > /c/Temp/byof-pw-install.log 2>&1; echo "exit=$? seconds=$(( $(date +%s) - t ))"
  echo "=== $(date -u +%FT%TZ) step 3: npm run acceptance:byof"
  t=$(date +%s)
  (cd "$W" && npm run acceptance:byof) > /c/Temp/byof-proof-run.log 2>&1
  echo "npm run acceptance:byof exit=$? seconds=$(( $(date +%s) - t ))"
  fingerprint
} >> "$LOG" 2>&1
cat "$LOG"
