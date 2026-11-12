# Evidence intelligence: what was built, measured and left open (2026-11-12)

Implementation program over the existing product, on synthetic data only. Nothing was pushed,
deployed, or connected to a real account. Every claim below names the test or run that shows it.

## 0. Baseline and assessment

**Baseline at `08d81f9`.** Clean checkout of `518ec0d` (same code) had passed everything earlier
the same night (`changeguard-heldout/evidence/clean-checkout-518ec0d.log`). At `08d81f9`:
typecheck and lint passed, and vitest gave 556 passed and 4 failed. All four failures were in
`connectors.test.ts`, caused by my own concurrent run resetting the shared test database; that
file alone passed 39/39.

**The six workflows, traced in code.** The gap that cut across most of them was
**provenance**: a number on screen could not be taken back to the records, mappings and rules
that produced it without reading SQL. The second gap was **semantics at intake**: two
documented vendor states reached trusted tables with the wrong meaning.

| Workflow | Before this work | Main gap found | Done here |
|---|---|---|---|
| A. Export → onboarding → mapping → validation → reconciliation | Onboarding lab, versioned mappers, quarantine | Live intake let outbound/spam calls and non-USD spend through | **M0** |
| B. Source event → identity → journey → outcome | Identity resolution, journeys | Excluded leads kept identity links | **M0 review fix** |
| C. Spend → attribution → metric → decision | Scorecard, definitions, decision readiness | No way to see which records make a number | **M1 trace** |
| D. Change → preflight → approval → release → monitoring | ChangeGuard | Preview, verified effect, observation and business outcome not separated; no link to the numbers | **M3** |
| E. Discrepancy → incident → investigation → correction → verification → audit | Action Center, investigator | Investigator could state a wrong figure while citing a real record | **M2** |
| F. Question → evidence → explanation → uncertainty → recommendation | Grounded investigator (deterministic + model adapter) | No typed claims or support status | **M2** |

**Backlog, in the order done.**
1. Fix source semantics at live intake.
2. Metric evidence trace.
3. Out-of-model figure verification and a claim model.
4. Trace ↔ ChangeGuard ↔ investigator journey.
5. Independent review fixes.

**Not started**, by priority: deeper onboarding revision handling (M4), journey identity tiers
and proactive monitoring (M5), and Decision Lab materiality states (M3 remainder).

## 1. Milestone 0: source semantics at live intake

**Red-proved at live intake** (`tests/integration/source-semantics.test.ts`, failing before the
fix): an outbound call became a lead; a spam revision of a lead stayed a lead; CAD spend was
written to `ad_spend_daily` as dollars. The ChangeGuard preview had warned about these shapes
(held-out HO-24/25), but the deployed mappers still accepted them.

| Change | Where |
|---|---|
| A raw event can be **excluded**: kept as evidence with its code, never projected, not an error, no exception | migration `0018`, `MapExclusion` in `lib/adapters/contract.ts`, `lib/ingest/ingest.ts` |
| calls@1.2 excludes `NOT_INBOUND`, `SPAM_CALL`, `NOT_A_LEAD`; a later revision that marks a lead takes it out of `v_leads` (attribution, prospects, lead evidence, identity) and a qualifying revision restores it | `lib/adapters/marketing.ts`, `applyExclusions`, `v_leads` filter |
| ads@1.2 refuses any currency but USD; spend rows record `reported_usd` or `assumed_usd`; nothing is converted | `lib/adapters/marketing.ts`, `ad_spend_daily.currency_basis` |
| calls@1.2 and ads@1.2 are **active**; every earlier shape maps the same way (unit test) | `lib/adapters/registry.ts` |
| Found on the way: replay planning re-mapped from "the version before the target" instead of the version the spend is stored under | `lib/ingest/replay-plan.ts` |

Golden B09/B20 numbers were unchanged: vitest 564/564 after this milestone.

## 2. Milestone 1: metric evidence trace

`lib/lineage/trace.ts` answers "where did this number come from?" for a branch's paid CAC or
paid spend. It is a **virtual graph over the existing records**, with no second store. It
returns:
- the scorecard value, **reproduced** from the listed records and checked to the cent (a
  mismatch is shown, never hidden);
- each campaign behind the spend, with its mapping, mapping version and the change that made
  it, the mapper versions and raw events behind its spend days, and whether its currency was
  stated or assumed;
- each counted customer, with the lead and raw event that credit them;
- what the definition leaves out;
- records excluded or held at intake;
- what the number cannot see: unmapped campaigns with leads here, open exceptions, failing feeds;
- freshness, the definition version, and stated limitations;
- a period-to-period change by campaign.

