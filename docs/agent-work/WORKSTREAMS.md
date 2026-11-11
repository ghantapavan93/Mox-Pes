# Workstreams and independence

The brief allowed parallel worktrees. They were **not** used for building. The new subsystem was
one coherent vertical slice with shared contracts (the mapping spec, the compiler, the service);
splitting it across builders would have created integration work without saving time. Parallel
agents were used where **independence** was the point:

| Agent | Role | Could read | Could not read | Output |
|---|---|---|---|---|
| Labeler 1 | Held-out eval set v1 + six hostile export files with expected outcomes | `lib/onboarding/targets.ts`, `lib/reference.ts` | The assistant, its tests | `mapping-eval.v1.json`, `holdout/*`, `EXPECTED.md` |
| Labeler 2 | Held-out eval set v2, harder vocabulary | same | v1, holdout, assistant, tests | `mapping-eval.v2.json` |
| Labeler 3 | Held-out eval set v3, written after the rules froze | same | v1, v2, holdout, assistant, scripts, tests | `mapping-eval.v3.json` |
| Data reviewer | Correctness counterexamples | All code, read only; no DB | — | 12 findings (REVIEW-FINDINGS) |
| Security reviewer | Attack the upload, intake and permissions | All code, read only; no DB | — | 9 findings (REVIEW-FINDINGS) |

The main thread owned contracts, implementation, integration, the global test runs and the final
evidence. Reviewers were briefed with what the feature *claims*, not with how it was built, and
were asked for reproductions, not opinions.
