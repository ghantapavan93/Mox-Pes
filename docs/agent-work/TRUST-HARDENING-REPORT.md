# Financial and AI trust hardening: R-38, R-37, the 11 critical VP findings

2026-11-12, branch `feature/audit-enterprise-redesign`. All data is synthetic, and everything runs
locally: no model, no live integration, nothing pushed or deployed. Commits: `b0de6c6` (R-38),
`c8d47fc` (R-37), `69214bd` (the critical review); then this report.

## 1 · Root causes

### R-38 · a template sentence with an unproved part read as supported

- **Path.** A tool computes a figure → a deterministic template writes the sentence
  (`lib/ai/deterministic.ts`) → `groundDraft` proves it (`lib/ai/proof.ts`) → `judge()` decides
  the support status → `buildClaims` → the claim check in the UI (`FindingsView.tsx`).
- **Cause.** `judge()` treated authorship as evidence. For model text, any unproved proposition
  meant "not supported". For a template, only a contradiction did. Everything else was
  SUPPORTED, with the reason "propositions outside the checker's vocabulary are not separately
  proved". So "supported" stood beside "0 of 2 propositions follow".
- **Scale, measured.** 135 of 391 supported claims over 92 demo questions; 32 of 168 on the
  held-out set.
- **Three kinds of unproved part.**
  1. **Record figures** the metric engine has no vocabulary for: "119 calls records quarantined",
     "across 4 campaign(s)", "from 134 stored payment records", one customer's money.
  2. **Readiness counts:** "4 of 4 paid channel(s) not ready". The engine proved readiness per
     named channel only.
  3. **Readings of things that are not claims:** a zip code or a rep's number read as a figure,
     and a quoted exception summary split at its ";" so its figures read as the sentence's own.

### R-37 · a stale payment copy put voided cash back

- **Vendor semantics.** These were determined before the rule was chosen. FieldRoutes payments
  carry no `dateUpdated` in the verified legacy contract (`research/06`, row 4). Current docs
  are said to add one; that is unconfirmed on a real tenant. A `/changelog` entity exists
  (Payment = 61). Payments reach us only by polling: push intake refuses CRM. A poll returns the
  vendor's current state. Replays keep the original receipt time. Sync jobs per office and
  entity are serialized by a unique index and fenced.
- **Cause.** A version is identified by content and ordered by observation, and a
  re-observation was always the newest state. That is right for a healthy poll. It is wrong when
  a stale replica serves an earlier version. The mock models exactly that fault (`out_of_order`:
  "a stale replica answers"). For appointments the source clock rejects the stale version. For
  payments nothing did, so an earlier "successful" copy after a void counted as cash again. The
  first poll can also see only the void; the replica then serves the pre-void version, which the
  ledger never saw.

### The 11 critical VP findings

None is a money or authorization defect (`vp-acceptance/evidence/CRITICAL-REVIEW.md`).

## 2 · Red / green

| Suite | Before the fix | After |
|---|---|---|
| `tests/unit/ai-template-trust.test.ts` (new, 18) | 12 failed, 6 passed (the 6 are guards that already held) | 18 passed |
| `tests/integration/payment-revisions.test.ts` (new, 12; 13 after the void-reverted case) | 7 failed, 5 passed | all passed |
| Connector stale-replica payment case (new) | written after the rule; covers the never-seen pre-void version | passed |
| Ledger model, 24 random histories | encoded the old rule; updated to the new rule as an independent fold | model = incremental = rebuild from the ledger, 24 of 24 |
| VP-05 · 8 safety (new) | guard: the claim held, it had no direct test | passed |

The red runs stashed the library fix and kept the new tests, as in earlier milestones. Older
tests that encoded the old behaviour were changed to the new rule, each with a comment saying
why, and none was loosened to pass:
- four AI tests that expected a template to be kept for being a template (three in
  `ai-proof.test.ts`, one in `ai-claims.test.ts`, which now declares the field it renders);
- three payment tests that expected an old copy to win (`ledger-model` in-batch A, B, A;
  `review-regressions` F2; `domain-model` A-1);
- the ledger model's reference fold.

## 3 · What is more correct now

**AI claims**
- A claim is SUPPORTED only when every figure and status it states is proved, whoever wrote it.
- A template's record figure is proved against the field it renders. The tool, the record and
  the field are shown in the proof. Only templates can declare such a field, and the declaration
  lives outside the schema the model submits.
- Readiness counts are proved from the readiness results, and a wrong count is contradicted.
- Templates are held to the causal net (0 template sentences matched it).
- A quotation is read as a quotation.
- "CAC per paying customer" is no longer certified. A test found it.
- A branch id inside a campaign id is not a branch mention. That alone flagged 279 correct
  sentences when template text was read as model text.
- **Coverage kept.** Every claim kept its status on the demo survey (391 supported) and the
  held-out set (336 claims). Held-out scores are unchanged: 32/32 outcomes, claims 136/138,
  75/75 wrong candidates rejected, 0/60 critical false accepts.

