# Premium polish: the other scenes (2026-11-16)

The B09 decision view was redrawn first (`HOLD-TO-DECISION.md` §9). Its §9.5 left five scenes of the
same polish spec undone. This pass does them, one scene at a time:
- **3.1** the Overview's headline figure;
- **3.3** B20's fix, from Execute to its receipt;
- **3.4** the incident queue;
- **3.5** Decision Lab's verdict rows;
- **3.6** the incident page's right rail.

**No decision logic changed.** Every number, verdict and state on these screens comes from the same
functions as before. One read was added, `listQueueGroups` (`lib/workflow/queries.ts`): the queue's
own filter and order, counted and listed per incident type.

The rules stayed:
- patterns came in, dependencies did not: no shadcn/ui, Recharts, dnd-kit or Motion;
- light theme only, Geist and Lucide;
- no drag and drop, tickers, flips, globes or confetti;
- every colour beside a word;
- every control works from the keyboard;
- under reduced motion nothing moves and nothing is lost.

The patterns are from `abderrahimghazali/shadcn-fintech`, read from a read-only clone:
- `AnimatedCounter`: 1200 ms, cubic ease-out;
- the quick transfer's idle, sending and done states;
- the health score's factor rows;
- the recent transactions' row recipe.

## 1. What changed

| Scene | Before (`0d97c13`) | After |
|---|---|---|
| 3.1 Overview | "187 open exceptions involve **$10,362** of collected revenue…" inside a 14 px paragraph | **$10,362** leads at 32 px under the title and counts up once on first paint. The sentence under it says what the figure is, its two parts and where to start. The funnel paragraph follows. The figure's definition is one click away |
| 3.1 KPI tiles | Border and shadow; ▲ ▼ ■ glyphs | The panel ring; a trend icon beside the sign and the words |
| 3.3 B20 Execute | "Executing…" in a half-faded button | A spinner beside "Executing…". The button stays focusable (`aria-disabled`). The outcome message has its icon, a check or a cross, beside its words. Focus moves to the receipt, as before |
| 3.3 B20 result | One green block: a key, a result line and 20 mixed rows | A receipt with an outcome strip (icon and words: "Execution succeeded and verified", who, when). Then the one number the fix was for, set at 22 px: **Paid-media CAC at B20, whole period $364.75 → $284.06**. Then "Expected to move" and "Ledger, must not move", each ledger row "conserved". An unchanged value is muted behind "=". The repeat-safety proof (the idempotency key) is one click away |
| 3.4 Queue | A flat table, 50 cases a page; on the seeded world page 1 held 44 branch mismatches | Six groups, one per incident type, the type that needs someone first on top and open. Each header shows: a mark tinted by the type's highest severity, the name, a count badge, where its cases are, that severity in words, the type's own amount with "spend" or "revenue", and its full list. The five most urgent cases sit one level in, under the same columns. "All cases" switches to the old paged list; a picked type is its own paged list |
| 3.5 Verdicts | A table: badges, and "4 checks" / "2 blockers" links under them | Factor rows: a mark tinted by the worse of the first two verdicts, the channel and its spend, three chips in words, a chevron. A row opens in place to the three verdicts' reasons, side by side. On a phone each chip carries its column's name |
| 3.5 Verified readiness | Bordered boxes | The same factor rows |
| 3.5 Scenario builder | "Run projection" first, beside "Save" | A footer: why it cannot run yet on the left; "Save scenario", then **Run projection**, on the right |
| 3.6 Rail | Two default panels: the decision, then the four steps with "You can." in a sentence | Three compact cards (12 px padding, 14 px titles), one job each. **Decision**: what this role can do. **How a fix is applied**: each step's permission in words at its right, "You can" or a lock and "Not your role". **Freshness**: the feeds behind the records, each "fresh", "stale" or "failing", by the top bar's rule |
| Every tile | `border` and `shadow-raised` | The panel's hairline ring, `rounded-xl`: `Stat`, `KpiTile`, the impact strip, and the definitions, feedback, onboarding and drift-review panels. Buttons and segmented controls keep the soft shadow; overlays keep theirs |
| Every table header | 11 px semibold, `tracking-wide` | 11 px medium, uppercase, `tracking-wider`; a row's hover tint fades in over 100 ms |

**The counter, and why it cannot show a wrong figure.** `components/CountUp.tsx` renders the final
figure as the element's text from the first byte. While it counts, CSS paints that text transparent
and draws the moving digits over it from `data-display`, with empty alternative text. A test, a copy,
a print and a screen reader therefore only ever read $10,362. The CSS applies only with scripting on
and no reduced-motion preference. It lets go after three seconds by itself, so a script that never
runs cannot leave $0 on screen. It is the page's one animation.

