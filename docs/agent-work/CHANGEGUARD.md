# Marketing ChangeGuard

**Why this exists:** the Action Center fixes what an exception already shows. B09 and B20 were
both found **after** the damage. ChangeGuard answers the questions before it:
- before a change: what could break?
- during it: is it safe to release?
- after it: did it work?

Background: `CHANGEGUARD-GAP-ANALYSIS.md` (role-to-capability matrix and what was reused).

Code:
- `lib/changeguard/` (model, preflight, service);
- `app/changes`, `app/api/changes`, `components/changes`;
- migration `0017_config_changes.sql`.

Everything runs against the synthetic environment. **No ad-platform, call-tracking or CRM
account is touched.**

## The journey (what a person sees at `/changes`)

1. **Propose:**
   - An analyst picks a campaign (unmapped ones first) and a branch, and gives a reason.
   - The change is stored as a draft, with its configuration hash.
2. **Preflight** runs at once and answers **14 questions**:
   - A mapping runs the **production write path** (the Action Center's mapping core, then
     reconciliation) inside a transaction that is **rolled back**.
   - Every branch's reporting is measured before and after the write.
   - A question that does not apply says why ("not applicable"), so nothing is silently
     unchecked.
3. **The page answers eight questions in order:**
   - what is changing;
   - what depends on it;
   - what we tested;
   - what failed;
   - what could be affected;
   - what must be corrected (the evidence names the fix, one click resubmits it);
   - who can approve;
   - what happened after release.
4. **Decide:** a different person with the approve permission approves.
   - The approval is **bound to** the configuration hash, the preflight hash, and the base
     hash: the mapping it replaces plus where the evidence points.
   - The author cannot decide their own change (service rule plus a CHECK constraint).
5. **Release** (an approved change only):
   - Under a row lock, the configuration hash and the base hash are re-checked.
   - If the base moved, the approval is **invalidated** (back to draft) instead of
     releasing.
   - The mapping is written and its version recorded (append-only history).
   - It is verified in the same transaction. A broken invariant rolls the whole release back.
6. **Verify and monitor:** checks are reported by layer: configuration, data-integrity and
   operational success.
   - **Measured business improvement is always "not measured".**
   - Re-verifying later checks two things: the mapping is still in place, and new leads still
     agree with it.
   - If either fails, the change becomes **recovery required**. A person proposes a
     compensating change; nothing is rolled back automatically.

State machine: `draft → ready_for_review | preflight_failed → approved | rejected | superseded →
monitoring → verified | degraded → recovery_required`. Every move goes through
`assertChangeTransition` and is written to `config_change_events` (append-only) and the audit
log.

## Change kinds

| Kind | Preflight | Releasable? |
|---|---|---|
| `campaign_mapping` | Production write path, rolled back. Checks: lead evidence, brand, lineage, competing changes, spend conservation, all-branch reporting diff, exceptions opened and cleared | **Yes** (synthetic environment) |
| `source_contract` | Sample payloads through the **deployed** mapper. Checks: refusal codes, structural diff against the latest stored payload, duplicates, dependent metrics | **No.** Activating a mapper version is a code deploy here, so it stops at review (declared, enforced) |

**Not modelled, by choice:**
- Lead-routing contracts: the product has no routing model, and inventing one would be
  speculative.
- Reporting definition changes.
- Effective-dated mappings: a mapping applies to the campaign's whole history. The preflight
  states this retroactive effect instead of hiding it.

## Scenarios (labelled, measured)

`tests/integration/changeguard.scenarios.test.ts` builds its own fixture through intake,
independent of the preflight logic.

| Scenario | Want | Got | Evidence |
|---|---|---|---|
| A · new campaign mapped to the wrong branch (B04) | block | **block**: `LEAD_EVIDENCE_DISAGREES`, `CROSS_BRAND` | Mapping table, audit log, open exceptions and raw ledger unchanged after preflight |
| A · corrected to B44, approved, released | allow | **allow → verified**: mapping v1 (as found) → v2; unmapped-spend exception cleared; B44 gained exactly the campaign's spend; no other branch moved | — |
| A · later leads land elsewhere | — | **recovery required**, mapping left in place | — |
| B · CRM payment shape change (`paymentApplications`, no `ticketID`) | block | **block**: `MISSING_FIELD`; dependent metrics collected, newCollected, atRisk | Nothing written |
| C · call provider sends the same lead twice | allow | **allow**: second sample is the same record version | — |
| D · late or corrected event | — | Existing proof, not re-built | `ledger-model.test.ts`: 24 random histories, rebuild = incremental = model |
| E · partial outage (429, timeout) | — | Existing proof, not re-built | `connectors.test.ts`, browser rate-limit test |
| F · benign added field (`call_score`) | allow | **allow**: a structural difference, not a contract violation | — |
| G · remap against the campaign's own leads | block | **block** | — |
| G · self-approval (even holding another role) | refuse | **ForbiddenError**; database CHECK refuses a direct write | — |
| G · branch-scoped role proposes or reads outside scope | refuse | **ForbiddenError** | — |
| G · approval presenting another preflight's hash | refuse | **409** | — |
| TOCTOU · mapping changed between approval and release | refuse | **409**; approval invalidated; fresh preflight sees the remap | — |
| H · AI says the change "increased revenue" | refuse | **dropped by grounding**; a hedged hypothesis stays | `groundDraft` |

