# B09: from decision hold to verified recovery (2026-11-13)

## Checkpoint

| Phase | SHA | State | Next action |
|---|---|---|---|
| 0. Locked scope | `d9620ef` | Branch B09, channel Google Local Services, October 2026, the existing `channel_coverage_gap` incident and Decision Lab hold. Synthetic data only. No budget action, no push. R-39, FI-4/R-50 and the R-46 rule (45 LSA calls carrying a Performance Max id stay unresolved) are out of scope | Three read-only research passes: source and replay, decision and evidence, analyst journey and scope |
| 1. Research | `d9620ef` | Three read-only passes returned (§1). B09 is a migration: Oct 13–30 spend exists under the Performance Max successor, filed as Google Search by `ads@1.0`. The active mapper is `ads@1.2` and files it as Local Services, so a dated re-fetch through the ads feed is a legitimate correction; no separate variant is needed | Freeze the ledger (§2), reproduce the first broken link |
| 2. Reproduced | `d9620ef` | `b09-recovery.test.ts` on the unchanged code. The selected week (Oct 26–30) re-fetched: `budgetSignal(B09).trustworthy` is **true** and the incident reads "Condition no longer detected", while Oct 13–25 are still filed as Search. A middle week (Oct 19–25) re-fetched: the original incident resolves and a second one (`…:2026-10-25`) opens. 2 of 6 tests fail exactly there | Carry the open incident forward; verify its whole window |
| 3. Fixed | uncommitted | Rule 6a carries an open coverage gap under its own fingerprint and evidence until its whole window is covered and nothing is misfiled, then verifies it once (§3). The incident page leads with the recovery; Decision Lab says why a partly repaired incident still holds; the selection travels Overview → evidence → incident → Decision Lab and back | Browser journey on a production build |
| 4. Reviewed | uncommitted | A fresh read-only reviewer broke claim 1 twice (a verified incident reopened on a routine feed day; a late-starting successor could never clear) and found a branch-remap hole and smaller issues; claims 2 and 3 held (§5). All fixed, each with a test | Final build, every state again |
| 5. Verified | uncommitted | Final build `d3CVYx3zUzxe2BMXQK_s0`, isolated `revenue_signal_b09`, fresh seed: 102 browser checks pass; every step matches the ledger to the cent (§4) | Full regression, commit |

## 1. Research (three read-only passes, in parallel)

| Pass | First broken link (observed) | Recommendation | Test that could disprove it |
|---|---|---|---|
| Source and replay | Re-sending the stored source records changes nothing: identical payloads are duplicates, yet the run reads `ads@1.2`. Only a new version (a later `fetchedAt`) is re-typed | A dated re-fetch through `runStream` is the same path the feed uses; newest `fetchedAt` wins; an older version cannot replace a newer one | Re-send the correction and one older version: spend must not move |
| Decision and evidence | The detector reduces the whole window to the channel's latest spend date, and that date is part of the incident's fingerprint (`lib/reconcile/reconcile.ts`). A re-fetch of the last days clears the hold; one of an earlier week resolves the incident and opens a new one; a gap in the middle is never seen | Carry the open incident forward under its own fingerprint and evidence, and require every date from its gap start to the feed's latest date | Partial re-fetches must keep one open row with the original id; the full one must resolve it |
| Analyst journey and scope | Daily evidence → incident (`components/trace/OverviewSelection.tsx`) carries only the id; the incident and Decision Lab carry no context; Decision Lab never links the exact records. An empty week says "nothing was delivered", which is wrong at the source | Carry branch, channel, period and week through the incident, parsed only after the scope check | A click-only walk keeps the week in every URL; a restricted viewer's responses carry no B09 evidence |

