# B09 acceptance runner (R-55)

One command reproduces the B09 proof from the repo alone. It needs no tools from `C:/Temp`, never
touches the demo database, and never reuses a server that happens to be running.

```bash
npm run acceptance:b09
```

## What it proves

It walks one freshly seeded synthetic world through the source's own corrections, as the release
walkthrough did (`RELEASE-CANDIDATE.md` §3):

1. **Missing records are not zero.** B09's Local Services coverage gap is open and the decision is
   held. The Overview lists the hold with no ids typed. The missing days read "no spend record",
   never a recorded $0.00. The incident's CRM card says the channel "has no spend record", and the
   incident never calls missing spend zero (`BIVE-ACCEPTANCE.md` R2).
2. **Partial hold.** The source re-sends Oct 26–30. Five of the 18 dates are covered, the same
   incident stays open, and every view still says the decision is held.
3. **Verified reclassification.** The source re-sends Oct 13–25. All 18 dates are covered.
   - **Reclassified, not added:** each of the campaign's 18 accepted days moves from Google Search
     to Google Local Services with the same cents, $2,123.52 in all. Company-wide accepted spend
     keeps the same total.
   - The same incident is resolved by one verification.
   - Decision Lab says "Ready for review" and that nothing is approved.
   - The verification's run says what it stored, what it changed and what used it.
4. **Duplicate and stale replays leave the accepted evidence unchanged.** Three more deliveries:
   - the same 13 versions again;
   - an older fetch of Oct 20, $50 higher;
   - an older fetch of Oct 20, $50 higher, that carries a Search campaign's name and inputs.
   After each one, every accepted spend day company-wide is identical, row for row: campaign,
   date, channel, cents and the source version it rests on. Money, customers, cash, the incident,
   its case and the campaign record are unchanged too. Each run's row says why. A run whose effect
   was never recorded says "Effect not recorded".
5. **The independent ledger.** What the source sent is captured before the product maps it. It is
   compared with what the product recorded:
   - the runs and the versions they stored;
   - the accepted days;
   - the verification's runs and cents;
   - every run's label;
   - the totals in every state.
   Each expectation comes from what was sent and simple arithmetic, not from the product's totals.
6. **Scope, paired.** Restricted roles are checked against 61 routes (30 pages, 31 read APIs), with
   B09's own ids filled in. The analyst requests each route as the control; the branch partner and
   the Joshua's brand lead request it in their own fresh contexts.
   - **A route proves a refusal** only when the analyst received B09 evidence there. Each of its
     two denied requests is paired with that allowed request.
   - **Routes with no B09 evidence for either role are counted apart.** They prove nothing.
   - **A leak** is any restricted response carrying B09 evidence, on any route.

## What it needs

- **Node 22,** and `npm ci` in the checkout.
- **Playwright's Chromium,** installed once per machine: `npx playwright install chromium`.
- **Postgres 17** at the demo's address (`postgres://postgres@127.0.0.1:54333`), allowed to create
  a database. The repo's `docker compose up -d` provides exactly that (README, "Run it").
- **A free port,** 3990 by default.
- **No other server running from the same checkout,** because the runner rebuilds `.next`. A
  separate worktree avoids this.

From a fresh clone or worktree, with Docker:

```bash
docker compose up -d
```

```bash
npm ci
```

```bash
npx playwright install chromium
```

```bash
npm run acceptance:b09
```

The runner never reads `DATABASE_URL` and never attaches to a running server. Next.js still loads
any `.env` file in the checkout, but the runner's own database setting overrides it. A fresh
worktree has no `.env` file, since git ignores them.

## What the command does

**Step 1, `tests/acceptance/b09/prepare.ts`.** It refuses to run when:
- the database is not `revenue_signal_acceptance` or `revenue_signal_acceptance_<suffix>`
  (`DATABASE_URL` is never read);
- the port is 3000;
- anything already listens on the port.

Otherwise it creates the database if it is missing and seeds it with the demo seed, the same
`seed()` the browser suite uses (about a minute).

**Step 2, `tests/acceptance/b09/playwright.config.ts`.** It builds this checkout and starts its own
production server, `next start` with `DEMO_MODE=1`, over that database. `reuseExistingServer` is
false, so a busy port stops it before any test runs. It then runs `b09-proof.spec.ts`.

