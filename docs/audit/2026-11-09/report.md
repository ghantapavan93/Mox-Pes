# Principal-engineer audit · Revenue Signal OS · 2026-11-09

Synthetic data throughout. Nothing here was run against a real CRM, call-tracking, ad or AI
account. The machine-checked version of this report is `final-run/verification.json`, produced
by `npm run audit:report` in a fresh clone. It fails if any fixed finding's regression test, or
any "safe" claim's evidence test, is missing or not passing.

## 1. Preservation and recovery

| What | Where | Verified |
|---|---|---|
| Pre-audit working tree (incl. the uncommitted `package-lock.json` change) | `refs/backup/pre-audit-2026-11-09` (commit e81c1b8, not on any branch) | A clone of the bundle, checked out at the ref, has the identical tree hash (80161c3…) |
| Whole repository, all refs | `~/Backups/revenue-signal-2026-11-09/repo.bundle` | `git bundle verify` OK; SHA-256 in `SHA256SUMS` |
| Private, git-ignored files (`research/`, `docs/outreach.md`) | `~/Backups/revenue-signal-2026-11-09/private-untracked.tgz` | Extracted and diffed: identical (30 files) |
| Post-audit state | `refs/backup/post-audit-2026-11-09` (commit 208c98a, not on any branch) | Verified below from a fresh clone |

Nothing was committed to `main` or pushed.

## 2. Inventory (baseline 61ac95f)

- **Stack:** Next.js 16.4.3 (App Router, cacheComponents, `after()`), React 19, Tailwind 4,
  Postgres 17, zod 4, `pg`, Anthropic SDK; vitest 5, Playwright 1.64.
- **Code:** `lib/` ≈ 17.2k lines (adapters, ingest, reconcile, identity, metrics, decision,
  workflow, events, jobs, connectors, ai, sim); `app/` ≈ 4.5k lines (12 pages, 28 route files).
- **Migrations:** 0001–0010 at baseline; the audit adds 0011 (`sync_requests`) and 0012
  (corrected `v_acquisitions`, `reporting.contract_v1`). Append-only.
- **Data generator:** `lib/sim/world.ts` (deterministic synthetic world, 134,337 source record
  versions), `lib/sim/seed.ts` (≈11 weeks of polling runs through the real pipeline).
- **Background work:** `lib/jobs/kick.ts` (in-process drain after a request), `scripts/worker.ts`
  (standalone worker), domain-event dispatch (`lib/events/consumers.ts`).
- **API endpoints:** 28 route files: cases, connectors (compare/jobs/sync/faults), customers,
  decisions (experiments/scenarios/verdicts), exceptions actions, health, identity conflicts,
  ingest, investigations, metrics, mock FieldRoutes, proposals, reconcile, replays, role, search.
- **Tests at baseline:** 255 vitest (unit + integration on real Postgres), 27 Playwright (26 + 1
  skipped video recorder).

## 3. Results

| Run | typecheck | lint | vitest | build | Playwright |
|---|---|---|---|---|---|
| Baseline, fresh clone of 61ac95f, new DBs | pass | pass | **255/255** | pass | **26 passed, 1 skipped** |
| Post-audit, fresh clone of 208c98a, new DBs, `npm run audit:report` | pass | pass | **294/294** | pass | **35 passed, 1 skipped** |

The skipped Playwright test is the demo-video recorder (runs only with `RECORD_DEMO=1`).
One intermediate run had 2 browser failures, both caused by audit changes and fixed before the
final run: a test that read the URL before navigation finished (test bug), and a new nav item
named "Guided path (B09)" that captured the ⌘K "B09" query (renamed "Guided demo").

## 4. Findings

39 findings in `findings.json` (one entry, J-8..J-13, groups six accessibility fixes):
**31 fixed with a regression test**, 2 fixed without an automated test, 2 documented (not
changed), 3 open (not fixed; one of them, O-1, is informational), 1 refuted. Every "fixed" entry
in `findings.json` names its test; every test marked red/green was run against the baseline code
first and failed. `final-run/verification.json` recounts these from `findings.json`.

| Status | Meaning | IDs |
|---|---|---|
| fixed | Changed, with a regression test that passes | A-1, A-4, B-2, B-3, B-5, D-1, D-3, D-4, D-5, D-7, D-8, E-3, E-6, E-7, F-1, F-2, G-4, G-5, G-6, I-1, I-2, I-4, I-5, J-1, J-2, J-4, J-5, J-6, J-7, J-8..J-13, J-14 |
| fixed_untested | Changed, no automated test | J-3 (screenshot script), O-2 (channel row tie order) |
| documented | Not changed; the limitation is written down where the number is shown | D-2 (branch CAC attribution), F-3 (click-age window) |
| open | **Not fixed** | G-7 (deletes and merges never detected), G-8 (late payment changes past the 35-day sweep), O-1 (info: reseed log noise in the test harness) |
| refuted | Investigated, not a defect | D-6 |

