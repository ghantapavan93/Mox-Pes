#!/usr/bin/env bash
# R-55 proof from the fresh worktree C:/Temp/rso-r55 (evidence harness, not repo tooling: the proof
# itself is the repo's `npm run acceptance:b09`). Hostile on purpose: a sentinel holds port 3000 and
# logs any request, DATABASE_URL points at the demo database, and the acceptance database is dropped
# first so the runner must create it. Writes /c/Temp/r55-proof.log.
set -u
W=C:/Temp/rso-r55
LOG=/c/Temp/r55-proof.log
PSQL="/c/Program Files/PostgreSQL/17/bin/psql.exe"
q() { "$PSQL" -h 127.0.0.1 -p 54333 -U postgres -At -d "$1" -c "$2"; }
fingerprint() {
  q revenue_signal "select 'content: max run ' || (select max(id) from ingestion_runs) || ', raw events ' || (select count(*) from raw_events) || ', audit rows ' || (select count(*) from audit_log) || ', max event ' || (select max(id) from domain_events) || ', answer checks ' || (select count(*) from shadow_checks) || ', incidents ' || (select count(*) from exceptions) || ', clock ' || (select now from app_clock)"
  q postgres "select 'writes since the stats reset: inserted ' || tup_inserted || ', updated ' || tup_updated || ', deleted ' || tup_deleted from pg_stat_database where datname = 'revenue_signal'"
}
: > "$LOG"
{
  echo "=== $(date -u +%FT%TZ) the worktree"
  git -C "$W" rev-parse HEAD
  echo "tracked files changed: $(git -C "$W" status --short --untracked-files=no | wc -l)"
  echo "=== npm ci"
  t=$(date +%s); (cd "$W" && npm ci) > /c/Temp/r55-npm-ci.log 2>&1; echo "npm ci exit=$? seconds=$(( $(date +%s) - t ))"
  echo "=== the demo database before"
  fingerprint
  echo "=== port 3000 is held by the sentinel; requests it has received so far: $(wc -l < /c/Temp/r55-port3000-hits.log)"
  echo "=== drop the acceptance database, so the runner must create it"
  q postgres "drop database if exists revenue_signal_acceptance" && echo dropped
  echo "=== $(date -u +%FT%TZ) the proof, with DATABASE_URL pointing at the demo database"
  echo "command: cd C:/Temp/rso-r55 && DATABASE_URL=postgres://postgres@127.0.0.1:54333/revenue_signal npm run acceptance:b09"
  t=$(date +%s)
  (cd "$W" && DATABASE_URL=postgres://postgres@127.0.0.1:54333/revenue_signal npm run acceptance:b09) > /c/Temp/r55-proof-run.log 2>&1
  echo "npm run acceptance:b09 exit=$? seconds=$(( $(date +%s) - t ))"
  echo "=== $(date -u +%FT%TZ) the demo database after"
  fingerprint
  echo "=== requests that reached port 3000 during the proof: $(wc -l < /c/Temp/r55-port3000-hits.log)"
  echo "=== the acceptance database exists: $(q postgres "select count(*) from pg_database where datname = 'revenue_signal_acceptance'")"
} >> "$LOG" 2>&1
cat "$LOG"
