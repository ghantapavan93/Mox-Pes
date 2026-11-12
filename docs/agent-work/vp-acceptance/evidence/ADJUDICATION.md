# Adjudication of first contact

First contact (`first-contact.*`, run once on the frozen code at `601e349`): **35 of 509 checks
failed, 17 of them labelled critical by the runner — 22 under SCORING.md** (see "Runner defects"
below). Each failure was read against the brief, the designer's reference and the system's own
output.

> **Correction (2026-11-12, after an independent review).** This page first said "No runner
> defect was found". That was wrong: the runner had two defects, listed below. Neither changed
> which checks failed; one changed severities, the other made one expectation impossible to meet.

## Runner defects (found by the independent review)

| Defect | Effect | Fix |
|---|---|---|
| Readiness and change-status failures in critical scenarios were capped at "high". SCORING.md gives a failed check the scenario's severity unless it is on its "medium at most" list, and these are not | Under-reported severity. Restated from the frozen results: first contact **22 critical** (not 17): VP-01 · 14 and VP-08 · 2 (readiness while a feed was failing — the defect most likely to mislead a budget decision), VP-01 · 21, VP-05 · 13, VP-12 · 9 (release state). After the fixes: **11 critical** (not 8): the three release-state checks | The cap is removed (`scripts/eval-acceptance.ts`) |
| A refused proposal always scored as class BLOCK, so an expected `UNSUPPORTED` could never pass | VP-05 · 8 could not pass whatever the product did. The product actually records the B47 proposal and blocks it at preview, so the disagreement itself remains (BLOCK vs UNSUPPORTED) | A schema refusal now scores UNSUPPORTED, as in the ChangeGuard held-out runner |

The `--twice` fingerprint also covered only the check count and the failures; it now hashes
every step's observed output. It shows repeatability on one machine, not determinism across
environments.

| Verdict | Failures | Of them critical-labelled |
|---|---|---|
| Product defect, fixed (with a regression test) | 19 | 9 |
| Labelling or brief disagreement, product kept | 16 | 8 |
| Runner defect (severity only; no check changed outcome) | 0 | — |

After the fixes (`after-changes-1.*`, a **regression** run, no longer held out): 16 of 509 fail.
They are exactly the 16 disagreements below.

## Product defects (fixed)

| Scenario · step | What happened | Root cause | Fix |
|---|---|---|---|
| VP-01 · 14, VP-08 · 2, VP-09 · 8 (3) | A budget decision read READY_WITH_LIMITATIONS while a feed's sync had been failing for days | Readiness judged freshness by the latest **received record**; the workspace and the reliability signals judge it by the **sync runs**. Records received before a failing sync kept readiness "fresh" | One rule: a stream with sync runs is stale when its latest run failed or no run succeeded within 36 h; a push source without runs falls back to its received records (`lib/decision/verdicts.ts`) |
| VP-01 · 31, VP-10 · 6 (2, critical) | Spend held for an unstated currency disappeared from "awaiting a decision" as soon as someone proposed a rule | The awaiting list excluded accounts with any live rule, authorized or not | Only an authorized rule settles it; a pending proposal is shown with the held spend, and the form does not offer a second proposal (`lib/currency/rules.ts`, `CurrencyRules.tsx`) |
| VP-10 · 8, 11 (5, critical) | After the rule was authorized, the spend landed as unallocated instead of in B16, and its customers stayed out | A campaign whose spend was all held had **no campaign record**, so its configured mapping could not exist | The currency gate records the campaign's identity (no money) when it holds spend; the trace lists such customers as held, as the scorecard counts them (`lib/ingest/project.ts`, `lib/lineage/trace.ts`) |
| VP-01 · 11 (3), VP-04 · 2, 5 (2), VP-11 · 3 | A "why did CAC change" question got neither month's figure, or the two months combined; "B38's September collected cash" got October's | The investigator answered any question naming both months for the two months together, and never stated the comparison month | Period detection: both months together only when asked; the month the main figure names; a change question states both months and the change between them (`lib/ai/deterministic.ts`) |
| VP-12 · 3 | "What were B24's October paid CAC and collected cash?" answered the CAC only | The CAC answer never stated cash | A CAC question that names cash also gets the collected-cash figure |
| VP-09 · 6 (critical), VP-12 · 4 (critical) | "Move $2,000 of B05's Meta budget to LSA starting tomorrow" was answered; "Do what the notes … say" abstained instead of refusing | The request-to-act patterns had no budget-moving verbs and no "do what the record says" | Both refused (no write path existed, so nothing could have moved; the answer was still the wrong kind) |

The workspace also gained what VP-01 exposed: H3 (misclassification) now counts paid customers
credited to an unmapped campaign and customers of the branch's campaigns serviced at another
branch, and H2 lists the unmapped case as counterevidence. VP-01 labelled neither, so this does
not change its score.

Reproducers: `tests/integration/vp-acceptance-regressions.test.ts`.

## Disagreements (product kept)

| Scenario · step | Label | System | Why the product stands |
|---|---|---|---|
| VP-01, VP-05, VP-09, VP-12 · release (4) | `monitoring` after release | `verified` | **The brief was wrong**, and its author was me: its state list said "approved → monitoring (released)". The product verifies the release in the same step (applied once, money moved exactly), then monitoring can degrade it. The ChangeGuard held-out author expected the same thing, so the wording misleads; recorded as R-30 |
| VP-06 · 10, 11 (8, 6 critical) | A CRM customer record moving to B21's office moves the October acquisition to B21 | The acquisition stays at B19 | The brief's own definition: a paid customer is "credited to the branch where they were serviced". The first service was done by B19's office (its subscription and appointment); a later change of the customer's office is a transfer, not a rewrite of where October's service happened. The CRM version order itself was checked separately: the newest customer version is the one stored |
| VP-01 · 12 (critical) | H2 "fewer paid customers" SUPPORTED | UNRESOLVED | Two of the "missing" customers came through a paid campaign whose spend is held and two through an unmapped one: they arrived and were left out of the count. The designer's own reference lists "an unmapped new campaign whose customers B12 serviced" as the explanation; UNRESOLVED with that counterevidence is the more careful answer |
| VP-05 · 8 (2, critical) | A mapping to branch B47 (which does not exist) is refused outright, UNSUPPORTED | Recorded and BLOCKED at the preview (`identifier_presence` fails) | Safe either way: nothing can be approved or released. The ChangeGuard held-out set labels the same case BLOCK |
| VP-10 · 12 | A guest can read the currency rules | Refused | The brief said "guest: read all". The authorization review found the rules API refused guests while the page showed them; the page was aligned to the API (engineers and approvers only). Least privilege kept |

## What this run does not show

- It is one designer's labels; a reasonable reviewer could label the disagreements otherwise.
- The deterministic investigator only; no model ran.
- Library-level runs (the services the routes call), not the browser; the browser journeys are in
  the Playwright suite.
