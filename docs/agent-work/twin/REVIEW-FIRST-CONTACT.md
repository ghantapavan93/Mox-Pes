# Reliability Twin: independent review, first contact (2026-11-12)

Three AI reviewers, each given the code and a role, none given the lead engineer's conclusions:
(1) data engineer + distributed systems, (2) financial controller + security, (3) SRE + product
designer. Each had to reproduce every finding (a failing test in its own database, or exact
steps). This file keeps what they reported **as reported**, then the disposition. It is AI review,
not a human audit.

Counterexample tests were adopted into `tests/integration/twin-review-regressions.test.ts`
(18 tests: 16 pass after the fixes, 2 pin pre-existing rules with `it.fails`). The reviewers' own
temporary files were deleted after adoption.

## Data engineer + distributed systems

| # | Severity (reviewer) | Finding, as reported | Reproduced red | Disposition |
|---|---|---|---|---|
| D1 | High | A quarantine replay puts voided payment cash back: replay now mapped at `last_delivered_at`, and a stale replica re-serving an unreadable earlier version moved that clock past the void. **New with this change** | yes (`expected 'successful' to be 'voided'`; HEAD control passes) | **Fixed.** A held record is mapped at first receipt for every source but calls (`replay.ts`, `heldClock`). Test `data 1` |
| D2 | Medium-high | A replayed quarantined call revision beats the good version observed after it: intake does not move the lead's clock when the live version is re-delivered. **New with this change** (and the pattern hits HEAD in other orders) | yes | **Fixed at the root.** A re-delivered live version moves `leads.source_updated_at` (`project.ts` upsert, `applyExclusions`). Test `data 2a` |
| D3 | Medium | A payload calls@1.1 reads and calls@1.2 refuses (`spam: null`): intake holds it, re-projection keeps the 1.1 lead; the rollback never re-reads what 1.2 held | yes | **Fixed in the twin, rule documented.** Re-projection still never drops what the old version counted, but reports it; gate B fails any stage with such a record. The rollback re-reads 1.2-held records with 1.1. Tests `data 2b` ×2 |
| D4 | Medium | A runner lost between a failed gate and its rollback: the rollback never runs | yes | **Fixed.** A FAILED stage with no rollback on record is rolled back by the next runner. Test `data 4` |
| D5 | Low | Forward then back leaves the lead clock at the re-read (T6), not where calls@1.1 had it (T5) | yes | **Resolved by D2:** calls@1.1 itself now records T6. Test `data 2c` |
| — | Sound | Within-batch and cross-batch A/B/A flips agree on both paths; R-37 intake unchanged; replay keys make a lost runner safe; re-delivery absorbed; sync fencing; no new lock cycle. **No runner lease** (evidence could be written twice) | — | Lease added (see S2) |

## Financial controller + security

