# BIVE final acceptance (2026-11-15)

"BIVE final acceptance" is a report label only: the repo has no BIVE process. This record follows
the agent-work conventions: one document, evidence beside it in `bive/`.

The three review lenses are drawn from public leadership descriptions supplied with the mission.
No one named there took part in this audit or endorsed it.

## 1. The bar, frozen before any review

| Item | Value |
|---|---|
| Candidate code | `4fc9eb5`, verified by `RELEASE-CANDIDATE.md` §2–§3 (docs-only commits may follow it) |
| Build | `XgMHB0FQcsdeS6IT2xXHD`: `next build` in the fresh worktree `C:/Temp/rso-rc`, detached at `4fc9eb5` |
| Environment | Windows 11; Node 22.14.0; npm 11.6.2; Postgres 17 at 127.0.0.1:54333; Next.js 16.4.3 |
| Fixture and seed | Demo seed (`npm run db:seed`, deterministic: 675 runs, 134,088 raw events). The B09 corrections go through the ads feed (`C:/Temp/b09-correct.ts partial, rest, duplicate, older, stale2`). The B09 integration fixture has a hand-written ledger (`b09-recovery.test.ts`) |
| Isolated databases | `revenue_signal_rc` (demo, browser suite), `revenue_signal_rc_test` (vitest), `revenue_signal_rc_eval` (frozen packs), `revenue_signal_rc_b09` (walkthrough). For this audit: `revenue_signal_bive_ro`, a copy of the walkthrough's final world that reviewers read with SELECT only; `revenue_signal_bive`, the coordinator's own walk |
| Expected failures and skips | 1 expected failure (R-39, pinned `it.fails`). 1 skip (the opt-in demo-video recording) |
| Known limitations | R-2 (demo roles are a cookie, plus the same-tab cache); R-39; R-46 (45 Local Services calls carrying a Performance Max id, unresolved); FI-4/R-50; R-51; R-52; R-53; npm audit reports 7 moderate advisories |

An earlier green build is no evidence here. Every result below is from this candidate's build and
databases, unless it says otherwise.

**After the freeze.** The review found two release blockers in `4fc9eb5` (§6). They were fixed in
two code commits, so the "docs-only" note above no longer holds.
- **Candidate under acceptance:** `91ef06f`, build `-t8FhwvfYGehXmbdri6T7`. Everything below
  that names a build ran on it, unless marked otherwise.
- **Databases:**
  - the lens walks used their own worlds, `revenue_signal_bive_a` and `revenue_signal_bive_b`;
  - ChangeGuard used `revenue_signal_cgr46`;
  - the three lane reviewers read `revenue_signal_bive_ro`, the `4fc9eb5` world;
  - the planned `revenue_signal_bive` was not used.

## 2. Acceptance matrix

Each row's evidence label:
- **[B]** browser-observed;
- **[S]** server- or database-verified;
- **[C]** code-inspected only;
- **[T]** test log.

Paths are under `docs/agent-work/`.

### Lens 1: marketing, product and adoption

| # | Expected outcome | Result | Proof |
|---|---|---|---|
| M1 | "Decision held" and why, from the Overview, no ids | **Pass** [B][S] | `bive/lens-a/missing-1-overview-*.jpg`; `walk-lensA.json` (Overview checks); Review A §8 |
| M2 | Missing is "no spend record", never $0.00 | **Pass after repair** [B][S]. **Failed on `4fc9eb5`:** the incident's "CRM outcomes" card said "recorded spend is zero" in every state (§6, repair 2) | `walk-lensA.json` ("missing dates read as no record"); `bive/incident-copy.json` |
| M3 | The selected week and the decision window shown apart | **Pass** [B] | `partial-2-daily-evidence-*.jpg`, which Review A called the strongest moment |
| M4 | After the partial correction: 5 of 18, same incident held, Oct 13–Oct 25 named | **Pass** [B][S] | `partial-{1,3,5}-*.jpg`; the ledger |
| M5 | Verified only at 18 of 18; "Reclassified, not added: $2,123.52" | **Pass** [B][S] | `verified-3-incident-*.jpg`; `bive/lens-b/walk-lensB.json` (chain) |
| M6 | "Ready for review", review items named, no approval implied | **Pass** [B]. Confusing but not misread (§9) | `verified-5-decision-lab-*.jpg`: "It is not an approval", "Nothing here approves a budget change." |
| M7 | Sits beside the CRM and ad platforms, does not replace them | **Pass** [B][S] | Answer checks: valid → "Nothing to do: both systems agree"; wrong branch or wrong period → "Open the product's trace" (`A-answer-*.jpg`); "reads data, never changes another system" |

