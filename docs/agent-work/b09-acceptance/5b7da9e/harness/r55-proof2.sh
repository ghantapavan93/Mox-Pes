#!/usr/bin/env bash
# R-55 proof, second run: a fresh worktree ($1) following only the checked-in instructions
# (docs/agent-work/B09-ACCEPTANCE-RUNNER.md, "What it needs"): npm ci, npx playwright install
# chromium, npm run acceptance:b09. Postgres already runs at 127.0.0.1:54333 here, so
# `docker compose up -d` is not needed. Hostile on purpose, as in the first run: a sentinel holds
# port 3000 and logs any request, DATABASE_URL points at the demo database, and the acceptance
# database is dropped first. Evidence harness, not repo tooling. Writes /c/Temp/r55-proof2.log.
set -u
W="$1"
LOG=/c/Temp/r55-proof2.log
PSQL="/c/Program Files/PostgreSQL/17/bin/psql.exe"
q() { "$PSQL" -h 127.0.0.1 -p 54333 -U postgres -At -d "$1" -c "$2"; }
fingerprint() {
  q revenue_signal "select 'content: max run ' || (select max(id) from ingestion_runs) || ', raw events ' || (select count(*) from raw_events) || ', audit rows ' || (select count(*) from audit_log) || ', max event ' || (select max(id) from domain_events) || ', answer checks ' || (select count(*) from shadow_checks) || ', incidents ' || (select count(*) from exceptions) || ', clock ' || (select now from app_clock)"
  q postgres "select 'writes since the stats reset: inserted ' || tup_inserted || ', updated ' || tup_updated || ', deleted ' || tup_deleted from pg_stat_database where datname = 'revenue_signal'"
}
: > "$LOG"
{
  echo "=== $(date -u +%FT%TZ) the worktree $W"
  git -C "$W" rev-parse HEAD
  echo "tracked files changed: $(git -C "$W" status --short --untracked-files=no | wc -l); .next present: $(test -d "$W/.next" && echo yes || echo no); node_modules present: $(test -d "$W/node_modules" && echo yes || echo no)"
  echo "=== step 1: npm ci"
  t=$(date +%s); (cd "$W" && npm ci) > /c/Temp/r55-npm-ci2.log 2>&1; echo "npm ci exit=$? seconds=$(( $(date +%s) - t ))"
  echo "=== step 2: npx playwright install chromium"
  t=$(date +%s); (cd "$W" && npx playwright install chromium) > /c/Temp/r55-pw-install2.log 2>&1; echo "npx playwright install chromium exit=$? seconds=$(( $(date +%s) - t ))"
  echo "=== the demo database before"
  fingerprint
  echo "=== port 3000 is held by the sentinel; requests it has received so far: $(wc -l < /c/Temp/r55-port3000-hits.log)"
  echo "=== drop the acceptance database, so the runner must create it"
  q postgres "drop database if exists revenue_signal_acceptance" && echo dropped
  echo "=== $(date -u +%FT%TZ) step 3: the proof, with DATABASE_URL pointing at the demo database"
  echo "command: cd $W && DATABASE_URL=postgres://postgres@127.0.0.1:54333/revenue_signal npm run acceptance:b09"
  t=$(date +%s)
  (cd "$W" && DATABASE_URL=postgres://postgres@127.0.0.1:54333/revenue_signal npm run acceptance:b09) > /c/Temp/r55-proof2-run.log 2>&1
  echo "npm run acceptance:b09 exit=$? seconds=$(( $(date +%s) - t ))"
  echo "=== $(date -u +%FT%TZ) the demo database after"
  fingerprint
  echo "=== requests that reached port 3000 during the proof: $(wc -l < /c/Temp/r55-port3000-hits.log)"
  echo "=== the acceptance database exists: $(q postgres "select count(*) from pg_database where datname = 'revenue_signal_acceptance'")"
} >> "$LOG" 2>&1
cat "$LOG"
