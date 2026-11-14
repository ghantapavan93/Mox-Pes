# Post-release monitoring (R-30)

2026-11-12/13. Synthetic data, local only. Nothing is deployed and nothing reaches a real system.
Commits `5fd1c76` (the check), `a630c21` (the page), `665baba` (disk preflight, R-49),
`a950693` (evidence list fix found on re-review).

## 1. Checked before deciding what to re-verify

| Question | Answer |
|---|---|
| Runtime code changed after the clean-tested commit `06de2ed`? | No. Only `b6abaf6` came after it, and it changed two docs. The Twin's clean-checkout result stands; its acceptance suite was not rerun on its own. |
| Does this work touch the Twin? | Yes, once: the disk preflight changes `lib/twin/runner.ts` and `world.ts`. So the Twin's tests ran again in the full regression and the clean checkout (section 8). |
| How did monitoring work before? | Only on a click. Every run, passing or failing, overwrote `verified_at`, so a failed check refreshed the "last verified" time. Its rule counted leads by `occurred_at` since the release, so a revision of an older lead was invisible to it. A newer ChangeGuard release of the same campaign made the older change fail `still_applied` and look like a drift. |

## 2. What was built, on existing infrastructure only

| Piece | Where | Reuses |
|---|---|---|
| One check, scheduled and on request | `lib/changeguard/monitor.ts` | `readCampaignBase` and `evidenceVerdict` (the preflight's coverage rule), `campaign_mapping_versions`, `feedFreshness` + `staleReason` (the Decision Lab / Shadow Mode freshness rule), `lockReconcile` |
| Schedule | `lib/changeguard/schedule.ts`; columns on `config_changes` (migration 0027) | the business clock (`app_clock`) that `released_at` is on |
| Worker step | `lib/jobs/tick.ts`, called by `scripts/worker.ts` on every loop (`--once` for one loop) | the existing worker loop: sync jobs, event dispatch, onboarding retention, then due checks |
| Review item | an `exceptions` row of kind `mapping_drift` with its Action Center case | the existing exception queue and `syncCases`; reconciliation never resolves it (like `payload_conflict`) |
| Page | question 8 of `app/changes/[id]` (`components/changes/MonitoringStatus.tsx`) | the existing ChangeGuard page |
| Evidence | `app/changes/[id]/checks/[runId]`, read-only | the change's own scope check (`assertScope`) |
| Manual "Re-verify now" | `monitorChange` now calls the same `runCheck` | the existing API action |

Not built: another scheduler, queue, alerting channel, dashboard or approval path. The demo's
in-process sync drain does not run checks; a worker does.

## 3. The check

Four questions, each answered on every run:

| Check | Pass | Not pass |
|---|---|---|
| `still_applied` | the live mapping is the released one | moved without a release → drift; the latest mapping version belongs to another ChangeGuard change → replaced |
| `campaign_id_unambiguous` | only this campaign uses its external id | another platform's campaign shares the id (R-46) → **unknown**: nothing is certified |
| `evidence_since_release` | the campaign's own leads arrive only at branches the approval saw, with a verdict no worse than at release | a lead at a branch the approval never saw, a worse verdict (agrees → split → disagrees), or the evidence withdrawn → drift; unresolved leads that decide the answer → **unknown** |
| `feeds_current` | every lead feed that carries the campaign delivered within 36 h (same rule as Decision Lab) | stale, never delivered, or its latest run failed → cannot certify |

**A campaign's own leads (since 2026-11-13, `CAMPAIGN-PLATFORM-MATCH.md` §6).** A lead counts
for a campaign only when its own record names the campaign's platform (`v_lead_campaigns`, the
resolver the reporting uses). Another platform's lead with the same id is that platform's
campaign's. A lead whose record names no platform, two, or one with no campaign of the id is
unresolved: neither support nor a contradiction. When the answer would differ depending on
whether those leads are the campaign's, the check says `LEADS_UNRESOLVED` and certifies nothing.

Outcome precedence: replaced > mapping moved > ambiguous id > unresolved leads that decide the
answer > evidence drift > stale feed > current. Stored records that contradict the mapping are a
drift even while a feed is stale (what is stored stays true). An ambiguous id blocks both
"drift" and "current": the guard is unchanged, though another platform's leads no longer count
as this campaign's.

