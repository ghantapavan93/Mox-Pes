# Design system

How Revenue Signal OS looks and behaves, and why. Patterns are studied from IBM Carbon (density,
tables, accessibility), Elastic Kibana and Sentry (investigation and issue detail) and shadcn/ui
(composable React primitives). The B09 incident's decision view (HOLD-TO-DECISION.md §9) also
studies Linear (a quiet scope line over one verdict), OpenStatus (a strip of days), Knock (one
event: what arrived, why it did not count), GitHub's diff and Midday's money type (what moved),
and the shadcn-fintech template's card frame and legends. The premium-polish pass
(`agent-work/PREMIUM-POLISH.md`) took four more patterns from that template's code: one counter on the
headline figure, a send flow's busy-then-done states, factor rows, and a transactions list's grouped
rows. Patterns come in, dependencies do not, and nothing is copied: no third-party branding, no
template.

**The test every screen must pass:** can a marketing leader understand the business problem in
15 seconds, investigate it in a few clicks, and trust what the screen says?

## Tokens (`app/globals.css`)

| Group | Tokens | Rule |
|---|---|---|
| Surfaces | `bg`, `surface`, `surface-2`, `sunken`, `border`, `border-strong` | Neutral. A panel (`Card`) and a tile (`Stat`, `KpiTile`, the incident's impact strip) are framed by a hairline ring, `ring-1 ring-text/10`, `rounded-xl`, with no shadow at rest, so the frame recedes and the data carries the colour. Buttons, segmented controls and overlays keep the one soft shadow (`shadow-raised`). Never gradients. |
| Text | `text`, `muted`, `faint` | All three pass 4.5:1 on every surface they sit on (tested). |
| Interaction | `accent`, `accent-hover`, `accent-soft` | Blue means "you can act here": links, primary buttons, focus ring. Nothing decorative is blue. |
| States | `bad`, `warn`, `good` + `-soft` | Red, amber, green only for a state the data is in. Never the only signal: every state also has a word. |
| Shell | `shell`, `shell-raised`, `shell-border`, `shell-text`, `shell-muted` | Dark navigation, so content surfaces stay calm. |
| Charts | `chart-paid`, `chart-unknown`, `chart-other`, `chart-good` | Categorical; each series also has a legend label and a hidden data table. |

`tests/unit/design-tokens.test.ts` computes WCAG contrast for every text token on every surface
it is used on (4.5:1), white on accent and shell (4.5:1), and the focus ring and meaningful chart
colours against the surface (3:1). A token change that breaks contrast fails the build.

**Type scale.** Page title 22/32 semibold (14/24 medium in `muted` when `PageHeader quiet` hands
the page to a verdict) · the Overview's headline figure 32/40 semibold · verdict 26–28/32–36
semibold · panel title 15/24 semibold (14/20 in a compact rail card) · body 14/20, a verdict's
status 15/24 · meta and table headers 11–12, headers uppercase and `tracking-wider` · KPI values
26/32 semibold · money in a diff, and a receipt's one emphasized change, 22/28 semibold. Numbers are
tabular everywhere (`tnum`). One family, Geist and Geist Mono.

**Density.** Tables 8 px vertical cell padding (about 36 px rows), panels 16 px padding, 24 px
between sections. Dense where people compare rows, spacious where they read a sentence.

## Components (`components/ui.tsx` unless noted)

| Component | Use it for | Notes |
|---|---|---|
| `PageHeader` | Every page's title block | Breadcrumbs, eyebrow (scope · period), title, one-paragraph description, actions, a toolbar row for filters. `quiet` turns the title into a scope line when a verdict below leads the page |
| `Card` | Any titled panel | Hairline ring, `rounded-xl`; `flush` for edge-to-edge tables; the `action` slot sits at the header's right, for one link, button or view switch; `size="sm"` is the compact card of a rail (12 px padding, 14 px title) |
| `DecisionWindow` (`components/incidents/DecisionWindow.tsx`) | The dates a decision needs, one at a time | One radio group (arrow keys, Home, End; the selection follows focus; one tab stop). Each date is a mark and a word: verified is filled with a check, no record is hatched with a cross, a recorded $0.00 is sunken with a 0. The legend carries the counts. The selected week is underlined in accent and named in its own fact beside the window's. The selected date's evidence follows: received, why it does or does not count, what clears it, and its records on the daily evidence. 9 columns below `md`, 18 from it |
| `MoneyMoved` (`components/incidents/GapRecovery.tsx`) | What a correction moved | A diff in three tiles: − out of, + into, then the branch total, "unchanged" only with the proof. Amounts stay in ink; only the sign is coloured, so a move never reads as a loss or a gain. Before anything moves there is no out/in pair, only what is still filed elsewhere: a "$0.00" tile would read as recorded zero spend |
| `Segmented` / `PeriodTabs` | Choices that live in the URL (brand, period) | Links, not buttons: shareable, back-button safe; `aria-current` marks the choice. A 32 px sunken track; the current item stays dark |
| `Button`, `ButtonLink`, `buttonClass` | Every button, and navigation that looks like an action | One class list: `md` 32 px (the default) or `sm` 28 px tall, 16 px icons (14 at `sm`), an 8 px radius, a 1 px press, the global focus outline. Variants: `primary` (solid accent: at most one per decision state), `secondary` (outline), `ghost` (toolbar), `danger` (outline with red words). Both render `data-variant`. On a coarse pointer `.tap-target` widens the hit area to at least 44 × 44 px without changing the look. `busy` keeps the button focusable (`aria-disabled`), ignores further presses and shows `Working` with its working words, in a grid cell shared with the label so the width holds |
| `StateBadge` | The five states a figure or decision can be in | missing ("No record", dashed), held (amber, lock), zero ("$0.00 recorded"), corrected (green, check), approved (neutral, signature); built on `Badge`; never blue, which means "you can act here" |
| `Stat` | Every headline number that is a defined metric | Definition one click away (formula, source, caveat, link to its `/definitions` entry); optional `delta` with which direction is good, its sign and words beside a trend icon |
| `KpiTile` | Headline counts that are not defined metrics (queue sizes, feed health) | With `href` the tile links to the filtered view behind the number; `current` marks the active filter with `aria-current` and a 2 px accent ring |
| `CountUp` (`components/CountUp.tsx`) | The one headline figure that counts (Overview) | 1200 ms, cubic ease-out, from zero on first paint. The element's text is the final figure from the first byte; the moving digits are painted over it by CSS with empty alternative text, so tests, copies and screen readers only ever read the real number. Nothing moves under reduced motion or without scripting, and the overlay lets go by itself after 3 s |
| `CaseQueueGrouped` (`components/actions/CaseQueue.tsx`, `QueueGroups.tsx`) | The incident queue, by type | One row group per incident type: a disclosure button (chevron, a mark tinted by the type's highest severity, the name, a count badge), where its cases are, that severity in words, the type's own amount with "spend" or "revenue", and its full list. Its five most urgent cases sit one level in, under the same columns. The first group starts open |
| `SnapshotDiff` (`components/actions/SnapshotDiff.tsx`) | A dry run's or an execution's before and after | A receipt: the branch's paid-media CAC change set large when it moved, then "Expected to move", then "Ledger, must not move" with each row checked. A changed value is ink and semibold; an unchanged one is muted behind "=" and says "(unchanged)" to screen readers |
| `VerdictMatrix` (`components/decisions/VerdictMatrix.tsx`) | Decision Lab's three verdicts per paid channel | Factor rows: a mark tinted by the worse of the first two verdicts, the channel and its spend, three chips in words, and a chevron. The row opens in place to the three verdicts' reasons, side by side. Each chip's column name is visible on a phone and read out at every width |
| `FilterSelect`, `FilterChips` | GET filter forms | Labelled native selects; applied filters as removable chips, each linking to the view without it |
| `Pager` | Offset-paged lists | "Showing a–b of n", previous/next; disabled ends are `aria-disabled` |
| `SectionNav` | Long pages (incident, Audit & Health, Decision Lab) | Sticky anchor links under the top bar; sections set `scroll-mt-28` |
| `Badge`, `SeverityBadge`, `StatusBadge` | States and labels | `dot` for status; colour plus word |
| `Th` / `Td` / `TableWrap` | Tables | Scroll horizontally inside their panel, never the page; header cells are `scope="col"`, 11 px uppercase, `tracking-wider`; a row's hover tint fades in over 100 ms |
| `KV` | Label/value facts | `columns={1}` in a narrow rail |
| `Callout` | Why something is blocked, stale or done | info / warn / bad / good, with icon |
| `EmptyState`, `Skeleton`, `Forbidden` | Empty, loading, out-of-scope | Skeleton is a `role="status"` with hidden "Loading…" |
| `Sparkline` | Decorative trend beside a number | `aria-hidden`: the number is the content |
| `StackedWeeks` (`components/StackedWeeks.tsx`) | Weekly composition | Legend, gridlines, hidden data table via `aria-describedby` |
| `WeeklyBars` (`components/WeeklyBars.tsx`) | One weekly series with a reference line | Same accessibility contract |

## Shell (`app/layout.tsx`)

- **Sidebar**: grouped by job (Operate, Understand, Systems), one icon family (Lucide), active
  item marked with `aria-current` and a bar. Collapses to an icon rail on desktop (state on
  `<html data-sidebar>`, restored before paint, kept in localStorage). Below `lg` it folds behind
  a Menu button.
- **Top bar**: the viewer's scope (what every number is computed over), the synthetic-data note,
  data freshness (oldest last successful sync, and how many feeds need attention, linking to
  Audit & Health), and the demo role switcher.
- **Guide bar**: shown only on `?guide=b09` URLs (the four-minute path, `/demo`). Leaving is one
  click; it never changes business logic.

## Behaviour rules

1. **Filters live in the URL.** Period, brand, page and audit cursors are query parameters.
2. **A selector never widens access.** Scope is resolved on the server from the viewer; a brand
   or branch the role cannot see is refused (403) or reads as missing (404), whatever the UI shows.
3. **Disabled actions say why.** The incident rail lists the four steps of a fix and whether the
   current role may take each; proposal cards name the next role.
4. **Staleness is visible.** The top bar turns amber when any feed's last success is more than 36
   hours behind the business clock.
5. **No unbounded tables in the viewport, and no sideways page scroll.** Lists page on the server
   (incidents 50, customers, audit by keyset); wide tables scroll inside their panel. Every grid
   cell may shrink (`.grid > * { min-width: 0 }`), hidden data tables sit in an `sr-only` wrapper (a
   `<table>` ignores a 1 px width), every scroll container is `position: relative` (so `sr-only`
   labels inside a scrolling table cannot escape it), and raw JSON wraps anywhere. `tests/e2e/z-layout.spec.ts`
   loads all 12 pages at 1440, 1280, 768 and 390 px and fails on any horizontal page scroll: the
   first redesign build failed it on 9 of 12 pages, which is how these rules were found.
6. **Primary lists become cards on phones.** Below 768 px the incident queue, the customer
   directory and the audit trail render one card per row (the table is `display: none` there, so
   assistive tech meets each row once); other tables scroll inside their panel.
7. **Never add up what does not add up.** Incident amounts mix spend and revenue and overlap, so
   Incidents shows counts and per-type amounts, not a money total; the deduplicated revenue at
   risk is a defined metric on Overview.
8. **Numbers carry their definition.** Every KPI opens to its formula, source and caveat;
   `/definitions` is the dictionary.
9. **A verdict is ink, never a colour.** A decision-led incident opens on one verdict ("Hold the
   budget decision", "Still on hold · 5 of 18 days verified", "Coverage hold cleared · 18 of 18
   days verified"), the strongest line on the page, always in `text`. A cleared hold lets a person
   review a decision; it approves nothing, so it never turns green, and "No budget change was
   approved." sits under it. Colour belongs to the evidence, and every colour has a word.
10. **Legends carry values.** A legend lists each mark with its count: it is the summary of what it
    labels, not decoration.
11. **Open the first thing that needs attention.** Where a view lists many items, the first
    unresolved one is selected by default (Sentry's rule). With none unresolved nothing opens by
    itself, and the next fact (what moved) keeps the first screen.
12. **Two scopes side by side, never merged.** A filter the reader picked (the selected week) and
    the rule the decision needs (the decision window) are separate facts, each with its own word:
    "Selected week covered" next to "Decision window incomplete".
13. **Motion is spent on state, never on decoration.** The whole budget: the Overview's one
    headline count-up; an action's busy state (a spinner beside its working words, the button still
    focusable with `aria-disabled`) and its outcome (the icon swaps, the words say it, focus moves to
    the result); a disclosure's chevron turning, 150 ms; a row's hover tint, 100 ms; and the date
    strip's selection. No tickers, drag and drop, flips, globes or confetti. Under reduced motion
    the same information arrives with nothing moving.
14. **Group a long list before listing it.** A queue opens grouped by type, the type that needs
    someone first on top and open, each with its count, its highest severity in words and its own
    amount, all spend or all revenue, never added across types (rule 7). Every case stays one link
    away: the type's own list is paged, and a single list of every case is one switch away.
15. **A result is a receipt, not a paragraph.** A fix's outcome leads with its word and icon, then
    the one number it was for, set large, then what moved and the ledger that must not, each checked.
    The proof that it ran once stays one click away.

## Screens

Every page opens with `PageHeader` (eyebrow = area · scope · period), answers its main question
before showing detail, and keeps filters in the URL.

| Screen | Information architecture |
|---|---|
| Shell | Grouped sidebar (Operate, Understand, Systems), collapsible rail, top bar with scope and freshness, guide bar on `?guide=b09` |
| Overview | The headline figure (revenue in open exceptions, the page's one count-up) with what it is and where to start, then the funnel behind it; trust callout, what changed, KPIs vs September, issues requiring review, weekly composition, bridge, branch and brand tables |
| Incidents | KPI strip (open, high severity, needs approval, closed; no money total, because case amounts mix spend and revenue and overlap), the fix workflow as a left-to-right state strip with side exits, amount at stake by incident type (click to filter), approval lane, then the filterable queue with removable filter chips: grouped by incident type (rule 14), or every case in one paged list (`?view=list`); a picked type is its own paged list |
| Incident detail | Decision-led incidents (a coverage gap, a refused spend revision): a quiet scope line, one verdict, one primary action. For a coverage gap, the decision window follows as a strip of dates, with the selected week set against the window and the selected date's evidence, then what moved, as a diff. Then the details, the story, the impact strip and the sections. Others: impact strip, sticky section navigation (evidence, fix & approval, records, audit), and a rail of compact single-job cards: the decision this role can take, who takes each step of a fix, and how fresh the feeds behind the records are. An execution reads as a receipt (rule 15) |
| AI Investigator | Model/deterministic mode stated first, incident scope callout, ask panel, recent investigations as a list with confidence and proposals |
| Customer Journeys | Lifecycle tiles (click to filter), identity review queue *above* the directory (decisions before browsing), directory with search, branch and lifecycle filters |
| Decision Lab | Branch and period in the header toolbar; sections numbered by the three questions (records right? enough evidence? did spend cause it?); readiness verdict first, blocking incidents linked; the verdicts and verified readiness as factor rows that open in place; the scenario form's actions in its footer, the primary one last |
| Google feedback | Decisions grouped by outcome (sent, withheld on purpose, not eligible), latest decisions, the event that would be sent, rules and limits |
| Definitions | Index of every entry, attribution policy, one card per metric with a stable anchor (`#metric-<key>`) that every KPI links to |
| Integrations | Health strip (connector, record versions, quarantine, unrecovered failures), then three views in the URL: CRM connector (operate), Field mapping (inspect), Ingestion pipeline (audit the log); the full audit trail lives on Audit & Health |
| Audit & Health | Health strip first (feeds, failed runs, domain events, connector), sticky section navigation, filterable audit trail with expandable details, throughput, feeds and runs, domain events, connector |

Committed screenshots are the pixel baselines: Overview and the B09 incident at 1440 and 390 px
(`tests/e2e/__screenshots__/`, checked with `VISUAL=1`). Full before/after sets (12 pages × 4
widths) are regenerated with `npx tsx scripts/capture-screens.ts docs/redesign/<dir> <base-url>`
against a demo-mode server; `docs/redesign/` is git-ignored and the sets are archived outside the
repository.
