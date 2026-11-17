# Does Revenue Signal solve the role's business problem?

2026-11-17. A business-fit pass on top of the product audit (`PRODUCT-AUDIT.md`), reusing its
verified results. Nothing here is committed, deployed or sent.

**Labels for public facts:**
- **observed** (publicly observed; the research note and its URL are cited);
- **inference** (supported by the observed facts);
- **unknown** (unknown until Moxie confirms).

The research notes saw the public pages on 2026-10-31 and 11-01 and were not re-checked live.
Product evidence keeps the audit's labels: observed in the app, targeted test, code, unverified.

**Not used, by rule:** claims about Moxie's internals whose only basis is an adjacent posting, a
vendor page or a case study. That excludes the FieldRoutes data model, "PestRoutes" as the CRM,
Power BI or Fabric as the stack, the contact-center setup, and any branch-credit rule.

## 1. The conclusion that changes the pitch

**Revenue Signal earns one claim: it tells marketing when an acquisition-cost jump is a measurement change rather than a market change, before anyone moves budget on it. It proves that with records, and it can route the repair. It does not diagnose intake or fulfillment, and the pitch should stop implying it is an attribution or growth platform.** This is the posting's own example of the work:

> "identifying why marketing data doesn't match sales results" (posting, `research/raw/jd-software-engineer-marketing.md:98`)

**Evidence (B20, synthetic, test + observed):**
- **The jump.** B20's paid-media CAC read **$490.11 for Oct 1–30**, against **$296.58 in September**. Week by week it went $263 → **$1,201** (week of Oct 12) → $836 → $800.
- **The spend.** Spend did not jump: $3,689 → $3,604 → $3,346 per week.
- **The customers.** Total serviced customers did not fall that week (27 → 27). What moved was the split: paid 14 → 3, unknown 6 → 16.
- **The cause.** Incident #1063 names it: 119 call records were held when the caller field moved.
- **After the replay.** October CAC is **$271.31, below September**, with the same $15,193 of spend and the same 109 customers. The +25 paid customers were already customers; the replay only attached their calls. That is 22 from unknown and 3 from door-to-door, reconstructed from base tables.

**The strongest competing explanation:** B20's paid demand really did fall in October. Unique
prospects fell from 316 to 238 even after the repair, and sales fell from 153 to 114. But spend fell
with them (−10%), and cost per paid customer ended lower than September. So the volume decline is
real; the cost jump was not.

**What would reverse the recommendation:**
- after the repair, B20's paid CAC stays above its own September level or the company's ($263.34);
- or sales per inquiry fall at B20 while other branches' do not;
- or Moxie's own call records show unanswered or lost calls rising at B20.

None of these is visible in the prototype; the last one never will be.

**The claim cuts both ways.** A tool that calls other numbers measurement artifacts must not publish
one itself. The money fixture (§3) caught the product doing exactly that: a branch whose only paid
customer came from another branch's campaign read a paid CAC of **$0.00**, the cheapest in the
company. That is fixed and verified (§3.7). The milder case is still open: a branch's own spend over
another branch's customers reads as a normal figure. Refusing it needs Moxie's branch-credit rule.

## 2. The decision, reconstructed

> A branch's reported acquisition cost jumps. Should we move ad spend, fix lead handling, address a service bottleneck, or hold the decision until we understand the number?

### 2.1 The handoffs

Each stage is a separate event, not a claim about how Moxie's systems are wired.

| Stage | Grain | Who could correct it | What could establish it | Timestamp that matters | What the next team does not know |
|---|---|---|---|---|---|
| Spend | campaign-day cost | whoever owns the ad account (unknown) | the ad platform's report. GTM carries Google Ads, Meta and Microsoft tags (observed, 16b:147); a tag is not spend | spend date, in the account's time zone | which branch's customers the campaign produced |
| Inquiry | one call or one form submission | marketing ops or web (inference) | the website routes by zip (`find-branch`, `geolocate-zip`, observed 03:18); each branch has its own phone (observed 03:32); call-number swapping (observed 16b:36); UTMs reach hidden fields, but the theme reads no gclid (observed 03:68–72) | event time | whether the caller is new, qualified, or already a customer |
| Qualified lead | unknown | unknown | unknown (definition, owner, rules) | unknown | whether it will book |
| Booking | a sale (a first subscription, in the prototype) | the booking team, unknown (online checkout exists, observed 03:21; door-to-door reps sell, observed 18a:226) | which system creates the booking is unknown | sale date | whether the first service will happen |
| First service | the initial service, completed | the servicing branch (inference) | public plan copy: an initial "flush" service, then maintenance after 30 days (observed 18a:111) | completion date | whether the customer pays |
| Cash | payments and refunds | finance or accounts receivable (unknown) | the terms bind once the initial service charge is paid (observed 18a:127); processor and refunds unknown | payment date | whether the customer renews |
| Renewal | the term continuing | unknown | a 12-month initial term continues into renewals; cancellation is through the portal (observed 18a:120–126) | renewal or cancel date | lifetime value |

**Branch roles kept apart.** These are the advertising branch (where the campaign is mapped), the
booking team, the servicing branch, and the financial owner. In the prototype:
- spend follows the campaign's mapped branch;
- customers and cash follow the CRM office that services them;
- the booking team is not represented at all;
- which branch "owns" a CAC is a recorded open decision (`docs/metric-definitions.md:35`, D-2).

No public statement says how Moxie credits branches (agent report: none found).

### 2.2 Four explanations for the same jump

Each row is separated by one observation. Period ratios are crude; a cohort view would be needed to
claim an intake change.