**What the release is compared with.** The release now records where the leads were when it was
approved (`verification.releaseEvidence`). Changes released earlier fall back to the preflight's
coverage evidence, which is what the reviewer saw.

**States shown** (`monitorState`):

| State | When |
|---|---|
| Current | the latest check (or the release, before the first slot) certified it, and no slot is overdue |
| Overdue | a slot passed 6 h ago with no conclusion (worker not running, or every attempt errored) |
| Insufficient evidence | the latest check could not certify it, or nothing ever has (a degraded release) |
| Confirmed drift | the latest conclusion was a drift, or the change is recovery required |
| Replaced | a newer ChangeGuard release of the campaign replaced it; scheduling stopped |

**Timestamps.** `verified_at` is the release verification and never moves. `last_verified_at`
moves only on "current", and not while a drift is open. An error records a run, concludes
nothing, keeps its slot and is retried an hour later.

**Schedule.** A slot every 24 h for 14 days after the release. A check that runs late covers
everything since the release; the slots it skipped are reported (`missedSlots`), not replayed.

## 4. The synthetic journey (`tests/integration/post-release-monitoring.test.ts`)

Changes go through ChangeGuard (preflight, approval by another person, release). Records arrive
through the polling ingestion path (`runStream` → `ingestRecords`). Every check runs inside the
worker's loop (`workerTick`). The business clock is moved by the test.

| Step | Input | Outcome | Last success | Review item |
|---|---|---|---|---|
| Release T0 | mon-B20 → B20; 8 calls at B20 | verified at release; slot 1 due T0+24 h | T0 | — |
| T0+23 h | — | nothing due; the worker does nothing | T0 | — |
| Slot 1 | a new call at B20; **two workers on one slot** | current; one conclusion recorded | slot 1 | — |
| Slot 2 | a revision that changes only the agent note | current (**benign**: no alert) | slot 2 | — |
| Slot 3 | no delivery for 42 h | insufficient evidence (stale feed) | slot 2 (not moved) | — |
| Slot 4 | the feed's latest run failed (503) | insufficient evidence (unavailable) | slot 2 | — |
| T0+126 h | slot 5 due at +120 h, no worker yet | **overdue** | slot 2 | — |
| Slot 5 | a revision moved call MON-5 from B20 to B19, delivered twice | **confirmed drift**: scope B19 + B20, the record and its prior version, $800 of spend at stake; recovery required | slot 2 | **created** (with case) |
| Slot 6 | the same revision delivered a third time | drift; the lead counts once | slot 2 | **same item updated** |
| Slot 7 | the check errors (its table renamed) | error, slot kept, retried at +1 h, then drift | slot 2 | same item |

In every step the mapping stayed B20 at version 2, and the source records were only those
delivered. On every branch's scorecard, the only field the drift check moved was the released
branch's open-item count (+1, the review item); spend, customers, CAC, collected and revenue at
risk did not move.

**Race with a newer release.** Change A (race-1 → B21) is checked; between the evaluation and
the record step, an approved change B (race-1 → B22) is released. The record step sees the
mapping version move under the lock and judges again:

- A is **replaced**, not drift. Nothing is certified or raised, and A's schedule stops.
- B is verified with its own slot, and B's later check is the only one that runs.
- B was approved on split evidence (6 and 6). A new lead at B21, which the approval saw, is not
  listed as contradicting; the check stays current.

Mutation: without the re-check, A recorded a stale "current" and the test failed.

**Ambiguity (the shared-id guard).** A Meta campaign starts using the Google campaign's id, and a
lead with that id lands at B05. The check says **insufficient evidence**
(`CAMPAIGN_ID_AMBIGUOUS`), lists both campaigns in the affected scope, raises no review item and
leaves the change verified. Since 2026-11-13 the B05 lead, labelled "Facebook", is the Meta
campaign's: it is not in the Google campaign's evidence, and the scope is B12 alone (it was B05
and B12 while every lead with the id counted).

**R-39 (shared-phone credit) stays open.** This check reads where a campaign's leads arrive, not
which customer a lead credits, so it cannot meet that ambiguity. Its evidence page says so.

**Mutations that turned the suite red:**

