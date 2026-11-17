# Revenue Signal OS: product audit, fixes and the B20 package

2026-11-17. Baseline: `main` at `1814616` (deployed). Every change below is **uncommitted** in the
working tree, for review. Synthetic data only, on isolated databases (`revenue_signal_walk`,
`revenue_signal_rc`, `revenue_signal_test`, four `revenue_signal_audit_*`); the demo database
`revenue_signal` was never touched. Nothing was pushed, deployed or sent.

Evidence labels used throughout: **observed** (in the running app), **test** (confirmed by a
targeted test or script), **code** (inferred from code), **unverified**.

## 0. Verdict

**Record now, with a narrower claim: the B20 repair journey on the local synthetic build.** It
runs as one continuous live sequence from the normal UI on a freshly seeded database (no staged
states), with the mapper the form selects by default, and reproduces the claimed numbers to the cent
(independently reconstructed from base tables). B09 needs pre-staged databases, because only test
harnesses can re-send the missing spend (N26), so it is not the recorded sequence.

| Readiness | Verdict | Why |
|---|---|---|
| Local synthetic demo (this working tree) | **Ready** | Section 5 checks pass; the B20 run is live and continuous. |
| Hosted demo (revenue-signal-os-green.vercel.app) | **Not yet** | It serves `1814616`: real brand names (N30), a failed dry run shown as a success (Q6), the approval not bound to the dry run (A2), and the other fixes here are absent. Redeploying is outside this task's rules. |
| Real-data pilot | **No** | No live vendor integration is tested (R-1); roles come from a demo picker (R-2, A6); live deliveries never move freshness (N14); identity rules for a restated instant are undecided (section 4). Held spend now holds the decision (N1, fixed by the decision boundary), but branch credit (D-2) is still unruled. |

**The strongest objection, answered since:** *"Can it say 'ready' when spend is missing?"* It
could. Spend excluded by a currency rule, or held for any other reason, opened no hold at the
branch. Decision Lab then read *ready* on a channel with no CAC, and the builder preselected the
move (N1, **test**). The decision boundary (BUSINESS-FIT §10) answers it.
- A held channel is not ready, and the Overview lists it.
- The pair the hold does not touch reads "among verified channels".
- The branch-wide recommendation is held until the held records are accepted.
The objection that remains is branch credit (D-2): which branch carries a customer another branch's
campaign bought. The product now names the mix; nobody has ruled on it.

## 1. What to show, what not to claim, next improvement

- **Show:** Overview, then B20 Heron, then incident #1063. As an engineer, propose and dry-run the replay. As an approver, approve and execute it. The resolved incident leads with its result.
- **Do not claim:**
  - two authenticated people (the role picker is a demo; A6, N8);
  - that "trustworthy" approves a budget move, or that attributed cost measures effectiveness;
  - that the AI investigator was evaluated against a model (N22);
  - that the hosted link shows this build;
  - adoption, time saved or savings. Scripted tests are not evidence of those.
- **Next improvement:** rule on held spend (N1), then implement the hold the decisions agent sketched in `lib/metrics/decision.ts` `budgetSignal`. It is the one remaining way the product can read *ready* on incomplete data.

## 2. The 90-second walkthrough

One continuous live run on a freshly seeded synthetic database, in demo mode. The roles are chosen
with the header's *Viewing as* picker: a demo stand-in for sign-in, and it should be said aloud once.

| Time | Do | Say |
|---|---|---|
| 0:00 | Overview, as Guest | "An independent prototype on synthetic data: it checks whether marketing's numbers can be trusted before anyone moves budget." |
| 0:08 | Click **B20 Heron** in the headline | "$10,362 of collected revenue sits in open exceptions; the product says where to start." |
| 0:15 | Point at **Budget signal: Not trustworthy yet** and click **#1063** | "B20 looks expensive, but an open incident changes which customers each channel produced." |
| 0:25 | Evidence card | "119 call records were held back when the caller field moved. Nothing was guessed." |
| 0:32 | *Viewing as* → Integration engineer; **Propose fix** (default mapper) → **Run dry run** | "The fix is previewed first and rolled back." |
| 0:45 | Dry-run receipt | "CAC would go from $364.75 to $284.06. Spend and customers stay put, and five ledger totals are checked." |
| 0:55 | *Viewing as* → Revenue ops approver; type a reason → **Approve** → **Execute (application, once)** | "A different role approves exactly this dry run; the application runs it once." |
| 1:05 | Reload #1063: **Fixed and verified** | **Stop talking.** Let the reviewer read *Why it moved / What did not / Still open*. |
| 1:20 | Overview | "The headline moved for a stated reason, three new conflicts are named with a next step, and no budget move was approved." |