| Explanation | The one observation that separates it | At B20 (test, product's own `branchRows`) | Do not do until you have it |
|---|---|---|---|
| **Acquisition changed** | spend per week up, or paid inquiries down, with the unknown share flat | spend flat to down; paid inquiries looked down (71 → 21 a week), but that drop was held calls (49–63 a week after the replay) | Do not touch call handling or service capacity. |
| **Intake changed** | inquiries steady but sales per inquiry down | 153/316 = 48% in September; 114/238 = 48% in October after the repair | Do not cut spend: demand is arriving. |
| **Fulfillment changed** | sales steady but first services per sale down, or longer to first service | 137/153 = 90% → 109/114 = 96% (October's last week still maturing) | Do not blame lead quality or cut marketing. |
| **Measurement changed** | totals flat while customers move between paid and unknown (or held records, unmapped spend, a coverage gap) | **yes:** week of Oct 12, serviced 27 → 27, paid 14 → 3, unknown 6 → 16; 119 held calls | **Do not move budget.** The comparison is not trustworthy until the records are fixed. |

**What the prototype can and cannot do:**
- It **proves** the measurement explanation: held records, an unknown-share jump with flat totals, the repair, and a receipt.
- It can only **point at** intake and fulfillment, through counts of inquiries, sales and completed first services.
- It **cannot observe** call outcomes, qualification, scheduling capacity or cancellation reasons, so it should not be asked to diagnose them.

## 3. Money and cohorts under a hostile review

**The fixture** (synthetic, on the isolated `revenue_signal_audit_cohort_test`). Every record
enters through the product's own intake and reconciliation; the scripts and raw evidence are in
`harness/cohort/`.
- **Spend.** $200 of Google Search on campaign `coh-A`, mapped to Branch A (B10), Oct 3–4.
- **Inquiries.** Two paid calls on A's tracking number, Oct 6 and Oct 7.
- **Bookings.** Customer 9101 at Branch B's office (B11); customer 9102 at A's office.
- **First service.** 9102 cancelled before its first service; 9101's was completed Oct 9, at B.
- **Cash for 9101.** $120 (Oct 10); $80 (Oct 15), delivered three times; a −$20 refund (Oct 22).

### 3.1 Expected against the product

| Question | Expected | The product | Verdict |
|---|---|---|---|
| Bookings | 2 | 2 (sold in the period) | right |
| First services | 1, not 2 | 1 | right |
| Cancellations | 1 | not on the scorecard; the bridge's "sold, not serviced" mixes cancelled with not yet serviced. The reporting contract does carry it (`initial_status`). | gap |
| Cash at an Oct 12 cutoff | $120 | $120, through the library's scope only; no screen takes a cutoff | right |
| Cash after everything | $180 | $180 | right |
| The $80 retried three times | no change | 2 payment rows; 3 duplicates counted; totals unchanged | right |
| Cohort cost per booking | $100 | no such metric. A Shadow check with that figure is refused: `INCOMPATIBLE_DEFINITION` | gap, refused correctly |
| Cohort cost per first service | $200 | $200, but as the period CAC: period and cohort coincide in this fixture, not in general | right by coincidence |
| Branch B's CAC | none without a credit policy | **"$0.00"** on the branch page, the Overview row, the channel row and the weekly bar | **wrong; fixed in 3.8** |
| Branch A's CAC | none without a policy | "—" ($200 of spend, no paid customer serviced at A) | honest, silent about A's campaign |
| Lifetime value | none | none shown | right |

**What the product cannot represent at all:**
- a qualified lead;
- a cancellation as its own count;
- the booking team;
- cohort cost (per booking, per first service);
- a branch-credit rule;
- a figure "as known at" a decision.

### 3.2 The equal-total swap

Two restatements that leave every company total where it was:

| Swap | Company before → after | Branches before → after | Flagged? |
|---|---|---|---|
| **Spend (4a).** Both campaigns restate Oct 3: A's to $50, B's to $100. | $250 spend, 1 paid customer, $250 CAC → the same | B's CAC $50.00 → $100.00. Its one customer came from A's campaign. | **no** |
| **Servicing office (4b).** The serviced customer moves to A's office, the cancelled one to B's. | spend, customers and CAC the same. Only revenue in open exceptions moved ($180 → $0), because the branch mismatch resolved. | A "—" → $200.00; B $0.00 → "—" | the mismatch resolved and reopened for the other customer |

**What this proves:** a company total that reconciles proves nothing about a branch. A branch
figure needs its own record trail (the trace has one) and a flag when a split is restated (missing).

### 3.3 What a decision saw, and what it shows later

A decision is taken on Oct 24: October cash $180, CAC $200. Then four records arrive:
- a refund dated before the cutoff, delivered late;
- a refund dated after it;
- an accepted newer revision of Oct 3's spend ($100 → $140);
- a refused revision of Oct 4's spend, in EUR.

| Where | Shows |
|---|---|
| The scorecard | October CAC **$240**, cash to the cutoff **$150**: restated, silently |
| The stored Shadow check | still $180, `MATCH`: the snapshot is kept |
| A Shadow re-run | `MISMATCH`, naming "1 record(s) that change this figure arrived after the snapshot was taken" |
| Budget holds | the refused revision holds B10's decision; the earlier $100 still counts |
| The ledger | keeps every receipt time, so the $180 can be rebuilt. No product read path does it |

**The answer:** the product can show what a decision saw only if someone stored a Shadow check at
the time. Otherwise "what did we know on Oct 24?" has no answer on screen.

### 3.4 What got cheaper

At B20, nothing got cheaper:
- **Inputs unchanged.** The same $15,193 of October spend and the same 109 serviced customers.
- **The repair.** It moved 25 customers into paid media: 22 from unknown, 3 from door-to-door.
- **CAC.** It fell from $490.11 to $271.31 because its denominator was repaired. Acquisition did not improve.
- **Cost per inquiry.** It only looked worse: paid inquiries fell from 71 to 21 a week because calls were held. After the replay, they were 49–63 a week.
- **Cost per booking and per first service.** The product does not compute them.

### 3.5 When to refuse a comparison

| Case | What the product says | Status |
|---|---|---|
| Paid customers with no spend counted (B11) | Branch page: "—", "no spend mapped here for 1 paid customer". Overview: "—", "no spend mapped here". Trace: see below. | **fixed in this pass** |
| A decision-blocking incident is open at the branch | "Not trustworthy yet", naming the incident | existing |
| The other figure counts another population | Shadow: `INCOMPATIBLE_DEFINITION`, "population: theirs is customers_sold, the product's is new_customers_first_serviced_paid_first_touch" | existing |
| Records arrived after the compared snapshot | Shadow: "revision: 1 record(s) that change this figure arrived after the snapshot was taken" | existing |
| A branch's own spend over another branch's customers (4a) | $50.00, "cost at B10": its only customer came from B10's campaign, so the figure cannot carry a decision. A partial mix is named beside the figure | **limitation shown (§10);** which branch carries the cost is still the branch-credit decision |

The trace's exact words for B11:

> $0.00 of paid media spend for 1 new paid customers: not computed, the same as the scorecard. No paid-media spend is mapped to B11 in Oct 1–30, 2026 (UTC), so these customers' cost sits at another branch, in another period, or with no campaign tied to them; $0.00 would read as the cheapest CAC in the company.

Said to a person, in one line: "I won't compare B11's acquisition cost. Its paid customer came from
a campaign charged to another branch, so the cost isn't in B11's numbers. Tell me which branch
should carry it, and I'll show both."

### 3.6 Who acts on each number on screen

The roles are generic. Who holds them at Moxie is unknown.

| Number (Overview, branch page) | Who acts | What they do | Keep? |
|---|---|---|---|
| Paid spend, with unmapped spend beside it | the channel owner in marketing | move budget; map the unmapped campaign | keep |
| Unique prospects and lead records | marketing ops | capture and de-duplication | keep |
| New customers serviced, and how many from paid media | branch operations | service capacity | keep |
| Paid-media CAC | the marketing lead, with finance | hold or move budget, only when trustworthy | keep |
| Unattributed share | marketing ops or data engineering | repair capture and linkage; it was B20's tell | keep |
| Collected from new customers, to date | finance | not a weekly lever; a young period always looks worse | keep, labelled "to date" |
| Revenue in open exceptions | each incident's owner | resolve the incident | keep |
| Booked annual value (the sub-line under "collected from new customers") | nobody, in this decision | — | **remove from the Overview** (recommended, not done): it is the number most likely to be read as lifetime value |

### 3.7 The fix

- **The defect.** B11 read "$0.00" paid CAC: $0 of mapped spend ÷ 1 customer that A's campaign produced. That was the cheapest figure in the company, shown as valid. The integrity check passed, and with the lead tagged to B11, nothing was flagged at all.
- **The change** (`lib/metrics/scorecard.ts`, definition v4):
  - `paidCac` returns no figure when no paid spend is counted.
  - The same rule now holds in the eight places that used to compute the CAC on their own: the Overview row, the weekly bars, attention flags, the CAC-change inquiry, the brand receipt, the Decision Lab baseline (two places), and the twin's independent check. They call `paidCac` or its predicate `cacDefined`; the twin restates the rule on purpose, so it stays an independent check.
  - The branch page, the Overview row and the trace say why.
- **Before and after**, from the running app on the fixture (`harness/cohort/proof/before`, `harness/cohort/proof/after`):

  | Surface | Before | After |
  |---|---|---|
  | Branch page | $0.00, "company $200.00" | —, "no spend mapped here for 1 paid customer" |
  | Overview row | $0.00 | —, "no spend mapped here" |
  | Channel row | $0.00 | — |
  | Weekly bar, Oct 5 | $0.00 | no data |
  | Trace | "÷ 1 new paid customers = $0.00" | the refusal above |

- **Failing before.** `tests/unit/paid-cac.test.ts` was run against the committed modules: 3 of 6 failed.
  - "expected +0 to be null";
  - false "CAC 2.0× / 3.0× median" flags, caused by $0 branches dragging the median;
  - `cacDefined` missing.

  The two controls passed. After the change, 6 of 6 pass.
- **The unaffected control.** On the pristine seed copy, `harness/cac-zero-control.mts` read 1,350 CAC figures (branches, channels and company, over three periods). Their fingerprint, `85bd0e019d5e0c54`, is identical before and after. No branch, channel, week or brand in the seed has paid customers with no spend, so no demo number, screenshot baseline or B20 figure can move. The fixture shows six such cases. The B20 walk database shows none.
- **Checks after the change:**
  - tsc and `eslint .` are clean;
  - vitest: 972 passed and 1 expected failure, across 85 files;
  - the production build passes;
  - z-layout: 8 of 8 against the working-tree baselines;
  - quality gates, golden paths, navigation and a11y: 77 of 77.
- **One decision surface moves, in an edge case the seed does not contain.** A channel with customers and no counted spend used to read $0.00. That made the budget signal's ratio undefined, which switched the signal off by accident. Now such a channel takes no part, as the documented rule says. The audit's held-spend experiment (N1, rerun on its own database) shows both sides:
  - **B03, all LSA spend held:** "$0.00, ready" with no signal → LSA "no CAC, ready", and the signal reads shift 2.32× between search and Meta. That is the same as before the spend was held; neither channel's figures depend on LSA.
  - **B03, a coverage gap on Meta:** still "not trustworthy", "Do not act on this number"; the ratio among the other channels now shows (1.53×).
  - Whether held spend should hold the decision was the open policy question (N1). The second pass (§10) applies the rules the brief then set: a held channel cannot carry an action on its cost; the pair it does not touch stays comparable; the branch-wide recommendation is held.
- **Not invented:** which branch or period should carry the cost. The change only declines to show a cost the scope does not contain.

## 4. The posting on trial

The posting is `research/raw/jd-software-engineer-marketing.md` ("Software Engineer – Marketing",
Tempe; the ATS and URL are unknown). Only its own bullets are used here; adjacent Moxie roles are
not.

| Posting (line) | Business decision it serves | Current product evidence (path) | Proof | Remaining gap | What to say in the interview |
|---|---|---|---|---|---|
| 98 "identifying why marketing data doesn't match sales results" | hold or move a branch's budget | B20: 119 held calls explain the CAC jump; base-table reconstruction (audit `audit-dm`); `final/` captures | **demonstrated** | synthetic data only | "This is the exact problem I built for, end to end; here is the record." |
| 49 full-stack apps, internal tools, APIs | an operator acts on a number | Overview → incident → dry run → approval bound to the reviewed dry run → idempotent execution → receipt (`action-center.test.ts`, `final/`) | **demonstrated** | demo roles, not sign-in (A6) | "Server-enforced end to end; the roles are a demo stand-in." |
| 53 multiple branches, brands, departments | one branch's decision held, another's not | unmapped spend holds B44, not B09 (`scenario.test.ts`); a refused revision on a shared ad account holds B10, not B07/B08/B11 (audit-dm FH-acct) | **demonstrated** (with controls) | departments not modelled; branch credit unknown | "Scope is applied in SQL, and the control proves an unaffected branch stays clear." |
| 50 attribution and funnel reporting: spend → leads → bookings → revenue → customer lifetime value | which channel earns its cost | spend → lead → sale → first service → cash, traced; CAC rebuilt from base tables | **partial** | no qualified-lead state; period CAC, not cohort; **no lifetime value or renewals** | "Connected through first service and cash; lifetime value isn't built, and I won't fake it." |
| 51 dashboards for acquisition costs, conversion, retention, channel performance | executive budget view | Overview, branch scorecard, conversion bridge | **partial** | retention not shown | "Acquisition and conversion yes; retention no." |
| 52 integrations with marketing platforms, CRM, REST APIs | can a broken feed be caught and recovered | push API, connector seam, mapper versions, quarantine and replay (B20) | **partial** | synthetic contracts; no real vendor tested (R-1) | "The seam and failure handling are real; vendor compatibility is untested." |
| 54 shared pipelines, reporting models, consistent metrics | one number everyone trusts | reporting views, metric definitions, ledger conservation checks | **partial** | two CAC denominators (N3); an unkeyed contact hash in BI (N12) | "Consistency is enforced and tested where I've shown it; two known gaps." |
| 55 monitoring, failed jobs, inaccurate data, broken integrations | notice and repair | B20 diagnosis and repair demonstrated; the live deploy's out-of-memory crash diagnosed and moved off (this session) | **partial** | live deliveries never move freshness (N14); no alerts | "Diagnosis and repair yes; monitoring is the gap I'd close first." |
| 56 database changes, safe production migrations | ship without breaking reporting | 35 append-only migrations; edited-migration guard; Neon load verified at 65 tables | **partial** | no zero-downtime or destructive migration demonstrated | "Additive and verified; I'd walk an expand-and-contract live." |
| 57 CI/CD, deployment, testing, release | releases nobody fears | CI repaired this session; Vercel deploys from `main`; 966 tests and browser and pixel gates | **partial** | CI on GitHub still unverified green | "The gates exist and run; I don't claim a production record." |
| 58 discovery through release and production support | — | a deployed prototype, and its first production incident (OOM) handled | **partial** | a demo, not a business system | "A demo's lifecycle, not a production one." |
| 59 work with Marketing, Sales, Operations and executives; support adoption | — | none with Moxie | **not demonstrated** | no stakeholder access | **Do not claim.** Say how I'd learn (section 7). |
| 61 use AI thoughtfully | where AI helps without hurting trust | deterministic investigator; claim checker; "the AI proposes, the ledger disposes" | **partial** | model path never evaluated (N22) | "Here's where I kept AI out of the write path, and what's unevaluated." |

**Three rows to defend if a staff engineer pauses the demo and asks for the record:**
1. Line 98 (B20, the record behind the number).
2. Line 49 (approval bound to the reviewed dry run, and a 409 when it isn't).
3. Line 53 (B44 held, B09 clear, with the test that proves the control).

**One weak but important requirement:** line 50's "customer lifetime value". The honest approach
after joining:
- learn how renewals and cancellations are recorded (the public terms describe a 12-month initial term that renews, cancellation through the portal, and an early-termination fee: observed 18a:120–126);
- agree on a cash definition and a cohort basis with finance;
- publish only "cash collected to date per acquired customer, by cohort", labelled as not lifetime value, until renewal history exists.

**One requirement not to claim:** customer lifetime value and retention (lines 50–51). "Booked
annual value" is on screen and could be mistaken for it; it is not.

**The posting's success expectations, translated** (lines 65 and 67, no invented targets):
- **Learn before building:**
  - today's CAC definition;
  - which system is authoritative for leads, bookings, service and cash;
  - how branch credit works;
  - how the last disputed number was settled, and who owned the correction.
- **First useful slice:** read-only evidence for one recurring decision. It says when a branch's CAC moved because the records changed (held records, an unknown-share jump with flat totals, unmapped spend), with links to the records, and no write path.
- **Adoption evidence that would justify expanding:**
  - the analyst opens it in the weekly review unprompted;
  - each flag ends with a named owner who acted;
  - no decision made from it was later reversed by the evidence;
  - a second branch or region asks for it.

## 5. Where it belongs, and what would make us stop

| Option | What it adds | When it is good enough | What it misses on the B20 task |
|---|---|---|---|
| **The current report and a manual checklist** | nothing new to adopt | discrepancies are rare; one analyst owns both the spend and CRM extracts; decisions are monthly | totals look fine while records are held. A checklist catches B20 only if it checks unknown share and held records weekly, by branch |
| **Read-only discrepancy evidence beside existing BI** (the strongest alternative) | weekly flags: unknown share jumping with flat totals, held records by source, unmapped spend, coverage gaps; each links to records; BI stays authoritative | most of the time: it gives the hold and the evidence without a new tool | a governed repair (dry run, a second approver, a receipt) and the "what changed, what did not" record; the fix goes through the normal engineering change process |
| **A separate investigation workspace** (this prototype) | decision readiness per channel, a governed repair with a verified receipt, an audit trail | only when fixes recur, cross teams, and someone needs to prove who changed what credit | — (it is the most to adopt and duplicates BI screens) |

**Recommendation:**
- **Start with the second option.** Most of B20's value is the hold and the evidence. The repair receipt earns its place only if the pilot shows corrections crossing teams and staying wrong.
- **The manual workflow is already good enough** when one person reconciles both extracts every week by branch, and unknown share is on the checklist.

**An authorized, read-only shadow pilot.** It is a proposal, not something Moxie has agreed to.

- **Who and when:** one marketing analyst who already runs the weekly branch budget review. It runs weekly, beside that review, not instead of it.
- **Permitted data:**
  - spend by campaign-day;
  - lead records with record ids and hashed contact keys only (no names, addresses or notes);
  - sale, service and payment events with ids and dates;
  - nothing else: no payment instruments, read-only access or exports.
- **Authority:** Moxie's existing report stays authoritative; Revenue Signal is advisory.
- **Adjudication:** the analyst and the owner each flag names decide whether it is a real issue, a non-issue or unknown. The log records the artifact that settled it and record ids only; no customer data is copied.
- **Cases, the same in both workflows:**
  - a real issue (a feed field changing, like B20);
  - a convincing non-issue (a seasonal cost rise with complete records, like B20's real October volume decline);
  - an unknown (a customer bought by one branch's campaign and serviced by another).
- **Measured:**
  - wrong decisions (a move later contradicted by the evidence);
  - false holds;
  - time from noticing a jump to the record that explains it;
  - whether the next owner was clear and accepted.

  No numerical benefit is claimed until it is measured.
- **Stop rules, stated before it starts:** stop if any of these happens.
  - It contributes to a wrong decision the existing process would not have made.
  - False holds outnumber real catches over the pilot.
  - The analyst stops opening it.
  - It needs customer data beyond hashed keys.
  - Data owners cannot act on its flags.

  A faster workflow with more wrong decisions is not a win.

## 6. The interview sequence (B20)

This is one continuous live run on a freshly seeded synthetic database. The roles are switched
with the demo picker; say so once.

1. **The business choice, on the Overview, as Guest.** "B20's paid CAC is flagged at 1.8× the median branch. Do we cut B20's paid search?"
2. **The wrong but plausible reading.** Open **B20 Heron**. The weekly CAC chart shows $1,201 in the week of Oct 12, so "search got expensive".
3. **The record that changes it.**
   - The budget signal reads **Not trustworthy yet**, naming #1063. Open it: 119 call records were held when the caller field moved, and 53 new customers lost their lead record.
   - "Same spend, same customers: the records changed."
4. **What the operator can decide.** Hold the move. As engineer, propose the replay and dry-run it: $364.75 → $284.06, ledger conserved. As approver, approve that dry run and execute it once.
5. **Stop talking at the "Fixed and verified" panel.** Let them read *why it moved, what did not, still open*.
6. **One line, then stop.** "After the fix B20's October CAC is $271, below September. The jump was measurement. What this does not tell you is whether paid search is effective, or whether B20's calls are being answered: that's your data, not mine."

**If asked who gets a customer one branch's campaign bought and another serviced:** "That's your
branch-credit rule, and the product won't invent it. Where a branch has the customer but none of
the spend, it shows no CAC rather than $0.00 (§3.5)." The seed has no such branch, so this is said,
not shown.

## 7. Three questions Moxie can answer from actual work

| Ask | How each answer changes the product |
|---|---|
| "What was the last marketing number someone disputed in a budget conversation?" | A cost or lead count moved by a feed or mapping change: the measurement check is the right first slice. Which branch gets a customer: branch-credit policy comes first, and the cross-branch rows matter more than repairs. Booked versus collected: start at finance's grain. |
| "What settled it: a CRM export, a call-tracking report, an ad-platform screen, a spreadsheet join?" | Names the source that is authoritative, and the evidence the tool must link to: record-level drill-down, or a reconciled total. |
| "Who owned the correction, and how long did the wrong number stay in reports?" | One analyst fixing it in an afternoon: the governed repair is overhead; ship read-only evidence. A fix that crossed teams and stayed wrong for weeks: the named owner and the receipt are the product. |

## 8. What to say

- **"I built and verified":**
  - the B20 measurement case end to end (hold, evidence, dry run, an approval bound to the reviewed dry run, idempotent execution, a verified receipt);
  - CAC and its denominator rebuilt from base tables;
  - ledger conservation;
  - scope-safe reads, and the brand, period and dead-link fixes;
  - the test and pixel gates;
  - a deployed demo and its first production incident;
  - a money fixture that caught the product's own $0.00 CAC, and the fix: the CAC is refused where its scope holds no spend, proven on the running app with an unchanged control.
- **"I would investigate with your team":**
  - branch credit across the advertising branch, booking team, servicing branch and financial owner;
  - how a lead is qualified, and what happens to calls;
  - service capacity and cancellations;
  - renewals and lifetime value;
  - the held-spend rule;
  - which systems are authoritative;
  - whether decisions need an "as known at" view (today a later revision restates the figure silently);
  - where this belongs beside your BI.
- **Leave out completely:**
  - anything about Moxie's CRM, BI stack, contact center or attribution model;
  - "two approvers" as authentication;
  - "evaluated AI";
  - lifetime value or retention;
  - cohort CAC or cost per booking (only period CAC exists);
  - time saved, savings or adoption numbers;
  - "integrates with your systems".

## 9. Evidence

- `research/raw/jd-software-engineer-marketing.md`: the posting, lines cited above.
- `PRODUCT-AUDIT.md` (§4 findings, §5 fixes, §9 checks).
- `final/` (the live B20 run) and `revenue-signal-b20.pdf` (reframed: page 1 leads with the business choice; page 3 states the decision).
- `walk/` (the starting state).
- The B20 weekly figures come from the product's own `branchRows`, read-only, on a pristine seed (`revenue_signal_deploy`) and the fixed walk database. The script is `b20-weekly.mts` in this session's scratchpad.
- `harness/cohort/`: the money-and-cohort fixture (`expected.json` written first, the two audit files, `evidence.jsonl` from before the fix) and the before/after captures of the running app.
- `harness/n1-rerun/`: the audit's held-spend experiment (`exp-n1.ts`, cases C, D and R, on `revenue_signal_audit_dm`, each rolled back), before and after the CAC fix. Only exception ids and the lines quoted in §3.7 differ.
- `harness/cac-zero-control.mts`: the seed-side control. Fingerprints: `revenue_signal_deploy` `85bd0e019d5e0c54` before and after; the walk database `77f958220a784649`, with no zero-spend case.
- The CAC fix: `lib/metrics/scorecard.ts` (`paidCac`, `cacDefined`), definition v4 in `lib/metrics/definitions.ts` and `docs/metric-definitions.md`, and `tests/unit/paid-cac.test.ts`.
- Side effect: running vitest from the repository writes its transform cache to `node_modules/.vitest-cache`, which git ignores. The fixture's own config turns that cache off.

## 10. The decision boundary (second pass, 2026-11-17)

The brief asked for one distinction. A fact can be displayable, a pairwise comparison valid, and a
budget recommendation still held. These are three separate outcomes. The work started from the
recorded B03 held-Local-Services case (N1 R), kept the CAC v4 fix, and did not touch branch credit.

### 10.1 What the claim was, before the change

In case R, one person revokes B03's Local Services currency rule. All 74 of its campaign-days are
excluded at intake. No incident opens. Captured from the running app on an isolated copy
(`harness/boundary/proof/before/B03.json`):

| Surface | It said |
|---|---|
| Branch card | "Data integrity: no blocking incidents"; "Google Search costs 2.3× Meta per attributed new customer (first evidenced touch). An observation, not a recommendation."; Local Services $0.00 / 14 / — |
| Decision Lab readiness | "1 of 4 paid channels at B03 are not ready …: Microsoft Ads." Local Services: **Ready** |
| Decision Lab note | "Budget signal: Google Search costs 2.3× Meta per customer · gate open" |
| Scenario builder | preselected **Google Search → Meta** |
| Scenario, Search → Local Services | refused: "has no spend at this branch in the period" (the wrong reason: it is held) |
| Overview | "3 budget decisions on hold at B44, B20, B09": B03 not among them |
| Overview, B03 alone | "No open incident affects these figures. Nothing open changes what these channels cost." (derived: `movement-before.mts`) |

**Classified.** The "shift" was computed as a branch-wide extreme: the most expensive channel
against the cheapest, among the channels with a CAC. When Local Services lost its CAC, it silently
became a pairwise display (Search against Meta). The card still presented it as the branch's
ranking. The Decision Lab then turned it into a recommendation by preselecting the move. Four
surfaces each applied their own label: the card's headline, the note's formula, the builder's
default rule and the Overview's incident list. None of them knew the spend was held.

### 10.2 The change: one boundary

- `lib/metrics/eligibility.ts` (new) gives each paid channel's standing from its records, in one
  SQL read per scope: held days with their own reason, recorded zeros, and customers whose
  campaign is held, unmapped or mapped to another branch. It matches `channelRows` for spend and
  customers on all 154 branch-channels of the October seed.
- `budgetSignal` (`lib/metrics/decision.ts`) composes three outcomes from that standing and the
  open incidents:
  - each channel's reasons;
  - the comparison (`branch`, `verified` with what is left out, or `unverified` when an incident's
    reach cannot be narrowed);
  - the recommendation (`shift`, `none` or `held`, with what holds it).
  `evidenceHolds` gives the Overview the holds that no incident states.
- `lib/decision/signal-copy.ts` holds every sentence: the card, the Decision Lab note, the builder's
  starting move and the CAC cell label. No page labels the outcomes itself any more. A raw ratio
  that pairs a left-out channel (a blocked ratio) is named once, as "Not a valid comparison: …,
  but Meta is left out (revision refused)". It is never the headline.
- Readiness (`verdicts.ts`) fails a channel whose own cost cannot carry a move. It gives one code per
  reason: `cost_held`, `cost_unmapped`, `cost_elsewhere`, `cost_no_spend`, `cost_recorded_zero`.
  The scenario refuses a move into or out of such a channel, with that reason. It also warns when a
  reviewable pair is not the branch's ranking. The fix receipt and the investigator carry the
  recommendation's status.

How the four rules were applied:

1. **No action on an indefensible CAC.** Each reason is kept apart and phrased from the held record
   itself: held at intake, revision refused, unmapped campaign, cost at another branch, no spend
   recorded, $0.00 recorded. Only the first three, and an incident, name what releases them. A
   recorded $0.00 holds nothing.
2. **The unaffected pair stays visible** as "Among verified channels", naming what is left out and
   why. It never reads as a branch-wide ranking. If an incident cannot be narrowed to channels (B20's
   held call records), nothing is shown as verified. The card then reads exactly as before, behind
   the gate.
3. **An unresolved blocker on either side holds the move.** An open incident still holds every move
   at its branch, as it did before. This pass did not loosen that. A correction clears only its own
   blocker. The receipt shows the decision's current status beside the fix's own verification.
4. **No reassignment.** A channel whose every customer came from another branch's campaigns reads
   "cost at B10" and cannot carry a decision. A partial mix is named beside the figure. No spend,
   customer or replacement figure moves between branches.

### 10.3 Before and after, on the running app (case R, B03)

| Surface | Before | After |
|---|---|---|
| Card headline | "Google Search costs 2.3× Meta per attributed new customer (first evidenced touch). An observation, not a recommendation." | "Among verified channels, Google Search costs 2.3× Meta per attributed new customer (first evidenced touch). Not a branch-wide ranking: Google Local Services is left out." |
| Card, new box | none | "Branch-wide recommendation held. Google Local Services is left out, and its missing cost could change which channel is cheapest or most expensive. A move between the verified channels can still be reviewed in the Decision Lab; a move involving Google Local Services cannot until its cost here is known." |
| Card, left out | none | "Google Local Services (14 customers): Its spend at B03 is held at intake on 30 days of the period (Oct 1–Oct 30): the currency rule that made this spend countable was revoked (CURRENCY_UNSTATED, account LSA-B03). None of it is counted, so its 14 customers have no cost per customer until the held records are accepted." |
| Card, Local Services CAC | — | —, "held at intake" |
| Lab readiness | "1 of 4 … not ready: Microsoft Ads" | "2 of 4 … not ready: Google Local Services, Microsoft Ads", then the reason, then "Google Search and Meta can still be compared, and a move between them reviewed; the branch-wide recommendation stays held while Google Local Services is left out." |
| Lab, Local Services | Ready | Not ready (`cost_held`) |
| Lab note | "… costs 2.3× Meta per customer · gate open" | "Budget signal, among verified channels: Google Search costs 2.3× Meta per customer (Google Local Services left out) · recommendation held" |
| Builder | Google Search → Meta preselected | nothing preselected: "Nothing is preselected while this branch's budget recommendation is held." |
| Scenario, Search → Meta | decision-ready, no warning | decision-ready, with "This compares two channels, not the branch: …" |
| Scenario, Search → Local Services | "has no spend at this branch" | "has no counted spend at B03 …: its spend at B03 is held at intake …" |
| Overview callout | "3 budget decisions on hold at B44, B20, B09" | "4 budget decisions on hold at B44, B20, B09, B03" |
| Overview hold list | none for B03 | "B03 · Spend held at intake · Google Local Services: Its spend at B03 is held at intake …" |
| Overview, B03 alone | "No open incident affects these figures. Nothing open changes what these channels cost. …" (the panel's before path on the same records, `movement-before.mts`; not captured from the page) | "Hold the budget decision. No incident is open, but the records hold it: Google Local Services: Its spend at B03 is held at intake …" |

### 10.4 The recorded cases and the controls (`harness/boundary/cases.mts`)

Each case runs in a rolled-back transaction on `revenue_signal_audit_dm` (`cases.before.out`,
`cases.after.out`).

| Case | Comparison shown | Recommendation | Moves withheld |
|---|---|---|---|
| R: Local Services held, no incident | among verified: Search 2.3× Meta | held by Local Services | any involving Local Services |
| D: refused Meta revision (META-1) | among verified: Search 1.5× Local Services; Meta left out, "revision refused"; the raw Search 2.3× Meta reads "Not a valid comparison" | held (incident) | all at B03 (the incident gate, unchanged) |
| C: all October Meta spend excluded, coverage gap | among verified: Search 1.5× Local Services | held (incident) | all at B03 |
| E: D corrected by an excluded newer revision | among verified: Search 1.5× Local Services; Meta left out, "held at intake on 1 day (Oct 20) … understated" | held by Meta | any involving Meta |
| RDfix: R + D, then an accepted revision | before: "Fewer than two paid channels … can be compared"; after: among verified, Search 2.3× Meta | held, then still held by Local Services | all, then any involving Local Services |
| Z: Local Services recorded at $0.00 | among verified: Search 2.3× Meta; Local Services "$0.00 recorded" | held, by the coverage gap the zeros open (spend "stopped" while leads arrive), not by the zero | all at B03 |
| S: Search held on a shared account (GA-WEST) | among verified: Local Services 1.5× Meta | held (incident) | all at B03 |
| B04 control (shares META-1 and GA-WEST) | identical before and after R, D and S | as before | none |

### 10.5 Proofs (`tests/integration/decision-boundary.test.ts`, 11 tests)

The world is small, and every expected number in it is computed from its records:

- **A held channel cannot look ready.** Its readiness fails with `cost_held` and the held record's own
  reason. The Overview lists it, though no incident does. A move involving it is refused with that
  reason.
- **The unaffected pair can still be compared:** "Among verified channels, Google Search costs 3.1×
  Meta …". A Search → Meta scenario is decision-ready and says it is a pair.
- **The observed shift is not a recommendation.** The recommendation is held and nothing is
  preselected. The fix receipt's snapshot says `held`.
- **A blocked ratio cannot become a shift.** With Meta's revision refused, the raw ratio (Search 3.1×
  Meta) stays data only. The headline, the note, the builder and the scenario all hold.
- **Not inherited.** B04 shares GA-WEST and META-1 and inherits neither the held channel, the refusal
  nor the held day.
- **A correction clears its own blocker only.** An accepted newer revision resolves the refusal
  ("Corrected. Oct 10: … accepted a newer revision"). Local Services still holds the recommendation.
  The accepted ledger is unchanged.
- **An authorized rule** (two people) releases the held channel and the recommendation.
- **A recorded $0.00, the control.** It leaves Microsoft Ads out as "$0.00 recorded" and holds
  nothing. The recommendation stands and the builder preselects the pair. No hold is listed, and a
  move into it is refused with "the source recorded $0.00".
- **B11 evidence.** "$50.00, cost at B10": its only customer came from B10's campaign. B10's partial
  mix is a limitation. The channel rows and the ledger are unchanged.

### 10.6 What did not move (`harness/boundary/decision-control.mts`, pristine seed)

- **Legacy outputs.** The gate's legacy outputs (signal, ratio, from, to, trustworthy, blockers) were
  recomputed by a frozen copy of the old rule and compared on all 132 branch-periods: 0
  mismatches, fingerprint `4286f88bf2f023e9`.
- **CAC figures.** The 1,350 seeded CAC figures still fingerprint `85bd0e019d5e0c54`.
- **The ledger.** $1,234,318.64 over 11,422 campaign-days, $1,203,871.00 collected, unchanged. The
  boundary only reads.
- **Where the seed now says more** (14 branch-periods):
  - B06 and B07 show the D-2 limitation beside their figures.
  - B09, B20 and B44 were held before and stay held.
  - At B09 and B44 the card now compares only the channels the incident does not touch. B09's
    distorted 8.6× stays visible as "Not a valid comparison: Google Search costs 8.6× Google Local
    Services …, but Google Local Services and Google Search are left out (incident #2455)". The B09
    four-minute path's golden values ("8.6×", "Not trustworthy yet", then "2.9×") still read.
  - B44's Local Services is left out ("2 of its 12 customers came from a campaign no branch is
    mapped to").
  - No channel's readiness status changed.
- **The B20 card is word for word unchanged** (basis `unverified`): headline, gate and red box. The
  B20 recording and PDF need no revision.

### 10.7 What still needs a business decision

- **Branch credit (D-2).** Which branch carries a customer bought by another branch's campaign. The
  product only names the mix.
- **Incidents that touch one channel.** Should they still hold moves between channels they do not
  touch? They still do (the gate is unchanged). Narrowing it would follow rule 3 literally, but it
  would relax holds the B09 and refused-revision work deliberately set.
- **How much held spend is tolerable.** One held day of 30 now leaves a channel out and holds the
  ranking (case E). A materiality threshold would be a policy, so none was invented.
- **A source-recorded $0.00.** It is not read as free and not held. In the full seed world, 30 zero
  days also open a coverage gap (spend "stopped" while leads arrive). That is the existing detector's
  rule, left as is.
- **"No spend recorded" with no known cause.** It has no release condition. Who investigates it is
  an owner decision.

### 10.8 Checks (final code)

- **Static checks.** `tsc --noEmit` and `eslint .` are clean.
- **vitest.** With CI's settings: 86 files, 983 passed and 1 expected failure (R-39, pinned). The 11
  new tests are included. The 10 files that touch the changed code were rerun after the last edit:
  131 of 131.
- **Build.** The production build passes.
- **Browser** (isolated `revenue_signal_rc`):
  - quality gates: 40 of 40;
  - golden paths, navigation and a11y: 37 of 37;
  - VP journeys, Overview movement and the B09 four-minute path: 14 of 14;
  - `z-layout`: 8 of 8. The two incident baselines (`incident-1440`, `incident-390`) were
    re-generated on purpose: the B09 budget card they embed changed as in §10.6. The Overview
    baselines needed nothing.
- **A failed first run.** The first combined run overlapped a cancelled one on the same database.
  It failed the Decision Lab layout-shift gate (CLS 0.209 on `/decisions?branch=B09`) and logged
  one server error, reading a branch row that disappears mid-reseed. The gate passed alone, and
  the clean runs logged no server error. The gate is timing-sensitive: the Decision Lab now reads
  the channel evidence too, about 65 ms per branch.