The trace is reachable as:
- the API `GET /api/metrics/trace?branch=&period=&metric=[&compare=]`;
- the page `/branches/[id]/trace`, linked from the branch page's spend and CAC tiles;
- the investigator tool `getMetricTrace`.

Scope is enforced on the server, and outputs carry CRM ids only, never phones, emails or hashes.

Questions it answers:
- "Why is paid CAC $X?" — the numerator and denominator rows.
- "Which records contribute?"
- "Which mapping version assigned this campaign?"
- "What was excluded, and why?"
- "What changed since September?"
- "What evidence is missing?"
- "How would a correction affect it?" — through the linked ChangeGuard preview.

Tests: `tests/integration/metric-trace.test.ts` (10), including a negative control in which a
doctored scorecard must surface as a discrepancy. Browser: `tests/e2e/z-trace.spec.ts`. The page
is included in the axe, layout-shift and hydration gates at 1440 and 390 px, and was checked
headless at 390, 768, 1280 and 1440 px with no horizontal overflow.

On the seeded B09 incident the trace shows the mechanism without any model: `pmax-lsa-B09`'s
$2,124 of Local Services spend is filed as `google_search` by `ads@1.0`, next to the open
coverage-gap exception.

## 3. Milestone 2: claims checked outside the model

The existing investigator already had typed evidence ids, grounding (claims citing ids no tool
returned are dropped), an injection scanner, a model adapter with bounds and cost, and an
evaluation set. Added:

- **Figure verification** (`lib/ai/numbers.ts`). Every dollar amount, percentage and count a
  claim writes in figures must appear, as the same kind of figure, in the output of the tool
  calls that returned its cited ids. Facts are typed:
  - money only from `…Cents` fields;
  - percentages only from share fields;
  - counts from integers and list lengths;
  - system-written sentences;
  - never from ids, names, notes, payloads or questions.

  The summary, next step, expected effect and risks are checked against all tool output, and
  withheld when they fail.
- **Claim model** (`ClaimSchema`). Each statement is typed `OBSERVATION`, `DERIVATION`,
  `HYPOTHESIS`, `RECOMMENDATION` or `CAUSAL`, with `SUPPORTED`, `PARTIALLY_SUPPORTED`,
  `CONFLICTED`, `UNSUPPORTED` or `NOT_DETERMINABLE` and a reason. It is shown as a collapsed
  claim check on the investigation.
- The verifier **found a real investigator defect on first run**: the branch-mismatch answer
  stated its 25-row sample as the total, when 58 were open. It now states both.

**Evaluation, kept separate:**

| Set | What it measures | Result |
|---|---|---|
| Deterministic dataset `2026-11-01.1` (15 cases, development) | The investigator end to end, and the verifier's false-rejection rate on tool-derived figures | 15/15, 0 unsupported claims, evidence recall 100%. **Not held out**: the verifier's id rules were tuned on it |
| Unit regressions (`ai-numbers`, `ai-claims`) | Every bypass the independent review found | All rejected; each failed on the earlier code |
| Mocked model (`ai-investigator.test.ts`) | An invented CAC citing a real id is dropped; a causal claim is dropped; statements typed | Pass |
| **Model-backed investigation** | — | **Not run: no API key is configured.** Model-mode quality is unverified; nothing here measures it |
| **Held-out investigator set** | — | **Not built.** The ChangeGuard blind set exists; an investigator one does not |

The orchestration is the existing explicit loop: scope, tools, analyst, planner. No framework
was added, because nothing measured here needed one.

## 4. Milestone 3: one journey, number to verified correction

- A trace's unmapped campaign links to ChangeGuard with the campaign and branch prefilled.
- A preview's affected branches link to their traces.
- A change states four evidence levels separately:
  - previewed impact (a rolled-back prediction);
  - verified configuration effect (release checks on live data);
  - observed since release (monitoring);
  - measured business outcome: **always "not measured"**.
- For a CAC question, the investigator reports unmapped campaigns whose leads land at the branch
  and points to ChangeGuard rather than proposing the write itself.

**The required proof journey** (`tests/e2e/zy-evidence-journey.spec.ts`, production build, B44's
real unmapped campaign):
1. unexpected CAC;
2. trace (reproduced; the campaign is missing evidence);
3. grounded investigation (claim check, 0 rejected);
4. prefilled ChangeGuard proposal, previewed;
5. approval by a different person;
6. release, verified, with "Not measured";
7. the trace now counts the campaign at mapping version 2, linked to the change;
8. the audit history names each actor.

## 5. Independent review

