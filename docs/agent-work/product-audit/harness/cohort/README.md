# Cohort fixture (BUSINESS-FIT.md §3)

A synthetic money-and-cohort fixture run against the product's own intake, reconciliation and
metrics, on the isolated `revenue_signal_audit_cohort_test` database only.

| File | What it is |
|---|---|
| `expected.json` | the expected answers, written before the first run |
| `c1-cohort.audit.ts` | parts 1–3: funnel, cash at cutoffs, the CAC split (A's campaign, B's customer), and the variant with the lead tagged to B |
| `c2-swap-later.audit.ts` | parts 4–5: the equal-total swaps and the changes after a decision cutoff |
| `cohort-lib.ts`, `vitest.cohort.config.mjs`, `empty-module.mjs` | shared helpers and the audit-only test config |
| `evidence.jsonl` | the run's evidence lines, taken **before** the CAC fix (B11 reads "$0.00") |
| `proof.cjs`, `proof/before`, `proof/after` | the running app on the fixture, before and after the paid-CAC v4 fix |

The checks report a miss where the product falls short of `expected.json`, so a run "fails" by
design. To rerun from the repository root:

```bash
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54333/revenue_signal_audit_cohort_test npx vitest run --config docs/agent-work/product-audit/harness/cohort/vitest.cohort.config.mjs
```

The proof captures came from `next dev` on a restored copy of the fixture
(`revenue_signal_audit_cohort_view`) with `DEMO_MODE=1`, then `node proof.cjs before` and
`node proof.cjs after`. The seed-side control is `../cac-zero-control.mts`.
