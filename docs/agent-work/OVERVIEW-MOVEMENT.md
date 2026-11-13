# What changed: from a movement on the Overview to its records (2026-11-13)

Synthetic data only, local only. Nothing is pushed or deployed. This adds one panel to the existing
Overview and one section to the existing trace page. There is no new dashboard, report builder,
Power BI dependency, attribution rule or Decision Lab change.

**The questions, in order:**
1. What changed in my branch or period?
2. Is it a business movement or a number to investigate?
3. Can I open the exact evidence and come back without losing my place?

## 1. Baseline (before this change, commit `2aebf91`)

Production build (`next start`), isolated synthetic database (`revenue_signal_drift`, freshly
seeded), marketing analyst. Screenshots: `overview-movement/screens/baseline_*` (desktop 1440,
phone 390).

**Inventory of the Overview (read in the browser):**

| Element | Today |
|---|---|
| Charts | One: "New customers serviced, by week" (paid / unknown / other, stacked). No selectable point |
| Filters | Brand tabs and period tabs (October, September, Both months), in the URL. No branch filter |
| Metric definitions | Each KPI tile links its definition (`/definitions#metric-…`) |
| Freshness | A "Data freshness" card at the bottom: each feed's last success |
| Hold logic | `decisionHolds`: open coverage-gap, quarantine and unmapped-spend incidents. The callout at the top, "Issues requiring review" below the tiles; B09 is third (B44, B20, B09) |
| Evidence routes | `/branches/[id]` (weekly CAC and unattributed share), `/branches/[id]/trace?period=&metric=paid_spend\|paid_cac\|collected` (the records behind a number), `/exceptions/[id]` |

**The path from the B09 hold to its spend records**, recorded by Playwright: B09 in the holds list
→ the branch page → the paid-spend tile's trace = **3 clicks**. The trace lists each campaign's spend
**for the whole month**, not by week. The Overview breadcrumb returns to `/?period=oct`, at the
top: no branch, no week. Nothing on the Overview itself says what changed at B09 or when, other
than the hold's sentence.

**Time until the B09 hold is usable** (the R-34 harness `scripts/measure-overview.ts`, driver
`C:/Temp/overview-measure.sh`):
- Protocol: 2 fresh seeds × (1 fresh + 3 warm) per browser layer, and 1 seed × 3 for the server
  layer.
