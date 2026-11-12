# The 11 critical-labelled findings, reviewed one by one

2026-11-12, after R-38 and R-37. The latest VP pack run, `after-changes-3.*`, fails 16 of 509
checks. Eleven of them are labelled critical. The frozen scenarios (`scenarios.v1.json`) and their
labels are **unchanged**. So are the first-contact results and `ADJUDICATION.md`. This page
reviews each critical finding again, with evidence. Each finding gets one of four verdicts: a
real product defect, an invalid test assumption, an incorrect reference expectation, or a
legitimate business ambiguity.

The earlier adjudication was written by the same author as the product, which the independent
review flagged. So every verdict here cites something checkable: the scenario's own world, the
brief's text, the code, or a test that fails if the claim is false.

## Summary

| # | Scenario · step | Label → system | Verdict | Defect fixed? |
|---|---|---|---|---|
| 1–3 | VP-01 · 21, VP-05 · 13, VP-12 · 9 | `monitoring` → `verified` after release | Legitimate ambiguity in the state model, with a real gap behind it (R-30) | No money or authorization defect. Wording and scheduled monitoring stay on the backlog |
| 4 | VP-01 · 12 | H2 `SUPPORTED` → `UNRESOLVED` | Incorrect reference expectation | Not a defect: the scenario's own world contradicts the label |
| 5 | VP-05 · 8 | mapping to B47: `refused` → recorded and blocked | Legitimate design ambiguity; safe | Safety now pinned by a test that fails if a blocked change can be approved or released |
| 6–11 | VP-06 · 10 (six figures) | a customer's office move moves its October acquisition → it stays at B19 | Legitimate business ambiguity: what "where they were serviced" means after an account transfer | Not a defect under FR-3 as written. Needs a business ruling (R-36) |

**No confirmed critical correctness or authorization defect.** Nothing was changed to make a
label pass. The pack still reports 11 critical findings, and it should, until a person rules on
the ambiguities.

## 1–3 · release state: `monitoring` expected, `verified` observed

- **Brief.** BRIEF.md lines 116–117: "approved → monitoring (released)", then "monitoring →
  verified | degraded".
- **Product.** `lib/changeguard/service.ts:366` releases and verifies in one transaction: the
  mapping is applied once and the spend moved exactly, so the status becomes `verified` (or
  `degraded`). `lib/changeguard/model.ts:43` still allows monitoring → verified. The UI says
  "Released and verified. Run monitoring later to check new leads still agree"
  (`components/changes/ChangeActions.tsx:14`).
- **What is right.** Both are defensible as words. The release checks are real checks, and they
  pass. The risk is in the meaning. "Verified" reads as settled, but it means "verified at
  release". Nothing re-checks the mapping later unless a person clicks (R-30). The label's state
  model is the more conservative of the two.
- **Verdict.** Legitimate ambiguity, plus a real gap. There is no money or authorization defect:
  money moved exactly, and only an approved change released. The fix is R-30 (scheduled
  monitoring, and the status shown as "verified at release" until it has run). That is backlog
  item 4. This mission adds no features.

## 4 · VP-01 · 12: H2 "Fewer new customers came through paid channels"

- **Label.** `SUPPORTED`. **System.** `UNRESOLVED`, with this counterevidence: "2 paid
  customer(s) serviced here are credited to a campaign mapped to no branch, so they are outside
  the count", plus the held-spend customers (`lib/inquiry/cac-change.ts:140-160`).
- **The scenario's own world** (`scenarios.v1.json`, VP-01): six October calls at B12 come
  through `c_new`, a paid Google Ads campaign mapped to no branch, and some become B12
  customers. The Meta campaign's spend is held for an unstated currency. The measured paid count
  fell from 6 to 5, but customers kept coming through paid channels: they were left out of the
  count, not lost. Counting them, October has more paid-channel customers than September.
- **Verdict.** Incorrect reference expectation. The label reads a drop in the measured count as
  a drop in real customers. The hypothesis is about real customers. `UNRESOLVED`, with the
  counterevidence shown, is the accurate answer. The designer's own reference names "an unmapped
  new campaign whose customers B12 serviced" as part of the explanation.

## 5 · VP-05 · 8: a mapping to B47, a branch that does not exist

- **Label.** Refused at input, class `UNSUPPORTED`. **System.** Recorded as `preflight_failed`,
  class `BLOCK`, with "fail identifier_presence: Branch B47 does not exist".
- **Safety.** Approval requires `ready_for_review` (`lib/changeguard/service.ts:255`). Release
  requires `approved` (`service.ts:298`). Until today the run showed only that another blocked
  change (ch-1) could not be approved; nothing tested the B47 change itself. Now
  `changeguard.heldout-regressions.test.ts`, "VP-05 · 8", proposes the B47 mapping and asserts
  it is blocked, that approving it throws, that releasing it throws, and that no `B47` mapping
  row exists.
- **Verdict.** Legitimate design ambiguity. Refusing at input gives faster feedback. Recording
  and blocking leaves an audit trail and an explanation. Both are safe, and the ChangeGuard
  held-out set labels the same case BLOCK.

## 6–11 · VP-06 · 10: a CRM customer moves to B21's office

- **Scenario.** Step 8 revises customer a2 to B21's office (dateUpdated 20 Oct). Step 9 delivers
  an older version (15 Oct, B19) late. The label expects a2's October acquisition at B21: B19
  ends with 2 paid customers, B21 with 3.
- **Product.** The acquisition stays at B19: B19 has 3, B21 has 2. Company paid CAC, total spend
  and collected cash match the label. `v_acquisitions` credits the office of the customer's first
  subscription (migration 0024, line 59). The scenario revised only the customer record; a2's
  subscription and initial service stay at B19's office.
- **Version order** (the part of the step that is about correctness): the newer customer
  version is the one stored. The 24-seed model test `ledger-model.test.ts` asserts that the newest
  `dateUpdated` wins in any delivery order. `connectors.test.ts` asserts that an older version
  delivered after a newer one never overwrites.
- **Brief.** FR-3: paid customers are "credited to the branch where they were serviced". The
  service was done by B19's office. The attribution research gives the same rule: "assign on
  service address, not call origin" (`research/05-attribution-model.md:191`). FieldRoutes'
  semantics for an account transfer (whether subscriptions follow the customer) are not
  documented in anything we verified.
- **Verdict.** Legitimate business ambiguity. Does an account transfer re-home past
  acquisitions? That is Moxie's decision, not the code's. If the answer is "yes, follow the
  customer", the fix is one join in `v_acquisitions`, and the six figures move. Until then, the
  product follows FR-3 as written. Nothing flags a customer whose office differs from its first
  service's office. That is a gap, recorded as R-42.

## What would change these verdicts

- A ruling from a Moxie finance or marketing owner on VP-06 and on the release vocabulary
  (R-36).
- FieldRoutes documentation of office transfers, or the payment changelog (R-37's residual).
- A blind re-labelling by someone other than this author.
