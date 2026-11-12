# ChangeGuard held-out evaluation (2026-11-11, evening)

A blind scenario set, written without the implementation, run against the real preflight, approval,
release and monitoring paths. Everything below can be re-run:

```
npx tsx scripts/eval-changeguard.ts docs/agent-work/changeguard-heldout/scenarios.v1.json out.json
```

Each scenario gets its own fresh database (`revenue_signal_eval` on port 54333). A full run takes
about 45 s.

## How it was kept blind

| Step | Evidence |
|---|---|
| The author was an independent agent given only the brief, the format and the permitted documents (business requirements, source contracts and mappers, invariants, roles, state transitions). Told not to open `lib/changeguard/`, `tests/`, the ChangeGuard documents, or git history; allowed to run only a JSON parse check | `changeguard-heldout/BRIEF.md` §9, `SCHEMA.md` |
| It wrote 50 scenarios over all 11 categories: 60 labelled decisions (34 `ALLOW`, 12 `BLOCK`, 12 `NEEDS_REVIEW`, 2 `UNSUPPORTED`) | `scenarios.v1.json` |
| The labels, the scoring rules and the runner were committed **before any scenario ran** | commit `151badb`; scenario file sha256 `eb8159ef…ec208c` |
| Two scoring amendments were made after reading the author's stated interpretations and before the run, without seeing any result (A1: a proposal refused for its actor is scored on the refusal; A2: one monotonic step clock) | `SCORING.md`, "Amendments" |
| First contact was committed as it ran, then never edited | commit `ea93e5a`, `evidence/first-contact.json` |

The runner calls what the HTTP routes call: the route's request schema, then `createChange`,
`decideChange`, `releaseChange`, `monitorChange`, `rerunPreflight`. The world is built through the
real intake (`ingestRecords` and the deployed mappers), the real mapping and lead-override actions,
and reconciliation. It reimplements no ChangeGuard rule.

## Clean checkout first

`518ec0d` in a fresh worktree with freshly created databases (`rso_verify`, `rso_verify_test`):
`npm ci`, migrate, seed, typecheck, lint, **vitest 551 / 551**, build, **Playwright (`CI=1 VISUAL=1`)
69 passed, 1 skipped, 0 failed** (14.3 min). The skip is the demo-video recording. Log:
`changeguard-heldout/evidence/clean-checkout-518ec0d.log`.

## First contact (held out)

48 valid scenarios, 55 scored decisions. Two scenarios turned out invalid (below).

| Measure | Result |
|---|---|
| **False approvals of unsafe changes** (expected `BLOCK`, system `ALLOW`) | **0** |
| Under-blocks (expected `BLOCK`, system `NEEDS_REVIEW`) | 0 |
| **Critical financial or authorization failures** (valid scenarios) | **0** |
| Steps that had to be refused: guest, branch partner and brand viewer proposing; brand viewer approving; approver and brand viewer releasing; proposers approving; approving a blocked change or a rejected one; approving with another change's reviewed identity (HO-38); releasing before approval; releasing a source contract; a non-author resubmitting; monitoring before release | **25 / 25 refused** |
| Financial invariant violations (FI-1, 2, 3, 4, 6 measured around every step) | 0 |
| Wrong live mapping at the end | 0 |
| Correct decisions requiring human review | 6 |
| **Missed reviews** (expected `NEEDS_REVIEW`, system `ALLOW`) | **2** (HO-24, HO-25) |
| False blocks (expected `ALLOW` or `NEEDS_REVIEW`, system `BLOCK`) | 5 (HO-14, HO-18, HO-28, HO-48, HO-50) |
| `UNSUPPORTED` expected and given (effective-dated mapping, unmodelled change kind) | 2 / 2 |
| Blocks and reviews carrying a failing or warning check with its reason | 24 / 24 |
| Scenarios matching every expectation | 27 / 48 |

Decision matrix (expected → system): `ALLOW→ALLOW` 27, `BLOCK→BLOCK` 13, `NEEDS_REVIEW→NEEDS_REVIEW` 6,
`NEEDS_REVIEW→BLOCK` 4, `NEEDS_REVIEW→ALLOW` 2, `ALLOW→BLOCK` 1, `UNSUPPORTED→UNSUPPORTED` 2.