**The original incident under the active contract.** `lib/adapters/registry.ts` sets `ACTIVE_VERSION.ads = "1.2"`
(`docs/agent-work/VENDOR-CONTRACTS.md` still says `ads@1.1` is active and `ads@1.2` staged: stale). The
stored successor records carry `campaignType: PERFORMANCE_MAX` and `localServicesEnabled: true`, and
the active mapper files those as Local Services (`lib/adapters/marketing.ts`). So the source's own
re-fetch of those dates, delivered through the existing ads intake, re-files existing spend; it adds
no money. The 45 calls labelled Google LSA that carry the Performance Max id stay unresolved: their
record names Google Local Services, the campaign is Google Ads.

## 2. The independent ledger (written before any change)

**Two scopes.** The *correction scope* is what a re-fetch delivers. The *verification scope* is what
the open incident requires: every date from its gap start to the spend feed's latest date, for its
branch and channel. The selected chart week is a viewing filter, never the rule.

### 2a. Integration fixture (`tests/integration/b09-recovery.test.ts`, hand-specified)

- **Clock:** business clock 2026-10-31T13:00Z. **Window:** October = [Oct 1, Oct 31) UTC; spend
  dates are bare dates (the account's day, G-4). B09 Coral is America/Phoenix.
- **Currency:** no record states one; the fixture's authorized company-wide USD rule applies.
- **Records** (source key `platform:campaignId:date`; original version `fetchedAt` = the next day
  06:00Z, mapped by `ads@1.0`):

| Campaign | Platform / account | Branch | Dates | Cents per day | Total |
|---|---|---|---|---|---|
| `lsa-B09` Local Services | google_lsa / LSA-B09 | B09 | Oct 1–12 | 10,000 + 100·d | 127,800 |
| `pmax-lsa-B09` PMax, Local Services enabled | google_ads / LSA-B09 | B09 | Oct 13–30 | 20,000 + 37·d | 374,319 |
| `gs-B09` Search | google_ads / GA-SW | B09 | Oct 1–30 | 30,000 | 900,000 |
| `gs-B13` Search (control) | google_ads / GA-SW2 | B13 | Oct 1–30 | 25,000 | 750,000 |

- **Leads:** one "Google LSA" call at B09 every day Oct 1–30 (18 after the gap; 19 with c2's own
  call on Oct 18, a count the review corrected). **Customers:** c1
  (B09, Google LSA, Oct 9), c2 (B09, Google LSA, Oct 18), c3 (B13, Google Ads, Oct 10); $149.00
  collected from each.
- **Corrections** (same payloads as the source sends, new `fetchedAt`, through `runStream`):
  - R1, the selected week's delivered days, Oct 26–30, fetched 09:00Z: 105,180 cents.
  - R1′, alternative partial, Oct 19–25, fetched 09:00Z: 140,000 + 37·154 = 145,698 cents.
  - R2, the rest, fetched 11:00Z: 269,139 cents (Oct 13–25) after R1.
  - D, R2 delivered again unchanged. O, Oct 20 fetched 10:00Z (older than R2) at 25,740 cents.

| State | Required dates covered (of 18, Oct 13–30) | B09 LSA | B09 Search | B09 paid spend | B13 | Incident | Decision |
|---|---|---|---|---|---|---|---|
| Missing | 0 | 127,800 | 1,274,319 | 1,402,119 | 750,000 | the coverage gap, open | held by it |
| Partial R1 | 5; missing Oct 13–25 | 232,980 | 1,169,139 | 1,402,119 | 750,000 | same id, open | held; names Oct 13–25 |
| Partial R1′ instead | 7; missing Oct 13–18, 26–30 | 273,498 | 1,128,621 | 1,402,119 | 750,000 | same id, open | held |
| Full R1 + R2 | 18 | 502,119 | 900,000 | 1,402,119 | 750,000 | same id, resolved, verified | not held by it |
| Duplicate D | 18 | 502,119 | 900,000 | 1,402,119 | 750,000 | unchanged; no new incident, no second verification | unchanged |
| Older O | 18 | 502,119 (Oct 20 stays 20,740) | 900,000 | 1,402,119 | 750,000 | unchanged | unchanged |

Customers (B09 2, B13 1) and cash (B09 29,800, B13 14,900 cents) are the same in every state.

### 2b. Browser world (the demo seed, in an isolated database)

The same rule on the real B09 story. Inputs read from the source payloads of the seeded world:
`lsa-B09` Oct 1–12 = 148,767 cents; `pmax-lsa-B09` Oct 13–30 = 212,352 cents, of which Oct 26–30 =
59,717 and Oct 13–25 = 152,635.

| State | B09 LSA October | Δ B09 Search | Δ B09 total | Required dates covered |
|---|---|---|---|---|
| Missing | 148,767 | 0 | 0 | 0 of 18 |
| Partial (week of Oct 26 re-fetched) | 208,484 | −59,717 | 0 | 5 of 18 |
| Full | 361,119 | −212,352 | 0 | 18 of 18 |
| Duplicate | 361,119 | −212,352 | 0 | 18 of 18 |

Every other branch's spend, every branch's customers and collected cash: unchanged. The 45 calls
carrying `pmax-lsa-B09`: unresolved throughout.

## 3. The change

- **`lib/reconcile/gap-coverage.ts` (new).** One computation of an incident's verification scope and
  coverage, used by reconciliation, the incident page and Decision Lab.
  - **Required dates:** from the gap's start, or its successor campaign's first spend when that is
    later (the days between are the migration's transition, listed and not required), to the spend
    feed's latest date while the incident is open. Once verified, the window is the one verified.
  - **Covered:** spend in the channel at the branch above $0.00 that day, the detector's own
    definition. No record is *missing*; a $0.00 record is listed apart.
  - **Misfiled:** successor spend in the window filed under another channel or at another branch.
  - **Lineage:** each covered date's accepted record, its ingestion run, the source's `fetchedAt`
    and the mapper version that filed it.
- **`lib/reconcile/reconcile.ts`, rule 6a (`carryCoverageGaps`).** Runs after rule 6, which is
  unchanged:
  - while rule 6 still finds an incident's own fingerprint, its fresh row stands as before;
  - otherwise an open incident stays detected with its fingerprint, summary and evidence, and a
    row rule 6 filed for the same branch and channel under a newer date is dropped;
  - when the window is covered and nothing is misfiled, the resolution and `evidence.verification`
    record what was verified, once; an earlier verification is kept, not overwritten;
  - a verified incident is re-checked over its verified window, within the detector's 60-day
    lookback: a later version that un-covers one of those dates reopens it under the same id.
- **Decision Lab (`lib/decision/verdicts.ts`).** After part of a gap is repaired, the hold says how
  many required dates are covered and which still are not. An untouched incident reads as before.
- **The incident page (`components/incidents/GapRecovery.tsx`).** The business conclusion first;
  four statements kept apart (source delivered, required dates covered, reconciles, decision); the
  delivery runs behind the covered dates; one next action. Nothing on it clears or approves anything.
- **The journey.** The trace's incident link, the incident and Decision Lab carry period, channel,
  week and brand, parsed only after each page's existing scope check.
- **Copy.** An empty week on the Overview no longer says "nothing was delivered for this channel":
  B09's spend was delivered, filed as Google Search. Two tests that quoted the old sentence say so.
- **Untouched:** the mappers, the R-46 rule, R-39, FI-4/R-50, the scorecard. No new table, status
  store, scheduler or dashboard. No budget action.

## 4. Results

**The source correction.** The Performance Max successor's own records (`pmax-lsa-B09`, Google Ads,
account `LSA-B09`, `PERFORMANCE_MAX` with Local Services enabled, no currency stated, so the
authorized account rule applies), re-fetched with the platform's stored amounts and a later
`fetchedAt`, delivered through the ads feed's polling path (`runStream`, active `ads@1.2`) and the
intake's consumers.

| State (browser world) | Run | Inserted / duplicates | B09 Local Services | Ledger | Δ B09 Search | Ledger | B09 total | Incident / case |
|---|---|---|---|---|---|---|---|---|
| Missing | — | — | 148,767 | 148,767 | 0 | 0 | 1,664,923 | #2455 open / 161 detected |
| Partial: Oct 26–30, fetched 13:00Z | #676 | 5 / 0 | 208,484 | 208,484 | −59,717 | −59,717 | 1,664,923 | #2455 open / 161 detected |
| Full: Oct 13–25, fetched 13:10Z | #677 | 13 / 0 | 361,119 | 361,119 | −212,352 | −212,352 | 1,664,923 | #2455 resolved, verified / 161 resolved |
| Duplicate of #677 | #678 | 0 / 13 | 361,119 | 361,119 | −212,352 | −212,352 | 1,664,923 | unchanged; same verification |
| Older Oct 20 version (+$50.00) | #679 | 1 / 0 | 361,119 | 361,119 | −212,352 | −212,352 | 1,664,923 | unchanged; same verification |

- In every state, B09's 146 customers and $18,239.00 collected, every other branch and the company
  totals are unchanged, and the 45 calls carrying `pmax-lsa-B09` stay unresolved.
- **The verification on #2455:** "Verified: all 18 required dates (Oct 13–Oct 30) have Google Local
  Services spend at B09 in the accepted source records, from 2 delivery run(s); no successor spend in
  that window is filed under another channel or at another branch." Runs #677 (Oct 13–25,
  $1,526.35) and #676 (Oct 26–30, $597.17).