### Lens 2: technology governance and operations

| # | Expected outcome | Result | Proof |
|---|---|---|---|
| T1 | Owner and assignment history from the incident, no SQL or id | **Pass** [B][S] | `walk-lensB.json` B-assign and B-trace; case #161's events. The owner is a role (R-2). A case that resolved itself is hidden by the Incidents list's default "Active" filter (recorded) |
| T2 | Source revision, correction, verification, each run's outcome | **Pass** [B][S] | `B-2-verification`, `B-3-run`; the chain in §8 |
| T3 | A duplicate, an older revision, and an older revision with other campaign fields change nothing, open no case, make no recovery | **Pass** [B][S] | `release-candidate/walk/walk-all.json` (durable); `RELEASE-CANDIDATE.md` §1 |
| T4 | Unknown effects say "Effect not recorded"; recovery limits written down | **Pass** [B] | Failed run #473; R-51, R-53 |
| T5 | Partner and brand get no B09 evidence, page or payload | **Pass after repair** [S][B]. **Failed on `4fc9eb5`:** brand-level answer checks leaked (§6, repair 1) | `bive/route-sweep-old-build.json` (6 leaks) → `route-sweep-new-build.json` (0 of 122). Caveats in §4: R4, R11 |
| T6 | Same-tab role switch recorded apart | **Recorded** [B] | The tab's hidden DOM keeps the B09 text it already received. Nothing new can be fetched after the switch: payloads clean, direct navigation refused |
| T7 | Someone else can start and demonstrate this build | **Pass for startup and in-repo checks** [T]. **Limit:** the walkthrough and sweep tools are outside the repo (§10) | `RELEASE-CANDIDATE.md` §2, §5 |

### Lens 3: financial and decision integrity

| # | Expected outcome | Result | Proof |
|---|---|---|---|
| F1 | Source, totals and decision evidence agree | **Pass** [S] | Ledger 27 of 27 (twice); the chain: sent = verified = accepted = 212,352¢; the trace matches the scorecard |
| F2 | The correction only moves money between channels | **Pass** [S] | B09 1,664,923¢; customers 146; cash 1,823,900¢; company-wide totals unchanged |
| F3 | No believable wrong result gets through | **Pass on the demo path.** **Not true off it** [S]: three wrong results reproduced (§5); the stale campaign rewrite was found and fixed (`RELEASE-CANDIDATE.md` §1) | `bive/data-integrity-repro.json` |
| F4 | Insufficient evidence is said so | **Pass** [B] | Held states; "no record"; "Effect not recorded"; R-46 unresolved leads kept apart |

### Other product promises

| # | Capability | Result | Proof |
|---|---|---|---|
| P1 | Drift review (B44/B39) | **Pass** [S][T]. In the candidate's browser-suite world (`bive/drift-audit.json`):<ul><li>Review #1 ("no mapping change") held through the Nov 3 check, which carried the same evidence.</li><li>New contradictions on Nov 4 and Nov 6 reopened the same case #198, twice; all three reviews and their audit rows were kept.</li><li>No review or check wrote a mapping version: it stays v2 (B44). The change stays `recovery_required`.</li></ul> | `drift-review.test.ts` (persists; same evidence does not reopen; a new contradiction reopens the same case, review kept); `zzzzzz-drift-review.spec.ts`; `bive/drift-audit.json` |
| P2 | ChangeGuard shared id | **Pass** [B][S][T] | Wrong mapping refused at preflight (`LEAD_EVIDENCE_DISAGREES`). Monitoring says insufficient evidence (`CAMPAIGN_ID_AMBIGUOUS`, `LEADS_UNRESOLVED`): no drift, no review item. Mappings identical before and after the check (`bive/changeguard/world.json`). 20 of 20 browser checks, including "certifies nothing" and partner redaction (`journey.json`). Frozen pack identical |
| P3 | Shadow Mode, answer assurance | **Pass** [B][T] | Valid figure matches; wrong branch and wrong period do not; `shadow-mode.test.ts` 15 of 15 (scope, period, incompleteness, causes never certified). No live model ran: answers are proved by templates |
| P4 | Reliability Twin | **Pass** [T]. The twin's integration tests and its browser spec pass in the candidate's run. A simulation only | `twin-rollout.test.ts` (1 → 5 → 44, every gate; a cross-brand credit stops stage B, which is rolled back and verified, and stage C never runs; a CRM outage the same); `zzzz-twin-rollout.spec.ts`. A synthetic simulation, not deployment |
| P5 | Authorization deep links | **Pass after repair** [S][B] | T5, plus `bive/post-refusals.json` |
| P6 | No unexpected errors in normal use | **Pass** [B][S] | 0 console, page or server errors across five walks on two builds. Fault injection and the reseed race are told apart (`RELEASE-CANDIDATE.md` §3) |