| ID | Sev | Area | Finding | Status |
|---|---|---|---|---|
| D-1 | high | D | Unmapped spend could never block a budget signal (its exception has no branch) | fixed |
| F-1 | high | F | Cancelled plans planned as Data Manager retractions, which Data Manager does not support | fixed |
| G-6 | high | G | A non-office wire time zone changed search windows but not the mapper | fixed (refused) |
| J-1 | high | J | An engineer could re-map or replay with no approval from the incident page | fixed |
| J-2 | high | J | Demo script walked the bypass path; quoted numbers asserted nowhere | fixed |
| A-1 | medium | A | Re-observed version that changed live rows published no event | fixed |
| B-2 | medium | B | Drain lost a kick that arrived during its final dispatch | fixed |
| B-3 | medium | B | Drain spun every 50 ms for up to 10 min on a stream held elsewhere | fixed |
| D-2 | medium | D | Branch CAC: spend by marketing branch, customers by servicing office | documented |
| D-3 | medium | D | CAC denominator included customers whose spend the numerator excludes | fixed |
| D-4 | medium | D | Payload conflicts had no branch and no customer | fixed |
| E-3 | medium | E | `POST /api/role` worked in any production build | fixed |
| F-2 | medium | F | "Not matchable: no click id" was false | fixed |
| G-4 | medium | G | Autumn clock change could drop a record between two sync windows | fixed |
| G-5 | medium | G | 429 without Retry-After exhausted retries inside one minute | fixed |
| G-7 | medium | G | Deletes and merges are never detected | open |
| I-1 | medium | I | Record keys could close the `<tool_output>` delimiter | fixed |
| I-2 | medium | I | A failed model run was labelled "no model configured" | fixed |
| J-3 | medium | J | Screenshot script targeted a removed test id | fixed, untested |
| J-4…J-13 | medium | J | Pagination (customers past end, 200-row queue cap, prefix audit links), `?period=toString`, focus/status after Execute, busy controls dropping focus, command menu semantics, chart data, diff row headers, skeleton announcements | fixed |
| A-4, B-5, D-5, D-7, D-8, E-6, E-7, I-4, I-5, J-14 | low | various | see `findings.json` | fixed |
| O-2 | low | O | Channel rows tied on customer count came back in a different order between runs | fixed, untested |
| F-3 | low | F | Click age measured from the lead time with a hard-coded 90 days | documented |
| G-8 | low | G | Late payment status changes older than the 35-day sweep are missed | open |
| D-6 | low | D | Coverage-gap reference date global, not per feed | refuted: all ad platforms share one `ads` stream |
| O-1 | info | A | Reseed during a server dispatch logs `relation domain_events does not exist` (test harness only; retried) | open |

Area C (transactions, rollback, idempotency) found no defect beyond B-5; the reviewer's checks
(dry runs roll back events, replays, jobs and nested savepoints; replay keys bound to request
fingerprints; execution keyed by proposal with the precondition re-checked under lock) are listed
in `findings.json` sources.

## 5. Synthetic numbers that changed, and why

Golden fixtures were regenerated with the app's own export scripts on a fresh database.

| Fixture | Change | Cause |
|---|---|---|
| `docs/case-file/snapshot.json` | October company paid customers 1,726 → 1,724; paid CAC $266.85 → $267.16 (still "$267") | D-3: two B44 customers credited to an unmapped campaign left the denominator |
| same | Open exceptions 186 → 187; revenue in open exceptions +$269 | D-4: payload conflicts now carry their branch and customer |
| same | `retract` key → `suppress_cancelled` (value 0) | F-1 |
| same | New fields (untied/disputed split, per-channel dry-run rows) | the file predated those export fields; not a number change |
| `docs/changeguard/snapshot.json` | **None** (identical apart from generation stamp) | O-2 made tied channel ordering deterministic |
| Demo script numbers (B20 $490 / $267, 119 records, 53 customers, dry run $365 → $284; B09 8.6× → 2.9×, $2,124, 45 leads, 22 records) | **None** | |

B44's October budget signal is now "not trustworthy" and B44 appears in the Overview holds list
(D-1). No number quoted in `docs/interview-demo.md` involves B44.

## 6. The four-minute B09 path

`/demo` → **Start the path**. Overview → Incident → Evidence → Dry run → Approval → Verified
correction → Decision readiness → Audit, 240 seconds in eight timed steps, with a guide bar on
every step (role button, what to show, what to say, leave at any point). Numbers are pinned in
`tests/fixtures/b09-golden.json`; `tests/e2e/zz-b09-four-minute-path.spec.ts` walks it from a
fresh seed and asserts each one. Final run: passed in 11.7 s of automated time.

## 7. Still uncertain

- Every connector behaviour was tested against the in-repo mock only. Mapper deviations G1–G10
  versus the current FieldRoutes docs remain (Pacific-time datetimes, `isInitial`, invoice
  `templateType`, payment applications), as do G-7 and G-8.
- Google: the Data Manager facts come from Google's documentation as read on 2026-11-09; one
  overview page contradicted the upgrade guide on retractions (the more specific page was
  followed). Enhanced conversions for leads, gbraid/wbraid and consent are not built.
- The model path of the AI investigator was tested with a scripted client only.
- No GitHub Actions run has been observed; CI was reproduced locally.
- D-2 (which branch owns CAC) is a business decision, not settled by code.

## 8. Claims for a technical interview

`claims.json` lists 12 claims that are safe (each backed by passing tests in the final run) and 9
that are not, with the reason. Short form:

**Safe:** exactly-once ingestion; fenced, idempotent sync workers; a transactional outbox with
snapshot coverage; no write without propose → rolled-back dry run → approval by another role →
one verified execution; ledger conservation on every fix; budget signals that refuse broken data;
collected revenue equal to ground truth to the cent; server-side scope with out-of-scope reading
as missing; an AI investigator that cannot write SQL or act; production builds that are not demos;
the documented FieldRoutes search → get pattern including the clock change; a four-minute path
reproducible on every seed.

**Not safe:** tested against any real account; production-ready connector; sends or retracts
Google conversions; respects Google's click window; AI evaluated with a real model; has
authentication; CI passes on GitHub; branch CAC is unambiguous; anything about Moxie's own data
or tools.