**The other files:**
- `deliveries.ts` is the delivery fixture. Each correction re-sends pmax-lsa-B09's own source
  records through the ads feed's polling path (`runStream` with the active mapper), then runs the
  intake's consumers.
- `ledger.ts` holds the world facts and the independent ledger.
- `env.ts` holds the database, port and output rules.

It reuses the repo's helpers: `seed()`, `setRole()` from the browser suite, the golden B09 fixture
(`tests/fixtures/b09-golden.json`) and the product's read paths.

| Setting | Default | Rule |
|---|---|---|
| `ACCEPTANCE_DATABASE_URL` | `postgres://postgres@127.0.0.1:54333/revenue_signal_acceptance` | The name must be `revenue_signal_acceptance` or `revenue_signal_acceptance_<suffix>` |
| `ACCEPTANCE_PORT` | `3990` | 1024–65535, never 3000, and nothing may listen on it |
| `ACCEPTANCE_OUT` | `test-results/acceptance-b09` (ignored by git) | Where the record goes |

**The record:** `<ACCEPTANCE_OUT>/results.json`. It holds:
- the commit SHA and any changes to tracked files;
- the command, the build id, the server, the database, and the Postgres, Node and Playwright
  versions;
- every check with its result and detail, and every console or page error;
- the world facts in each state, the ledger, and each scope pair.

The suite exits non-zero when any check fails. Playwright's own report is `report.json` beside it.

## What moved out of `C:/Temp`, and what did not

| `C:/Temp` tool | In the repo |
|---|---|
| `b09-correct.ts` (deliveries) | `deliveries.ts`: partial, rest, duplicate, older and stale. Stale is the 13:07 fetch, run #680 in the release record |
| `b09o-ledger.ts` (ledger) | `ledger.ts`, extended to the stale delivery and to every state's totals |
| `rc-walk.ts` (state walk, durability) | `b09-proof.spec.ts`: the four views in each state, the run rows and the replays |
| `bive-route-sweep.ts` (route sweep) | `b09-proof.spec.ts`: the same routes, each refusal now paired with its allowed request |

**Not brought in, because the proof does not need it:**
- screenshots;
- the 390 and 320 widths;
- the keyboard path;
- the click path from the Overview and Back;
- the same-tab role residue (R-2);
- the lens walks;
- the stale variants used only to diagnose (13:05, 13:08, newer).

Two of those are covered in the repo another way:
- the click path and Back: `zz-b09-four-minute-path.spec.ts`;
- history from before migration 0031: `b09-recovery.test.ts`.

The historical records in `release-candidate/` and `bive/` are left as they were.

## The recorded run

Recorded in `b09-acceptance/README.md`. The run was from a fresh worktree at `23617ca`. Port 3000
was held by a sentinel that logs requests, and `DATABASE_URL` pointed at the demo database.
- **Result:** `npm ci`, then `npm run acceptance:b09`, exited 0 in 235 s, with 97 of 97 checks
  and no console or page errors.
- **Same world as the release record:** incident #2455 and runs #676–#680.
- **Scope:** 31 routes prove a refusal, giving 62 denied requests, each paired with its allowed
  request. 30 routes carry no B09 evidence for either role and are counted apart. Leaks: 0.
- **Isolation:** the demo database's content and write counters did not change, and no request
  reached port 3000.
- **Refusals:** four cases each stopped with exit 1 before seeding or serving. They were the demo
  database, port 3000, a busy port through the command, and a busy port through Playwright alone.

## Limits

- **Synthetic data and demo roles.** A role is a cookie (R-2); this is not production
  authentication.
- **Evidence is recognized by markers.** These are names, ids, amounts and links. A route can
  carry B09 information in a form no marker names. Answer-check text written in a form the
  product does not recognize is R-57's open limit.
- **Scope reads server payloads.** It reads the full HTML or JSON a role receives, not what a
  browser renders after it. A payload without B09 evidence cannot render any.
- **One seed.** The proof's numbers and run ids belong to the deterministic demo seed. If the seed
  changes, the runner fails loudly and the expectations must be updated with it.
- **The server listens on all interfaces,** as `npm run start` does. Run it on a trusted network.
- **The demo's own browser suite is unchanged.** It still reseeds `DATABASE_URL` and reuses a
  server on port 3000 outside CI (R-55).