| Mutation | Tests that failed |
|---|---|
| Removing the re-check under the lock | 2 |
| Refreshing the last success on any outcome | 5 |
| One review item per run instead of per change | 2 |
| Listing approved split-branch leads as contradicting (the behaviour before `a950693`) | 1 |

## 5. Scope on the evidence

The evidence page is read-only and applies the viewer's branch scope (`redactRun`). Company-wide
roles see every row. A B20 partner reading the B20 change sees B20's rows; B19's lead, record ids
and any sentence naming B19 are counted instead ("1 branch outside your scope"). Another brand's
lead cannot read the change. The review item names only the released branch, because the
incident page and the AI tools show it wherever that branch is in scope.

## 6. Disk preflight before expensive verification (R-49)

Before a twin is cloned, the runner measures free space on the database server's data volume and
needs the copy plus 1 GB. A current base means one base-sized copy; a missing or outdated base
means twice the control database.

When space is short, it first drops finished twins of **its own** control database, oldest first
and errored ones last. It never drops the base, a running twin or any other database. If that is
not enough, it refuses with the numbers, and nothing is cloned. The measurement fails closed for
a server not on this machine. Measured here: 19.5 GB free, 390 MB needed.

The regression and clean-checkout scripts (`C:/Temp`, not in the repository) refuse below 6 GB.
The clean checkout drops only its own twin clones and its own base at the end.

## 6a. The reviewer's path and the decision summary (roadmap 4a, 2026-11-13)

**Checked first, in the production browser, on the B44/B39 drift: the path already worked, so it
was not rebuilt.**

| Step | What the reviewer clicks |
|---|---|
| 1 | Incidents → "Amount at stake by incident type" lists *Mapping drift after release* first (`$4,539 · 1 open`) |
| 2 | That filters the queue to the one case |
| 3 | The incident page links *Open check #N of change #M* |
| 4 | The check's evidence page; its breadcrumb opens the change |

No change id is needed at any step. What was missing was the last hop: from the change to the
changed lead's own record.

**Added, on the existing page and design system:**

- **A decision summary above the numbered sections.** It is built only from stored results:
  the release verification, the latest concluded check, and a fresh read of the live mapping
  (`lib/changeguard/summary.ts`, `components/changes/DecisionSummary.tsx`). It shows:
  - the release verdict, and the lead evidence it was approved on;
  - the latest check's verdict and time;
  - what changed in the evidence, for example "Call … was revised at the source: it now arrives
    at B39, a branch the approval did not see (it was B44)";
  - what the system did not change: the live mapping and its version, read now, and that no
    check edits spend, customers, credits or source records;
  - one next action for the viewer's role.
- **A caution, whenever the evidence moved,** that one changed lead does not show the mapping is
  wrong. It says how many of the campaign's leads still arrive at the released branch, and that a
  revision can be a source correction. Nothing in the summary suggests a remap.

**The next action, by role** (B44/B39):

| Viewer | Action |
|---|---|
| Analyst, engineer, approver | primary **Review the changed lead** → the lead's own customer or prospect page, scrolled to that lead's row; its *raw #…* button shows both stored versions (B44, then B39) |
| Guest (read-only) | the same page as a plain link, **Read the changed lead**; no primary action, no change buttons |
| A viewer whose scope excludes the lead's branch | **Read the evidence** (redacted); the lead is counted, not named |
| Engineer, when a check is overdue | **Check the worker** (Audit & Health) |
| Other roles, when a check is overdue | a hand-off sentence: "This is not a drift" |

**Overdue stays apart from drift.** An overdue check has its own state, tone (warning) and clock
icon. When a drifted change's next check is also late, the summary keeps the verdict ("Confirmed
drift", error tone) and adds a separate chip: "Next check overdue … A missing check, not a new
finding."

**Wording.** "Recovery required" now says that a person reviews the evidence first, and that a
compensating change is one possible outcome, not the default. The incident's explanation says a
contradiction is not proof that the mapping is wrong.

**Also:**

- The check's evidence page links each contradicting lead to its record, where the viewer's
  scope allows.
- The ChangeGuard browser spec now waits for its preflight and release requests (R-20's
  pattern): a release took 4.8 s once and raced the 5 s assertion.

**Tests:**