**Files:**
- new:
  - `components/CountUp.tsx`;
  - `components/actions/QueueGroups.tsx`;
  - `docs/agent-work/premium-polish/` (the captures, `checks.json` and `harness/scenes.cjs`);
- changed, by scene:
  - 3.1: `app/page.tsx`, `components/AtRiskSplit.tsx`, `app/globals.css`;
  - 3.3: `components/actions/SnapshotDiff.tsx`, `WorkflowPanel.tsx`, `ProposalControls.tsx`,
    `components/ReplayPanel.tsx`;
  - 3.4: `app/exceptions/page.tsx`, `components/actions/CaseQueue.tsx`, `lib/workflow/queries.ts`;
  - 3.5: `components/decisions/VerdictMatrix.tsx`, `ScenarioBuilder.tsx`, `app/decisions/page.tsx`;
  - 3.6: `app/exceptions/[id]/page.tsx`;
  - every tile: `components/ui.tsx`, and the five pages named in the table;
- `docs/design-system.md`: behaviour rules 13–15, and the new and changed components.

## 2. Taken, adapted, left out

**Adapted:**
- **The Overview's hero.** The spec asks for a hero card with the period tabs in its action slot. The
  page title, the eyebrow and the tab row already frame the answer, so the figure leads the header
  instead of sitting in a second frame.
- **The queue's groups are counted on the server.** The queue pages on the server, so a group
  counted on the page would read "24" for a type with 123 cases. `listQueueGroups` counts and sums
  each type under the reader's filters, and lists its five most urgent cases in the queue's own
  order.
- **A type's amount** adds up its own cases only, all spend or all revenue, and says which. Types are
  never added together (behaviour rule 7). The "Amount at stake by incident type" card above stays.

**Left out, on purpose:**
- **Deleting the "Verified readiness" list** (spec 3.5). It stays a card of its own, in the same
  factor-row form:
  - the VP journey J8 reads it;
  - the readiness summary's "Review the channel" button jumps to it;
  - it holds the policy, rule by rule.
  Folding it into the verdicts is an information-architecture decision, not a polish.
- **The rail's "Evidence (selected record)" card** (spec 3.6). The Evidence panel already leads the
  main column, and a copy in the rail would repeat it. It waits for the inspector, which would give
  it a record to select.
- **`ChartLegend`, square chart dots, `font-medium` panel titles** (spec §1–2). They are not in these
  scenes. The panel title stays the B09 slice's 15/24 semibold.
- **The phone receipt's table.** On a phone it still scrolls sideways inside its own frame, as it did
  before. The CAC change above it does not scroll.

## 3. Review of the rendered screens

The first after-captures were reviewed for hierarchy, wrapping, keyboard focus and what a screen
reader hears. The quality gates then ran axe on every page. Six problems were found, and all were
fixed before the final captures.

| Found | Fixed |
|---|---|
| Decision Lab's "2 · Decision readiness" header wrapped to two lines | Wider verdict columns; the header row never wraps |
| The queue's "43 branches" wrapped inside its cell | The group's branch cell does not wrap |
| A one-case group read "List all 1" | "Open as a list", with its type for screen readers |
| Words laid out side by side ran together for a screen reader: "Branch mismatch58 cases", "whole period$364.75", "the fix.You can", "Integrity:Fail" | A space between them, in six places: group buttons, the receipt line, the rail's steps, verdict chips, verified-readiness rows, and the Overview figure beside its definition link. The receipt's arrow is hidden from screen readers, which hear "to" |
| The harness read the receipt line from the collapsed dry-run copy (an empty string) | It reads the execution's own receipt |
| axe, at 390 px: the queue's "List all" links were 16 px tall, beside the group buttons (WCAG 2.2 target size; serious, 3 links) | Every group's list link, and the rail's "Audit & Health" link, is a 24 px target. The gate passes at all four widths |

## 4. Measured in the rendered pages (`premium-polish/checks.json`)

The builds:
- before: `1YtM3m5k-65AfCnBQh3a_`, built from `6ed9066`, whose code is `0d97c13`'s;
- after: `yGNKzTTPMrI3OX5Xz2jNA`, the final code's build.
Both read `revenue_signal_rc`, freshly seeded.

**The count:**
- in every frame the element's text is "$10,362";
- mid-count the overlay is `"$4,565" / ""` and the text is transparent;
- settled, there is no overlay and the text is ink;
- under reduced motion it settles on mount and nothing is painted over.

