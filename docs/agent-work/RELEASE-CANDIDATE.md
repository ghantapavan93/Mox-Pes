# Release candidate: local synthetic demo (2026-11-15)

The final acceptance pass for the synthetic proof-of-work. It started from `a6f8e4b` (the
delivery-outcomes pass).

## 1. The stale-delivery question: settled, one write boundary fixed

**Question.** Can a #679-style older revision of the same spend record, carrying another
campaign name and other classification inputs, change what the product reports?

**Method.**
- The expectations were written before any replay ran, and each capture records their sha256:
  - `release-candidate/stale-replay-expected.md`;
  - `release-candidate/stale-replay-expected-2.md`.
- The replays ran through the ads feed's polling path (`runStream`, `ads@1.2`) in the isolated
  `revenue_signal_b09` world, then the intake's consumers.
- Each facet was captured separately (`C:/Temp/rc-stale-capture.ts`):
  - the raw record;
  - the accepted spend row;
  - the campaign record;
  - the channel allocation;
  - the evidence trace;
  - the decision: verdicts, budget signal, gap status, incident and case;
  - the run's own row.

**Observed.** Captures are `release-candidate/stale-*.json`.

| Replay of Oct 20 (`pmax-lsa-B09`) | Spend, allocation, decision | Campaign record | Trace |
|---|---|---|---|
| Fetched 13:05 (#680). This is #679's fetch time, and fetch time is part of the version id | Unchanged. It was not stored: a payload conflict, which opens one unscoped medium item (#5723) | Unchanged | Unchanged |
| Fetched 13:07 (#681): its own older version, "B09 Coral \| Search", SEARCH inputs | **Unchanged.** Oct 20 stays #677's 12,091¢ at 13:10. Local Services 361,119¢, Search 1,017,687¢, B09 paid 1,664,923¢. Same verdicts, signal, verified gap, incident | **Rewritten:** "B09 Coral \| Search", `google_search`, SEARCH | Shows "B09 Coral \| Search" for spend filed as Local Services |

The dollars and the decision held. The campaign's own record did not. It feeds:
- the evidence trace;
- ChangeGuard's preflight;
- the AI investigator's campaign lookup;
- a coverage gap's successor evidence.

A believable but wrong label got through, and the run's row still said "No change".

**Cause.** The spend projection promises that every upsert is guarded by the source clock
(`lib/ingest/project.ts`). The campaign record was the one write without that guard. Any version
carrying the campaign rewrote it, in arrival order. The contract already orders versions:
VENDOR-CONTRACTS G-5 says "each fetch is a version, newest `fetchedAt` wins", and within one batch
the projection already took campaign fields from the newest fetch. No new ordering rule was
needed.

**Fix.** Only the write boundary changed.
- **Migration `0031`:** `ad_campaigns.source_updated_at`, the fetch time of the version whose fields
  the record holds.
- **The upsert:** it sets the name, channel and type only from a version at least that new. The
  Local Services flag stays OR-ed, which does not depend on order.
- **Why field by field:** the update always runs, so the spend insert still gets the campaign id.
  A guard on the whole update would drop that id, and an older-date backfill could no longer
  repair its own day.
- **The held-currency insert** also records the clock.
- **History:** the clock starts at the newest fetch each campaign's accepted spend rests on. A
  record an older version already rewrote is not repaired by the migration.

**Tests** (`b09-recovery.test.ts`, "the campaign record follows the newest fetch"):

| Case | Before the fix | After |
|---|---|---|
| An older revision with another name and Search inputs: stored, no change; each facet checked on its own | **Failed**: campaign became "B09 \| Search", `google_search`, SEARCH | Pass |
| A newer revision renames the campaign and files its own day | Pass | Pass |
| An older-date backfill (Oct 14, newer than its day, older than the rename) repairs its day | **Failed**: the day was repaired, but the name rolled back | Pass |
| Migration 0031 on history: wiped clocks rebuild exactly; applied again, nothing changes | (new) | Pass |

**On pre-0031 history.** This is the same B09 world, which carried the bad rename from #681.
- Migration 0031 gave all 156 campaigns a clock. The bad record stayed, as the migration says.
- Another older revision (#682, 13:08) then changed nothing.
- A newer fetch (#683, Oct 30 at 13:20) restored the record: "B09 Coral | Local Services
  (Performance Max, pay-per-lead)", `google_lsa`, PERFORMANCE_MAX. Its row reads "1 change to
  accepted records".

**Other suites.** Every other suite that touches ads or campaigns: 26 files, 377 passed, plus the
1 known expected failure (R-39).

## 2. One clean release verification

### Setup

- **Worktree:** a fresh worktree, `C:/Temp/rso-rc`, detached at the candidate. The main checkout is
  untouched.
- **Isolated databases:**
  - `revenue_signal_rc`: the demo database and the browser suite;
  - `revenue_signal_rc_test`: unit and integration tests;
  - `revenue_signal_rc_eval`: the frozen packs;
  - `revenue_signal_rc_b09`: the walkthrough.
- **Environment:** Windows 11, Node 22.14.0, npm 11.6.2, Postgres 17 (127.0.0.1:54333), Next.js 16.4.3.
- **Order:** every step ran in sequence, and each exit code was logged.

### The exact commands, in the worktree

```bash
export DATABASE_URL=postgres://postgres@127.0.0.1:54333/revenue_signal_rc
export TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54333/revenue_signal_rc_test
export EVAL_DATABASE_URL=postgres://postgres@127.0.0.1:54333/revenue_signal_rc_eval
npm ci && npm run db:migrate && npm run build          # phase 1 (empty databases)
npm run typecheck && npm run lint && npx vitest run && npm run db:seed
npx tsx scripts/eval-ai.ts --no-store
npx tsx scripts/eval-investigator.ts docs/agent-work/investigator-heldout/cases.v1.json /tmp/investigator.json
npx tsx scripts/eval-changeguard.ts docs/agent-work/changeguard-heldout/scenarios.v1.json /tmp/changeguard.json
npx tsx scripts/eval-acceptance.ts docs/agent-work/vp-acceptance/scenarios.v1.json /tmp/vp.json --twice
npx tsx scripts/eval-acceptance.ts docs/agent-work/shadow-acceptance/scenarios.v1.json /tmp/shadow.json --twice
CI=1 VISUAL=1 npx playwright test --reporter=line      # phase 2 ends here
```

### Two candidates

- **`4fc9eb5` (§1's fix):** verified in full, except its browser suite. That suite was stopped
  unrun once the BIVE audit (`BIVE-ACCEPTANCE.md`) found two release blockers in it.
- **`91ef06f`:** fixes both blockers (`97a0e18`, `91ef06f`). It was verified from scratch: new
  databases, install, migrations, build, walkthrough, route sweep, then the full sequence.

| Step | `4fc9eb5`, build `XgMHB0FQcsdeS6IT2xXHD` | `91ef06f`, build `-t8FhwvfYGehXmbdri6T7` |
|---|---|---|
| Install (`npm ci`) | Pass. npm audit: 7 moderate, all in the lint toolchain (typescript-eslint → minimatch), none in runtime dependencies | Pass, same lockfile |
| Migrations on an empty database | 31 applied | 32 applied |
| Typecheck, lint, build | Pass | Pass |
| Unit and integration (vitest) | 79 files: 932 passed, plus the 1 known expected failure (R-39) | 79 files: 933 passed, plus the 1 known expected failure (R-39) |
| Seed | 675 runs, 134,088 raw events | Same |
| The five frozen eval packs | Pass. Identical to the last baseline (`a6f8e4b`), except the commit, a process id, and the input files' sha256 (the worktree checks them out with CRLF; byte-equal without CR) | Pass. Identical to the same baseline, with the same exceptions: neither fix moved a pack |
| Full browser suite, with pixel comparisons | Not run (superseded) | 125 passed, 1 skipped (the opt-in demo-video recording), 0 failed, in one run (24.7 min). No pixel baseline changed |

**Migrations on history recorded before them:**
- **0030:** its behaviour is unchanged since `DELIVERY-OUTCOMES.md`, which verified it on the
  B09 world's history.
- **0031:** applied to the B09 world's pre-0031 history (§1). Wiped clocks rebuild exactly
  (`b09-recovery.test.ts`).
- **0032:** a row reset to the old empty scope is repaired, and applying the migration again
  changes nothing (`shadow-mode.test.ts`).

## 3. The production-browser walkthrough

- **Build:** the candidate's own build, `next start` with `DEMO_MODE=1` on :3500 over a fresh seed.
- **Widths:** desktop 1280 and phone 390.
- **Start:** the Overview. No incident or run id is ever typed.
- **Deliveries:** between states, each correction goes through the ads feed's polling path.
- **Results:** 230 of 230 checks on `91ef06f`; also 230 of 230 on `4fc9eb5`. No console or page
  errors. The server log has no errors. Evidence is in `release-candidate/walk/` (`walk-all.json`
  has every check, click and fact) and `release-candidate/ledger.json` (27 of 27).

| # | What must hold | Result |
|---|---|---|
| 1 | B09's missing dates are not shown as recorded $0 | Pass. Every missing day reads "no spend record"; the week says "That is no record, not $0." The incident card that called it "zero" was fixed (`91ef06f`) |
| 2 | The first correction verifies 5 of 18; the decision stays held | Pass. "5 of 18 dates in the decision window (Oct 13–Oct 30) have Google Local Services spend at B09; Oct 13–Oct 25 still have none, so it still holds." This shows on the Overview, the daily evidence, the incident and Decision Lab |
| 3 | The rest verifies all 18; $2,123.52 moves Search → Local Services; total spend unchanged; the same incident keeps its history | Pass. Local Services +212,352¢ and Search −212,352¢. B09 paid 1,664,923¢; customers and collected cash unchanged at B09 and company-wide. #2455 resolved, one verification. Case #161's timeline: detected → owner assigned → investigating → resolved |
| 4 | Follow the verification to the delivery and back | Pass. Run #677's marked row: "13 changes to accepted records. Incident #2455's verification used Oct 13–Oct 25 (13 of 18 dates)". One Back returns to the incident with period, channel, week and the open details kept |
| 5 | A duplicate and an older revision change nothing and open no second case or recovery; unrecorded effects stay unknown | Pass. #678 "Duplicate"; #679 and #680 "Stored, but a newer revision was already accepted"; #680 also left the campaign record alone. Money, case, verification and exceptions are unchanged. Failed run #473 reads "Effect not recorded" |
| 6 | Decision Lab: the hold cleared, the two review items visible, no approval implied | Pass. "Ready for review"; "Coverage hold cleared, incident #2455"; "Other checks need review: 2 of 4 channels", naming #970 (a campaign with spend but no branch mapping) and 5 door-to-door conflicts; "Nothing here approves a budget change." |
| 7 | Restricted roles, fresh contexts: rendered page and server payload | Pass. Partner and brand get no B09 evidence on 7 deep links. The route sweep then covered 61 routes × 3 roles (`bive/route-sweep-*.json`). The same-tab limit is recorded apart: the tab's hidden DOM keeps what it already received, and nothing new can be fetched |

**Errors in normal use.**
- **Normal use:** five runs on two builds (`walk-all.json`, `bive/lens-*/walk-*.json`) logged no
  console or page error and no server error.
- **The reseed race:** `event consumer failed … relation "domain_events" does not exist` appeared
  once in the browser suite of an earlier run (`DELIVERY-OUTCOMES.md` §7). It came while a spec
  reseeded the database under the running server. It did not appear in the candidate's run.
- **Deliberate fault:** the twin's `sync job failed … unavailable` is its injected CRM outage.

## 4. Decision

The candidate is decided once, together with the BIVE audit (`BIVE-ACCEPTANCE.md` §9):
**READY FOR LOCAL SYNTHETIC DEMO** at code `91ef06f`, build `-t8FhwvfYGehXmbdri6T7`.

**Updated local synthetic demo checkpoint: `28e498b`, build `Lc4HRzPXzTTju7yRCUitk`.** The R11
fix (R-57) passed the same verification after the decision (§7). The original acceptance of
`91ef06f`, above, stands as recorded. Commits after `28e498b` change only docs and test tooling.

## 5. Shortest verified local startup

Needs Node 22, Postgres 17 and an empty database (README's Docker file provides Postgres; that path
was not re-run here).

```bash
npm ci
DATABASE_URL=postgres://postgres@127.0.0.1:54333/revenue_signal npm run db:seed
npm run build
DEMO_MODE=1 DATABASE_URL=postgres://postgres@127.0.0.1:54333/revenue_signal npm run start
```

On Windows `cmd`: `set DEMO_MODE=1&& set DATABASE_URL=…&& npm run start`. Open
http://localhost:3000 and choose "Viewing as". The seed takes about a minute here.

Two warnings:
- **Port 3000 must be free.** Outside CI, the browser tests reuse whatever server answers there.
- **Reseed after any browser test run.** The tests write into `DATABASE_URL`, the demo database by
  default.

To rerun the B09 proof without touching the demo, use `npm run acceptance:b09`. It has its own
database and its own server on port 3990 (`B09-ACCEPTANCE-RUNNER.md`).

## 6. Known limitations

See `BIVE-ACCEPTANCE.md` §10.

## 7. After the decision: the answer-check scope fix (`28e498b`)

The acceptance recheck left R11 (`BIVE-ACCEPTANCE.md` §4): an answer check was listed by what it
read, not by what it names. It was fixed after the decision in `28e498b` (R-57,
`SHADOW-MODE.md` §4) and verified the way `91ef06f` was: the same worktree moved to the fix, the
same isolated databases (`revenue_signal_rc` dropped and recreated empty), the same script.

| Step | `28e498b`, build `Lc4HRzPXzTTju7yRCUitk` |
|---|---|
| Install, migrations on an empty database, build | Pass. 33 migrations applied. The build logs the same three Turbopack tracing warnings as `91ef06f`'s |
| Migration 0033 on history recorded before it | Applied to `revenue_signal_r57`, a copy of the release walk's final world (`revenue_signal_rc_b09`, at 0032, two analyst checks): one migration applied; both checks keep what they read and record no names; a second run is "Up to date" |
| Typecheck, lint | Pass (exit 0, 0) |
| Unit and integration (vitest) | Exit 0. 79 files: 937 passed, plus the 1 known expected failure (R-39). The four added tests are R11's |
| Seed | Exit 0. 675 runs (1 failed), 134,088 raw events: unchanged |
| The five frozen eval packs | Exit 0 each. Identical to the same baseline (`a6f8e4b`), with the same exceptions as `91ef06f`: the commit, the Node process id in one warning line, and the input files' sha256. Those hashes equal `91ef06f`'s run, because the worktree checks the scenario files out with CRLF. No pack moved |
| Full browser suite, with pixel comparisons | Exit 0. 125 passed, 1 skipped (the opt-in demo-video recording), 0 failed, in one run (29.6 min). No pixel baseline changed. The only server error is the twin's injected CRM outage. The reseed race did not appear |
| Fresh-context walk on `revenue_signal_r57` (`bive/r57/walk.json`) | 24 of 24, no console or page errors. Every refusal is paired with an allowed read of the same check by another role: API list, API detail (404 when refused), the list page and the check page, with no entered text in any of them |

Every step's exit code, the summaries and the pack comparison are in
`release-candidate/verify-28e498b.txt`, copied from `C:/Temp/rc-verify-phase1.log` and
`rc-verify-phase2.log`.

**Result: it passed.** The local synthetic demo checkpoint moves from `91ef06f` to `28e498b`,
build `Lc4HRzPXzTTju7yRCUitk` (§4). One limit of R-57 stays open: scope names are recognized the
way an answer is read. A scope written another way, such as "b09", "coral" or "Moxie's" alone,
is not recognized, so that text can still reach a viewer of what the check does name
(`bive/r57/name-forms.txt`).

What the walk covered:
- **History:** the two checks stored before 0033 are read by the analyst and refused to the
  partner and the brand lead.
- **The partner's answer naming only B09 and Moxie:** it opens at once for the partner, with both
  claims "Outside your scope" (`partner-own-check-*.jpg`). The brand lead gets 404 and a "could
  not be found" page (`brand-lead-refused-partner-check-*.jpg`). The analyst reads it.
- **An analyst's answer naming B40–B43, then B09:** refused to the brand lead.
- **The control,** an analyst's answer about B40 alone: the brand lead reads it
  (`brand-lead-allowed-control-*.jpg`).
- **The brand lead's answer naming nothing:** the brand lead reads it, the partner is refused.