**Money**
- A payment version that would raise counted cash is held when it is an earlier version seen
  again, or the live voided version with only its status put back.
- A held version is counted as a delivery, and the later state stays. A version first stored
  while held is kept as excluded evidence (`EARLIER_VERSION_HELD`), so a rebuild from the ledger
  agrees. A high payload conflict tells a person what happened.
- A correction (changed amount or date) still applies, and a void seen again still removes cash.
- Live payments are locked in id order before any raw event is written.
- **Seeded world.** It holds 0 payments, so its figures are unchanged (company paid CAC
  $267.16).

**Evaluation**
- The VP-05 safety claim is pinned by a test.
- Each critical finding has a verdict backed by evidence. No label was changed.

## 4 · The 11 critical-labelled VP findings

| Finding | Verdict |
|---|---|
| VP-01 · 21, VP-05 · 13, VP-12 · 9: `monitoring` expected, `verified` observed | Legitimate ambiguity with a real gap: "verified" means verified at release, and nothing re-checks later (R-30) |
| VP-01 · 12: H2 expected SUPPORTED, observed UNRESOLVED | Incorrect reference expectation: the scenario's own customers kept coming through paid channels; they were left out of the count |
| VP-05 · 8: B47 expected refused, observed blocked | Legitimate design ambiguity; safe, and now tested |
| VP-06 · 10 (six figures): an office move should move the acquisition | Legitimate business ambiguity: FR-3 says "where they were serviced", and the product credits the first service's office; Moxie must rule (R-36, R-42) |

## 5 · New and remaining risks

- **R-37, still open.** A real void reversal with nothing else changed is held until a person
  checks it, so cash is understated, never overstated. A stale void lowers cash. Closing the
  conflict does not apply the held version.
- **R-38, still open.** Templates are not held to the model's closed reading. A template whose
  wording misdescribes a correctly rendered field is caught only by its tests.
- **R-42 (new).** An office transfer is not flagged.
- **R-43 (new).** The evaluation path runs parallel queries on one client (pg deprecation,
  evaluation only).
- **Shared-phone rule latency, re-measured.** The view takes 316 ms against 165 ms before the
  rule; the scorecard takes 681 ms for 44 branches. All probes are index scans, so no
  optimization is justified.
- **Not shown by any of this.** No model ran (R-10). No human usability study (R-35). Labels
  are by one AI author (R-36).

## 6 · Regression results

These come from one full production regression in the main checkout, at `69214bd`. Steps ran in
sequence, with nothing else running (log: `C:/Temp/final-regression-r38.log`).

| Gate | Result |
|---|---|
| Typecheck, lint | pass, pass |
| Unit and integration (vitest) | **784 / 784** |
| Seed | 134,088 raw events; 0 payments held by R-37; company paid CAC $267.16 |
| eval-ai (deterministic) | **15 / 15**; 0 unsupported claims, 0 forbidden claims |
| Investigator held-out (62 cases) | outcomes **32 / 32**; reference facts in a supported claim 32 / 32; claims 136 / 138 (IV-16 by design); wrong candidates rejected 75 / 75; **0 / 60** critical false accepts; template sentences contradicted by their own proofs 0 / 168 |
| ChangeGuard held-out (50) | 30 match, 18 status-wording disagreements (`monitoring` vs `verified`), 2 invalid (HO-33, HO-44); unchanged from the last run |
| VP pack (12 scenarios, `--twice`) | 509 checks, **16 failed, 11 critical**. They are the same 16 findings as `after-changes-3`, none new and none gone. Every scenario repeated identically |
| Shadow pack (12 scenarios, `--twice`) | **320 / 320**; every scenario repeated identically |
| Production build | pass |
| Browser suite (production server, pixel baselines on) | **111 passed, 1 skipped, 0 failed** (23.9 min), including the R-38 assertion in `zy-evidence-journey` |

The isolated-checkout run of the commit that adds this report follows in 6a. It was added after
that run finished.

## 7 · Next: the smallest complete Reliability Twin slice

- **Change.** One change kind, the calls mapper version (calls@1.0 → calls@1.2, which reads the
  119 held B20 records), rolled out over 1 → 5 → 44 branches in a world cloned from the seed
  (`create database … template`, as the scenario runner already does).
- **Five invariants per stage.**
  - The cash trace and the CAC trace reproduce the scorecard.
  - No lead is two customers' first touch.
  - Company spend is conserved.
  - No branch outside the stage changes.
- **Two fault families per stage.** A 429/503 mid-window with backfill, and a crash after commit
  before acknowledgement. Each must end with no gap and no double count.
- **Gate.** A failed invariant stops the rollout. Recovery re-projects the stage's branches with
  the old mapper and must restore the pre-change state exactly (a diff of zero).
- **Shown as** one stage table on the ChangeGuard change page.
- **Acceptance.** A blind scenario pack in the VP pack's format, frozen before the first run.
- **Built from parts that exist.** ChangeGuard, the replay, sync jobs, the mock's fault store,
  the traces and the scenario runner. No new agent or framework.
