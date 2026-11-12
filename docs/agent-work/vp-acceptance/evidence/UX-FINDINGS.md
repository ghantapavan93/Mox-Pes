# UX red team: task-completion findings and their status

**What this is.** An AI evaluator walked the local production build in headless Chromium on
2026-11-12, as seven personas, at 390/768/1280/1440 px, with synthetic data. **It is not a study
with human users**, and nothing here shows that business users find the product intuitive
(R-35). Timings come from single runs. The evaluator changed no repository file.

Status is as of this commit. "Fixed" means changed in code and checked again in a browser.
"Gated" means a browser test now fails if the problem returns.

## Persona completion (first walkthrough)

| Persona | Result | What blocked or slowed them |
|---|---|---|
| 1 Marketing analyst | Completed | Incident #970 offered two other forms (a wrong turn) |
| 2 Finance controller | **Partly** | No page listed B09's October payments and refunds (P1-3) |
| 3 Engineer | Completed within permission | Root cause only visible in raw JSON |
| 4 VP | **Partly** | No single summary; uncertainty spread across caveats |
| 5 Nontechnical user | **Partly** | A plain "Not ready" answer, then undercut by jargon and a preselected unsafe scenario (P1-7) |
| 6 Approval boundaries | Completed | Every self-approval refused (403); two messages did not match state (P1-10, P1-11) |
| 7 Scope | **Leak found** | `/demo` showed B09 data to the partner and brand roles (P0-1) |

After the fixes the finance controller's task is possible: browser journey J2 completes it
(`tests/e2e/zx-vp-journeys.spec.ts`). The persona walkthrough was **not** repeated, so the
other "Partly" rows are unchanged as evidence.

## Findings

| # | Sev | Finding | Status | Evidence |
|---|---|---|---|---|
| P0-1 | P0 | `/demo` showed B09's incident, spend and leads to the partner (B20) and brand roles, who get 403 on `/branches/B09` | **Fixed, gated** | `app/demo/page.tsx`; J6 and the axe gate's `forbidden` page; headless check: refused for partner and brand, shown for marketing |
| P0-2 | P0 (conditional) | Any role can switch itself to approver | **By design in the demo** | R-2, R-22: SSO claims replace `/api/role` before any real use |
| P1-3 | P1 | No collected-cash trace; `metric=collected` silently showed the CAC trace | **Fixed, gated** | `/branches/[id]/trace?metric=collected` (`CashTraceView`), a Collected tile on the branch page; J2 checks it against a reference from raw payloads, J5 against a refund delivered through intake |
| P1-4 | P1 | Branch table labelled channel spend "Revenue at stake" | **Fixed** | `components/ExceptionTable.tsx`: "At stake" with a spend/revenue sub-label per row |
| P1-5 | P1 | Overview headline put serviced customers beside a CAC that uses a different denominator | **Fixed, gated** | `app/page.tsx` names the numerator and denominator; J8 asserts it |
| P1-6 | P1 | The approver's dry-run table mixes company totals into a branch-titled table and a different period | **Open** | R-31 |
| P1-7 | P1 | Decision Lab preselected the move whose cost is distorted by a blocking incident | **Fixed, gated** | No pair is preselected while the budget signal is gated; J8 asserts the disabled state |
| P1-8 | P1 | Two approval models (Incidents vs ChangeGuard) with different rules and words; no "who acts next" after approving | **Partly fixed** | Each ChangeGuard status now states the next step and who takes it; the two models remain (R-32) |
| P1-9 | P1 | The investigator was labelled "read-only" but drafts proposals | **Fixed** | The eyebrow and the form say it drafts a proposal for a person to approve and never applies one |
| P1-10 | P1 | "Case closed." while every count still listed the exception open | **Fixed (message)** | The message says the exception stays open until its records change; one role can still close a case without a second approval (by design: closing changes no data) |
| P1-11 | P1 | "Approved. The application can now execute it." read as done; the case still said awaiting | **Fixed (message)** | "Approved, not yet applied. Next: an approver executes it once…" |
| P2 | P2 | Overview 3.3–4.7 s, Decision Lab 3.7–5.8 s, no busy state on switches | **Open** | R-34 |
| P2 | P2 | Reload during a dry run looks as if nothing happened | **Open** | R-34 |
| P2 | P2 | Raw error text ("Internal Server Error", "Failed to fetch") with no next step | **Open** | R-34 |
| P2 | P2 | ChangeGuard Approve with no reason failed with "Invalid request"; the 10-character rule was only a placeholder | **Fixed** | Label "Why do you decide this? (at least 10 characters)"; Approve/Reject disabled below 10 characters |
| P2 | P2 | ChangeGuard "Map to branch" defaults to B01; a mistaken change cannot be withdrawn | **Open** | R-34 |
| P2 | P2 | A claim check showed "supported" beside "0 of 2 propositions follow" | **Open, not reproduced since** | Investigation #16 on the shared demo data |
| P2 | P2 | Jargon shown to business users (β, "gated", "evidenced touch", internal ids) | **Open** | R-34 |
| P2 | P2 | Walls of text and raw JSON on incident and audit pages | **Open** | R-34 |
| P2 | P2 | Conflicting "start here" pointers; Overview shows 12 of 44 branches with no way to see the rest | **Open** | R-34 |
| P2 | P2 | "October" means Oct 1–30 while data runs to Oct 31 | **Open** | The period label states "Oct 1–30, 2026 (UTC)" |
| P2 | P2 | Scoped roles see Integrations and Audit in the navigation, then a 403 | **Open** | R-34 |
| P2 | P2 | The 403 view had no h1 and returns HTTP 200 | **h1 fixed and gated; status open** | `components/ui.tsx`; R-33 |
| P2 | P2 | A partner's 403 on `/changes/1` names the change's branch | **Open** | Low: reveals a branch id, not a figure |
| P2 | P2 | Every page titled "Revenue Signal OS" | **Fixed, gated** | Each page sets a title; the axe gate fails on an unnamed page |
| P2 | P2 | Focus stays on the body after navigation and after submitting a form | **Open** | The skip link and `main` focus are gated (keyboard path); route-change focus is not |
| P2 | P2 | The approval textbox's accessible name included hashes | **Fixed** | The hashes moved to a description (`aria-describedby`) |
| P2 | P2 | Repeated link names ("Branch mismatch" ×46), live-region noise from the investigator trace | **Open** | — |

## Accessibility gate now in the suite

`tests/e2e/z-quality-gates.spec.ts` runs axe-core (WCAG 2.0/2.1/2.2 A and AA plus best
practice) on 23 pages, including the cash trace and a 403 refusal, at 1440, 1280, 768 and
390 px, and fails on any violation, any page-level sideways scroll, or a page title that does
not name the page. A keyboard-only test goes skip link → `main` → the trace's primary action →
the investigator. Last run: all pass (5 tests, 3.2 min).