- **The final decision.** Decision Lab reads "Ready" for every paid channel at B09, gate open,
  effectiveness unknown (no randomized experiment). Verified readiness: Google Local Services and
  Google Search *need review* (#970, an unmapped B44 Local Services campaign; 5 door-to-door
  conflicts); Meta and Microsoft Ads are *ready, with limitations*. Eligible for a person's review;
  nothing approves a budget change.
- **The untouched demo world:** all 197 incidents and their cases are identical, field for field,
  between a seed on the previous commit and a seed on this code.

**Integration (`tests/integration/b09-recovery.test.ts`, 12 tests, the ledger of §2a):** missing,
partial (the selected week), sufficient, duplicate, older revision, a later feed day, a regression
that reopens and re-verifies, a late-starting successor, the successor moved to another branch, a
middle week, a case closed by hand, and an untouched incident's fresh evidence.

**Browser (production build `d3CVYx3zUzxe2BMXQK_s0`, `revenue_signal_b09`, screenshots in `b09-recovery/`):**

| Phase | Checks | What |
|---|---|---|
| Missing, partial, verified | 26, 28, 24 | Marketing at desktop 1280 and phone 390, clicks only, from the Overview: B09 → Local Services → week of Oct 26 → Open evidence → the incident → Decision Lab → the incident → back to the same day-by-day evidence → the Overview, same selection |
| Persist | 2 | A reload shows the verified panel, word for word, and the resolution |
| Scope | 22 | Partner and brand, each in a fresh context: the server response and the rendered page with its payload, for the incident, the trace, Decision Lab and the Overview, carry no B09 evidence. Same-tab downgrade below |

