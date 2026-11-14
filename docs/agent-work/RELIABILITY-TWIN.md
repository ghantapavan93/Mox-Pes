# Reliability Twin: the calls@1.2 rollout over 1 → 5 → 44 branches

2026-11-12, branch `feature/audit-enterprise-redesign`. A **simulation** on synthetic data. Nothing
was deployed, activated for real traffic, or sent to an external system. Code: `lib/twin/*`, the
change page's question 9 (`components/changes/RolloutEvaluation.tsx`), `npm run twin`.

## 1 · The upgrade, as the code defines it

| | calls@1.0 | calls@1.1 (the real predecessor) | calls@1.2 (active today) |
|---|---|---|---|
| Caller in `customer_phone_number` | read | read | read |
| Caller in `caller.number` (the B20 account migration) | refused, `MISSING_FIELD` | read | read |
| `direction: "outbound"` | ignored: counted as a lead | ignored: counted | **excluded**, `NOT_INBOUND` |
| `spam: true` | ignored | ignored | **excluded**, `SPAM_CALL` |
| `lead_status: "not_a_lead"` | ignored | ignored | **excluded**, `NOT_A_LEAD` |
| A later revision marking a counted call this way | no effect | no effect | the lead leaves every lead metric; a later qualifying revision restores it |

Source: `lib/adapters/marketing.ts` (`CallTrackingMapper`, `excludeUnqualified`), the registry
(`lib/adapters/registry.ts`), VENDOR-CONTRACTS C-3. The rollout evaluated is **calls@1.1 →
calls@1.2**. calls@1.0 → 1.1 is the earlier B20 fix; its 119 held records stay held (their
recovery is the incident's replay, not this change).

Customer consequence: an excluded call stops being anyone's first touch, so the customer's credit
moves to their next evidenced touch, or to "no lead" (unknown). That moves paid customers, the CAC
denominator. Spend, cash and every non-call source are untouched.

The synthetic world carries none of the three fields, so the scenario supplies them (section 3).

## 2 · What the product can and cannot do, and what the twin adds

**The product has no per-branch mapper activation.** `ACTIVE_VERSION` selects one version per
source for every branch; changing it is a code deploy. The twin does not change that. Its
per-branch routing (which branches read calls with 1.2) exists only inside `lib/twin/runner.ts`,
against an isolated database.

| Term | What it means here | Where it happens |
|---|---|---|
| Testing a rollout | Running the change stage by stage in an isolated copy of the world and gating each stage | The twin (`lib/twin/*`), a separate database per evaluation |
| Activating a mapper | Making a version the one intake uses | Only a code deploy of `ACTIVE_VERSION`, for all branches. The twin never does it |
| Replaying historical records | Re-mapping stored raw records with another mapper version, idempotently, keeping each record's original evidence | `replay()` (`lib/ingest/replay.ts`), mode `reproject`, in the twin |
| Recomputing projections | Leads, credits and figures re-derived from what is stored | The projection upserts and views; the twin re-reads them after each step |
| Approving a change | A different person approves the exact configuration and preflight hashes | ChangeGuard. A source-contract change stops at review: activating a mapper is a deploy |
| Publishing a change | Releasing an approved change into the synthetic environment | ChangeGuard release (campaign mappings only). The twin publishes nothing |

## 3 · The scenario (TW-1)

- **Base world.** The production seed with calls@1.1 after the call-feed fix, built once into
  `rso_twin_base` (67 s) and fingerprinted by its recipe, migrations and seed sources. Each
  evaluation clones it (`create database … template`, 1.6 s).
- **Inputs CallRail would have sent, which calls@1.1 counted.** Per branch, picked
  deterministically: 1–3 spam revisions and 1–3 outbound calls (the pattern differs by branch), a
  "not a lead" revision, a no-op revision, and two new customers who called first (one call marked
  spam), whose CRM records only the backfill brings in.
- **During each stage, to every branch:** a late spam or "not a lead" revision, a correction back
  to a good lead (stage B), a revision with no caller (stage B, B05: missing evidence). Every
  delivery is sent twice.
- **Stages:** A = B12; B = B12, B05, B23, B28, B41 (three brands, four time zones); C = all 44.
- **Hashes:** the scenario hash covers the definition, the fault plan and every generated input;
  the source hash is the twin's stored records after the inputs, before stage A.

## 4 · How a stage runs

Each stage's steps run through production code, in the twin: `reproject` (replay, calls@1.0 and
1.1 → 1.2, the stage's new branches), `deliver` (intake: `ingestRecords`, routed by branch),
`backfill` (the CRM sync worker against the mock FieldRoutes server), `reconcile`, then the gates.
Each step is acknowledged in the control plane (`rollout_stages.steps`) after it commits.

**Gates** (`lib/twin/gates.ts`): A–J are the financial and access invariants, F1 and F2 the
fault outcomes. A gate whose evidence is missing fails. The **independent reference**
(`lib/twin/oracle.ts`) shares no code with the paths under test: it reads the stored call
payloads, applies the contract (latest observation decides; under 1.2 the three exclusions),
credits customers by the written first-touch rule in TypeScript, and counts per branch. On the
demo database it agrees with the product for 17,111 of 17,111 customers and 44 of 44 branches.

**Fail-closed.** A stage starts only after the previous one PASSED. A failed gate makes the stage
FAILED; it is rolled back (its branches re-projected to calls@1.1 through the same replay) and the
rollback is checked against the reference; every later stage is BLOCKED and never runs. Nothing is
promoted after a failed gate.

**Faults, two families at every stage.**

| Stage | Source errors during the backfill | Process lost after a commit, before acknowledgement |
|---|---|---|
| A | 429 with Retry-After on the first customer search | the rollout runner, after the re-projection committed |
| B | 503 on a second `get` (a batch already committed); two 429s | a sync worker, after committing a batch |
| C | a delayed response past the client timeout; an office down for exactly five attempts (exhaustion, then the runbook retry) | the rollout runner, after the deliveries committed |

A lost process is abandoned at a deterministic point: after the commit returned, before the
acknowledgement write. It writes nothing more (the sync worker's pool is closed). A new runner,
with new connection pools, resumes from durable state only. One runner holds an evaluation at a
time (a lease in the control plane, checked before every runner write).

## 5 · Stage by stage (standard rollout, durable Postgres, evaluation 1 in the demo database)

| Stage | Result | What the change did, as the gates found it |
|---|---|---|
| 1 branch (B12) | **Passed**, after the runner was lost once | 7 credits moved (6 off a paid channel, 1 back). B12 paid CAC $287.95 → $297.24: spend $27,642.94 unchanged, paid customers 96 → 93, as the reference counts. 7 calls excluded. 43 branches outside the stage unchanged, figure for figure and credit for credit |
| 5 branches | **Passed**, a sync worker lost mid-job | 30 credits moved (18 off paid, 11 back). B05 CAC $272.57 → $270.02 (106 → 107). 37 calls excluded. One revision with no caller held for replay; its lead kept its last readable version. 39 branches outside unchanged |
| 44 branches | **Passed**, the runner lost once | 310 credits moved (215 off paid, 77 back); paid CAC moved in 41 branches, each with unchanged spend and the reference's paid count. 352 calls excluded |

Every stage: spend $1,234,318.64 over 11,422 campaign-days and collected cash $1,203,871.00 over
11,131 payment rows unchanged row for row; every record stored before the stage still stored
byte for byte; the CAC and cash traces of every stage branch reproduce the scorecard and the
reference; scoped viewers refused.

**Stopping runs.** *Cross-brand credit:* stage B fails gate I — B43 (brand joshuas, outside the
stage) went from 49 to 48 paid customers because a call tagged to B28 was a customer's only
touch. Stage B is rolled back in 9.1 s and the rollback verified: every credit, counted call and
branch figure equals the reference with only B12 on calls@1.2, and every branch outside the
stage is back to its figures. Stage C never runs. *CRM outage:* stage B's subscription job for
B28's office fails five attempts and its runbook retry; F1 fails; the stage is rolled back and
verified; stage C never runs.

## 6 · Independent reference

On the demo database (calls@1.2 everywhere) the reference and the product agree on 17,111 of
17,111 customers' credits and on prospects, acquired, paid and unknown customers in 44 of 44
branches (0.6 s). In every stage of every run since, gates A and B compared every customer
(17,113–17,220) and every call: 0 differences. The reference is **partly** independent (R-45):
it shares the written rules, so a rule wrong in both passes (R-39; R-46 was one until 2026-11-13, when both moved to
matching a campaign id on the platform the lead names: `CAMPAIGN-PLATFORM-MATCH.md`).

## 7 · Faults and recovery

| Family | What happened | Result |
|---|---|---|
| 429 (Retry-After 90 s) | job retried after the simulated wait | succeeded; 6 of 6 new records stored once |
| 503 on the second get | first batch committed; resumed after the last committed id | succeeded; nothing fetched twice |
| delayed response past the timeout | client aborted; retried | succeeded |
| office down for five attempts | job failed (`unavailable`), runbook retry | succeeded; 234 of 234 new records stored once |
| sync worker lost after a committed batch | heartbeat went stale; re-queued; another worker resumed after id 2002868 | succeeded; no record stored twice |
| runner lost after the re-projection committed | resumed runner found both replay keys | stored results returned; nothing ran twice |
| runner lost after the deliveries committed | resumed runner delivered again | 44 re-deliveries absorbed; every figure identical |

**Recovery guarantees.** Verified per run: restored business state (against the reference),
preserved evidence (digest of every earlier record), and the records not restored (still on the
new mapper: 0; held because neither mapper reads them: 1). **Limits:** effects outside the twin
(conversion uploads, decisions people took) are listed, not reversed; Decision Lab verdicts,
exports and investigations are not re-checked after a rollback; identity conflicts opened during
a stage stay.

## 8 · Performance (durable Postgres: fsync, synchronous_commit and full-page writes on)

One machine, single runs, twin cloned in 2.2 s (base built once in 67 s, fsync off).

| Stage | Total | Re-project | Deliver ×2 | Backfill | Reconcile | Gates | Per new branch | Records re-projected | CRM records fetched | Retries (simulated wait) | Commits | Rows fetched |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A, 1 branch | 10.5 s | 0.2 s | 2.6 s | 2.3 s | 0.7 s | 4.7 s | 10.5 s | 418 | 101 | 1 (90 s) | 163 | 2.7 M |
| B, +4 | 20.2 s | 7.0 s | 2.6 s | 0.6 s | 0.7 s | 8.1 s | 5.0 s | 1,553 | 485 | 3 (300 s) | 579 | 5.1 M |
| C, +39 | 45.3 s | 9.3 s | 2.5 s | 8.2 s | 0.7 s | 33.8 s | 1.2 s | 12,538 | 3,628 | 5 (23 s) | 3,377 | 22.6 M |

Whole evaluation 104 s; the stopping run 54 s, its rollback 9.1 s. Peak memory 297–321 MB. The
44-branch scorecard query took 861–952 ms before and 861–871 ms after each stage: no regression.
The reference takes 0.6–0.8 s. Most of stage C is gate H (88 traces, four at a time). Stage time
counts the attempt that finished it; an interrupted attempt's acknowledged steps keep their own
timings. Nothing was optimised away: every gate ran in full. Gate H's 88 traces ran one at a time
in the first run (134 s for stage C under load); they now run four at a time, with the same
checks.

## 9 · Independent review

Three AI reviewers reproduced 23 findings (`twin/REVIEW-FIRST-CONTACT.md`, kept as reported).
Fixed, each with a regression test: two regressions my replay change had introduced (a
quarantine replay putting voided cash back; a lagging lead clock), two pre-existing product
defects (a later identity decision ignored; an impossible held spend date taking the scorecard
down, or keeping held customers in paid CAC), the twin's own gaps (no runner lease, no way to
abandon a stuck run, ERROR leaving stages "Running", no rollback after a crash between two
writes, weak gates G and I, twin name collisions, an incomplete base fingerprint) and seven UX
issues. Not fixed, pinned with `it.fails`: two pre-existing attribution rules both the product
and the reference apply (R-39, R-46); they need a ruling. **R-46 fixed 2026-11-13** in both
(`CAMPAIGN-PLATFORM-MATCH.md`); its pin was removed. R-39 stays pinned.

## 10 · Verification

| Check | Result |
|---|---|
| Reprojection ordering and rollback (`reprojection-ordering.test.ts`) | red first (2 of 3), then green |
| Twin acceptance (`twin-rollout.test.ts`) | 8 / 8: standard PASSED; cross-brand and CRM outage both stop at B, roll back verified, C never runs; gate sensitivity; access refusals |
| Review regressions (`twin-review-regressions.test.ts`) | 16 pass, 2 expected fails (the pinned rules) |
| Full regression at `23aad50` | typecheck, lint pass; vitest **808 / 808** + 2 expected fails (67 files); eval-ai 15/15; investigator held-out 61 pass, 1 by design (IV-16); ChangeGuard 30 / 18 wording / 2 invalid; VP 509 checks, the same 16 failed (11 critical); Shadow 320 / 320; every evaluation repeated identically; build pass |
| Browser suite at `23aad50` | 111 passed, 1 skipped, **1 failed: the new Twin spec**, whose locator also matched rows nested in the stage details (test defect). Fixed in `a10a662`; its axe check then found a real heading-order defect, fixed in `de05326`; the Twin spec then passed (3.8 min, production build) |
| Durable Postgres | standard run PASSED in 104 s; stopping run FAILED at B as designed, rollback verified, 54 s |
| Clean checkout of `06de2ed` (detached worktree, `npm ci`, fresh databases, its own twin base) | install, migrate, seed, typecheck, lint pass; vitest **808 / 808** + 2 expected fails (Twin base rebuilt from scratch); build pass. Browser suite first run: 100 passed, **7 failed, because the machine's disk filled** (Postgres: "could not extend file: No space left on device", 714 MB free of 931 GB; R-49). After dropping this mission's twin databases, the same worktree's browser suite: **112 passed, 1 skipped, 0 failed** (34.0 min) |
