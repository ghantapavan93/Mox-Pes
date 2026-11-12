# VP acceptance report: the war room

Revenue Signal OS, branch `feature/audit-enterprise-redesign`, 2026-11-12. Everything ran
locally on synthetic data. Nothing was pushed or deployed. No live Moxie system was touched,
and no AI accuracy or business outcome is claimed beyond what the evidence below measured.

This report answers the mission's Phase 8 (scorecard) and Phase 10 (the 14 questions). An
independent, read-only review of the first draft, the evidence and the code is in
[`vp-acceptance/evidence/INDEPENDENT-REVIEW.md`](vp-acceptance/evidence/INDEPENDENT-REVIEW.md).
Its verdict was **accept as a proof-of-work demo, not the report as written, and not as
financial correctness on real data.** It found an open money defect (one paid call credited
every customer sharing its phone; now fixed), two runner defects (one under-reported severity),
four invariants that could never fail (removed or replaced) and several overstated sentences.
This version is corrected; the review's text is kept unchanged.

## Evidence index

| Deliverable | Where |
|---|---|
| Frozen adversarial scenario pack (12 scenarios, 509 checks, sha256 `0dd8a0bf…a3ac`) | [`vp-acceptance/scenarios.v1.json`](vp-acceptance/scenarios.v1.json), [`FREEZE.md`](vp-acceptance/FREEZE.md) |
| First-contact result, unchanged | [`vp-acceptance/evidence/first-contact.txt`](vp-acceptance/evidence/first-contact.txt) |
| Adjudication of every first-contact failure | [`vp-acceptance/evidence/ADJUDICATION.md`](vp-acceptance/evidence/ADJUDICATION.md) |
| Regression runs after the fixes (labelled as regression) | `vp-acceptance/evidence/after-changes-1.*`, `after-changes-2.*` |
| End-to-end browser suite | `tests/e2e/*.spec.ts`; the persisted-effect journeys in `tests/e2e/zx-vp-journeys.spec.ts` |
| Frontend task-completion findings | [`vp-acceptance/evidence/UX-FINDINGS.md`](vp-acceptance/evidence/UX-FINDINGS.md) |
| Reproducible failure cases | `tests/integration/vp-acceptance-regressions.test.ts`, `fault-injection.test.ts`, `metamorphic.test.ts` |
| Performance and recovery | [`PERFORMANCE.md`](PERFORMANCE.md) and the table under dimension 8 |
| Limitation register | [`REMAINING-RISKS.md`](REMAINING-RISKS.md) (R-1 to R-36) |

## How first contact was kept honest

An independent agent wrote the 12 scenarios from a brief, blind to the code. The pack was
hashed and committed before the runner met the product. The first run was committed as it
came out: **35 of 509 checks failed; 22 critical under SCORING.md** (the runner labelled 17,
because it capped readiness and release-state failures at "high": a runner defect the
independent review found). Each failure was then read against the brief and the designer's
reference: 19 were product defects (fixed, each with a regression test) and 16 were
disagreements where the product was kept. Five disagreement groups need a human ruling (R-36).
Every later run is labelled a regression run, because the pack has since been used to improve
the code and is no longer held out. (509 is the runner's count of checkable expectation fields:
each metric, outcome, class, status, hypothesis, `mustState`, `forbidden` and `mustNotMention`
entry. The designer counted 480 expectations in FREEZE.md by another rule; 509 is the
denominator used throughout.)

## Scorecard (Phase 8)

There is no overall percentage. Severity stays visible: one false certified financial claim or
one unauthorized release would outweigh everything that passes.

### 1. Financial correctness