Two adversarial reviewers, data/finance and applied-AI/security, worked from the code alone
and were asked for reproducible counterexamples. They found seven intake/trace defects and seven
verifier defects. Each fix has a test that fails without it (run red unless noted).

| Id | Finding | Fix |
|---|---|---|
| F1 high | Spam calls stored before 0018 stayed leads | Re-delivery applies exclusions whatever was stored; migration `0019` backfills leads |
| F2 high | Replay applied no exclusions | Both replay modes exclude and apply |
| F3 high | A held original replayed after a spam revision counted | `reapplyNewerExclusions`: the newest stored version decides |
| F4 medium | Excluded leads kept identity links | Resolution retires them |
| F5 medium | Old non-USD spend stayed summed | `0019` withdraws it to quarantine with `CURRENCY_UNSUPPORTED`; stated USD becomes `reported_usd` |
| F6 medium | Trace missed held spend | Same branch rule as the tools (payload branch, else campaign map) |
| F7–F9 low | All-time lead count; two snapshots; "to the cent" with rounded dollars | Period filter; repeatable-read snapshot; exact dollars |
| S1–S2 high | Cents read as dollars, counts as percentages | Typed facts |
| S3 high | Ids, the user's question or a campaign name could plant a figure | These are never facts |
| S4 high | Unit words, "dollars", "percent", single digits unchecked | Extracted and checked |
| S5 medium | Summary, next step, effect, risks unchecked | Checked; withheld on failure |
| S6 medium | CONFLICTED too broad yet shown as verified | Only the metric's own id; downgraded to hypothesis |
| S7 medium | Causal claim as a hypothesis passed | Dropped as `CAUSAL`; negations are not claims |

Not fixed, stated:
- The trace's "reproduced" check runs separate SQL from the scorecard, but it applies the same
  definition. It shows the two queries agree, not that the definition is right.
- A campaign id containing a "$" amount inside a **system-written** exception summary could still
  plant a money fact (text facts are taken only from summary, detail, reason and sampleError).
- Sign errors are not detected (absolute values are compared).

## 6. Architecture decisions

| Decision | Why | Rejected |
|---|---|---|
| Virtual evidence graph: set-based SQL over existing tables, typed evidence ids | No second source of truth; no copy to keep consistent; 6 queries per trace, none per record | A graph database or lineage tables: no measured need |
| Exclusion as a raw-event state plus a lead flag, filtered in `v_leads` | One filter covers every lead metric; history kept; reversible by a later revision | Deleting leads (breaks links and history); quarantining (not an error, would flood exceptions) |
| Figure verification in code, typed, from recorded tool outputs | The model is never the judge of its own numbers | A second model as verifier: no key, and not deterministic |
| Keep the existing explicit investigator loop | Already bounded (tools, turns, timeout) and tested | LangGraph or another framework: no measured benefit |
| No embeddings | Every question here is answered by relational joins | — |

## 7. Performance

- Dry run and execution: about 5 s each on the seeded world. Roughly 3 s is four all-branch
  scorecards (the proof that no unrelated branch moved), and 1 s is the reprojection temp tables.
- A single materialized pass of `v_acquisitions` saves 16% of a scorecard (identical rows),
  about 0.5 s per operation. **Not applied**: it feeds every number, and the saving does not
  change the wait (`CHANGEGUARD-HELDOUT.md`).
- **Trace** (seeded world: 44 branches, about 25k leads, 17k customers; Postgres `fsync=off`;
  5 runs each, in one repeatable-read snapshot):

  | Trace | p50 | min | max |
  |---|---|---|---|
  | B09, October | 689 ms | 674 ms | 947 ms |
  | B44, October | 736 ms | 698 ms | 964 ms |
  | B09, both months | 878 ms | 812 ms | 1123 ms |

  Most of the cost is the scorecard row it reproduces against (the same `v_acquisitions` pass as
  above). The trace page also traces September for the comparison, so it renders in about 1.5 s.
- **Investigator:** the deterministic B09 CAC investigation, which now includes the trace,
  completed in about 2.5 s over HTTP on the dev server. Evaluation latency p50 37 ms, p95 2.3 s
  (15 cases). It costs $0: no model calls.

## 8. Remaining risks (new or changed)

| Risk | Impact | What would retire it |
|---|---|---|
| Model-backed investigation never evaluated | Claims about model quality are unsupported | An approved key, data-handling approval, a held-out investigator set |
| No held-out investigator evaluation | The 15-case set is development; the verifier was tuned on it | An independently written, frozen set like the ChangeGuard one |
| Exclusion codes come only from CallRail-shaped fields | Other call platforms' "not a lead" states are unknown | Vendor documentation and a recorded payload per platform |
| Unstated currency is assumed USD (shown on every trace) | A non-USD account without `currencyCode` would be summed | A per-account currency registry |
| M4 (deeper onboarding revisions), M5 (identity tiers, proactive monitoring), Decision Lab materiality: not built | Those workflows stay as they were | The next milestones |

