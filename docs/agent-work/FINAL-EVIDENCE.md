# Final evidence matrix (November 11 continuation)

Every claim below points at something that can be re-run. "Not done" means not done.

All work is committed locally on `feature/audit-enterprise-redesign`. **Nothing was pushed,
deployed or merged.** No real company data and no vendor credentials were used.

## Commits

| Commit | Content |
|---|---|
| `454d6e5` | Enterprise redesign phase 2 and hardening (baseline, Stage 0) |
| `dcbb806` | Adversarial intake: 36 hostile cases, 8 defects fixed (Stage 0) |
| `0979ec7` | Data onboarding lab, schema-assistant evaluation, review fixes (Stage 0) |
| `c6ed3e3` | Concurrency, ledger lifecycle, person-level separation of duties (Stages 1–3) |
| `c875ec9` | Severity-aware assistant evaluation, 1M-row durable benchmark (Stages 6–7) |
| `88747a1` | Vendor contract states, staged calls@1.2 and ads@1.2 (Stage 4) |
| `29a9d1b` | Revenue opportunities: missed follow-up and pre-service retention (Stage 5) |
| `f3d123f` | Migration checksums ignore line endings |
| `01c6472` | Independent review fixes; demo storyline and technical deep dive (Stages 8–9) |

## Stage by stage

| Stage | What the brief asked | Evidence | Status |
|---|---|---|---|
| 0 Baseline | Durable commits; clean-worktree verification | Three logical commits; clean checkout of `0979ec7`: `npm ci`, migrate, seed, typecheck, lint, vitest 419/419, build, e2e 62 passed / 3 skipped (`VERIFICATION.md`) | **Met** |
| 1 Reconciliation correctness | Property and model-based tests; full = incremental; no silent financial change | `ledger-model.test.ts`: 24 seeded random histories, incremental = reference model = rebuild; a negative control. Two bugs found red, fixed (in-batch A,B,A; `last_delivered_at`). Cross-brand CRM moves quarantined (0015) | **Met** |
| 2 Concurrency | Deterministic tests A–H with barriers | `concurrency.test.ts`: 10 staged interleavings proven blocked via `pg_stat_activity`. Found a deadlock (40P01) in the table-lock design, and (by review) an unlocked replay path; both fixed, red/green | **Met** (F covered by the existing worker-takeover test) |
| 3 Security and identity | Role forging, escalation, same-person approval, CSRF, audit integrity, ASVS 5.0 | Separation of duties by subject, DB-enforced (0014); append-only audit; CSRF proxy; Secure cookie; `SECURITY-ASVS.md` chapter table | **Met with limits**: demo authentication (V6 not met), no CSP, unkeyed hashes |
| 4 Vendor contracts | Simulators from official docs; documented / assumed / mock-verified / live-verified | `VENDOR-CONTRACTS.md` (CallRail v3, Google Ads v26, FieldRoutes); `vendor-contract.test.ts` 17 cases. Four silent states found; staged mappers refuse them | **Met** for documentation and mock verification. **Live verification: none, by rule** |
| 5 Journeys and readiness | Missed follow-up and retention with FACT / INFERENCE / HYPOTHESIS / RECOMMENDATION / MEASURED OUTCOME; policy-based readiness | `/decisions/opportunities`, `OPPORTUNITIES.md`; readiness policy with audited, append-only, one-step overrides; unit 12, integration 8, e2e 2 | **Met**. On the seeded data neither hypothesis is supported, and the page says so. No outcome has been measured |
| 6 AI evaluation | Severity-aware metrics; no tuning on held-out data; a model only if authorised | `AI-EVALUATION.md`. Held-out v3: precision 97.8% vs 93.0%; one critical error vs six; burden 52 vs 58. Calibration not established. Gate in CI | **Met**. Model-backed candidate **not evaluated** (no authorised access) |
| 7 Performance | Reproduce 50k; 1M durable; throughput, memory, CPU, latency, WAL, correctness, restart | `PERFORMANCE.md`: 1M rows in 178 s durable (5,604 rows/s), p50/p95/p99 339/439/627 ms, 199 MB RSS, 1,981 MB WAL, exact totals; crash, hard kill and resume exact; 50k reproduced on both configurations | **Met** for 1M on one laptop. **10M not run** (reason in §4) |
| 8 Whole-product review | Review and simplify; browser inspection | One independent reviewer: 8 findings, 7 fixed with tests, 1 documented (`REVIEW-FINDINGS.md`). New page inspected in the browser as marketing and approver. `/simplify` and `/code-review` were not invoked (only on request) | **Met** |
| 9 Demo and deep dive | Verified 5-minute demo (14 steps plus a failed input); technical deep dive; evidence matrix | `EXECUTIVE-WALKTHROUGH.md` (each step mapped to its test); `TECHNICAL-DEEP-DIVE.md` (10 areas); this file | **Met** |

## Final regression (after the last commit)

Run on commit `01c6472`, in sequence, nothing edited during the run:

| Check | Result |
|---|---|
| `npm run typecheck` | pass |
| `npm run lint` | pass |
| `vitest run` (unit + integration) | **510 / 510**, 43 files, 283 s (was 419 at `0979ec7`) |
| `npm run build` (production) | pass, 21 s |
| Playwright on the production server (`CI=1`), pixel baselines included (`VISUAL=1`) | **66 passed, 1 skipped, 0 failed, no retries** (11.4 min). The skip is the demo-video recording, which runs only when asked |

One correction to the record: commit `01c6472`'s message says "opportunity tests 21/21". The
correct count is 20 (12 unit and 8 integration), all passing.

## Found and fixed in this continuation (each with a test that fails without the fix)

| Defect | Found by |
|---|---|
| Table lock deadlocked live intake vs publication on an identical payload (40P01) | Deterministic concurrency test |
| In-batch A, B, A of a receipt-ordered record ended on B | Model-based ledger test |
| A ledger rebuild could not reproduce the projection (`last_delivered_at` imprecise) | Model-based ledger test, negative control |
| A CRM id reused across brands silently moved a customer | Model-based ledger test |
| Separation of duties by role only (one person, two roles) | Security audit |
| Outbound, spam and not-a-lead calls counted as leads; a non-USD account summed as dollars (staged fixes) | Vendor contract tests |
| Migration checksums broke on a CRLF checkout | Reproduced on the dev database |
| Replay bypassed the lead-write lock | Independent review, then test A4 |
| Existing customers counted as unconverted prospects; a stale override kept showing; unsupported gaps valued | Independent review |

## Recommended next business-facing action

Ask for **one week of real, redacted CallRail and FieldRoutes exports** from one branch, under a
written data-handling approval. Then run them through the onboarding lab's dry run (which
publishes nothing) and the vendor contract tests. That single step answers the largest open
risk (R-1: no real payload has ever been seen). It also tests whether missed follow-up can be
measured (outbound calls) and gives the schema assistant its first human-labelled evaluation.
It needs no deployment and no write access.