## 3. How the audit ran

- **The coordinator** owned every database, build, delivery, walk and fix. Every walk ran on its
  own seeded database and port, never two at once.
- **The lane reviewers** were three independent read-only subagents: the analyst journey and
  frontend; data, replay and decision; authorization, audit and handoff. They read the
  candidate's code and evidence and queried `revenue_signal_bive_ro` with SELECT only. They ran
  against `4fc9eb5`.
- **The lens reviewers** were two more independent read-only subagents: **A**, would this help a
  marketing team decide; **B**, would an engineering team trust it to operate. Each had its own
  world, and each got the task and fixture, not a verdict.
- **The limitation:** reviewers could not drive a browser. The coordinator walked each lens's
  world in the production build, and reviewers judged those captures, labelled [B].
- **Reproduction:** every finding was reproduced or its label kept before it was classified.
  - Two blockers: by a failing test and an HTTP sweep, and by code plus screen.
  - Three data findings: on a scratch database (§5).
  - The rest: kept at the label their reviewer gave.

## 4. Findings and their disposition

Release blockers, per the mission: wrong dollars, wrong campaign or decision, misleading approval
state, unauthorized evidence on a supported path, broken core journey, non-reproducible startup.

| Id | From | Finding | Label | Class | Status |
|---|---|---|---|---|---|
| R1 | Authorization lane F-1 | A brand-level answer check was readable by every scoped viewer: an empty stored scope is inside every scope | [S] | **Blocker** | Fixed in `97a0e18` (§6) |
| R2 | Analyst lane F1 | The incident said the channel's "recorded spend is zero": while held, no record is not $0; once verified, false | [C][B] | **Blocker** (missing ≠ $0 is an explicit acceptance criterion) | Fixed in `91ef06f` (§6) |
| R3 | Data lane F2, F3, F8 | Off-path wrong results: an overlapping successor; a refused newer revision; a reformatted fetch time | [S] reproduced | Not on the demo path | Before real data (§5) |
| R4 | Lens B F3, authorization lane F-6 | 30 of the 61 swept routes carry no B09 evidence even for the analyst (e.g. `/api/cases/161` is POST-only: 405 for everyone), so their refusals prove nothing. Refused pages return 200 (R-33) | [S] | Evidence caveat | Stated here; a refused POST is in P5 |
| R5 | Lens B F1, authorization lane F-4 | The walkthrough, sweep, ledger and delivery tools live in `C:/Temp`; another engineer cannot rerun them from the commit | [C] | Not a blocker: startup and the README demo path reproduce | Limitation (§10); in-repo equivalents named there |
| R6 | Lens A F1, analyst lane F8 | Verified Decision Lab: three readiness phrasings, #970's reason cut at 140 characters, no named reviewer | [B][C] | Nonblocking: "It is not an approval" is on the card | Backlog: the most valuable product improvement (§8) |
| R7 | Lens A F2–F6; analyst lane F2–F7 | The verified headline names Search, not Local Services; the KPI tiles under B09 are company-wide without saying so; the red gap marker and "Data as of 8:00 AM" after verification; only half of the remaining dates one click away; mismatches give no likely cause; the stale header explanation; status shown by colour in places; September $0.00 for a then-new campaign; a second primary in Fix & approval [C]; a keyboard-unreachable weekly table | [B][C] | Nonblocking | Backlog |
| R8 | Coordinator | After assigning and reloading the incident, Decision Lab's incident link lands on `…#recovery#recovery`. Seen in 4 of 4 walks (desktop, missing state); the page works | [B] | Nonblocking | Backlog; cause not proven |
| R9 | Data lane F1, F4–F7; lens B F6 | A future-dated row hides every gap; a future fetch locks a day; a full regression wipes stored verifications; two incidents on one channel; a re-map credits the original runs; a day's and its campaign's channels can diverge | [C] | Not on the demo path | Before real data |
| R10 | Authorization lane F-2, F-3, F-5; lens B F2, F4 | Audit names roles, not people; a manual reconcile is unattributed; assignment takes no reason; a shared-id contradiction reaches no owner (the guard is kept, as the mission says); tests share the demo database and port | [S][C] | Nonblocking (demo roles: R-2, R-22) | Backlog |
| R11 | Authorization lane, recheck of R1 | An answer check's stored scope is what it read, not what it names. A check that read nothing, because everything it named is outside the runner's scope, stores an empty scope, which every scoped viewer can list: a branch partner's answer naming Moxie and B09 would reach the Joshua's lead. A fifth named branch is not read (`MAX_BRANCHES` is 4), so it is not stored. A company-wide snapshot naming an unknown brand stores an empty scope. Each exposes text someone entered, never a figure the product read | [C]. No stored check in the demo or walk databases has an empty scope [S] | Nonblocking: no product evidence, and off the demo path | **Fixed after the decision** in `28e498b` (§9; R-57) |

