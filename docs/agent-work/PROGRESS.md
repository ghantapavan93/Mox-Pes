# Progress (2026-11-11)

## What exists now that did not this morning

1. **An adversarial harness against the live intake** (36 cases). It found 8 defects in code that
   had passed 332 tests: impossible dates silently moved to other days on four feeds, padded ids
   becoming duplicate ledger keys, float-rounded money, a throwing mapper failing its whole
   batch, an unbounded push body, and quadratic redaction (a 3 MB note would have held an ingest
   transaction open for hours). All fixed, red-proven on `HEAD`, regression-tested.
2. **A data onboarding lab** (`/onboarding`). Upload CSV, XLSX or JSON → profile of every row →
   suggested mapping with evidence and abstentions → a person answers what the file cannot say
   (date order, time zone, what a money column means, value translations) → versioned mapping →
   dry run with the deployed mappers → every row given a disposition → comparison with the ledger
   to the cent → approval by a different role → publication through intake (calls and web
   leads), or comparison only (CRM payments and ad spend). Retention 24 h. Server-side
   permissions; separation of duties enforced by the database.
3. **A measured schema assistant.** Three evaluation sets written by independent agents (184
   cases). Held-out wrong-suggestion rate 2.2% (v3) against a naive baseline's 7.0%; abstains on
   ambiguity 89% of the time against 68%. A regression gate in `npm test`.
4. **Two independent reviews** after all of that was green: 21 more defects (three high-severity
   denial-of-service paths, two silent data-loss paths), all fixed with the reviewers'
   counterexamples as tests.
5. **Production-mode end-to-end verification**, which exposed four more problems the dev server
   hid: a pre-existing invalid nested table, a test-reseed deadlock race, a real layout shift on
   `/customers`, and a test that matched a hidden route kept by React Activity. All fixed.
6. The engineering record in this folder.

## Final results (all from this session's runs)

| Check | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run lint` | pass |
| `vitest run` (unit + integration), run alone | **419 / 419** (35 files; baseline was 332 / 332) |
| `npm run build` (production) | pass; 10 onboarding routes |
| Playwright, production server (`CI=1`), `VISUAL=1` pixel baselines included | **64 passed, 1 skipped, 0 failed** (15.0 min) |
| Schema assistant, held-out v3 | 6 wrong / 269 suggested (2.2%); detection 7/9 |
| Benchmark, 50,000-row export | profile + dry run about 7 s; publication about 7,700 rows/s (`fsync=off`) |

The one skipped test is the pre-existing demo-video recording, which only runs when asked.

Earlier runs in this session that failed are recorded, not hidden: the dev-server end-to-end run
(3 failures from editing files during the run) and the first production run (4 failures, root
causes fixed). See FAILURES.md.

## Completion gates (the brief's acceptance criteria)

| Gate | Status |
|---|---|
| Unfamiliar-data fixtures exercised (independent, held out) | **Met** |
| Ambiguous mappings never silently accepted | **Met** (dry run blocked; eval abstention measured) |
| Invalid records never silently discarded | **Met** (one disposition per row, asserted; unterminated-quote loss fixed) |
| Financial totals explainable | **Met** (cent-exact decomposition, asserted) |
| Source and mapping lineage | **Met** (row → raw event; mapping version and spec hash per dry run) |
| Re-imports idempotent | **Met** (tested) |
| Existing B09 / B20 cases correct | **Met** (scenario suites and both golden paths pass) |
| Concurrency, out-of-order, recovery | **Met** for existing suites; the publication race is fixed by a lock (not deterministically testable) |
| AI: fixed evaluation, abstention, no write access, injection robustness | **Met** for the deterministic assistant. **Not met** for any model-backed AI (not evaluated) |
| Security: staged ingestion, permissions, secrets, PII, audit | **Met** with stated limits (THREAT-MODEL: hashing ≠ anonymisation; demo auth) |
| Measured performance | **Partly met**: to 50k rows; **not** 1M / 10M |
| Clean build, tests passing, reproducible migrations | **Met** |
| Recovery from a clean checkout | **Not re-verified this session** (last verified at commit `7ff8547`); nothing is committed yet |
| Executive and technical demos | **Met** (written; flow browser-verified) |
| Scenarios B and C, decision-readiness policy | **Not met** (ROADMAP M-5, M-6) |
| Live vendor integration | **Not met, by rule** (no credentials) |

## State of the repository

Nothing is committed. All work is in the working tree on `feature/audit-enterprise-redesign`
(on top of commit `7ff8547`, together with the previous session's uncommitted Phase 2 and
hardening work). A backup of the tree as it was this morning is in
`Desktop/Moxie-backups/worktree-2026-11-11/`. The demo database has been reseeded and the demo
exports regenerated. `.claude/launch.json` is a local preview config and should not be committed.
