/**
 * The four-minute B09 golden path: one incident, from the number a marketer would act on to the
 * audit row that proves who changed what. Synthetic data; the Google change it simulates (Local
 * Services → Performance Max) is real, the branch, dates and pipeline failure are invented.
 *
 *   Overview → Incident → Evidence → Dry run → Approval → Verified correction →
 *   Decision readiness → Audit
 *
 * Pure data, shared by the presenter page (app/demo/page.tsx), the in-page guide bar
 * (components/GuideBar.tsx) and the browser test that walks it
 * (tests/e2e/zz-b09-four-minute-path.spec.ts). The numbers a presenter quotes are the golden
 * fixture tests/fixtures/b09-golden.json; that test asserts the UI shows each of them.
 */

export type GuideRole = "marketing" | "engineer" | "approver";

export interface GuideStep {
  n: number;
  key: "overview" | "incident" | "evidence" | "dry_run" | "approval" | "verified" | "readiness" | "audit";
  title: string;
  role: GuideRole;
  /** Presenter time budget; the eight add up to PATH_SECONDS. */
  seconds: number;
  /** Where the step happens; `{gap}` is the incident's exception id. */
  path: string;
  /** What to point at, in order. */
  show: string[];
  /** The one sentence to say. */
  say: string;
}

export const GUIDE_ID = "b09";
export const PATH_SECONDS = 240;

export const ROLE_LABEL: Record<GuideRole, string> = {
  marketing: "Marketing analyst",
  engineer: "Integration engineer",
  approver: "Revenue ops approver",
};

export const B09_STEPS: GuideStep[] = [
  {
    n: 1, key: "overview", title: "Overview", role: "marketing", seconds: 30, path: "/?period=oct",
    show: ["Decision holds: B09 · Channel imbalance", "“Google Local Services spend at B09 stopped…”"],
    say: "This is the number a marketer would act on, and the system has put it on hold.",
  },
  {
    n: 2, key: "incident", title: "Incident", role: "marketing", seconds: 25, path: "/exceptions/{gap}",
    show: ["The summary: Local Services spend stopped, its leads kept arriving", "Nothing failed validation"],
    say: "Nothing crashed. The meaning of the data changed.",
  },
  {
    n: 3, key: "evidence", title: "Evidence", role: "marketing", seconds: 35, path: "/exceptions/{gap}#evidence",
    show: ["Spend affected: $2,124", "Campaign lineage: the Local Services campaign stops, a PERFORMANCE_MAX campaign starts in the same ad account", "45 Local Services leads after the gap", "CRM outcomes: new customers, invoiced, collected"],
    say: "Every claim links to a stored record: the spend rows, the leads, the CRM customers.",
  },
  {
    n: 4, key: "dry_run", title: "Dry run", role: "engineer", seconds: 45, path: "/exceptions/{gap}#action-center",
    show: ["Propose: Re-map channel, mapper ads@1.1", "Run dry run (rolled back)", "Five ledger rows conserved; the budget signal is still blocked"],
    say: "The fix runs for real inside a transaction that rolls back. Nothing is saved.",
  },
  {
    n: 5, key: "approval", title: "Approval", role: "approver", seconds: 25, path: "/exceptions/{gap}#action-center",
    show: ["A different role approves this exact dry run, with a reason"],
    say: "Whoever proposed or dry-ran it cannot approve it; the server refuses.",
  },
  {
    n: 6, key: "verified", title: "Verified correction", role: "approver", seconds: 30, path: "/exceptions/{gap}#action-center",
    show: ["Execute (application, once)", "claimed 22 · projected 22", "Ad spend, raw events, customers, invoiced, collected: conserved", "Exception resolved; executing again returns the stored result"],
    say: "Spend didn't change. Revenue didn't change. Which channel it belongs to did.",
  },
  {
    n: 7, key: "readiness", title: "Decision readiness", role: "marketing", seconds: 30, path: "/branches/B09?period=oct",
    show: ["Budget signal: Google Search costs 2.9× Local Services (it read 8.6× before)", "Data integrity: no blocking incidents", "Decision Lab: the incident no longer blocks B09"],
    say: "Now the comparison is safe to look at, and it is an observation, not an instruction.",
  },
  {
    n: 8, key: "audit", title: "Audit", role: "approver", seconds: 20, path: "/exceptions/{gap}#case-audit",
    show: ["proposal_create · engineer", "proposal_dry_run · engineer", "proposal_approve · approver", "proposal_execute · the application on behalf of the approver"],
    say: "Who proposed, who tested, who approved, what ran: one row each.",
  },
];

/** A step's URL with the guide parameters, so the guide bar knows where the presenter is. */
export function stepHref(step: GuideStep, gapId: number): string {
  const [pathAndQuery, hash] = step.path.replace("{gap}", String(gapId)).split("#");
  const sep = pathAndQuery.includes("?") ? "&" : "?";
  return `${pathAndQuery}${sep}guide=${GUIDE_ID}&step=${step.n}&gap=${gapId}${hash ? `#${hash}` : ""}`;
}

export function stepAt(n: number): GuideStep | null {
  return B09_STEPS.find((s) => s.n === n) ?? null;
}