- Integration: two cases.
  - The summary for every role on the drift: the exact sentences, the action and its target, the
    redaction for the B20 partner, and drift plus a late check.
  - On the race scenario: current (no action), overdue (engineer vs analyst), and replaced.
- Browser (production build), one journey: Incidents → by type → the case → *Open check* → the
  change, by breadcrumb → the summary (above question 1) → *Review the changed lead* → the record
  row → its two stored versions. Then:
  - at 390 px: no sideways scroll on the change and the record, and axe clean;
  - as guest: read-only, the record still opens;
  - with the clock 79 h after the release: the drift verdict plus a separate overdue chip.

## 7. What remains unknown

- **No real feed or worker.** The cadence (daily for 14 days, overdue after 6 h) is a choice, not
  a measured need. Overdue is computed when a page is read; no one is notified.
- **The evidence rule is conservative.** Any lead at a branch the approval never saw is a drift.
  A campaign whose calls naturally spill into a neighbouring branch will alert; a person then
  acknowledges it.
- **The held-out runner's FI-4 counts the review item.** The runner applies FI-4 ("no branch's
  scorecard changes") to monitor steps too, which `SCORING.md` does not list. In HO-45, the drift's
  review item moves B05's open-exception count, so the runner now reports a critical-labelled FI-4
  finding there. No money, customer, mapping or raw-event value moved. The runner was left
  unchanged; R-36 asks for a ruling.
- **Ambiguity is detected for one case.** It is detected when another campaign on any platform
  shares the external id. Leads without a campaign id are not this check's evidence at all.
- **The demo's clock is frozen,** so in the demo a slot never comes due unless the clock is moved
  (the browser spec does this, then restores it).

## 8. Results

**Focused, first** (`post-release-monitoring`, the three `changeguard*` files,
`twin-disk-preflight`): 62 passed.

**Full production regression** on `665baba`, in the main checkout (`C:/Temp/final-regression-r30.sh`):

| Check | Before (`23aad50`) | Now |
|---|---|---|
| Disk preflight (≥ 6 GB) | — | pass |
| Typecheck, lint | pass | pass |
| Vitest | 808 passed + 2 expected fails, 67 files | **826 passed + 2 expected fails, 69 files** (+14 monitoring, +4 disk) |
| AI evaluation | 15/15 | 15/15 |
| Investigator held-out | 61 pass, IV-16 by design | same |
| ChangeGuard held-out | 30 pass / 18 fail / 2 invalid | same counts; **one new critical-labelled finding in HO-45** (FI-4, the review item; section 7, R-50) |
| VP acceptance | 509 checks, 16 failed, 11 critical | identical: no scenario's findings differ |
| Shadow acceptance | 320/320 | 320/320, repeated identically |
| Build | pass | pass |
| Browser suite (`next start`) | 111 passed, 1 skipped, 1 failed | **113 passed, 1 skipped, 0 failed** (31.5 min) |

After `a950693` (the evidence-list fix): focused tests 62 passed again; the ChangeGuard and
monitoring browser specs passed on a rebuilt production app (3 tests). Screenshot check of
change #2 on the demo world after the spec: Confirmed drift; verified at release Oct 31 1:00 PM;
latest check Nov 2 1:05 PM; last success Nov 1 1:05 PM; next slot Nov 3; incident open.

**Clean checkout** of `a950693` (fresh worktree, `npm ci`, new databases, its own twin base
built from scratch, `C:/Temp/rso-verify-run.sh`):

| Step | Result |
|---|---|
| Disk preflight, worktree, `npm ci` (38 s), migrate, seed (61 s) | pass |
| Typecheck, lint | pass |
| Vitest | 826 passed + 2 expected fails, 69 files (953 s) |
| Build | pass |
| Browser suite | 112 passed, 1 skipped, **1 failed**: the B09 four-minute path. Its page snapshot shows the Overview still `Loading…` when the 5 s assertion ran; the hold and its incident (#2455) were already in the guide. Rerun three times in the same checkout: **3/3 passed**. A known load-time issue (R-34), not this change: nothing here touches the Overview. |
| Own-resource cleanup | dropped exactly `rso_twin_verify_base` and its two clones; the main checkout's base and twins and every other database stayed |

Free disk on C: afterwards: 18 GB.
