#!/usr/bin/env bash
# Full-suite attempt a1 with diagnostics, plus CPU and Postgres activity every 2 s for 6 minutes.
mkdir -p /c/Temp/stab/a1
PSQL="/c/Program Files/PostgreSQL/17/bin/psql.exe"
(
  for i in $(seq 1 180); do
    "$PSQL" -h 127.0.0.1 -p 54333 -U postgres -d postgres -Atc "select to_char(clock_timestamp(),'HH24:MI:SS'), count(*) filter (where backend_type = 'autovacuum worker'), count(*) filter (where backend_type = 'client backend' and state = 'active'), coalesce(string_agg(distinct left(query, 40), ' | ') filter (where backend_type = 'autovacuum worker'), '') from pg_stat_activity" >> /c/Temp/stab/a1/pg-activity.log 2>&1
    sleep 2
  done
) &
typeperf "\Processor(_Total)\% Processor Time" -si 2 -sc 180 > /c/Temp/stab/a1/cpu.log 2>&1 &
bash /c/Temp/stab/run-attempt.sh a1
rc=$?
wait
exit $rc
