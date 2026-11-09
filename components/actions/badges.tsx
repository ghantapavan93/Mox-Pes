import { Badge } from "@/components/ui";
import type { ProposalStatus } from "@/lib/workflow/proposals";
import { STATE_LABEL, STATE_TONE, type CaseState } from "@/lib/workflow/states";

/** Case state, with the shared status semantics (needs attention = warn, broken = bad, done = good). */
export function CaseStateBadge({ state }: { state: CaseState }) {
  return <Badge tone={STATE_TONE[state]}>{STATE_LABEL[state]}</Badge>;
}

const PROPOSAL_TONE: Record<ProposalStatus, "good" | "warn" | "bad" | "neutral" | "accent"> = {
  draft: "warn",
  dry_run_failed: "bad",
  dry_run_ok: "accent",
  approved: "accent",
  stale: "warn",
  rejected: "neutral",
  superseded: "neutral",
  executed: "good",
  failed: "bad",
};

export const PROPOSAL_STATUS_LABEL: Record<ProposalStatus, string> = {
  draft: "Needs dry run",
  dry_run_failed: "Dry run failed",
  dry_run_ok: "Awaiting approval",
  approved: "Approved · ready to execute",
  stale: "Stale · needs a new dry run",
  rejected: "Rejected",
  superseded: "Superseded",
  executed: "Executed",
  failed: "Execution failed",
};

export function ProposalStatusBadge({ status }: { status: ProposalStatus }) {
  return <Badge tone={PROPOSAL_TONE[status]}>{PROPOSAL_STATUS_LABEL[status]}</Badge>;
}

/** Human or AI source. AI proposals take exactly the same path; the label is for the reader. */
export function SourceBadge({ source }: { source: string }) {
  return <Badge tone={source === "ai" ? "accent" : "neutral"}>{source === "ai" ? "AI-proposed" : "human"}</Badge>;
}