## 3. Coverage: routes, roles and states

59 page and API routes, 6 roles (Guest, Marketing analyst, Integration engineer, Revenue ops
approver, Branch partner B20, Brand lead). Combinations were exercised only where they could change
a decision, expose the wrong evidence or strand someone.

| Journey | Role(s) | What was exercised | Label |
|---|---|---|---|
| First-time reviewer | Guest | Overview → headline link → B20 page → budget signal → incident | observed (walk, `walk/`, `final/`) |
| Engineer and approver | Engineer, Approver | Propose (default mapper) → dry run → approve (reason) → execute → receipt → resolved incident → Overview | observed (twice, fresh seed) + test (`action-center.test.ts`) |
| Repeat execute, failure, stale plan | Approver | Execute twice; a fault mid-run; records changed after approval | test (`action-center.test.ts`; audit-acc W2, W4, W5) |
| Approval binding | Approver | Approving another dry run's fingerprint | test (new, `action-center.test.ts`) |
| Scoped reviewer | Branch partner, Brand lead | Overview, holds, incident links, Decision Lab blockers, search and API counts | observed (brand-lead dead end, before and after) + test (audit-acc P1, `scenario.test.ts`) |
| Marketing lead | Marketing analyst | Decide act / wait / escalate at B20 and B09; return after the correction | observed (B20) + test (B09 reconstruction, audit-dm) |
| Analyst | Marketing analyst | Trace B20 CAC to base rows; compare a file with the ledger | test (audit-dm B20/B09 SQL; audit-up U1–U7) |
| AI Investigator | All | Deterministic path only; citation, contradiction, scope, injection | test (audit-up A0–A5); **the model path is unverified** |
| Ingestion and revisions | Engineer | Retry, the same instant written differently, a conflict, a late arrival, a refused revision; pushes; freshness | test (audit-rev S1–S6, N17, s4) |
| Phone width (390 px) | Approver | Resolved incident (result first) and receipt; no horizontal overflow | observed (`final/12-*`, `11-*`) |

