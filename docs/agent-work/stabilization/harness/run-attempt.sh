#!/usr/bin/env bash
# One browser-suite attempt on the verification worktree, with its own output folder so no attempt
# clears another's traces. Diagnostics on; every test's trace kept (tracing runs for every test
# under the default retain-on-failure too, so the timing conditions are the same).
#   bash C:/Temp/stab/run-attempt.sh <name> [spec files...]   (no spec files = the full suite)
NAME="$1"; shift
OUT=/c/Temp/stab/$NAME
mkdir -p "$OUT"
cd C:/Temp/rso-rc || exit 1
export DATABASE_URL=postgres://postgres@127.0.0.1:54333/revenue_signal_rc
export TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54333/revenue_signal_rc_test
export EVAL_DATABASE_URL=postgres://postgres@127.0.0.1:54333/revenue_signal_rc_eval
export STAB_DIAG=C:/Temp/stab/diag-init.js
export STAB_DIAG_LOG=C:/Temp/stab/$NAME/diag.log
: > "$STAB_DIAG_LOG"
LOG=$OUT/run.log
t0=$(date +%s)
echo "=== STEP $NAME at $(git log --oneline -1); build $(cat .next/BUILD_ID); specs: ${*:-all}; tracked changes: $(git diff --stat | tail -1)" > "$LOG"
env CI=1 VISUAL=1 npx playwright test "$@" --reporter=line --trace=on --output="C:/Temp/stab/$NAME/test-results" >> "$LOG" 2>&1
rc=$?
echo "=== END $NAME rc=$rc seconds=$(( $(date +%s) - t0 ))" >> "$LOG"
sed 's/\x1b\[[0-9;]*m//g' "$LOG" | grep -E "^=== |^  [0-9]+ (passed|failed|skipped|flaky|did not run)|^  [0-9]+\) "
exit $rc
