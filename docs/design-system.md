# Design system

How Revenue Signal OS looks and behaves, and why. Patterns are studied from IBM Carbon (density,
tables, accessibility), Elastic Kibana and Sentry (investigation and issue detail) and shadcn/ui
(composable React primitives). Nothing is copied: no third-party branding, no template.

**The test every screen must pass:** can a marketing leader understand the business problem in
15 seconds, investigate it in a few clicks, and trust what the screen says?

## Tokens (`app/globals.css`)

| Group | Tokens | Rule |
|---|---|---|
| Surfaces | `bg`, `surface`, `surface-2`, `sunken`, `border`, `border-strong` | Neutral. Elevation is one soft shadow (`shadow-raised`), never gradients. |
| Text | `text`, `muted`, `faint` | All three pass 4.5:1 on every surface they sit on (tested). |
| Interaction | `accent`, `accent-hover`, `accent-soft` | Blue means "you can act here": links, primary buttons, focus ring. Nothing decorative is blue. |
| States | `bad`, `warn`, `good` + `-soft` | Red, amber, green only for a state the data is in. Never the only signal: every state also has a word. |
| Shell | `shell`, `shell-raised`, `shell-border`, `shell-text`, `shell-muted` | Dark navigation, so content surfaces stay calm. |
| Charts | `chart-paid`, `chart-unknown`, `chart-other`, `chart-good` | Categorical; each series also has a legend label and a hidden data table. |

`tests/unit/design-tokens.test.ts` computes WCAG contrast for every text token on every surface
it is used on (4.5:1), white on accent and shell (4.5:1), and the focus ring and meaningful chart
colours against the surface (3:1). A token change that breaks contrast fails the build.

**Type scale.** Page title 22/32 semibold · panel title 13/20 semibold · body 14/20 · meta and
table headers 11–12 · KPI values 26/32 semibold. Numbers are tabular everywhere (`tnum`).

**Density.** Tables 8 px vertical cell padding (about 36 px rows), panels 16 px padding, 24 px
between sections. Dense where people compare rows, spacious where they read a sentence.

## Components (`components/ui.tsx` unless noted)

| Component | Use it for | Notes |
|---|---|---|
| `PageHeader` | Every page's title block | Breadcrumbs, eyebrow (scope · period), title, one-paragraph description, actions, a toolbar row for filters |
| `Card` | Any titled panel | `flush` for edge-to-edge tables; `action` slot for a link or button |
| `Segmented` / `PeriodTabs` | Choices that live in the URL (brand, period) | Links, not buttons: shareable, back-button safe; `aria-current` marks the choice |
| `ButtonLink` | Navigation that looks like an action | primary / secondary / ghost |
| `Stat` | Every headline number | Definition one click away (formula, source, caveat); optional `delta` with which direction is good |
| `Badge`, `SeverityBadge`, `StatusBadge` | States and labels | `dot` for status; colour plus word |
| `Th` / `Td` / `TableWrap` | Tables | Scroll horizontally inside their panel, never the page; header cells are `scope="col"` |
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
6. **Numbers carry their definition.** Every KPI opens to its formula, source and caveat;
   `/definitions` is the dictionary.

## Screens redesigned so far

| Screen | Status |
|---|---|
| Shell (sidebar, top bar, guide bar) | Done |
| Overview | Done: trust callout, KPIs vs September, issues requiring review, weekly composition chart, bridge, branch and brand tables, freshness |
| Incident detail | Done: header with impact strip, sticky section navigation, evidence / fix & approval / records / audit, a rail with the decision and the role-by-role fix steps |
| Incidents list, AI Investigator, Customer Journeys, Decision Lab, Google feedback, Definitions, Integrations, Audit & Health | Restyled through the shared components (cards, tables, badges, tabs); their layouts are the next slices |

Committed screenshots are the pixel baselines: Overview and the B09 incident at 1440 and 390 px
(`tests/e2e/__screenshots__/`, checked with `VISUAL=1`). Full before/after sets (12 pages × 4
widths) are regenerated with `npx tsx scripts/capture-screens.ts docs/redesign/<dir> <base-url>`
against a demo-mode server; `docs/redesign/` is git-ignored and the sets are archived outside the
repository.