| # | Severity (reviewer) | Finding, as reported | Reproduced red | Disposition |
|---|---|---|---|---|
| F1 | High | Two customers share a phone and each called before the first sale; the second customer's own call is reserved for the first, who is credited elsewhere, so it credits nobody. Product and reference agree, so gates A, G and H pass on a wrong count | yes | **Confirmed, pre-existing, not fixed here.** This is R-39's documented open item; the fix is an assignment over customers' chosen touches, a change to the money rule that needs a ruling. Pinned with `it.fails` (`R-39`) |
| F2 | High | A pair rejected, re-opened and accepted credits nobody: `v_acquisitions` let any old rejection veto; the reference depended on row order | yes | **Fixed (pre-existing product defect).** Migration 0026: credit follows the latest decision per pair (`v_identity_decisions`); the reference reads decisions in id order. Test `financial 2` |
| F3 | Medium | Gate I passes while a branch outside the stage moved (a customer's channel changed; totals did not) | yes | **Fixed.** Gate I also fails when any customer of a branch outside the stage changes credit. Test `financial 3` |
| F4 | Medium | Gate G cannot catch a wrong CAC: it reuses the product's function and spend | argued | **Partly fixed, stated honestly.** G recomputes CAC in its own integer arithmetic from the reference's paid customers and the unchanged spend (E). It does not re-derive spend from ad payloads; that limit is in its label and the report |
| F5 | Medium | A mapped Google campaign loses its paid customer because a Meta campaign shares its id (unmapped is keyed by id alone, in product and reference) | yes | **Confirmed, pre-existing, not fixed here.** Leads carry a campaign id without a platform; matching by platform needs that on the lead. New risk R-46; pinned with `it.fails`. **Fixed 2026-11-13** in the product and the reference: a campaign id is matched on the platform the lead's own record names (`CAMPAIGN-PLATFORM-MATCH.md`); the pin was removed |
| F6 | Medium | One quarantined spend day dated `2026-02-30` crashes the scorecard for every viewer; a non-ISO held date leaves the campaign's customers in paid CAC (the reference holds them) | yes ×2 | **Fixed (pre-existing product defect).** `try_date()` (migration 0026) in the scorecard's held-spend CTE and the CAC inquiry; a fully held campaign counts as held whatever its date reads. Tests `financial 6` ×2 |
| F7 | Low | Two control databases can name the same twin (sanitised, truncated name + an id that restarts at 1) | yes | **Fixed.** The twin name carries a hash of the full control database name; the runner re-checks the name. Test `financial 7` |
| — | Sound | No access hole: scoped viewers refused (GET/POST 403), resume across changes 404, verdicts not resumable, twin names guarded, stage work confined to the twin plus the control plane's own tables. The reference matched the twin for all 17,220 customers. **The reference is only partly independent:** it trusts version status, `last_delivered_at` ordering, and web and door-to-door lead rows | — | Stated in the report and R-45 |

## SRE + product designer

| # | Severity (reviewer) | Finding, as reported | Disposition |
|---|---|---|---|
| S1 | High | A hung evaluation cannot be cancelled: the heartbeat timer keeps it "alive", resume says "still reporting", a new start says "already running" | **Fixed.** `progress_at` moves only with steps; a runner alive but not progressing for 10 minutes is shown "Not progressing" with **Abandon**; a run has a 45-minute limit; the base-build lock wait is bounded |
| S2 | High | Resume has no lease: two runners can drive one evaluation | **Fixed.** `runner_id` lease taken by a conditional update, renewed by the heartbeat, checked before every runner write; another runner may take it only after it goes stale. Test `SRE H2` |
| S3 | High | After ERROR, stages still say "Running"; an ERROR can never be resumed; the half-applied stage is not explained | **Fixed.** ERROR marks the stage in flight `INTERRUPTED` ("stopped mid-way": its finished steps are applied in the twin, not rolled back); an ERROR can be resumed on the same code while its twin is kept. Test `SRE H1/H3` |
| S4 | Medium | Logs cannot tell simulated faults from real ones | **Fixed.** Runner lines carry `[twin evaluation N · simulated]`; the twin's sync workers are named `twin:evaluation:N:worker`, and sync log lines now include the worker id |
| S5 | Medium | In the stale state, Run is enabled and fails with 409 | **Fixed.** Run is disabled while any evaluation is unfinished; the in-flight stage reads "Interrupted" |
| S6 | Medium | "Recovering" means two things | **Fixed.** "Resuming" vs "Rolling back" |
| S7 | Medium | The recovery panel hides what was not restored (a held record), and a production line reads as if uploads happened | **Fixed.** A "Not restored" row; the production effects are worded "in a real rollout … would" |
| S8 | Medium | At 390 px the finding text is clipped | **Fixed.** Each stage is a stacked block on a phone |
| S9 | Medium | The base fingerprint hashes 7 files and misses their imports; old verdicts are never flagged | **Fixed.** The base hashes all of `lib/` (but the twin) and the migrations; each evaluation records a code fingerprint, the page marks a verdict "Outdated" when the code differs, and resume refuses mixed code |
| S10 | Low | The stop message is jargon ("Failed: I") and the row reads like a pass | **Fixed.** "Gate I failed: branches outside the stage unaffected did not hold. …" |
| S11 | Low | A crash at one point skips the rollback; dropped twins still listed as live evidence | **Fixed** (D4); a dropped twin is shown as deleted |
| — | Sound | Fail-closed (C blocked, 0 attempts); rollback verified; planned runner loss safe; resume during a live run refused; "nothing deployed" wording clear; at most 7 connections per run | — |
