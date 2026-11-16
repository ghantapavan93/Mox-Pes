#!/usr/bin/env bash
# A clean browser run on the verification worktree: no diagnostics, the config's own trace setting
# (retain-on-failure), and its own output folder so no later run clears its traces.
#   bash C:/Temp/stab/run-clean.sh <name> [spec files...]   (no spec files = the full suite)
NAME="$1"; shift
OUT=/c/Temp/stab/$NAME
mkdir -p "$OUT"
cd C:/Temp/rso-rc || exit 1
export DATABASE_URL=postgres://postgres@127.0.0.1:54333/revenue_signal_rc
export TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54333/revenue_signal_rc_test
export EVAL_DATABASE_URL=postgres://postgres@127.0.0.1:54333/revenue_signal_rc_eval
LOG=$OUT/run.log
t0=$(date +%s)
echo "=== STEP $NAME at $(git log --oneline -1); build $(cat .next/BUILD_ID); specs: ${*:-all}; tracked changes: $(git status --short --untracked-files=no | wc -l)" > "$LOG"
env CI=1 VISUAL=1 npx playwright test "$@" --reporter=line --output="C:/Temp/stab/$NAME/test-results" >> "$LOG" 2>&1
rc=$?
echo "=== END $NAME rc=$rc seconds=$(( $(date +%s) - t0 ))" >> "$LOG"
sed 's/\x1b\[[0-9;]*m//g' "$LOG" | grep -E "^=== |^  [0-9]+ (passed|failed|skipped|flaky|did not run)|^  [0-9]+\) "
exit $rc