**Not covered:** a real model (no key, by rule); real HTTP status codes of refused pages (N27c rests
on code and Next's docs); concurrent executions racing intake inside one transaction; ChangeGuard's
half of N8; every period/brand/role combination on every page.

## 4. Findings

The 4 audits ran in parallel with independent scratch databases. Their scripts and outputs are listed in section 7.

| Id | Finding | Verdict | Label | Severity | Status |
|---|---|---|---|---|---|
| B20 | $364.75 → $284.06; spend $32,098.27 and 17,111 CRM customers unchanged; +25 = 22 unknown → paid + 3 door-to-door → Search | claim holds | test (base-table SQL = product) | — | — |
| B09 | $2,123.52 moved Search → Local Services; total $16,649.23 in all three states; 5/18 → 18/18 | claim holds | test | — | — |
| N30 | Real brand names beside synthetic numbers | confirmed | observed | positioning | **fixed** |
| A2 | An approval was not bound to the dry run the approver reviewed | confirmed | test | wrong decision | **fixed** |
| A1 | A campaign-mapping plan executed after new spend landed (fingerprint ignored spend) | confirmed | test | wrong number | **fixed** |
| N7 | One person could map a campaign from the incident and move a branch's CAC | confirmed | test | wrong number | **fixed** |
| A5 / ALLOC | Mapping a campaign to a branch its leads never name verified, and the total tied out | confirmed | test | wrong number | **fixed** |
| N27b | Scoped viewers' holds and Decision Lab blockers linked to a company-level incident ("not found") | confirmed | observed + test | dead end | **fixed** (Overview, branch page, What changed, Decision Lab) |
| Q6 / P2 | A failed dry run or execution showed raw database text with a success mark | confirmed | test | wrong status | **fixed** |
| Q12 | "October" meant Oct 1–30; 29 Oct 31 payments ($3,812) still count in "collected to date" | confirmed | test | label | **fixed** (label and note) |
| Receipt | "Open exceptions at B20 3 → 5" read as more problems: the run closed #1063 and opened 3 conflicts | confirmed | observed | dead end | **fixed** |
| N1 | Held spend (currency rule, refused revision) never holds a decision; a $0.00 CAC can read *ready* | confirmed | test | wrong decision | **fixed** (decision boundary, BUSINESS-FIT §10). After the CAC v4 fix, B03 read *shift 2.32×* with its LSA spend held and LSA *ready*. It now reads "among verified channels" with LSA left out, LSA not ready, and the recommendation held |
| CAC0 | A branch whose only paid customer came from another branch's campaign read paid CAC **$0.00**, the cheapest in the company (business-fit fixture, B11) | confirmed | test + observed | wrong number | **fixed** (definition v4) |
| R54b | A later excluded revision lifts the hold, leaving $34.28 counted nowhere | confirmed | test | wrong decision | open |
| FH-period | October incidents hold September (B20, B09 September figures identical before and after) | confirmed | test | false hold | open |
| FH-succ, FH-ovw, FH-unm | A coverage-gap successor matched by ad account; the Overview listing a hold its gate does not; one unmapped campaign warning 44 branches | confirmed | test | dead end / low | open |
| N2 | The gap clock uses the newest date on any platform; a future-dated record grows B09's window from 18 to 64 dates | confirmed | test | wrong decision | open |
| N3 | Two CAC denominators (scorecard 40 vs channel rows 42 at B44) | confirmed | test | wrong number | open |
| Revision 1b | One instant written two ways overwrote a spend day ($108.50 → $150.00), with no exception | confirmed | test | wrong number | **open: policy needed** (a pinned R-54 behaviour) |
| Revision 1c | A same-version payload conflict reaches no decision | confirmed | test | wrong decision | open |
| N17 | Under the frozen demo clock a later push can look older and be dropped | confirmed | test | wrong number | open (fix sketched: monotonic receipt time per source) |
| N14 | Live pushes and syncs never move feed freshness | confirmed | test | dead end | open |
| 3a/3c | Screens disagree between intake and reconciliation; no "reconciled as of" marker | confirmed | test | wrong decision | open |
| N8 | Approval checks the proposer only; audit rows store roles; the executor is not stored | confirmed | test | governance | open |
| N6 | A production build without demo mode is readable by anyone (guest over 44 branches, audit included) | confirmed | test | access | open (by design for the read-only demo link) |
| N27a, N27c | A change refusal names its branches (403); refused pages answer HTTP 200 | confirmed | test / code | access / low | open |
| N12 | The BI layer publishes an unkeyed contact hash (`prospect_key` = `leads.phone_hash` on 24,893 of 24,893) | confirmed | test | privacy | open (fix sketched: keyed HMAC or surrogate id) |
| A3 (AI) | A branch partner asking company-wide questions gets B20-only answers at high confidence | confirmed | test | wrong decision | open |
| A4 (AI) | An injected note can become a draft proposal's rationale (no write path to the ledger) | confirmed | test (scripted client) | low | open |
| N22 | The model investigator was never evaluated against a model; the held-out set is no longer held out | confirmed | code + git | AI honesty | open: pre-frame (section 8) |
| U4–U6 | Upload result page contradicts itself after publish; a variance has no reachable next step; the dry run ignores currency rules | confirmed | test | label / dead end / wrong number | open |
| Held up | Repeat execute is idempotent; a mid-run failure rolls back; scoped reads and counts stay in scope; upload compare writes nothing (24 tables) | disproved (works) | test | — | — |

## 5. Fixes made (uncommitted)

Each lists the expected outcome stated before the change, the case that fails before it, and the
control that must not change.

1. **N30, fictional brands** (`lib/reference.ts`, migration `0035_fictional_brand_names.sql`, `lib/shadow/answer.ts`, `lib/ai/{deterministic,investigate,proof}.ts`, `components/RoleSwitcher.tsx`).
   - Expected: no screen or reporting row shows a real brand. Brand ids, scope and URLs are unchanged, and questions written with the former names still resolve.
   - Fails before: `tests/unit/brands.test.ts` (names).
   - Control: `ai-investigator.test.ts` refusals; `shadow-mode` answers written with former names.
2. **A2, approval bound to the reviewed dry run** (`lib/workflow/proposals.ts` `approveProposal`, `app/api/proposals/[id]/route.ts`, `ProposalControls`).
   - Expected: an approval without a fingerprint is a 400; another dry run's fingerprint is a 409 that writes nothing.
   - Fails before: the new route assertions in `action-center.test.ts`.
   - Control: approving the reviewed dry run is a 200; the end-to-end run still executes.
3. **A1, stale mapping plan** (`lib/workflow/kinds.ts` `mapCampaign.touches`).
   - Expected: a spend day added or restated after the dry run makes the execution refuse as stale.
   - Fails before: audit-acc W1.
   - Control: the existing stale-run test and the happy path in `action-center.test.ts`.
4. **N7, no one-person mapping** (`app/api/exceptions/[id]/actions/route.ts`, the incident page).
   - Expected: a direct mapping returns 409 and points to the workflow; the page offers the workflow, not a form.
   - Fails before: audit-acc W8.
   - Control: acknowledge, close and lead override are unchanged.
5. **A5 / ALLOC, mapping must match evidence** (`mapCampaign.execute`, the propose form).
   - Expected: a branch none of the campaign's leads name fails the dry run with the reason; only those branches are offered.
   - Fails before: audit-acc W6a, audit-dm ALLOC (B43 accepted).
   - Control: mapping B44's campaign to B44.
6. **N27b, no dead links for scoped viewers** (`lib/metrics/decision.ts` `companyLevel`, `components/incidents/IncidentRef.tsx`, Overview, `BudgetSignalCard`, `MovementSection`, `lib/decision/verdicts.ts`).
   - Expected: the brand lead sees "incident #970 (company-wide, outside your scope; an analyst resolves it)" instead of a link to "not found".
   - Fails before: `scenario.test.ts` (`companyLevel`, Decision Lab hrefs); observed in walk 1.
   - Control: company-wide roles keep the link, and a hold is company-level exactly when its incident has no branch.
7. **Q6, failures shown as failures** (`lib/workflow/failure.ts`, the proposals route, `useAction`, `WorkflowPanel`).
   - Expected: a failed dry run or execution renders red with authored text, or one plain sentence instead of raw database text.
   - Fails before: audit-up q6.
   - Control: verification messages, which are authored, still show; `tests/unit/workflow-failure.test.ts`.
8. **Q12, the period says its dates** (`components/ui.tsx` `PeriodTabs`, the Overview note).
   - Expected: the tabs read Oct 1–30, Sep 1–30 and Sep 1 – Oct 30, and the Overview says Oct 31 counts in no period yet.
   - Control: every figure is unchanged.
9. **B20, the result first** (`lib/workflow/snapshot.ts` `openExceptionList`, `SnapshotDiff`, `components/incidents/FixResult.tsx`).
   - Expected: the receipt names the window and the exceptions the run closed and opened, with a link to review them, and says that *trustworthy* is not approval. The resolved incident leads with why CAC moved, what did not, and what is open.
   - Fails before: `action-center.test.ts` (the list did not exist).
   - Control: the os-golden-path *October budget signal* row still reads *trustworthy*; the approval fingerprint does not include the snapshot (`kinds.ts` `preconditionFingerprint`).
10. **CAC0, no $0.00 CAC** (`lib/metrics/scorecard.ts` `paidCac` and `cacDefined`, definition v4; the Overview row, branch page, trace, attention flags, CAC-change inquiry, brand receipt, Decision Lab baseline, twin gate G). Business-fit pass, BUSINESS-FIT.md §3.7.
   - Expected: paid customers with no spend counted show no CAC, with the reason, everywhere a CAC is computed.
   - Fails before: `tests/unit/paid-cac.test.ts` (3 of 6 on the committed code); the running app on the cohort fixture showed $0.00 on five surfaces.
   - Control: 1,350 seeded CAC figures, fingerprint unchanged; no seeded branch, channel, week or brand has the case.
   - One decision surface moves, in the N1 case only: see N1 above.
11. **N1, the decision boundary** (`lib/metrics/eligibility.ts`, new; `budgetSignal`, `evidenceHolds` in `lib/metrics/decision.ts`; every sentence in `lib/decision/signal-copy.ts`; readiness, scenario, card, Decision Lab, Overview, movement takeaway, fix receipt, investigator). Second business-fit pass, BUSINESS-FIT.md §10.
   - Expected: three separate outcomes. Facts are displayable. A comparison is valid among verified channels, naming what is left out. A recommendation stays held while an incident or a left-out channel's missing cost holds it. A recorded $0.00 holds nothing.
   - Fails before: the held-LSA case at B03 read *Ready*, preselected Search → Meta, and was not on the Overview (`harness/boundary/proof/before/B03.json`, `cases.before.out`).
   - Proof: `tests/integration/decision-boundary.test.ts` (11 tests). It covers a held channel, an unaffected pair, a blocked ratio, the shared-account control (B04), a correction that leaves another blocker open, a recorded zero and the B11 evidence.
   - Control: the legacy gate outputs are equal on all 132 seeded branch-periods. The 1,350 CAC figures and the ledger are unchanged, and the B20 card is unchanged word for word.

## 6. Open decisions (not invented here)

- **Held spend (N1, R-54):** decided by the second business-fit brief's rules and built (BUSINESS-FIT §10). What remains open:
  - whether a single held day should hold the ranking (no materiality threshold was invented);
  - whether an incident that touches one channel should keep holding moves between channels it does not touch (it still does).
- **A restated instant (revision 1b/1c):** when the same instant arrives written another way with different content, should it replace, conflict or hold? A test deliberately pins today's behaviour (`refused-revision.test.ts:270`).
- **Cross-branch acquisition (XBR):** which branch owns a customer bought by another branch's campaign?
- **Restatement of published metrics:** this needs one written sentence (section 8).

## 7. Commands and evidence

All on isolated databases (never `revenue_signal`).

```bash
npx tsc --noEmit
npx eslint .
TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54333/revenue_signal_test INGEST_API_KEY=ci-ingest-key TWIN_SKIP_DISK_PREFLIGHT=1 npx vitest run
DATABASE_URL=postgres://postgres@127.0.0.1:54333/revenue_signal_rc CI=1 PORT=3989 npm run build
DATABASE_URL=postgres://postgres@127.0.0.1:54333/revenue_signal_rc CI=1 PORT=3989 VISUAL=1 npx playwright test z-layout --update-snapshots
DATABASE_URL=postgres://postgres@127.0.0.1:54333/revenue_signal_rc CI=1 PORT=3989 VISUAL=1 npx playwright test z-layout
DATABASE_URL=postgres://postgres@127.0.0.1:54333/revenue_signal_rc CI=1 PORT=3989 npx playwright test z-quality-gates golden-path z-redesign-navigation z-a11y-regressions
DATABASE_URL=postgres://postgres@127.0.0.1:54333/revenue_signal_rc CI=1 PORT=3989 npx playwright test zx-vp-journeys zy-overview-movement zz-b09-four-minute-path
npx tsx docs/agent-work/product-audit/harness/boundary/cases.mts
npx tsx docs/agent-work/product-audit/harness/boundary/decision-control.mts revenue_signal_deploy
BASE=http://localhost:3988 OUT=docs/agent-work/product-audit/final node docs/agent-work/product-audit/harness/walk.cjs
node docs/agent-work/product-audit/harness/pdf.cjs docs/agent-work/product-audit/final docs/agent-work/product-audit/revenue-signal-b20.pdf
```

**Results:** see section 9, filled in from the final run.

**Evidence:**
- `walk/`: the starting state, before any fix. These are the 1440 captures plus `walk.json`, with the brand lead's 404.
- `final/`: the fixed build, as captures, crops and `walk.json`.
- `harness/walk.cjs` and `harness/pdf.cjs`.
- `harness/boundary/`: the decision boundary's cases, seed control and page captures (BUSINESS-FIT §10; its README says how to rerun).
- The four audits' scripts and outputs, in the session scratchpad. They are not committed and are cleared on reboot:
  - `audit-dm/` (decisions, money, B20 and B09 SQL);
  - `audit-rev/` (identity, revisions, N17, freshness);
  - `audit-acc/` (repair, approval, access);
  - `audit-up/` (uploads, AI, privacy).

## 8. Pre-frames for the panel

- **AI (N22):** "Every quality number you see is the deterministic path. The model path is wired but has not been evaluated against a model, and the held-out set is no longer held out. The AI proposes; the ledger disposes: no AI path can change the ledger, and a proposal still needs a dry run and a different role's approval."
- **Restatement policy:** "Metric values are not restated in place. A correction arrives as a new record version, or a new mapper version, and is re-projected. A period's numbers change only when the records behind them change, and the receipt shows before and after. A figure read before a correction is history, not a current clearance."
- **N17:** "Yes, it is in the register. It exists only because the demo clock is frozen, and the fix is sketched: receipt time monotonic per source."

## 9. Final run

Final build `Qt6C4d59fYZHHTkFrcST2`; checks build `vvkx3CCaWnJ53p49BlZ0l` (same code, before the dry-run id wording).

| Check | Result |
|---|---|
| `tsc --noEmit`, `eslint .` | 0 errors |
| vitest, unit + integration (CI's settings) | 84 files: 966 passed and 1 expected failure (R-39, pinned) |
| `z-layout --update-snapshots` | 8/8. `overview-1440` and `overview-390` were re-generated on purpose: fictional brand names and dated period tabs. Incident baselines are unchanged. |
| `z-layout` plain re-check | 8/8 |
| `z-quality-gates`, `golden-path`, `os-golden-path`, `z-redesign-navigation`, `z-a11y-regressions` | 70 passed, 2 failed, then 17/17 on a re-run of the 2 specs. The failures were the tests' own API approvals, which named no dry-run fingerprint (A2). Those calls, and the same calls in `zx-vp-journeys` and `zz-b09-four-minute-path`, now send a well-formed one. |
| UI walk (`final/walk.json`), on a freshly seeded database and the final build | The form's default mapper is 1.2. Focus lands on the receipt after Execute, and no second Execute button is left. The dry run reads "would close 1 (#1063) and would open 3: D2D / paid conflict, $148.00". The resolved incident leads with the result, and its link goes to `/exceptions?branch=B20&kind=channel_conflict`. The Overview moves from $10,362 / 187 to $7,649 / 189, start with B01 Alder. The brand lead's hold reads "incident #970 (company-wide, outside your scope…)". There is 0 px horizontal overflow at 390. |
| PDF | 3 pages and 355 KB, with selectable text and no content under the footer. Each page was rendered and inspected (`final/pdf-page-{1,2,3}.png`). |

**Decision boundary pass (BUSINESS-FIT §10), on the final code:**

| Check | Result |
|---|---|
| `tsc --noEmit`, `eslint .` | 0 errors |
| vitest, unit + integration (CI's settings) | 86 files: 983 passed and 1 expected failure (11 new in `decision-boundary.test.ts`); the 10 files touching the change rerun after the last edit: 131/131 |
| `z-quality-gates` | 40/40 (alone; a first run that overlapped a cancelled one failed the Decision Lab CLS gate at 0.209, see BUSINESS-FIT §10.8) |
| `golden-path`, `os-golden-path`, `z-redesign-navigation`, `z-a11y-regressions` | 37/37 |
| `zx-vp-journeys`, `zy-overview-movement`, `zz-b09-four-minute-path` | 14/14 |
| `z-layout` | 8/8 after `incident-1440` and `incident-390` were re-generated on purpose (the B09 budget card they embed); the Overview baselines needed nothing |
| Seed control (`harness/boundary/decision-control.mts`) | legacy gate outputs equal on 132/132 branch-periods (`4286f88bf2f023e9`); CAC fingerprint `85bd0e019d5e0c54` unchanged; ledger unchanged |

`walk/` is the starting state. `walk-after/` is an intermediate run, after the receipt and incident-link fixes and before the others. `final/` is the shipped state.

Not run in this pass: the full browser suite beyond the five specs above, the acceptance packs (`acceptance:b09`, `acceptance:byof`), and CI on GitHub (nothing was pushed).