### The two "critical" lines in the raw first-contact log

`first-contact.txt` lists HO-33 (a release accepted that should have been refused) and HO-44 (wrong
live mapping) as critical. **Both scenarios are invalid, not failures.** Each asks the older Action
Center path to remap an **already mapped** campaign after approval. That path refuses
(`ActionError: Campaign not found or already mapped`, recorded at the step in `first-contact.json`),
so the outside remap the scenario depends on never happened. The release and monitoring results are
correct for what did happen. The first runner recorded the refusal without reporting it. It now
reports any refused world step as an invalid scenario (commit `768a8ba`). A regression test pins
the property this revealed: **only ChangeGuard can move a mapped campaign's spend**
(`changeguard.heldout-regressions.test.ts`, HO-33 / HO-44).

What this leaves unmeasured by the held-out set: the base moving between approval and release
through a path that works (an unmapped campaign mapped by the Action Center). The internal TOCTOU
test covers it; no blind scenario did.

## Adjudication of every other miss

The labels are not changed. Each miss is classified here.

| Scenario | Expected → system | Verdict | Why |
|---|---|---|---|
| HO-24 outbound / spam / not-a-lead calls | `NEEDS_REVIEW` → `ALLOW` | **Defect (high), fixed** | The deployed calls@1.1 maps them as leads; the preview called the shape benign |
| HO-25 spend in CAD | `NEEDS_REVIEW` → `ALLOW` | **Defect (high), fixed** | ads@1.1 would sum CAD as dollars; the preview called it benign |
| HO-48 mapped to Mission B28, all 13 leads at Moxie B05, proposed B05 | `NEEDS_REVIEW` → `BLOCK` | **Defect (high), fixed** | A cross-brand mis-mapping could never be corrected toward its own evidence: a dead end with the money at the wrong brand |
| HO-50 three-way split 5 / 4 / 4, proposed the 5 | `NEEDS_REVIEW` → `BLOCK` | **Defect (medium), fixed** | The plurality branch was called a contradiction, and the evidence text said "5 arrived at B27 and 5 at B27" |
| HO-14 B07 6 leads vs Mission B29 7, proposed B07 (Moxie) | `NEEDS_REVIEW` → `BLOCK` | Label disagreement, not fixed | Most leads and the majority brand point elsewhere; blocking is the safe direction, with correct evidence |
| HO-18 remap B22 → B23 with 10 leads at B22 and 9 at B23 | `NEEDS_REVIEW` → `BLOCK` | Label disagreement, not fixed | The proposed branch has fewer leads. The scenario's real point (a handover needs an effective date) is the stated limit: mappings are not effective-dated |
| HO-28 CRM payments with `officeID` "15" | `ALLOW` → `BLOCK` | Author data error | The author assumed office 15 is B15's CRM office; it is not, and the mapper correctly refuses an unknown office |
| HO-21 approving a source contract | step `accepted` → `refused` | By design | A source contract stops at review (BR-11). The brief's "reviewed but never released" left room to read approval as allowed |
| 13 scenarios: status `monitoring` expected right after release | `monitoring` → `verified` | Label reading | Release verifies in the same step (BR-8), passing through `monitoring`; the brief's state list did not say so |

## Fixes (each with a regression test that failed before it)

`tests/integration/changeguard.heldout-regressions.test.ts`, 9 tests. The 4 defect tests were run
red before the fixes, the 5 guards green before and after.

