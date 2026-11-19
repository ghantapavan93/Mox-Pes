/**
 * The visitor tour: B20's finished repair, start to finish, read-only. It is the hosted demo's
 * guided path. The B09 presenter path (lib/demo/b09-path.ts) proposes, dry-runs, approves and
 * executes a fix, which needs staff roles and changes data, so it runs only in demo mode. This one
 * changes nothing a visitor shares: it reads the stored receipt of a repair that was already made
 * (lib/demo/hosted-correction.ts), the evidence behind it, who approved it, and why it is not a
 * budget decision. The one thing a visitor may do on it, asking the investigator, is answered in
 * their own private workspace.
 *
 *   The result → Why it moved → Evidence → Held records → Approval → Investigator → Budget decision
 *
 * The words carry no figures: every figure is on the page the step opens, read from the stored
 * receipt, so the tour cannot say a number the page does not show. It recites the same story as
 * the captioned walkthrough (docs/agent-work/release/recording/b20-receipt-walkthrough.md).
 *
 * Pure data, shared by the tour bar (components/GuideBar.tsx), the pages that start it
 * (app/start/page.tsx, app/demo/page.tsx) and the browser test that walks it
 * (tests/e2e/z-visitor-tour.spec.ts).
 */

export const TOUR_ID = "b20";
/** The tour's branch: the one with the repaired incident. */
export const TOUR_BRANCH = "B20";
/** The question the investigator step pre-fills: the one the walkthrough and journey J4 ask. */
export const TOUR_QUESTION = "Why did B20's CAC jump in October?";
/** Where the tour starts: a route that finds the repaired incident and opens its first step. */
export const TOUR_START = "/demo/tour";

export interface TourStep {
  n: number;
  key: "result" | "why" | "evidence" | "records" | "approval" | "investigator" | "decision";
  title: string;
  /** Where the step happens; `{incident}` is the repaired incident's exception id. */
  path: string;
  /** What to look at, in a few words. */
  look: string;
  /** What it means, in one or two plain sentences. */
  says: string;
  /** The investigator step once its answer is open (/investigator/<id>): the same step, other words. */
  answered?: { look: string; says: string };
}

export const B20_TOUR: TourStep[] = [
  {
    // The receipt panel opens at the top of the window: on a phone the incident's header above it
    // would push the figure under the tour bar.
    n: 1, key: "result", title: "The result", path: "/exceptions/{incident}#fix-result",
    look: "The green panel.",
    says: "Branch B20's October cost per new customer won through paid ads (its CAC) read too high. A repair was approved and verified; the panel shows the figure before and after.",
  },
  {
    n: 2, key: "why", title: "Why it moved", path: "/exceptions/{incident}#fix-result",
    look: "“Why it moved” and “What did not”, in the same panel.",
    says: "The ad spend never changed. Call records had been held back, so customers who called in looked as if nothing had brought them in. Replaying those calls gave each customer the channel that brought them; the spend stayed the same.",
  },
  {
    n: 3, key: "evidence", title: "Evidence", path: "/exceptions/{incident}#evidence",
    look: "The Evidence card.",
    says: "Why the calls were held: they failed a check after the call feed renamed a field. The app held them instead of guessing what they meant.",
  },
  {
    n: 4, key: "records", title: "Held records", path: "/exceptions/{incident}#records",
    look: "The held calls, one row each.",
    says: "Each held call, read again by the corrected mapper, and the customer it led to. Every claim on the page points at stored records like these.",
  },
  {
    n: 5, key: "approval", title: "Approval", path: "/exceptions/{incident}#case-audit",
    look: "The audit history.",
    says: "One role proposed the repair, another tested it in a dry run that saved nothing, and a different role approved that exact dry run. The app then applied it once and checked that the five ledger totals did not move.",
  },
  {
    n: 6, key: "investigator", title: "Ask the investigator", path: "/investigator?q={question}",
    look: "The question is filled in: press Investigate.",
    says: "It reads stored records with read-only tools and cites every finding. A visitor's question stays private to their browser for 24 hours.",
    answered: {
      look: "The answer.",
      says: "Each finding cites the stored record it rests on: select one to open it. The assessment says what to do next.",
    },
  },
  {
    n: 7, key: "decision", title: "The budget decision", path: "/decisions?branch=B20&period=oct",
    look: "The readiness line at the top.",
    says: "A corrected number is not permission to move money. Moving budget stays a separate decision, and Decision Lab shows what it would still need.",
  },
];

/** A step's URL with the tour parameters, so the tour bar knows where the visitor is. */
export function tourHref(step: TourStep, incidentId: number): string {
  const [pathAndQuery, hash] = step.path.replace("{incident}", String(incidentId)).replace("{question}", encodeURIComponent(TOUR_QUESTION)).split("#");
  const sep = pathAndQuery.includes("?") ? "&" : "?";
  return `${pathAndQuery}${sep}${tourQuery(step.n, incidentId).slice(1)}${hash ? `#${hash}` : ""}`;
}

/** The tour's place as a query string ("?guide=b20&step=6&incident=1063"), for a page that moves on by itself. */
export function tourQuery(n: number, incidentId: number): string {
  return `?guide=${TOUR_ID}&step=${n}&incident=${incidentId}`;
}

export function tourStepAt(n: number): TourStep | null {
  return B20_TOUR.find((s) => s.n === n) ?? null;
}

/**
 * The tour's place from a page's search params, or null when the page is not on the tour. Pages
 * read it to keep the tour bar on after they move on by themselves (the investigator opens its
 * answer).
 */
export function tourPlace(params: { guide?: unknown; step?: unknown; incident?: unknown }): { step: TourStep; incidentId: number } | null {
  if (params.guide !== TOUR_ID) return null;
  const step = typeof params.step === "string" ? tourStepAt(Number(params.step)) : null;
  const incidentId = typeof params.incident === "string" && /^\d{1,12}$/.test(params.incident) ? Number(params.incident) : 0;
  return step && incidentId > 0 ? { step, incidentId } : null;
}
