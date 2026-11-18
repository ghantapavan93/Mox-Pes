#!/usr/bin/env bash
# Reproduces GitHub CI's Linux browser run locally (RELEASE-DESIGN.md, WP-I): the same Node 22,
# Postgres 17, `npm ci`, `npm run build`, `npx playwright install --with-deps chromium` and
# CI=true, in Docker, on a committed source snapshot. CPUs are capped so a slow runner's
# timing shows. Usage (Git Bash):
#
#   bash linux-ci-repro.sh <git-ref> <outDir> [cpus] [spec ...]
#
# Writes <outDir>/playwright.log and copies test-results/ there. Nothing touches the host's
# databases or the repo's working tree.
set -euo pipefail
export MSYS_NO_PATHCONV=1

REF="${1:?git ref}"
OUT="${2:?out dir}"
CPUS="${3:-2}"
shift 3 || true
SPECS="${*:-tests/e2e/os-modules.spec.ts tests/e2e/z-a11y-regressions.spec.ts tests/e2e/z-quality-gates.spec.ts tests/e2e/z-trace.spec.ts tests/e2e/zy-evidence-journey.spec.ts tests/e2e/zy-overview-movement.spec.ts tests/e2e/zz-b09-four-minute-path.spec.ts}"

REPO="$(git rev-parse --show-toplevel)"
SRC="C:/Temp/rso-ci-src"
rm -rf "$SRC" && mkdir -p "$SRC" "$OUT"
git -C "$REPO" archive "$REF" | tar -x -C "$SRC"

docker rm -f rso-ci-pg rso-ci-run >/dev/null 2>&1 || true
# CI reaches its Postgres service at 127.0.0.1:54333. The run container shares this container's
# network namespace, so the same URL works here. A host name such as "rso-ci-pg" would count as a
# remote database (lib/db.ts) and switch on TLS and the three-connection pool.
docker run -d --name rso-ci-pg --cpus "$CPUS" \
  -e POSTGRES_USER=postgres -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=revenue_signal \
  postgres:17 -c port=54333 >/dev/null
for i in $(seq 1 60); do docker exec rso-ci-pg pg_isready -U postgres -p 54333 >/dev/null 2>&1 && break; sleep 1; done
docker exec rso-ci-pg psql -U postgres -p 54333 -qc "create database revenue_signal_test"

set +e
docker run --name rso-ci-run --network container:rso-ci-pg --cpus "$CPUS" --memory 6g \
  -v "$SRC:/src:ro" \
  -e CI=true \
  -e DATABASE_URL=postgres://postgres@127.0.0.1:54333/revenue_signal \
  -e TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54333/revenue_signal_test \
  -e INGEST_API_KEY=ci-ingest-key \
  -e TWIN_SKIP_DISK_PREFLIGHT=1 \
  node:22-slim bash -lc "
    set -e
    cp -r /src /work && cd /work
    npm ci --no-audit --no-fund
    npm run build
    npx playwright install --with-deps chromium
    npx playwright test $SPECS
  " >"$OUT/playwright.log" 2>&1
STATUS=$?
set -e
docker cp rso-ci-run:/work/test-results "$OUT/test-results" >/dev/null 2>&1 || true
docker rm -f rso-ci-run rso-ci-pg >/dev/null 2>&1 || true
echo "exit=$STATUS"
tail -15 "$OUT/playwright.log"
exit $STATUS