## 5. Wrong results off the demo path (reproduced, not fixed)

Each ran through the ads feed's polling path on a scratch database (`bive/data-integrity-repro.json`).

| Case | What the product said | What was true |
|---|---|---|
| Successor started Oct 10, three days before the stop; only the window re-fetched | Verified; "Reclassified, not added: $3,743.19…"; decision trustworthy | 61,221¢ of the successor's Oct 10–12 spend still filed as Search |
| A newer Oct 20 revision refused (fractional conversions) | Decision trustworthy, no blockers. The quarantine item has no branch | Oct 20 stays the older 20,740¢; the source now says 40,000¢ |
| The same correction re-sent with `.000Z` in its timestamps | 13 new versions, "13 changes" | The same instants: a retry, which should be duplicates |

So "Reclassified, not added" and a trustworthy B09 decision are proven for the B09 case. They are
not proven in general.

## 6. Repairs: one round, two blockers

| | R1: answer-check scope (`97a0e18`) | R2: "zero" (`91ef06f`) |
|---|---|---|
| Failing case kept | `shadow-mode.test.ts` (failed before: the partner listed check #1). HTTP sweep on the old build: 6 leaks, all this check (`bive/route-sweep-old-build.json`) | The sentence at `components/CoverageGap.tsx:158` |
| Narrowest fix | A check's stored scope = every branch it read, including all of a read brand's branches. Migration 0032 repairs stored rows | The sentence follows the state: no record "for some or all of those dates" while held; "now re-filed and verified" once resolved |
| Original failure rechecked | Test passes. New build: 0 of 122 restricted requests leak | `bive/incident-copy.json`: held and resolved sentences rendered by the new build |
| Neighbouring case | A check on the partner's own branch stays theirs. Snapshot checks unchanged. The analyst still receives B09 evidence on 31 routes | **Correction:** the commit message's "no other view calls missing spend zero" is wrong. The daily evidence's month comparison prints $0.00 for a month with no record, beside a "new"/"gone" badge (analyst-lane F4, nonblocking, R-56) |
| Independent recheck | Lens B, on `91ef06f`: "0 leaks in 122 restricted requests. The old build leaked … 97a0e18 fixed it." The authorization-lane reviewer, on `91ef06f`: **fixed** on all three read paths (list, detail page, API), which share one visibility rule; nothing else reads `shadow_checks`. Migration 0032 touches only answer checks, and a second run changes nothing. Neighbours hold: a check naming a branch and a brand stores both; a refused brand is not read. Two gaps remain, both code-inspected and both text only (R11):<ul><li>a check that read nothing stores an empty scope, which every scoped viewer can list;</li><li>a fifth named branch is neither read nor stored.</li></ul> | The analyst-lane reviewer, on `91ef06f`: **fixed** in the missing and verified states (both rendered) and in the partial state (code-read: Oct 13–25 have no record, so "some or all" holds). Edge cases off the B09 path stay (R-56):<ul><li>the sentence follows the incident's open or resolved status, not the gap's own state, so a resolved gap that is historical or unverified would still read "re-filed and verified";</li><li>a held date that recorded $0.00 would be called "no spend record";</li><li>a gap with nothing filed would read "$0.00 is filed as …" (`GapRecovery.tsx:76`).</li></ul> |

A second round was not needed. Both rechecks confirmed their fix. The gaps they found next to it are nonblocking (R11; R-56).

## 7. The main B09 workflow, walked

| Step | Where | Result |
|---|---|---|
| A. Detect | Lens A, desktop and 390, plus 320 reflow | Pass. "no spend record" vs "recorded $0"; week vs window. At 320, no page-level sideways scroll; wide tables scroll inside named regions |
| B. Investigate | Lens A | Pass. Daily evidence → incident: dates, branch, channel, owner role, one next action. Assignment from the incident's Owner control; history on the case timeline |
| C. Correct partially | Lens A, run #676 | Pass. 5 of 18; the same incident held; Decision Lab names Oct 13–Oct 25 |
| D. Verify fully | Lens A and B, run #677 | Pass. 18 of 18; $2,123.52 moved Search → Local Services; total, customers and cash unchanged; same incident and case; the verification names #677 and #676 |
| E. Trace and return | Lens A and B, release walk | Pass. Stored / accepted / used told apart on the run row; one Back; context and open details kept; keyboard-only path too |
| F. Decide | Lens A and B | Pass. Hold cleared; #970 and the door-to-door conflicts named; no approval implied |
| G. Durability | Release walk and lens B | Pass. Reload; duplicate #678, older #679, other-metadata #680: no money, case, recovery or campaign change |

States checked:
- **Loading:** a labelled placeholder (`role=status`, `aria-busy`, "Loading…") is streamed on
  the daily evidence, the incident and Decision Lab.
- **Empty:** "No audit rows match these filters."
- **Held, partial, verified:** as above.
- **Unavailable:** an out-of-scope incident is a 404 by design (the page does not confirm it
  exists); Decision Lab "403 · not in your scope"; Integrations "limited to company-wide roles".
- **Colour:** status words were checked under forced colours.

Results:

| Walk | World | Checks |
|---|---|---|
| Lens A | `revenue_signal_bive_a` | 231 of 231 |
| Lens B | `revenue_signal_bive_b` | 68 of 68 |
| Release walk | `revenue_signal_rc_b09` | 230 of 230 |

## 8. The two reviews, written apart

### Review A: would this help the marketing team decide? (lens A reviewer)

- **Strongest moment:** `partial-2-daily-evidence-desktop-1280.jpg`. "All 5 days have a spend
  record: $597.17" sits directly above "the window (Oct 13–Oct 30) is not: Oct 13–Oct 25 still
  have no Google Local Services spend. The decision stays held."
- **Most confusing moment:** `verified-5-decision-lab-desktop-1280.jpg`. The card uses three
  readiness phrasings, and #970's reason is cut at "…spend not…" (R6).
- **What an analyst can correctly say:**
  - **Missing:** "B09 shows no Local Services spend after Oct 12. But $2,123.52 under its Local
    Services Performance Max campaign is filed as Google Search, and 45 Local Services leads kept
    arriving. So neither channel's cost per customer can be used, and the decision is held."
  - **Partial:** "Oct 26–30 ($597.17) is now filed as Local Services. Oct 13–25 ($1,526.35) is
    still filed as Google Search. So only 5 of 18 dates are covered, and the decision is still
    held."
  - **Verified:** "All 18 dates Oct 13–30 now carry Local Services spend. The $2,123.52 was moved
    from Google Search, not added, so B09's October total stays $16,649.23. The budget decision
    can now go to a person for review, and nothing has been approved."
- **Judgment:** demonstrable unaided, with one step a presenter must explain: the verified
  Decision Lab card. The other frictions:
  - B09 is reached through the branch list;
  - the owner is a role, not a person;
  - only Oct 12–18 is one click away in the partial state.
- **The one improvement that would matter most:** the verified Decision Lab summary. One verdict
  per channel, full reasons (why the B44 campaign bears on B09), and a named reviewing role.
- **Pilot (proposed, not measured):**
  - **What to put in front of an analyst:** one branch's apparent channel drop, then hold or act.
  - **What to watch for unaided:** whether they say "misfiled, not stopped, decision held", and
    name the remaining dates in the partial state.
  - **What must hold before expanding:**
    - their reading matches the stored facts in all three states;
    - one real report figure is checked with its owner;
    - the handoff reaches a real owner's queue;
    - at least one real gap is found that the existing report missed.

### Review B: would an engineering team trust it to operate? (lens B reviewer)

**The evidence chain** (B09, world `revenue_signal_bive_b`):
1. Runs #676 and #677 sent 59,717¢ (Oct 26–30, 13:00Z) and 152,635¢ (Oct 13–25, 13:10Z), both
   `ads@1.2`.
2. The accepted days are raw events 200015–200019 and 200020–200032.
3. Campaign 8677 has 18 `google_lsa` days, 212,352¢ in all. Its record carries the 13:10Z clock.
4. Incident 2455's verification names #677 (13 dates) and #676 (5), covering 212,352¢ on 18 of
   18 dates.
5. Case 161: detected → owner set to engineer (by marketing) → investigating → resolved
   (reconcile), never reopened.
6. B09 paid spend stays 1,664,923¢. Customers and cash are unchanged. Runs #676–#680 wrote only
   spend days.

Each link carries a reproducible SQL check in the reviewer's report.

**Three invariants:**
1. Reclassified, not added.
2. The newest fetch decides; repeats and older versions change nothing. The strongest negative
   case is #680: an older Oct 20 version with another name and Search inputs changed no spend,
   channel, campaign field, verification, incident or case.
3. Monitoring is read-only, and another platform cannot vouch for a mapping. Change #1 failed
   preflight with `LEAD_EVIDENCE_DISAGREES`; the monitoring runs wrote no mapping version.

**Safe to demonstrate now:**
- the B09 chain;
- the run outcomes #676–#680 and "Effect not recorded" for #473;
- ChangeGuard's refusal and its "certifies nothing" limit;
- role scope in fresh contexts;
- drift review and the twin, as tested simulations.

**What remains synthetic:**
- all data, with vendor mocks (R-1);
- demo roles (R-2, R-22);
- the twin, which simulates a per-branch rollout the product cannot perform (R-44, R-45).

**Before connecting real data:**
- real sign-in in place of demo roles, and page state cleared when the user changes;
- refusals that return real 403/404;
- shared-id contradictions routed to an owner;
- one rule for a day's versus its campaign's classification;
- the acceptance tooling committed;
- demo and test databases kept apart;
- the §5 counterexamples fixed;
- keyed hashing (R-5), CRM account namespacing (R-3), merge detection (R-4).

The reviewer also reported a missed Next.js security release. That is not confirmed: npm audit on
the lockfile shows no advisory for `next`.

## 9. Reconciliation and decision

**Do the reviews disagree?**
- **The headline.** Review A reads "$2,123.52 reclassified, not added" correctly. Review B proves
  it from source to screen on the B09 case. It passes. As a general claim it does not (§5): the
  record says so, and the B09 demo does not depend on it.
- **"Ready for review".** Review A found the verified card confusing: three phrasings and a cut
  reason. It did not find it read as approval: "It is not an approval" and "Nothing here approves
  a budget change." are on the same card. Review B proved the status chain. The frontend passes,
  with R6 as the first backlog item.
- **Reproducibility.** Review A found the workflow demonstrable unaided. Review B found the
  acceptance tooling outside the repo. Both hold:
  - the demo starts and runs from the written steps;
  - the in-repo browser suite and integration tests reproduce the journeys;
  - the exact walks recorded here need `C:/Temp` tools (§10).

**Decision:** **READY FOR LOCAL SYNTHETIC DEMO** at code `91ef06f` (build `-t8FhwvfYGehXmbdri6T7`).
This record and its evidence are committed on top, docs only. It is not a production release; §10
says what it does not establish.

**After the decision.** R11 was fixed in `28e498b` and verified the same way
(`RELEASE-CANDIDATE.md` §7):
- four tests that failed before the fix and pass after it;
- a fresh-context walk on the fix's build, 24 of 24;
- the full regression in the release worktree, every step exiting 0. Vitest: 937 passed plus the
  expected failure. The packs did not move. Browser suite: 125 passed, 1 skipped, 0 failed.

The accepted local demo checkpoint is now **`28e498b`**, build `Lc4HRzPXzTTju7yRCUitk`. The
decision above was taken on `91ef06f` and stands as recorded. R-57 keeps one open limit: a scope
written in a form the product does not recognize, such as "b09" or "Moxie's" alone, is not read
as naming it.

## 10. What remains, and what this audit does not establish

**Limitations kept as they are:**
- R-39: the expected failure, pinned.
- Unresolved Local Services / Performance Max lead attribution (R-46): 45 calls.
- FI-4/R-50.
- Nonblocking polish (R6–R8, R10).
- The off-path wrong results (§5, R9).
- Demo roles are a cookie. The same tab keeps what it already received; it is not erased.
- 30 of 61 swept routes prove nothing about refusal (R4).
- On `91ef06f`, an answer check is visible by what it read, not what it names, so entered text
  can be listed outside its scope (R11). Fixed after the decision in `28e498b`. Left there: a
  scope written in a form the product does not recognize, such as "b09" or "Moxie's" alone (R-57).
- The acceptance tooling lives outside the repo (R5):
  - `C:/Temp/b09-correct.ts` (deliveries);
  - `rc-walk.ts` (walks);
  - `bive-route-sweep.ts`;
  - `b09o-ledger.ts`;
  - `rc-stale-capture.ts`;
  - `bive-repro.ts`.

  The same journeys run from the repo through `tests/integration/b09-recovery.test.ts`
  (source-correction path, hand-written ledger, stale campaign fields), `run-effect.test.ts`,
  `shadow-mode.test.ts`, and the browser suite (`zz-b09-four-minute-path.spec.ts` follows the run
  link and Back).

  **After the decision:** since `23617ca`, the B09 proof itself runs from the repo with one
  command, `npm run acceptance:b09`, on its own database and server (`B09-ACCEPTANCE-RUNNER.md`;
  the recorded run is in `b09-acceptance/`). It pairs each refusal with its allowed request and
  counts the 30 routes that prove nothing apart. The lens walks and screenshots stay outside the
  repo (R-55).

**Not established:**
- production deployment;
- production access isolation or authentication;
- any live vendor integration (R-1);
- real business improvement;
- time savings, since every walk was scripted;
- that "Reclassified, not added" or "trustworthy" hold outside the B09 case;
- analyst behaviour, since no person was observed.

## 11. Three claims an unfamiliar reviewer can verify

1. **A correction moves money between channels without adding any, and the screen proves it.**
   - **The screen:** $2,123.52 moves from Search to Local Services, and B09's total stays
     $16,649.23.
   - **The records:** the chain in §8: runs → raw events → accepted days → verification → case.
   - **Check it:** run `b09-recovery.test.ts`, which uses a hand-written ledger.
2. **Stale or repeated deliveries change nothing, and each run says what it did.**
   - **Check it:** #678 says "Duplicate"; #679 and #680 say "Stored, but a newer revision was
     already accepted", and #680 leaves the campaign's name and channel alone.
   - **Tests:** `b09-recovery.test.ts` ("the campaign record follows the newest fetch") and
     `run-effect.test.ts`.
3. **A restricted demo role receives no B09 evidence on any of 61 routes.**
   - **Scope:** this is checked in fresh contexts, in page and payload. A leak found in this
     audit was fixed and proven on both builds.
   - **Check it:** the route sweep in `bive/`, and `shadow-mode.test.ts`.
   - **The limits:** demo roles are not production authentication. On `91ef06f` an answer
     check's entered text can be listed outside its scope (R11); no such check exists in the demo
     world, and `28e498b` fixes it.

The strongest claim each review verified on its own:
- **Review A:** at every B09 state, the screens let an analyst state the decision correctly, and
  nothing reads as an approval.
- **Review B:** the decision's number traces from the source's own delivery to the screen, and
  the strongest stale case (#680) changes nothing.