## 9. Final regression

On `dd1353d`, in sequence, nothing edited during the run
(`changeguard-heldout/evidence/final-regression-evidence.log`):

| Check | Result |
|---|---|
| `npm run typecheck`, `npm run lint`, `npm run build` | pass |
| `vitest run` | **593 / 593**, 51 files (was 560 at `08d81f9`) |
| Playwright, production server, `CI=1 VISUAL=1` | **72 passed, 1 skipped, 0 failed**, 17.8 min. The skip is the demo-video recording. Includes the B09 four-minute path, ChangeGuard, the trace and the new proof journey |
| Deterministic investigator evaluation (development set) | 15/15, 0 unsupported claims |
| ChangeGuard blind set rerun | 30 / 48 match every expectation (was 31). The one change is **HO-25** (CAD spend): the deployed mapper now refuses non-USD spend, so the source check blocks instead of warning. The frozen label (NEEDS_REVIEW) stays. Its author's own notes accepted BLOCK, and blocking is the safe direction (`evidence/after-evidence-work.json`) |

Clean-checkout run of these commits: **not done** in this program (the last clean checkout is of
`518ec0d`).

## 10. Final product review

| # | Question | Answer, with the evidence |
|---|---|---|
| 1 | Can every critical metric be traced to sources? | **Paid CAC and paid spend, per branch: yes.** They are reproduced from campaigns, mappings, spend days, raw events, customers and leads (`lib/lineage/trace.ts`). Other metrics (collected, at-risk, unknown share, brand totals) have **no trace yet** |
| 2 | Can the user understand why data is unreliable? | On the trace: excluded and held records by code, unmapped campaigns with leads at the branch, open exceptions, failing feeds, assumed currency, the definition version and its caveat |
| 3 | Can the investigator explain a discrepancy without hallucinating? | The deterministic investigator: yes on its 15-case development set (0 unsupported), and it cites the trace. **A model-backed investigator was not evaluated** (no key) |
| 4 | Can unsupported claims be rejected automatically? | Figures, evidence ids and causal wording, yes, in code (`lib/ai/numbers.ts`, `analyst.ts`), with every bypass the review found now rejected. **Not:** figures written as words, bare ratios, sign errors |
| 5 | Can a configuration change be previewed safely? | Yes: the real write path in a rolled-back transaction (ChangeGuard), now reached from the trace with the change prefilled |
| 6 | Does release verification match actual state? | Yes: release checks run on live data in the release transaction. The proof journey then shows the trace counting the campaign at the new mapping version |
| 7 | Can uncertain identities remain unresolved? | Unchanged from before (pending identity conflicts stay unresolved until a person decides). An excluded lead's link is now retired. Identity tiers (household, probable person) **not built** |
| 8 | Can legitimate source corrections be represented? | Call revisions (spam marking and unmarking), spend restatements, refunds and CRM re-deliveries, by source clock. Replays defer to the newest stored version |
| 9 | Can monitoring tell integration errors from business change? | Partly: the trace separates held and excluded records and failing feeds from the number. The proactive monitoring milestone (BUSINESS CHANGE / SOURCE DELAY / … classification) **was not built** |
| 10 | Is the application easier to use than before? | One click from a number to its records, one click to investigate it, one click to preview its correction. Verified in the browser at 390–1440 px; no user study was done |
| 11 | What can existing enterprise tools handle? | Warehousing, BI dashboards, ad-platform and CRM administration. This adds the record-level reconciliation, the gated correction and the claim check, which those tools do not provide |
| 12 | What is still unverified? | Model-backed investigation; a held-out investigator set; live vendor payloads; real identities (SSO); a clean-checkout run of these commits |
| 13 | What was simplified or not built? | M4 onboarding revision states, M5 identity tiers and proactive monitoring, Decision Lab materiality states, traces of other metrics, effective-dated mappings (still retroactive, stated on every trace) |
| 14 | Can another engineer reproduce it? | Yes: `npm run db:migrate && npm run db:seed`, then `npx vitest run`, `npm run eval:ai -- --no-store`, `CI=1 VISUAL=1 npx playwright test`, and `npx tsx scripts/eval-changeguard.ts …` |

**Next highest-value step:** an independently written, frozen held-out set for the investigator
(as was done for ChangeGuard), run against the deterministic path now and against a model path
once a key and data-handling approval exist. Every claim the system makes about investigation
quality rests on a development set today.