**Keyboard:**
- queue groups are buttons in reading order, and only the first starts open;
- Enter on "Branch mismatch 58 cases" opens it and shows 5 cases;
- verdict rows open from the keyboard at 1440 and 390 px.

**B20's Execute:**
- the busy button is `aria-disabled`, still focusable, with its spinner;
- the request returned 200 and focus moved to the receipt;
- the status read "Executed and verified."; all 5 ledger rows were "conserved";
- the repeat-safety proof opens to the key.

**Contrast:**
- every measured line passes AA's 4.5:1;
- the lowest: a table header at 4.83:1 (11 px on `surface-2`), and a step's number on its green tint
  at 4.77:1;
- the rest are 5.37:1 or more.

**Clipping:** no sideways page scroll on any of the five scenes at 1440 or 390 px.

## 5. Evidence

All in `premium-polish/`, captured by `harness/scenes.cjs`. "Before" and "after" pairs use the same
URL, role and database; only the build differs. Each pair exists at 1440 × 900 and at 390 × 844:
- **3.1:** `{before,after}-overview-{1440,390}.jpg`, and `after-overview-counting-1440.jpg` (a frame
  mid-count);
- **3.3:** `{before,after}-b20-approved-1440.jpg`, `{before,after}-b20-executing-1440.jpg` and
  `{before,after}-b20-receipt-{1440,390}.jpg`;
- **3.4:** `{before,after}-queue-{1440,390}.jpg`, and `after-queue-keyboard-1440.jpg` (a second group
  opened with Enter);
- **3.5:** `{before,after}-lab-{1440,390}.jpg`, and `after-lab-open-{1440,390}.jpg` (the first row
  opened from the keyboard);
- **3.6:** `{before,after}-rail-{1440,390}.jpg`.

**Executing frames.** In both builds the frame held the request, then aborted it, so nothing ran.
The after build's Execute then applied B20's replay once, as the golden path does.

**To re-run:**
1. Seed `revenue_signal_rc`.
2. Serve a build of `0d97c13` on port 3990 and this build on 3991, both in demo mode on that
   database.
3. Run `node docs/agent-work/premium-polish/harness/scenes.cjs docs/agent-work/premium-polish`.

## 6. Verification

Code: the final working tree, build `yGNKzTTPMrI3OX5Xz2jNA`. Every check ran on `revenue_signal_rc` with
`CI=1 PORT=3989`; the demo database `revenue_signal` was never touched.

| Check | Result |
|---|---|
| `npx tsc --noEmit`, `npx eslint .` | Clean |
| `npx vitest run tests/unit` | 379 of 379 (36 files) |
| `VISUAL=1 npx playwright test z-layout --update-snapshots` | 8 of 8. The Overview and incident baselines were re-generated on purpose: the headline figure, the ringed tiles, the trend icons and the rail all change them |
| `VISUAL=1 npx playwright test z-layout`, a plain re-check | 8 of 8: every page has no sideways scroll at 1440, 1280, 768 and 390 px, and the four baselines match |
| `z-quality-gates`, axe, layout shift and hydration | 7 of 7. Zero axe violations (WCAG 2.2 AA) on every page at 1440, 1280, 768 and 390 px; CLS under 0.1 at 1440 and 390 px; every page hydrates without an error. The first run failed axe at 390 px (target size, §3); this is the run after the fix |
| `z-redesign-navigation` (the queue's filters, chips, state strip and a partner's scope) | 11 of 11 |
| `golden-path`, `os-golden-path`, `z-a11y-regressions`, `z-redesign-navigation` | 37 of 37, on the build before the last fixes (`7zA2EVNWHcmrZR-OhHDHs`). It covers B20's propose, dry run, approve and Execute; the repeat that returns the stored result; B09's re-map through the receipt; the receipt's row headers and "(unchanged)" words; and the queue. The final build differs from it by the 24 px link targets, spaces for screen readers in four places, comments, the counter's settled guard and the queue's grouping key |
| `docs/agent-work/premium-polish/harness/scenes.cjs` on the final build | Every check in §4 |

## 7. Not done

- **The spec items left out on purpose** (§2): the Verified-readiness merge, the rail's selected-record
  card, `ChartLegend`, and the phone receipt's sideways table.
- **The full release regression** was not run: only the specs that open these screens. `d431e9b`
  stays the accepted checkpoint.
- **Target size was not measured.** The queue's group buttons are at least 44 px tall on a phone
  (`min-h-11`). The verdict rows and the desktop group rows were not measured against the 44 px
  touch aim.
