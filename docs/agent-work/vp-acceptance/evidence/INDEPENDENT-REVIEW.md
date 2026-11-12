# Independent review of the VP acceptance report

A separate agent reviewed `VP-ACCEPTANCE-REPORT.md`, its evidence and the code on 2026-11-12.
It was read-only: it read files and used read-only git, and ran nothing (a regression was running
on the shared databases). Its text is below unchanged, followed by what was done about each
finding.

---

## Headline findings

1. **There is an open money defect the scorecard calls "None".** The view `v_acquisitions` matches a customer to a lead only by phone or email hash (`database/migrations/0012_audit_corrections.sql`, the touch lateral join). The `v_leads` view (0018) never checks `identity_conflicts`. So two customers sharing a phone can both be credited with one paid call. That inflates paid customers and understates CAC, which breaks SR-4. The report saw this in a smoke run and filed it as a "known limitation" in dimension 2 (`VP-ACCEPTANCE-REPORT.md:62`). Its "Failed (open)" rows still say "None". It is not in REMAINING-RISKS and has no test. VP-01 was built so that no figure depends on the shared phone, so "VP-01's identity checks passed" proves nothing.
2. **The runner understates severity against the frozen scoring rules.** SCORING.md says a failed check takes the scenario's severity unless it is on the "medium at most" list. Readiness and status are not on that list. The runner caps both at "high" in critical scenarios anyway (`scripts/eval-acceptance.ts:605`, `:669`). This cap was in the frozen runner, so it was not tuned afterwards. Under SCORING.md the counts are 22 critical at first contact (report: 17) and 11 now (report: 8). The stale-feed readiness defect is the one most likely to mislead a budget decision. Under the frozen rules it was critical in VP-01 and VP-08. The report never calls it critical.
3. **"0 runner defects" is false.** `classify()` can only return ALLOW, BLOCK or NEEDS_REVIEW (`eval-acceptance.ts:370`). A refused proposal is scored as "BLOCK" (`:663`). So VP-05 step 8, which expects UNSUPPORTED, fails whatever the product does. That check is the runner's defect, not a disagreement.
4. **The traces check consistency, not correctness.** The cash trace and the scorecard both read the same `crm_payments` table with the same office and date filters; the CAC trace and the scorecard both read `v_acquisitions`. Two of the four cash invariants can never fail: "net = gross − refunds" is an arithmetic identity over the same rows, and "whole cents" runs on a bigint column.
5. **The AI evidence covers only template mode.** `judge()` marks a template claim SUPPORTED unless something contradicts it; missing facts and unread propositions are ignored for templates (`lib/ai/proof.ts:1656-1667`). That explains UX P2 "supported beside 0 of 2 propositions follow": designed behaviour, not a one-off. VP-12's prompt-injection checks ran where no model exists to be injected. The only blind measurement of the claim checker was 26 of 57 critical false claims accepted, and that set has since been used for tuning.
6. **CRM payments (and calls) use "last received wins", not "newest version wins".** A payment version's date is its receipt time (`lib/adapters/crm-fieldroutes.ts:270`). Redelivering an older, identical version makes it live again (`lib/ingest/ingest.ts:105-107`): an old "successful" copy of a payment that was later voided would count as cash again. BRIEF SR-2 says CRM records are ordered by update time. The risk register does not mention payments.

## Specific checks (summary)

- **J2's reference** is independent of the cash SQL but shares `raw_events` contents and quarantine status, the last-delivered-wins rule, the `branches` office/timezone mapping and `PERIODS`. It would catch projection bugs (sign, status mapping, rounding, office join, double-counted refunds), not intake, identity, ordering or period-definition bugs.
- **J5** shows a same-month $25 refund through library intake lowers cash by exactly 2,500 cents and that an identical redelivery is absorbed. It does not show a cross-month refund, over-refund detection, a corrected existing record or an older version arriving late, and it cannot be re-run without a reseed.
- **`--twice`** shows the score repeats on one machine, in one process, from a dirty tree. The fingerprint hashed only the check count and failures; unlabelled outputs were never compared; OS, Node, Postgres and timezone were never varied.
- **The 16 disagreements:** VP-06 reasonable; VP-01 H2 reasonable; VP-05 B47 safe in effect but its class check is a runner defect; VP-10 guest defensible but a requirement change that should be recorded; release `monitoring` vs `verified` (4) **a product weakness explained away** that needs a human ruling.

## Overstated claims it listed

Dimensions 1–2 "Failed (open): None"; the critical counts; "0 runner defects"; "invariants that can fail" (one cannot); J2 "not the product's tables" (it reads `raw_events`); "model text is rejected" (never run with a model); "the newest version wins" (false for payments and calls); "a different person must approve" (any visitor can switch role in the demo); "verifies exact money moved" (inexact movement still commits, as degraded); "12/12 repeated identically" (repeatability, not determinism); J5 as "source correction" (it adds a new record); VP-09/VP-12 refusals "fixed" (regexes keyed to the scenario wording); "the brief was wrong" on monitoring (the ruler wrote both); a citation of this file before it existed; 509 checks vs FREEZE's 480 expectations unexplained; the report and UX-FINDINGS untracked; axe "0 violations" is not WCAG conformance.

## Recommendation (verbatim)

**Accept as a proof-of-work demo. Do not accept the report as written. Do not treat the evidence as financial correctness on real data.** Conditions: fix the shared-phone double credit or register it with a test; restate the critical counts under SCORING.md and remove the severity cap; reclassify VP-05's class check as a runner defect; correct overstated claims and remove the invariants that cannot fail; order payment versions by a source clock or register receipt ordering as a limitation; have a human rule on all five disagreement groups; keep model mode off until a fresh blind set and an approved key; before real data, SSO and keyed hashing; commit the report and UX-FINDINGS, fill the placeholders, and reproduce on a second machine.

---

## What was done

| Finding | Action | Evidence |
|---|---|---|
| 1 Shared-phone double credit | **Fixed.** A lead credits a customer only when its phone and email point at no other customer, or a reviewer accepted the pair; a rejected pair never credits. Red first: 3 paid customers where 1 was right | `database/migrations/0022_unambiguous_touch.sql`; `tests/integration/shared-phone-credit.test.ts` |
| 2 Severity cap | See the runner section of `ADJUDICATION.md` | — |
| 3 VP-05 class check | Recorded as a runner defect | `ADJUDICATION.md` |
| 4 Vacuous invariants | See `ADJUDICATION.md` and the report | — |
| 5 Template trust | Registered | `REMAINING-RISKS.md` |
| 6 Payment receipt ordering | Registered | `REMAINING-RISKS.md` |
| Overstated claims | Report corrected | `VP-ACCEPTANCE-REPORT.md` |