- **Same-tab downgrade, through the role selector:** the page is re-rendered for the partner, and
  Back and a direct navigation show nothing of B09. What the tab had already received stays in its
  memory: React keeps up to three visited routes hidden, and their text was still in the DOM.
- **A role cookie changed outside the app (a script):** Back restored the previous page with no
  server request; a reload refused it. Demo roles are a cookie (R-2); not fixed here.

**Pixel baselines.** `incident-1440` and `incident-390` (`tests/e2e/__screenshots__/`) were
regenerated: the recovery panel adds 388 px and 740 px at the top, and above it the images are
identical. The old baselines also predated later sidebar entries and the `ads@1.2` label, both
within the 1% tolerance. Both Overview baselines passed and were not touched.

**Regression** (one full run on the final code, `C:/Temp/final-regression-b09r.sh`):

| Step | Result |
|---|---|
| Typecheck, lint, build | pass |
| Vitest | 76 files: 905 passed, 1 expected failure (R-39's pin). Was 893 + 1: the 12 new tests |
| Frozen eval packs: AI, investigator held-out, ChangeGuard held-out, VP and Shadow acceptance (`--twice`) | **Identical** to the R-46 ChangeGuard run, line for line and report for report; only a Node process id and the recorded commit differ |
| Browser suite | 116 passed, 2 failed, 7 did not run, 1 skipped (exit 1) |

- **Both failures came from one expectation.** `os-golden-path` read the incident id from Decision
  Lab's link with a pattern anchored at the end of the href. The link now carries `?period=oct` (and
  the Overview's selection, when there is one). The second failure (`z-a11y-regressions`, which
  needs the proposal the golden path executes) and the 7 that did not run followed from it.
