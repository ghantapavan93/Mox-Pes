# Investigation workspaces, verified readiness and reliability signals

## D. Investigation workspace (`lib/inquiry`, migration `0021_inquiries.sql`)

A question kept open: *"Why did <branch>'s paid CAC increase?"*. Six competing hypotheses are
tested by code against the stored records, comparing September with October. All six run in one
repeatable-read snapshot with **11 bounded reads**, and nothing loops on the data. On the demo
data the run takes about 3 s.

**The premise is tested first.** If CAC did not increase, the answer says so and does not explain
an increase that did not happen. On the demo data B09's paid CAC *fell*, from $274.30 to
$241.29, and the workspace says that.

| | Hypothesis | Verdict rule (shown with the verdict) |
|---|---|---|
| H1 | Paid spend went up | SUPPORTED if October spend > September. Its size is the spend share of ln(CAC Oct / CAC Sep) |
| H2 | Fewer paid customers | SUPPORTED if fewer, unless the unknown share rose or customers were held out. Then UNRESOLVED: they may be unattributed, not missing |
| H3 | Misclassification | SUPPORTED if an open coverage-gap, branch-mismatch or channel-conflict exception exists. UNRESOLVED if spend was classified by an older mapper. Otherwise CONTRADICTED |
| H4 | Integration stopped or records held | SUPPORTED if a feed is stale or failed, a needed feed has never succeeded, records are held at the branch, or a mapped campaign's spend stops more than five days before the period ends |
| H5 | Definition changed | CONTRADICTED. Both months are recomputed under the current definition, so a definition change cannot create a difference between them. A comparison with a figure reported earlier is named as what would change this |
| H6 | Conversions not matured | Compares the paid-prospect conversion rate between the two months, against the September median lead-to-service lag. NOT_TESTABLE below 10 prospects in either month |

Each hypothesis carries:

- the **test** rule;
- its **evidence**, with evidence ids;
- the **counterevidence searched for** and what was found (for example, a fall in paid customers
  together with a rise in the unknown share);
- **what would change it**.

The conclusion is one of explained, partly explained, unexplained, premise false, or not testable.
It lists the supported hypotheses, and when H3 or H4 is among them it says that part of the
change may be measurement rather than marketing.

**Persistent.**

- Each re-test stores a new version, and the page shows which verdicts changed since the last one.
- People can add notes.
- Every open and re-test is audited.
- A workspace is scoped like its branch: out of scope it is not found and not listed, and a guest
  cannot open one.

**Page.** `/investigator/inquiries/<id>`, opened from the investigator page. The page discloses
progressively:

1. the conclusion;
2. the six verdicts;
3. each verdict's test and evidence, opened on demand;
4. the evidence ids.

## E. Verified decision readiness (`lib/decision/verified.ts`)

Can a budget decision rest on numbers that are **proved**, not only computed? One deterministic
policy is applied per channel. Every rule is shown with its result, along with the state that rule
forces when it fails:

| State | When |
|---|---|
| NOT_READY | A Decision Lab readiness blocker; failing data integrity; the paid-CAC trace or the cash trace does not reproduce; a money or attribution invariant is broken |
| NEEDS_REVIEW | Integrity passes only with warnings, or the branch's latest workspace supports or leaves open H3 or H4 |
| READY_WITH_LIMITATIONS | No measured effect (attribution only); figures that leave held-spend customers out; unknown-channel share above 20% |
| READY | Every rule passes, including a completed randomized holdout for the channel |

The decision is `stateOf(rules)`, a pure function that is unit-tested. The rules are shown in the
Decision Lab's *Verified readiness* card, under the verdict matrix.

## F. Targeted reliability signals (`lib/health/signals.ts`)

Five conditions are checked. Each one names its size, the role who acts and the place to act, and
**nothing is shown when there is nothing to do**:

| Signal | Severity | Owner |
|---|---|---|
| Ad accounts sending spend with no stated currency, and no decision on them | medium | integration engineer |
| Currency rules waiting for a second person | medium | approver |
| Paid customers left out of CAC because their campaign's spend is held | high | integration engineer |
| Paid customers counted while some days of their campaign's spend are held (CAC understated) | high | integration engineer |
| Refunds without a stored original payment, or payments refunded beyond their amount | high | integration engineer |
| A feed with no successful run in 36 h | medium | integration engineer |

They are shown on Integrations → Ingestion pipeline. On the freshly seeded demo, none fires.

Signals and currency rules are shown to engineers and approvers only, as their APIs are.

## After the reviews of 2026-11-12

| Finding | Fix |
|---|---|
| H1 and H2 counted as drivers for any move in their direction (a cent of spend) | A driver must account for at least 10% of ln(CAC Oct / CAC Sep) |
| H3 supported by an open exception of any age | Only an exception inside September–October |
| H4 supported by a paused campaign or a stale ads feed, which LOWER October CAC | H4 is directional: stale lead or customer feeds, held lead or customer records, and September spend held at intake support it; stopped October spend, a stale ads feed and October spend held at intake are listed as counterevidence |
| H4 blind to spend held for its currency | Read per month for the branch's mapped campaigns |
| "Explained" read as a cause; decomposition shares inconsistent and clamped | "Accounted for", in a neutral tone; shares from unrounded parts, adding to 100%, shown unclamped, with "a decomposition, not a measured cause" |
| Re-test or note on another branch's workspace answered 403, revealing it exists | 404, as for a missing one |
| The Decision Lab picked a workspace arbitrarily (the business clock is frozen) | Latest tested version, then version, then id; it bears on October only, and links to the workspace |
| Verified readiness mixed snapshots | One read-only repeatable-read transaction; the collapsed row shows a shortened first reason and "+N more" |
| Concurrent proposals or re-tests surfaced as 500 | 409, "made at the same time; reload and try again" |

## Tests

| File | Covers |
|---|---|
| `tests/integration/inquiry.test.ts` | Spend up and fewer paid customers supported, H3/H4/H5 contradicted; H4 supported by stopped spend and stale feeds; premise false; versions, changed verdicts, notes, scope, guest refused, audit |
| `tests/integration/verified-readiness.test.ts` | Policy order; every rule shown; NOT_READY from a readiness blocker while the numbers themselves are proved; reads the workspace; scope |
| `tests/integration/reliability-signals.test.ts` | Silent when clean; names unstated currency, held-spend customers, broken refunds and a pending rule |