- ANALYZE ran after every seed (0 of 65 tables left unanalyzed).
- Results: [§5](#5-verification).

## 2. References, opened, and what was taken from each

All four pages were fetched on 2026-11-13; Linear's redesign page and WCAG 2.2 were read for the
drift review the same day (`DRIFT-REVIEW.md` §2).

| Reference | Borrowed | Where |
|---|---|---|
| Power BI, drillthrough | The source page passes its selection as the target's filter. A back button on the target is recommended. Avoid visuals that show blank under that filter | "Open evidence" carries branch, period, channel and week to the existing trace page. "Back to the Overview selection" restores all four; the browser's own Back works too. The target says what it does not establish instead of showing blanks |
| Power BI, cross-filter / cross-highlight | Selecting a point filters or highlights other visuals; designers decide which visuals interact | One interaction only: a point updates one explanation beside the chart, and other lines dim (highlight, not filter). The KPI tiles and tables do not change |
| ONS, line charts | Line charts for change over time, comparing a few series. Leave gaps where regular data is missing. Annotate significant events | Weekly lines per channel; a week with no spend record is a gap, never $0. A recorded $0.00 is a point on the axis. The incident's stored date is a marked line |
| W3C, complex images | A short text alternative plus a long description available to everyone, including the values | The takeaway sentence is visible above the chart. The SVG has a short label. An "Exact weekly values" table holds every value, with its status in words |
| Linear, UI redesign | Content and action above chrome (read for the drift review) | The takeaway is the panel's largest text; one primary action ("Open evidence") appears once a point is selected |

## 3. Two layouts, one choice

Two static sketches used the real B09 weekly figures and the product's tokens
(`screens/overview-prototype-*`):
- **C, chart first:** the chart, then the explanation.
- **D, decision first:** the takeaway and trust line, then the chart, with the explanation beside it.

| | C: chart first | D: decision first |
|---|---|---|
| Desktop 1440: takeaway / action | y = 723 / 785 | y = 189 / 404 |
| Phone 390: takeaway / action | y = 418 / 532 | y = 181 / 650 |

**Chosen: D.** The reader gets the conclusion before the lines (189 px against 723 px on desktop).
On a phone, C reaches its action sooner, but only by putting the chart before the sentence that
says what it shows.

The sketch also exposed two problems:
- Labels at the end of each line were clipped at the right edge.
- The Meta and Microsoft lines overlap.

So the product uses a legend that is also the channel selector, and one colour for the channel in
focus.

## 4. What was built

**One panel on the Overview, "What changed"** (`components/overview/MovementSection.tsx`). It sits
under the hold callout and above the KPI tiles. It reuses the Overview's period tabs, scope and
shell. Top to bottom:

1. **Scope:** a branch picker ("All branches in view", or one branch in the viewer's scope), with
   the period from the Overview's tabs shown beside it. Both are in the URL
   (`?period=oct&branch=B09`).
2. **Takeaway**, in plain language, before the chart (`lib/metrics/movement-copy.ts`), built only
   from the scoped data:
   - For B09: "Google Local Services spend at B09 stopped after Oct 12 while its leads kept
     arriving."
   - Then: "$2,123.52 has since been spent under pmax-lsa-B09, which is filed as Google Search.
     Until it is re-mapped, cost per customer is wrong for both channels."
   - The figures come from the open incident's stored evidence. "Stopped" is checked against the
     chart's own weeks, and "kept arriving" against the stored lead records.
3. **Trust line:** "Investigate before acting", when an open incident changes what a channel cost
   here, with a link to the incident. Otherwise "No open incident affects these figures". If the
   ads feed is stale, it says the latest weeks may be incomplete.
4. **The chart** (`components/overview/MovementChart.tsx`):
   - One metric and one unit: the scorecard's *paid media spend*, per week (Monday–Sunday, UTC),
     one line per channel, Sep 1 – Oct 30, with the selected period shaded.
   - One colour for the channel in focus; the others are grey, told apart by dash pattern and
     label.
   - A week with no spend record is a gap in its line. A point that counts fewer than 7 days is
     hollow, and the caption says so: a week with days missing, or a week cut by the window's
     edge. A recorded $0.00 is a point on the axis.
   - The incident is a marked line at its stored first day without spend ("Coverage gap from
     Oct 13 · #2455"). It is drawn only when the chart's scope is that incident's branch.
5. **Selection:** a point, or the channel buttons and week buttons under the chart (keyboard and
   touch).
   - It updates one explanation beside the chart: the week's value and how many days have records,
     or "No spend record on any of its 7 days. This is not $0".
   - Lead records that week are given as context in another unit.
   - **Open evidence** and **Reset** sit below it.
   - The selection is written to the URL (`channel`, `week`) with the native History API, so there
     is no server round trip.
6. **Exact weekly values:** a table with every value and its status in words ("no record",
   "$0.00 (recorded)", "$117.91 (1 of 7 days)").
7. **Definition, unit and freshness:** the metric's formula, "US dollars per week", and the last
   spend date the ads feed delivered.

**The evidence:** the existing `/branches/[id]/trace?period=&metric=paid_spend` page, given
`channel` and `week`. It opens with "Selected on the Overview" (`components/trace/OverviewSelection.tsx`):
- every day of that week, with its stored spend record (campaign, amount, raw event), or
  "no spend record";
- a total that says whether it is a recorded zero or no record;
- the coverage-gap incident for that channel, when its stored date is on or before that week;
- what these records do not establish;
- **Back to the Overview selection**, which restores branch, period, channel and week. The
  breadcrumb does the same, and so does the browser's Back.

Below it, the trace page is unchanged: the whole month's campaigns, reproduced against the
scorecard.

**Data** (`lib/metrics/movement.ts`):
- One read per concern, run in parallel: weekly spend by channel, weekly lead records, period and
  comparison totals, the ads feed's last delivered day and freshness, holds, and coverage-gap
  markers.
- Each week-channel cell is one of: `recorded`, `partial`, `zero`, `missing` or `not_delivered`.
- `overviewMovement` checks scope before any read: a branch outside the viewer's scope returns
  `outside_scope` and nothing else.
- The page starts these reads once its own reads are done, and renders the panel in its own
  Suspense boundary after the hold.
- When the panel's scope is the page's scope, it reuses the page's decision holds instead of
  reading them again. The panel and the hold callout then always name the same holds. A chosen
  branch reads its own holds; that read takes about 50 ms.
- Both choices came from measuring the hold: [§5](#5-verification).

**Not built:** a second chart, cross-filtering of the KPI tiles or tables, a dual axis, a new data
pipeline. The existing "New customers serviced, by week" card stays as it was.

## 5. Verification

Every browser check below ran on the production build (`next build`, then `next start` with
`DEMO_MODE=1`) against the isolated synthetic database, reseeded before each run. Screenshot names
carry `on-2aebf91`: this change, uncommitted, on top of commit `2aebf91`.

### What the browser proves (`tests/e2e/zy-overview-movement.spec.ts`, Chromium)

**The selected week is exactly the evidence's date range.**
- Desktop: B09, Google Local Services, Oct 19–25 → Open evidence. The URL carries
  `channel=google_lsa&week=2026-10-19`.
- The evidence heading reads "Selected on the Overview: Google Local Services · Oct 19–Oct 25".
- Its day rows are exactly 2026-10-19 to 2026-10-25, each once, in order.
- The same check passes for Oct 5–11 and Oct 12–18 (seven days each), and for the window's last
  week, Oct 26–30 (five days).

**The figure is the records' figure.** For Oct 5–11, three numbers are the same dollar amount:
- the chart's explanation;
- the stored records, summed in SQL;
- the sum of the seven daily rows on the evidence page.

The evidence summary reads "All 7 days have a spend record: $842.34 in all."

**Returning restores the branch and the week.** "Back to the Overview selection" returns to
`/?period=oct&branch=B09&channel=…&week=…#movement`. The scope is still B09, the same point is
selected and its week button is pressed. The browser's Back does the same. This was checked:
- on desktop (Oct 19–25 and Oct 5–11);
- on a 390 px phone (Oct 12–18);
- with the Enter key on each focused control (Oct 26–30);
- for B07 (Meta, Oct 19–25).

**A recorded zero is not missing coverage.**

| | B07 Meta, Oct 19–25 (revised to $0.00 through the ads feed) | B09 Local Services, Oct 19–25 (the coverage gap) |
|---|---|---|
| Chart | A point on the axis (`data-status="zero"`) | A gap in the line |
| Weekly table | "$0.00 (recorded)" | "no record" |
| Explanation | "$0.00, recorded: the platform reported spend on 7 of 7 days, and it was zero." | "No spend record on any of its 7 days. This is not $0" |
| Daily evidence | 7 stored records, each "$0.00 · recorded zero", with its raw event | 7 days "no spend record", and the incident's callout |
| Summary | "All 7 days have a spend record: every one reports $0.00, a recorded zero." | "No day of this week has a spend record … That is no record, not $0." |

The mixed week, B09 Oct 12–18, shows one record ($117.91) and six days with "no spend record":
"1 of 7 days has a spend record ($117.91 in all); the other 6 have none, which is not the same as
$0."

**Phone, touch, keyboard, scope, accessibility.**
- At 390 and 320 px the page never scrolls sideways.
- The Spend cell of a day with a record, of a day without, and every "recorded zero" label lie
  inside the viewport.
- On a touch phone (`hasTouch`, `isMobile`), taps select the point and open the evidence.
- The channel and week controls are native buttons. Focused, they show a focus ring, and Enter
  selects them.
- A partner restricted to B20 sees B20 only. `?branch=B09` says "B09 is outside your scope", and
  the evidence URL for B09 shows no selection.
- axe (WCAG 2.2 AA and best practice) finds 0 violations on the Overview with a selection (desktop
  and 390) and on the evidence (desktop).

### Critique pass and fixes

1. **The phone evidence hid the amounts.** The day-by-day table had a 560 px minimum width. At
   390 px its Spend column, and with it "$0.00 · recorded zero", sat off to the right inside a
   sideways-scrolling table. A reader saw a campaign on a zero day without seeing it was $0.00.
   - Now three columns (Day, Spend, Campaign) fit 320 px; the raw record's id sits under the
     campaign.
   - "no spend record" and "$0.00 / recorded zero" sit in the same column, one under the other.
   - The first fix still clipped the third column. Its header, "Campaign and stored record", does
     not wrap, so it widened the table past the screen. The header is now one word, and a long
     campaign name may break.
   - The spec checks those cells lie inside the viewport at 390 and 320, and that the table itself
     needs no sideways scroll.
2. **A mixed week was called zero.** A week with three $0.00 days and four days without a record
   showed as "zero". Missing days now take precedence: the week is "partial", with "$0.00, recorded
   on 3 of 7 days: the platform reported zero. The other 4 days have no spend record, which is not
   the same as zero." Covered by the unit and integration tests.
3. **The hold got slower.** See the timing below.
4. **The hold list jumped.** The panel sits above the hold list and renders about half a second
   after it. Its placeholder was about 340 px tall, so when the panel arrived the B09 hold moved
   down by 437 px at 1440 and by 701 px at 390. A reader reaching for it would miss.
   - The panel's height follows its chart, which scales with the width: 686–1,276 px across 26
     widths. A first try with Tailwind's five breakpoints still moved the hold 54 px at 1280.
   - The placeholder now holds the middle of the measured range in nine width bands.
   - Measured after the fix at 18 widths from 320 to 1920 px, the hold moves at most 37 px
     either way (`overview-movement/timing/shift-after.jsonl`).
   - The spec checks it moves at most 40 px at 1440 and 390.
   - A branch's panel is taller than the all-branches panel (800 px against 776 at 1440), so after
     choosing a branch the hold can still move about 55 px.
5. **The last week looked like a fall.** The window ends on Oct 30, so its last week counts 5 days,
   and its first week 6. Both were solid points, so every line seemed to drop at the end: Google
   Search across all branches fell from about $68,000 to $47,000. Meanwhile the explanation called
   that week partial.
   - A point that counts fewer than 7 days is now hollow, for either reason.
   - The caption says "a hollow point counts fewer than 7 days".
   - The spec checks hollow and solid points.

### Time until the B09 hold is usable

The R-34 harness and protocol (§1), on the production build at each stage. Each figure is the
median, with min–max, in milliseconds; "warm" is every load after the first one following a
reseed.

| Warm loads | Before (`2aebf91`) | Panel reads beside the page's | Reads after the page's | **Final: after, page's holds reused** |
|---|---|---|---|---|
| Direct load of `/` (n = 6) | 1,197 (1,163–1,314) | 1,254 (1,235–1,285) | 1,270 (1,231–1,391) | **1,220 (1,187–1,253)** |
| Guided start, `/demo` → Start (n = 6) | 1,135 (1,101–1,163) | 1,302 (1,232–1,429) | 1,197 (1,173–1,234) | **1,182 (1,140–1,196)** |
| Server: the chunk with the holds (n = 2) | 1,075 (1,058–1,091) | 1,174 (1,171–1,176) | 1,105 (1,086–1,124) | **1,101 (1,099–1,102)** |

| First load after a reseed | Before | Beside | After | **Final** |
|---|---|---|---|---|
| Direct (n = 2) | 1,307 (1,303–1,310) | 1,376 (1,329–1,422) | 1,470 (1,312–1,627) | **1,339 (1,311–1,366)** |
| Guided (n = 2) | 1,177 (1,171–1,183) | 1,644 (1,603–1,684) | 1,244 (1,231–1,256) | **1,212 (1,181–1,243)** |
| Server (n = 1) | 1,252 | 1,282 | 1,439 | **1,215** |

Raw lines, one per load: `overview-movement/timing/{before,after-parallel-reads,after-reads-deferred,after-final}.jsonl`.
The driver reseeds the database before each batch and checks that ANALYZE ran (§1).

**What the stages showed:**
1. **Reads beside the page's.** The panel's reads took the pool's ten connections ahead of the
   hold's. The guided start was 167 ms slower, the server 99 ms.
2. **Reads after the page's.** It still read the decision holds again: about 0.45 s of database
   work, just as the hold was being shown. Alone, at all branches, that read took 435–491 ms of the
   panel's 457–524 ms; the panel's other reads took about 50 ms together. The guided start was
   still 62 ms slower.
3. **Final.** The panel reuses the page's holds.
   - The direct load is 23 ms slower at the median, inside the spread: the two ranges overlap.
   - The guided start is 47 ms slower, and its ranges do not overlap: a small, real cost.
   - The server is 26 ms slower, with two loads each.

**Net:** the B09 hold is usable about 25–50 ms later than before this change (2–4 %), at
1.1–1.3 s either way.

**When the panel itself appears.** Six direct loads of the final build (a scratch Playwright
script):
- In five, the panel's headline showed 513–519 ms after the hold.
- In the first, cold load, both showed together.

The panel's reads take about 50 ms, so the reads are not what holds it back.
- In the HTML stream, the server sends the panel 14–21 ms after the holds (five GETs of the
  October Overview).
- The wait is in the browser. React's streaming runtime (19.3, read in
  `react-dom-server.node.production.js`) spaces out the reveals of successive Suspense
  boundaries. Its reveal script waits until 300 ms after the previous reveal, or 500 ms on its
  animated path.
- So the panel shows about half a second after the hold, however fast its reads. That is why its
  placeholder must hold the panel's height (fix 4 above).

**Confirmation on the committed build.** The placeholder fix (CSS on the loading state only) came
after the final timing. So the hold was timed once more on the committed build, with one seed
(`timing/final-confirm.jsonl`):

| | Warm | First load |
|---|---|---|
| Direct | 1,228 (1,206–1,390), n = 3 | 1,618, n = 1 |
| Guided | 1,154 (1,150–1,178), n = 3 | 1,281, n = 1 |
| Server | 1,129 (1,102–1,156), n = 2 | 1,215, n = 1 |

Warm loads match the final column. The single first direct load is slow; one of two first loads
in the third column was too (1,627).

### Live check in Chrome (final build)

In Chrome (Claude in Chrome), on the production build at port 3100, freshly seeded, as the
marketing analyst:
1. On `/?period=oct&branch=B09`, clicked "Google Local Services", then "Oct 19–Oct 25". The URL
   became `…&channel=google_lsa&week=2026-10-19#movement`. The panel read "Google Local Services
   at B09 · Oct 19–Oct 25. No spend record on any of its 7 days. This is not $0".
2. **Open evidence** led to `/branches/B09/trace?period=oct&metric=paid_spend&channel=google_lsa&week=2026-10-19`.
   - The heading read "Selected on the Overview: Google Local Services · Oct 19–Oct 25".
   - The day rows were 2026-10-19 to 2026-10-25, all "no spend record".
   - Incident #2455's callout was shown.
3. **Back to the Overview selection** led to `/?period=oct&branch=B09&channel=google_lsa&week=2026-10-19#movement`.
   - The scope was B09, with the branch picker on B09.
   - Google Local Services and Oct 19–Oct 25 were pressed, with the explanation shown.
   - Focus was on the panel.

Chrome's screenshot timed out, as it had earlier in this session. The checks above are DOM reads.
The screenshots come from Playwright.

### Screenshots (`overview-movement/screens/`)

**Before**, commit `2aebf91` (`baseline_*`, desktop 1440 and phone 390): the October Overview, the
B09 branch page, and B09's paid-spend trace.

**Sketches** (`overview-prototype-*`): layouts C (chart first) and D (decision first).

**After**, this change (`final_*_on-2aebf91`):

| State | Desktop 1440 | Phone 390 | Phone 320 |
|---|---|---|---|
| The Overview, all branches, before choosing a branch (`overview-all`) | ✓ | | |
| The panel at 320 px (`branch-selected`) | | | ✓ |
| B09: a point selected and explained (`point-selected`). Desktop: Local Services, Oct 19–25. Phone: Oct 12–18 | ✓ | ✓ | |
| That point's daily records (`evidence-selected-point`): 7 days without a record on desktop; 1 record and 6 without on the phones | ✓ | ✓ | ✓ |
| Back on the Overview (`returned`); byte-identical to `point-selected` | ✓ | | |
| B07 Meta's recorded $0.00 week on the chart (`real-zero`) | ✓ | | |
| Its seven $0.00 records (`evidence-real-zero`) | ✓ | ✓ | |
| B09 refused to the B20 partner (`outside-scope`) | ✓ | | |

### Checks

On the final working tree:

| Check | Result |
|---|---|
| Typecheck, lint | Pass |
| Unit and integration tests for the Overview and drift review (4 files) | 46 passed |
| Browser, final build, isolated database: `zy-overview-movement` (6 tests) and `z-trace` | 8 passed |
| Pixel baselines (`VISUAL=1`, default database) | `overview-1440` and `overview-390` regenerated after the last chart change. The incident baselines are unchanged |

**Full regression** (`C:/Temp/final-regression-overview.sh`): one run, every step in sequence,
every step exit 0.
- Typecheck and lint pass.
- Vitest: 73 files, 874 passed and 2 expected failures. The previous regression (drift review)
  had 71 files, 860 and 2; the 14 new tests are this change's.
- Seed, then the AI eval: 15 of 15 passed.
- The held-out evals (investigator, ChangeGuard, VP acceptance, shadow acceptance) exit 0.
  - Their per-scenario output is identical to the previous regression's, timings aside.
  - That includes the existing FAIL and CRIT lines: ChangeGuard HO-14, HO-18, HO-25 and HO-28;
    VP-01, VP-05, VP-06, VP-09, VP-10 and VP-12.
  - These are measured results of those packs, not gates. This change does not touch them.
- Build passes.
- Browser, every spec with `VISUAL=1`: 125 passed, 1 skipped (the demo-video recording, which
  runs only with `RECORD_DEMO`). Before: 119 passed and the same skip. The six new tests are this
  change's. Playwright retries nothing in this project.

Earlier runs, their screenshots and the measurements found the defects listed under "Critique
pass and fixes". Each was fixed and the affected specs were rerun. The results above are each
spec's last run, on the final build.

## 6. Limitations

- **One metric.** The chart draws paid media spend only. Cost per customer is not charted by week.
  A weekly ratio over a partial or missing week would mislead, and its denominator (serviced
  customers) matures late. The CAC tile and the trace keep the period figure.
- **UTC weeks.** Weeks run Monday to Sunday in UTC, not in the branch's local time. The first week
  (Aug 31 – Sep 6) has 6 days in the window and the last (Oct 26–30) has 5. Both say so.
- **Spend records only.** The evidence lists spend records. Lead records are counted in the
  explanation ("22 lead records … a count, not dollars"), not listed. Lead-level evidence stays
  with the incident and the trace's other metrics.
- **Coverage gaps only on the chart.** Markers come from coverage-gap incidents' stored evidence,
  in a single-branch scope. Other incidents (quarantined records, unmapped spend) appear in the
  hold list and the trust line, not on the chart.
- **No natural zero week.** The seeded world has no week of recorded $0.00. The browser spec
  creates one as a revision through the ads feed and restores it afterwards. The integration test
  builds its own.
- **Branch picker reloads.** Choosing a branch is a form submit: one server round trip. Selecting
  a point is not.
- **Small chart text on phones.** The SVG scales down, so its axis labels are small at 390 px. The
  week buttons and the exact-values table carry the same values at full size.
- **The panel shows about half a second after the hold.** React spaces out streamed reveals, so
  the placeholder shows meanwhile. It holds the panel's height to within 37 px at the 18 measured
  widths. A branch's panel is a little taller, so after choosing a branch the hold can still move
  about 55 px.
- **The hold is 25–50 ms later than before** (2–4 %): the price of the panel's remaining reads and
  rendering, measured above.
- **Timing is a small sample** from one Windows laptop, with the database on the same machine.
  See the protocol in §1.
- **The in-app browser pane is hidden** in this session, which stalls Suspense reveals there. It
  was used for DOM reads only. The screenshots come from Playwright, and the walkthrough used
  Chrome.