| Defect | Fix (commit `b7fa221`) | Guard kept |
|---|---|---|
| Source contract preview passed shapes the deployed mapper misreads | Each sample also runs through any **staged** mapper version (calls@1.2, ads@1.2, already written from the vendor documentation). If the staged version refuses what the deployed one projects, the check warns `DEPLOYED_MAPPER_MISREADS` with the staged refusal codes (`NOT_INBOUND`, `SPAM_CALL`, `NOT_A_LEAD`, `CURRENCY_UNSUPPORTED`) | A benign added field (`call_score`) still passes |
| Cross-brand correction toward the evidence was impossible | When the current mapping is in another brand but the campaign's lead majority is in the proposed brand: a warning (`CROSS_BRAND_CORRECTION`) a person must accept | With no lead evidence, or a lead majority in another brand, still `CROSS_BRAND` (block) |
| The plurality branch counted as a contradiction | "Disagrees" now means under half of the leads **and** another branch has more. A plurality without a majority is split (warning) | A branch with fewer leads than another is still blocked, and the message names the other branch |

One existing test encoded the old boundary (5 of 13 at the plurality branch counted as a
contradiction). Its purpose is that evidence drift across the decision boundary invalidates an
approval. It now drifts across the new boundary (another branch overtakes) and still passes.

### After the fixes (same file, no longer held out)

`evidence/after-fixes.json`: missed reviews 0, false blocks 3 (HO-14, HO-18, HO-28: the
adjudicated rows above), correct human reviews 10, false approvals 0, refusals 25 / 25, invariant
violations 0, 26 / 26 blocks and reviews explained. 31 of 48 match every expectation; 13 of the
other 17 differ only in the `monitoring` / `verified` reading. **This run measures the fixes, not
generalisation.** A fresh blind set (v2) is the only honest next measurement.

## The ~5-second dry run and execution

Measured, not assumed (statement log at 150 ms, then `EXPLAIN ANALYZE`):

| Part of one dry run or execution (seeded world, `fsync=off`) | Cost |
|---|---|
| 4 all-branch scorecards (`branchRows`, before and after, twice) | about 3 s (0.67–0.90 s each) |
| 2 temp tables of `v_acquisitions` (reprojection) | about 1 s |
| Everything else | about 1 s |

`branchRows` evaluates the `v_acquisitions` view twice (its `sold` and `acq` parts); each pass walks
all 17,111 customers through per-row subqueries. One measured option: a single materialized pass.

| `branchRows` | p50 current | p50 materialized | Rows |
|---|---|---|---|
| All branches | 751 ms | 629 ms | identical |
| One branch (B20) | 734 ms | 616 ms | identical |
| Joshua's five branches | 750 ms | 616 ms | identical |

**Recommendation: do not apply it now.** It saves about 0.5 s of 5 s per operation (10%) and about
0.12 s per page. Rows were identical in the scopes tested, but the query feeds every page's numbers,
and the gain does not change what a presenter sees (a 4.5 s wait is still a wait). Most of the
remaining cost is deliberate: the before-and-after scorecard of **every** branch is what proves "no
unrelated branch moved". A larger gain would need a set-based rewrite of `v_acquisitions`, which
every attribution metric reads. That is not justified by a demo wait. If a real deployment needs it,
apply the materialized CTE first and run the full regression and the scenario suites.

## Coverage and limits (stated, not hidden)

- **One author, an AI agent.** Not human revenue-ops experts. Its labels disagree with the system
  in defensible ways (HO-14, HO-18); a second, human labeller would settle those.
- **The runner and the system share an author.** This is mitigated by frozen labels and rules and a
  committed first contact, but the adjudication above is also the system author's; read it with
  that in mind.
- **Not exercised by a valid blind scenario:** the base changing between approval and release
  (both attempts used an impossible path), and SSO identities (the actors are demo subjects).
- **Concurrency**: one scenario ran steps at the same moment (HO-37, two people releasing one
  approved change: exactly one accepted, the other refused). The other three were sequential
  (a competing change for the same campaign, a swapped review identity, approving after a
  rejection). None of this is a deterministic interleaving proof; the internal
  `concurrency.test.ts` is.
- **Self-approval by an author who also holds the approve permission** cannot be expressed with the
  demo roles (no role both proposes and approves); the internal tests cover it.
- **Monitoring** uses the same "at least half of the leads since release" rule as before; the new
  plurality rule was not carried into monitoring, because no scenario showed a need.
- **Synthetic data only.** No vendor account, CRM or ad platform was touched.

## Final regression

See `FINAL-EVIDENCE.md`, "Held-out evaluation".