**On the 7 labelled block/allow cases: 0 false positives, 0 false negatives.** That is a small,
self-written set, not a held-out measurement (see Limits). Mutations show the tests have teeth:
removing the base from the stale-approval hash fails the TOCTOU test, and disabling the
lead-evidence rule fails Scenario A and the tally.

The demo world gives the same answer: `lsa-B44-x` has $4,539.34 of spend with no branch and 10
leads at B44.
- **Mapping it to B04 is blocked.** The preview shows the reporting consequence: B04's paid CAC
  would rise from $218.86 to $289.79 (spend it did not earn). B44's paid customers would go 70 → 72
  while its spend stayed put.
- **Mapping it to B44** gives B44's true paid CAC: $285.69 → $340.80.

**Found while building:** a mapping also moves the paid-customer count at the branch where the
campaign's leads land. The CAC denominator excludes customers of unmapped campaigns. So that
branch is shown as a dependent, not reported as "unrelated" (regression-tested).

## Independent adversarial review (commit 120bee4)

One reviewer agent, given the code and a list of claims to break. It confirmed:
- the preflight never mutates;
- double release is impossible;
- swapped payloads and preflights are refused;
- concurrent proposals for one campaign are safe.

It found 10 issues. Each was checked against the code. Each fix has a regression test, and the
review tests fail on the pre-fix code (checked by stashing the fixes):

