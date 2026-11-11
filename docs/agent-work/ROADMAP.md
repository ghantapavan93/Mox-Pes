# Roadmap

Ordered by the brief's execution order. Status as of 2026-11-11 (end of this session).

| Milestone | Brief phase | Status | Evidence / what is left |
|---|---|---|---|
| M-0 Preserve and baseline | 0 | **Done** | Backup `Moxie-backups/worktree-2026-11-11/` (tarball + diff); baseline typecheck, lint, vitest 332/332 |
| M-1 Adversarial tests of the current system | 1 | **Done** | 36 intake cases; 8 defects found (ADVERSARIAL-MATRIX §1) |
| M-2 Repair high-severity defects | 2 | **Done** | All 8 fixed, red-proven on `HEAD`, regression-tested |
| M-3 Staging-first data onboarding | 3 | **Done (bounded)** | CSV/XLSX/JSON → profile → mapping versions → dry run → quarantine → approval → publication / reconciliation; UI; API; 4 browser tests. Limits: 5 MB / 50k rows; four datasets |
| M-4 AI-assisted mapping with evaluation | 4 | **Done (deterministic)** | Assistant + 3 independent sets (184 cases); held-out wrong-suggestion rate 2.2%; regression gate. Model mode: not evaluated |
| M-4b Independent review and repair | 25/7 | **Done** | 21 reviewer findings, all fixed with tests (REVIEW-FINDINGS) |
| M-5 Revenue opportunity workflows (Scenario B missed follow-up, C retention) | 5 | **Partly done (2026-11-11)** | `/decisions/opportunities`: both journeys on stored data, every statement labelled (fact / inference / hypothesis / recommendation / measured outcome), readiness policy with audited one-step overrides (docs/agent-work/OPPORTUNITIES.md). Open: outbound follow-up data, lead qualification, cancellation reasons, post-service retention signals, a measured intervention |
| M-6 Decision readiness by policy (materiality, scope, overrides) | 13 | **Not started** | Today: per-channel verdicts with reasons. Needs materiality thresholds, partial decisions, documented overrides, false-positive tracking |
| M-7 Integration contracts | 6/10 | **Documented** | INTEGRATION-CONTRACT; no live system |
| M-8 Held-out adversarial, performance, security | 7 | **Partly** | Held-out exports and eval sets; benchmark to 50k rows (`fsync=off`); two reviews. Not done: 1M/10M, load concurrency |
| M-9 Executive and technical demos | 8 | **Done (written + browser-verified flow)** | EXECUTIVE-WALKTHROUGH, TECHNICAL-DEEP-DIVE; demo exports generated from the seed |

## Next, in order

1. Commit decision for this work (nothing is committed; see PROGRESS).
2. M-6 before M-5: a readiness policy that does not block a whole budget decision for one
   unrelated record changes what the existing product says every day.
3. A v4 evaluation set written after this session's changes, and a small human-labelled set.
4. R-3 (CRM account namespacing) before any multi-brand real data.