| | |
|---|---|
| Tests performed | Property tests over 12 seeded random worlds against an independent reference calculator; metamorphic relations (refund delta, order independence, idempotent redelivery, newest version wins, locality); browser journey J2 (B09 collected cash against a reference written separately from the payment payloads in the raw ledger: independent of the cash SQL, but it shares the ledger's contents, its quarantine status, the last-delivered rule, the branch table and the period cut, so it catches projection bugs, not intake or ordering bugs); J5 (a new refund delivered through library intake); VP pack money checks (VP-03 cash to the cent, VP-10 currency, VP-11 refund-heavy months) |
| Passed | Metamorphic file 36/36; J2, J5; VP-03 38/38, VP-11 31/31, VP-10 48/49 |
| Failed, then fixed | **One paid call credited every customer sharing its phone** (found by the independent review; red test: 3 paid customers where 1 was right). Fixed in migration 0022; the attribution trace now carries an invariant that fails if it recurs (R-39) |
| Disputed | VP-06's 8 checks: the label moves an October acquisition when the customer's CRM office later changes; the product keeps it at the branch that did the service (ADJUDICATION; R-36) |
| Unsupported | Spend in a currency other than USD is refused; spend with no stated currency is held until a two-person rule authorizes it |
| Not tested | Real FieldRoutes data (R-1); merged or deleted CRM customers (R-4) |
| Critical findings | First contact: spend authorized under a currency rule landed as unallocated, not in B16, and its customers stayed out (VP-10, 5 critical checks). Fixed |
| Known limitations | Currency rules are undated (R-28); the period "October" is Oct 1–30 |
| Improvement after repairs | VP-10 7 failed (6 critical) → 1 (0 critical; the guest-access disagreement); VP-11 1 → 0 |

### 2. Data integrity

| | |
|---|---|
| Tests performed | Fault test 1 (a connection killed mid-ingest), redelivery and ordering relations, VP-02 (a messy batch: unreadable, duplicate, outbound and spam records), VP-06 (spam marked then unmarked), J5's redelivery |
| Passed | All four fault tests; VP-02 28/28; J5 (a redelivered refund is absorbed: one payment row, delivery count 2, the figure unchanged) |
| Failed (open) | None |
| Not tested | Vendor-side loss: CallRail does not resend webhooks (R-16) |
| Critical findings | None at first contact in this dimension |
| Known limitations | Payments and calls are ordered by receipt, so a late duplicate of an older payment state becomes current again (R-37); hashing is not anonymisation (R-5); one CRM account assumed (R-3) |

### 3. Unauthorized-action prevention

| | |
|---|---|
| Tests performed | VP-07 (a branch partner and a brand user probe across scope); J6 (out-of-scope reads and writes, then a database check that nothing was stored); fault test 2 (two releases of one approved change at the same moment, with a row lock held and the second waiter observed); the ChangeGuard held-out set; self-authorization of a currency rule (VP-10) |
| Passed | VP-07 51/51; J6; fault test 2 (applied once, money moved once); ChangeGuard held-out (a regression suite now): 30 of 50 match every expectation, 0 false approvals, 18 adjudicated disagreements (mostly `monitoring` vs `verified` and false blocks HO-14/18/25), 2 invalid scenarios (HO-33, HO-44: they depend on a remap the older path refuses; `CHANGEGUARD-HELDOUT.md`) |
| Failed (open) | None |
| Critical findings | UX red team P0-1: `/demo` showed B09's incident figures to roles outside B09. Fixed and now covered by J6 and the accessibility gate |
| Known limitations | Demo authentication: any visitor can pick any role (R-2, R-22); a refused page returns HTTP 200 with a 403 body (R-33) |

### 4. Grounded AI claim quality

Deterministic (template) mode only. **No model-backed run was made: there is no API key, so
model-backed quality is unverified** (R-10).

| | |
|---|---|
| Tests performed | Investigator held-out set (62 cases; now a regression suite); proof engine and claim reading; VP pack AI steps (VP-01, VP-04, VP-09, VP-12: false premises, hostile text, requests to act) |
| Passed | Held-out set (regression now): 32/32 outcomes; claims 136/138 judged correctly, 75/75 wrong claims rejected, 0/60 false accepts in critical cases (the two misses are IV-16's definition paraphrases, rejected by design). `eval-ai`: 15/15. Shadow Mode answer checks: 31/31 labelled claims after fixes (see the Shadow Mode section) |
| First contact (held out) | 20/30 correct outcomes; 26 of 57 critical claims falsely accepted |
| Failed (open) | IV-16, rejected by design (claims 136/138 at the last run) |
| Unsupported | Model text is designed to be rejected when any part is unread, but no model ran, so that path is tested only on fixed strings |
| Critical findings | First contact: questions about a change in CAC got neither month, or both months merged; a budget-move request was answered instead of refused. Fixed, but the refusals are patterns keyed to wordings like the scenarios'; rephrasings are not tested |
| Known limitations | Template claims are trusted unless contradicted (R-38); the closed reading is a list of patterns (R-27); confidence is not calibrated (R-18); VP-12's prompt-injection checks ran where no model exists to be injected |

### 5. End-to-end workflow completion

| | |
|---|---|
| Tests performed | The full Playwright suite on a production build; eight journeys (below) |
| Passed / failed / skipped | Clean checkout of `fb06e57` (fresh worktree and databases, production build, pixel baselines on): **111 passed, 0 failed, 1 skipped** in 26 min. An earlier run in the working copy had 4 failures: two Overview baselines (the intended headline change; regenerated) and two timeouts while other suites loaded the machine (R-41) |
| Journeys | J1 CAC trace → investigation → ChangeGuard → verified (`zy-evidence-journey`); J2 finance cash against raw payloads; J3 a false premise answered as one, every re-test kept; J4 a wrong mapping blocked, corrected, approved by another demo role, released (`zzz-changeguard`); J5 a new refund delivered through library intake, and its duplicate absorbed (not a corrected existing record, not a late older version); J6 scope and permission, with database checks; J7 incident dry run → approve → execute (`os-golden-path`, `zz-b09-four-minute-path`); J8 executive: readiness → a projection that stores nothing → a saved, audited scenario |
| Persona completion | 3 completed, 3 partly, 1 found a leak (first walkthrough; not repeated after fixes) |

### 6. Frontend accessibility and usability

| | |
|---|---|
| Tests performed | axe-core WCAG 2.2 AA plus best practice on 23 pages × 4 widths; page-level overflow; page titles; a keyboard-only path; the AI persona walkthrough |
| Passed | 0 axe violations (automated checks only; not a WCAG conformance claim), 0 sideways scroll, every page titled; keyboard path passes |
| Failed (found, then fixed) | The 403 view had no h1; every page had the same title |
| Not tested | **Any human usability session.** Nothing here shows business users find it intuitive (R-35) |
| Open | UX-FINDINGS lists 14 open P2s and one open P1 (mixed dry-run scopes) |

### 7. Failure recovery

| | |
|---|---|
| Tests performed | Fault tests 1–4 (test 2 waits on observed lock waiters; test 3 does not, it shows the next reconciliation catches up); VP-08 (a partial outage: stale ads and calls feeds, delayed and duplicated deliveries); a 100,000-row load whose loader process was killed and restarted (PERFORMANCE.md §3; not a database failure) |
| Passed | All four fault tests; VP-08 19/19; the restart resumed with exact totals |
| Not tested | A database failover; a vendor outage longer than the demo's history |
| Known limitations | Post-release monitoring runs only when a person asks (R-30); nothing is rolled back automatically, by design |

### 8. Performance

Demo database on one laptop, `fsync` off unless stated, medians of repeated calls.

| Path | Median |
|---|---|
| Branch rows (all 44) | 588 ms before migration 0024; **769 ms after** (the one-lead-one-customer rule adds indexed lookups per candidate lead; 7 runs) |
| Company totals | 933 ms |
| Paid-CAC / cash / attribution trace | 727 / 684 / 671 ms |
| Reliability signals | 903 ms |
| Verified readiness | 2.9 s |
| Investigation workspace | 3.6 s |
| Decision Lab page / Overview page (over HTTP) | about 4.3 s / 3.3 s |
| Bulk backfill, 1M rows durable | 5,604 rows/s (PERFORMANCE.md §2) |

The Decision Lab is slow because its A/A self-check recomputes on every load (R-34). None of
this was measured on production-class hardware.

### 9. Independent reproducibility

| | |
|---|---|
| Tests performed | The pack's hash freeze; a manifest per run (scenario hashes, commit, mapper versions, Node, Postgres); `--twice`: every scenario re-run in a fresh database and its outcome fingerprint compared; a clean checkout of the final commit into a new worktree with new databases |
| Passed | 12/12 scenarios repeated with the same outcome, in one process on one machine (repeatability, not determinism across environments; the fingerprint now covers every step's observed output); clean checkout of `fb06e57`: install, migrations, seed, typecheck, lint, vitest 751/751, build and the browser suite (111 passed, 1 skipped) all passed, on the same machine |
| Known limitations | One AI designer wrote the pack, and the runner and the system share an author (R-36). Five disagreement groups need a human ruling. The run needs a local Postgres; no second machine was used |

### 10. Business decision usefulness

| | |
|---|---|
| Tests performed | Decision Lab verified readiness (VP-09); J8; the investigation workspace's six hypotheses (VP-01, VP-04) |
| What it does | Says whether a budget decision is ready, and why not, with each reason linked to its evidence; projects a budget shift with stated assumptions and a sensitivity range; stores a scenario only when a person saves it |
| Not measured | **Any business outcome.** Every release says "Measured business improvement: not measured". No revenue or CAC improvement is claimed |
| Known limitations | The workspace is not aged out (R-29); scenarios B and C stop at hypothesis (R-11) |

### Measured change after repairs

| Measure | First contact | Now |
|---|---|---|
| VP pack failed checks (critical under SCORING.md) | 35 (22) | 16 (11), all adjudicated disagreements; 3 of the 11 are the disputed release state |
| UX P0 findings open | 1 | 0 (plus P0-2, by design in the demo) |
| UX P1 findings open | 9 | 1 open, 1 partly fixed |
| Pages in the accessibility gate | 21 | 23, 0 violations |

## Shadow Mode: checking another system's figures and answers (governing mission, M1)

The next slice the governing mission asked for, built on the existing proof engine, traces and
scenario runner (`SHADOW-MODE.md`; capability map in `CAPABILITY-MATRIX.md`). Another reporting
system ("Atlas BI", synthetic) publishes a metric snapshot or a conversational answer; the
product says whether it holds, with proof references, and changes nothing in either system.

| | |
|---|---|
| What it decides | For a figure: NOT_DETERMINABLE, INCOMPATIBLE_DEFINITION (not an error: a different measure), INCOMPLETE_EVIDENCE (even when values agree, since both may miss the same records), then MATCH or MISMATCH to the cent, naming the numerator, denominator or a later revision. For an answer: each claim SUPPORTED, CONTRADICTED, UNSUPPORTED (causes, invoiced amounts, other months) or OUT_OF_SCOPE (not read) |
| Independent oracle | A blind 12-scenario pack written from the contract alone (`shadow-acceptance/`), frozen before the runner could execute it: 80 snapshots and 31 labelled claims; 37 expected MATCH and 17 expected SUPPORTED, so refusing everything fails it |
| First contact | **5 of 320 checks failed, 2 critical**: unreadable ad records dated inside the window were missed because intake stores them with their receipt time, so agreeing figures were certified MATCH. Also a month outside Sep–Oct read as October, and a dimension misnamed. All fixed with tests that failed first (`shadow-acceptance/evidence/ADJUDICATION.md`) |
| After the fixes (regression) | 320/320; every scenario repeated with the same fingerprint |
| Browser | J9: the figure entered right and a dollar off gives MATCH and MISMATCH; an answer's three claims get three verdicts; three append-only rows with actor and audit; a partner gets 404. Both pages in the accessibility gate |
| What else it caught | The proof engine's month blind spot (shared with the investigator) and a raw-number reason ("the cited fact is 17515" for $17,515.00) |
| Limits | The contract and the code have one author; the designer followed it literally and listed ten assumptions. UTC days, September–October 2026 and USD only. Deterministic reading only; no model. The "other system" is synthetic; nothing here touches MoxieBI or any real report (R-40) |

## The 14 questions (Phase 10)

**1. Can I trust this financial number?** Only as far as its trace, and the trace shows
consistency more than correctness: it recomputes paid CAC, spend or collected cash from the
same stored tables the scorecard reads and says whether the two agree to the cent. Invariants
that can fail are shown with it (every refund names a stored payment; no payment is refunded
beyond what it paid; no credited lead also matches another customer). Correctness evidence is
separate: property tests against an independent calculator, and J2 against a reference written
from the raw payment payloads. The review found a real defect the traces could not see (shared
phones), now fixed. It is synthetic data: trust in real numbers needs R-1 closed first.

**2. How can I independently reproduce it?** Open the trace: it lists every payment, refund,
campaign and customer behind the figure, with its definition version. For a whole scenario,
re-run the pack: `npx tsx scripts/eval-acceptance.ts docs/agent-work/vp-acceptance/scenarios.v1.json out.json --twice`.
The output's manifest names what must be held fixed, and the repeat must match.

**3. What happens when source data disagrees?** It is kept, not overwritten silently. For ad
spend and CRM records that carry an update time, the newest version wins; payments and calls
carry none, so the last one received wins (R-37). Older versions stay in the raw ledger. A lead
that matches two customers credits neither until a reviewer decides. Disagreements become
exceptions with the money at stake (unmapped spend, a lead and its CRM branch disagreeing,
spend in an unstated currency). Spend the system cannot attribute is shown as unallocated, not
spread.

**4. What does the AI actually know?** Only what its fixed, read-only tools return, within the
viewer's role and branch scope. Each claim is checked by code against typed facts from those
tools. Only template mode ran: a template claim stands unless something contradicts it
(R-38). Model text is designed to be rejected when any part is unread, but no model ran.
Source notes are treated as data: VP-12's hostile campaign names and notes were ignored and
logged, though no model was present to be injected.

**5. What could make its conclusion wrong?** Missing data it cannot see (a feed that never
arrived), a hypothesis outside the six it tests, a sentence shape the closed reading does not
cover (R-27), and stale workspaces (R-29). The workspace lists, for each verdict, what would
change it.

**6. What prevents an unsafe action?** The AI has no write path: it can only draft a proposal.
Every change is previewed on the real write path, and a different subject must approve it
against the hashes they saw. In the demo that subject is a role any visitor can pick, so this
is a code control, not an authentication boundary (R-2, R-22). Release is applied once under a
lock (fault test 2). Scope is re-checked on the server for every action (J6, VP-07). The pack's
approvals always used the stored hashes, so a mismatched review was not exercised there.

**7. What happens after approval?** For an incident fix, nothing until an approver executes it
once. For a mapping change, release applies it and checks it in the same transaction: a failed
"applied" check aborts the release; spend that did not move exactly leaves it live as
`degraded`. `verified` therefore means "verified at release". Monitoring compares new evidence
later, only when a person asks (R-30).

**8. Can the system recover from a real failure?** From the failures that were injected: a
killed connection commits nothing and the retry ingests once; a double release applies once; a
revision during reconciliation is reflected on the next run; a 100,000-row load resumes after a
crash with exact totals. Failover and long vendor outages were not tested.

**9. Can a nontechnical employee complete the task?** Not shown. The AI walkthrough's
nontechnical persona completed it only partly, before the fixes. No human study was run (R-35).

**10. How would this integrate with existing CRM, BI, data engineering and operational
tools?** Through contracts, not replacement. Intake takes vendor-shaped records through
versioned mappers (FieldRoutes, CallRail, Google, Meta, Microsoft shapes; all mocks, R-1).
BI reads versioned `reporting.*_v1` views. [`INTEGRATION-CONTRACT.md`](INTEGRATION-CONTRACT.md)
describes the embedded mode; it is designed, not deployed.

**11. What ongoing maintenance will this create?** Mapper versions per vendor API change;
campaign-to-branch mappings for every new campaign; currency rules per ad account; adjudicating
exceptions; keeping the frozen evaluation sets fresh (R-21, R-23); and the auth integration
(R-2). Each is a person's recurring task, not a one-off.

**12. What measurable operational benefit can be tested without inventing revenue?** Nothing
was measured here. Measurable today: dollars of spend that count toward no branch and how long
they stay that way; the share of paid customers whose first touch is evidenced; customers left
unattributed by an identity conflict and how long review takes. Time from a feed failing to
someone being told would need a notification the product does not send. "Releases without a
second person" is enforced by code, so counting it tests the code, not operations.

**13. What remains unproven?** Real vendor data (R-1), model-backed AI (R-10), human usability
(R-35), the product's judgement in five disputed groups (R-36), receipt ordering for payments
(R-37), template claims trusted by default (R-38), production performance, and any business
outcome. See the register.

**14. What should deliberately not be built?** An AI that moves budget or applies changes on
its own; unrestricted SQL for the model; automatic rollback; a replacement for the CRM or the
BI tool; a multi-touch attribution model before identity and mapping quality are proven on real
data.

## Architecture decisions made in this mission

| Decision | Why |
|---|---|
| Feed freshness is judged from sync runs; a push source without runs falls back to its received records | First contact: readiness said "fresh" while a sync had failed for days, because older records had arrived |
| Only an **authorized** currency rule settles held spend; held spend still records its campaign's identity (no money) | A proposed rule hid held spend; a campaign with all spend held could not be mapped |
| An acquisition stays at the branch that did the first service when the CRM customer later moves office | The brief's own definition of where a customer is credited (VP-06, adjudicated) |
| A change question states both months and the change; the month a question names is the month answered | First contact merged months or answered the wrong one |
| Collected cash has its own trace, read straight from the payment records, with invariants | The finance persona could not list a month's payments and refunds |
| The acceptance runner calls the real services, applies route-only permission checks itself (marked ROUTE CHECK), and records a manifest and a determinism check | So a run can be reproduced and a repeat can prove it |
| Least privilege over the brief: a guest is refused currency rules | The API already refused them; the page was aligned to the API |

## One next feature

**A read-only shadow run against one real office.** Load one branch's FieldRoutes and CallRail
exports (redacted, with Moxie's approval and data-handling agreement) through the same mappers,
nightly, and publish one reconciliation: the product's collected cash and paid-customer counts
against the CRM's own reports, to the cent, with every difference listed as an exception.

Why this one: R-1 (no real vendor data) is the largest unproven assumption, and every other
claim here rests on it. It needs no write access, changes nothing in Moxie's systems, and gives
the operational measures in question 12 on real data without claiming revenue.