| # | Finding | Severity | Fix |
|---|---|---|---|
| 1 | Monitoring had no permission check: a guest could flip a released change | High | Requires propose or approve |
| 2 | Evidence drifting across the 50% line kept the same base hash | Medium | The base hash includes the evidence verdict for the proposed branch |
| 3 | Release read the base before taking the mapping lock; a mapping made in between would be overwritten | Medium | Lock first, then read; the write refuses if the mapping is not the reviewed one (`expectedPrevious`) |
| 4 | "Spend conserved" and the audit check were vacuous | Medium | Replaced by: the proposed branch gains exactly the campaign's media spend, the previous loses exactly that, and no branch outside the change moves (preflight and release) |
| 5 | Causal-claim guard misses and false drops (decimals, "May", "caused revenue to rise", "cut CAC"; "0 customers attributed") | Medium | Outcomes only (bare "customers" is a count); decimals inside gaps; hedges no longer match months; 17 pinned cases |
| 6 | Lead evidence ignored a person's lead branch override, unlike the metrics | Medium | Evidence uses `v_leads.effective_branch_id` |
| 7 | Brand check added nothing when leads existed, and nothing at all without them | Medium | Majority brand; a remap across brands fails even with no lead evidence |
| 8 | Monitoring appended duplicate checks and could clear "degraded" | Low-medium | Release checks kept; monitoring checks replaced on each run |
| 9 | A scoped viewer could read a company-wide source check by id; anyone could supersede another author's change | Low | Company-wide changes need company-wide scope; only the author resubmits |
| 10 | A preflight re-run racing an approval could silently drop the approval | Low | The status is re-checked under the row lock before a preflight is stored. **Not deterministically tested** (the race window is the preflight's duration) |

## Performance

On the full seeded world (44 branches, 156 campaigns, about 25k leads; Postgres with
`fsync=off`):
- campaign-mapping preflight: **1.1 s p50, 1.4 s max** over 7 runs;
- the mapping table, audit log and open exceptions were identical before and after all 7 runs.

The cost is two full branch scorecards and one reconciliation inside the rolled-back
transaction.

## Three-minute demonstration

Verified by `tests/e2e/zzz-changeguard.spec.ts` on the production build.

| Time | Role | Action | Say |
|---|---|---|---|
| 0:00 | Marketing | **ChangeGuard** → propose `lsa-B44-x` → **B04** | "A new Local Services campaign. Someone maps it to Briar." |
| 0:20 | — | Preflight: **failed**. Q4 shows the campaign's 10 leads at B44, and B44's brand | "The system checked the change against the campaign's own leads before anyone approved it." |
| 0:50 | — | Q5: B04's CAC would rise, B44's paid count moves, no other branch changes; the unmapped-spend exception would clear | "This is the reporting damage we just avoided, measured on the real write path and rolled back." |
| 1:20 | Marketing | Q6: **Resubmit corrected change** (B44) → ready for review; "a different person must decide it" | — |
| 1:45 | Approver | Approve; the decision shows the configuration and preflight hashes it binds to | "If the mapping or its evidence moves before release, this approval stops counting." |
| 2:10 | Marketing | **Release** → **verified**: configuration applied, B44 gained exactly $4,539.34 from unallocated, no other branch moved, the exception cleared; **business improvement: not measured** | "Configuration success is not revenue." |
| 2:40 | — | **Safe refusal:** a later flood of leads elsewhere turns it to recovery required, with no automatic rollback. Or try approving your own change | — |

### Ninety-second cut

The same path, shortened. Every beat is asserted by the first test in
`tests/e2e/zzz-changeguard.spec.ts` on the production build. Start from a fresh seed, as
Marketing, at `/changes`.

| Time | Role | Action | Say |
|---|---|---|---|
| 0:00 | Marketing | Propose `lsa-B44-x` → **B04** | "Someone maps a new Local Services campaign to Briar." |
| 0:15 | — | **Preflight failed**: `LEAD_EVIDENCE_DISAGREES`, `CROSS_BRAND`; B04 proposed, B44 lead evidence, other branches changed: none | "It ran the real write, measured every branch, rolled it back. The campaign's own leads are at Willow." |
| 0:40 | Marketing | **Resubmit corrected change** (B44) → ready for review; "a different person must decide it" | "One click to the fix. And I can't approve my own change." |
| 0:55 | Approver | Approve (bound to the configuration and preflight hashes) | "If the mapping or its evidence moves before release, this approval stops counting." |
| 1:10 | Marketing | **Release** → **verified**: B44 gained exactly $4,539.34 from unallocated; **business improvement: not measured** | "Money moved, not created, and configuration success is not revenue." |

## Acceptance gates

| Gate | Status |
|---|---|
| Existing journeys, B09/B20, onboarding, financial totals | Full regression after this work: see `FINAL-EVIDENCE.md` |
| Preflight uses production validation and write logic | **Met**: the Action Center mapping core plus reconciliation; source checks use the deployed mapper |
| Configurations versioned; approval bound to the exact version | **Met**: config hash, preflight hash, base hash; `campaign_mapping_versions` |
| Unauthorized execution rejected | **Met** (service and database) |
| No real external system modified | **Met**: none is reachable |
| Unrelated branches not blocked | **Met**: preflight is per change; the all-branch diff proves the others are untouched |
| Unsafe changes detected; valid changes not blocked; FP/FN measured | **Met on 7 labelled cases** (0/0). Not a held-out set |
| No unknown data treated as valid | **Met**: no lead evidence is a warning a person must accept, never a pass |
| Simulated release reproducible; failure recovery | **Met**: release, stale-approval invalidation, recovery-required |
| Browser workflows functional and accessible | **Met**: production-browser test; axe zero violations at 1440 and 390 px |

## Limits (stated, not hidden)

- **Demo identities.** One synthetic person per role: "a different person" is a different demo
  subject. A role switch is not authentication. The two-person boundary is real in the code
  and database, not in the demo login.
- **Lead evidence.** It exists only where leads carry the campaign id (calls and web here). A
  campaign without it can be approved only with a person accepting the "no lead evidence"
  warning.
- **Preview drift.** The preview is a snapshot. Release re-checks the base (mapping and
  evidence direction), not every number; other new data between preview and release shows up
  in verification, not as a block.
- **Held-out scenarios: one blind set, now used.** The 7 cases above were written alongside the
  code. A 50-scenario blind set was then written by an independent agent and run once before any
  fix (`CHANGEGUARD-HELDOUT.md`): 0 false approvals, 25 / 25 required refusals, 2 missed reviews,
  5 false blocks. Four defects were fixed, so that set is no longer held out; a v2 is the next
  honest measurement.
- **Source contracts stop at review**, because mapper activation is a code deploy.

## The VP's question

*"We already have lead routing, pipelines, CRM, reporting and AI. Why does this matter?"*

Because each of those is a contract with the others, and a one-line configuration change (a
campaign's branch) moves money between branches in every report built on top. The routing
still works, the pipeline stays green, and the dashboard is confidently wrong.

What this demonstrates:
- it uses the systems already in place (the same write path, reconciliation and approval
  rules);
- it catches the wrong change **before** release, with its evidence and its exact reporting
  consequence;
- it refuses to call a correct configuration a business win.

That is the "own what happens after you ship" part of the role, shown working rather than
claimed.