- **Updated, not loosened:** the test now expects exactly `/exceptions/<id>?period=oct`, with a
  comment. On a fresh seed both files then passed, 17 of 17.
- **Two more full runs on the same build and product code, neither fully green:**

  | Run | Passed | Failed | What failed | That spec alone, fresh seed |
  |---|---|---|---|---|
  | 2 | 122 (+1 skipped) | 1, and 2 of its steps did not run | `zzzzzz-drift-review` "stale save": focus was not on the conflict notice when checked | 5 of 5, twice |
  | 3 | 124 (+1 skipped) | 1 | `zy-evidence-journey`: a ChangeGuard change's status was not visible within 5 s of submitting it | 1 of 1, twice |

- Every test passed in at least one full run on this code. The two later failures are different
  timing-sensitive steps in code this change does not touch (R-41); each passed in the other runs
  and alone.
- The new rule is not what slows a ChangeGuard preflight, which runs reconciliation:
  - On the untouched demo world it adds one query per open gap.
  - `gapCoverage`, where it runs, takes 1.8 ms median.
  - A whole reconciliation takes 713 ms median (lab database, warm).

## 5. Independent review

A fresh read-only reviewer had the diff, the ledger and the evidence, and tried to disprove the three
claims.

| Finding | Severity | Fix | Test |
|---|---|---|---|
| A verified incident reopened when any campaign's next feed day arrived before Local Services': its window grew with the feed | High | A verified window is frozen; only a regression inside it reopens | "a later feed day does not reopen …" |
| A successor starting days after the stop could never clear: the days between have no record anywhere | High | Required dates start at the successor's first spend; the transition is listed | "a successor that starts two days after the stop" |
| Moving the successor to another branch hid its misfiled spend | Medium | Successor spend at another branch counts as misfiled | "the successor mapped away …" |
| A second verification overwrote the first; the reopen wording overstated the lookback | Low | Earlier verifications are kept; the wording states the 60-day limit | "… both verifications are kept" |
| The verified panel mixed stored and live numbers; dates covered by two runs counted twice; Decision Lab's links dropped the brand slice and used an anchor only coverage gaps have; the ledger's lead count | Low | Fixed | Browser checks |

Claims 2 (replay) and 3 (restricted viewers) held. The reviewer sent crafted requests as the partner
and the brand viewer, including RSC payloads and injected parameters; every response was a 404
fallback, a 403 or "outside your scope".

## 6. What remains

- **A gap the source never fills stays held.** Coverage gaps cannot be acknowledged or closed by
  hand to lift a hold (unchanged policy); the panel names the missing dates.
- **The 60-day lookback.** A regression inside a verified window more than 60 days back shows on
  the incident page as historical but does not reopen it.
- **One incident per open gap.** A new stop at a later date for the same branch and channel, while
  the incident is open, is absorbed into it; its successor list is the one recorded before.
- **Run telemetry.** A run that stores an older version counts it as "projected" even when the
  accepted record does not change (run #679).
- **Demo roles.** The same-tab behaviour above; a refusal is a not-found page sent with HTTP 200.
- **Wording.** Decision Lab's "Ready" is its existing word for "a person can decide on this"; the
  incident page says that nothing approves a budget change.
