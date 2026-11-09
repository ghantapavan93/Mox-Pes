import Link from "next/link";
import { Badge } from "@/components/ui";
import type { PlannedProposal } from "@/lib/ai/contract";
import type { ProposalState } from "@/lib/ai/queries";
import { dateTime } from "@/lib/format";
import { KIND_TITLE } from "@/lib/workflow/kinds";
import { STATE_LABEL, STATE_TONE, isCaseState } from "@/lib/workflow/states";

/**
 * What the planner did with each suggested fix, and where that proposal stands NOW in the
 * Action Center: dry run, approvals (by role), execution and its verification. The AI path
 * only ever created the draft; everything after it is a person's action on the case page.
 */

const PLANNED_TONE: Record<PlannedProposal["status"], "good" | "accent" | "warn" | "neutral" | "bad"> = {
  created: "accent",
  existing: "accent",
  not_permitted: "neutral",
  rejected_by_policy: "warn",
  failed: "bad",
};

const PLANNED_LABEL: Record<PlannedProposal["status"], string> = {
  created: "Proposal created",
  existing: "Linked to the live proposal",
  not_permitted: "Suggestion only",
  rejected_by_policy: "Not proposed (policy)",
  failed: "Refused by the Action Center",
};

/** The next human step for a proposal, from its live state. */
function nextStep(s: ProposalState): string {
  if (s.execution) {
    return s.execution.status === "succeeded"
      ? s.execution.verified
        ? "Executed and verified."
        : "Executed; verification did not pass."
      : `Execution failed and was rolled back${s.execution.error ? `: ${s.execution.error}` : ""}.`;
  }
  switch (s.status) {
    case "draft":
      return "Next: an integration engineer runs the dry run (rolled back).";
    case "dry_run_failed":
      return `The dry run did not verify${s.dryRun?.error ? `: ${s.dryRun.error}` : ""}.`;
    case "dry_run_ok":
      return `Next: approval by a role other than ${s.proposedRole}.`;
    case "approved":
      return "Approved: the application executes it from the case page.";
    case "stale":
      return "The records changed since the dry run: run it again.";
    case "rejected":
      return "Rejected by an approver.";
    case "superseded":
      return "Replaced by a newer proposal on the case.";
    default:
      return s.status;
  }
}

export function ProposedActions({ planned, states }: { planned: PlannedProposal[]; states: ProposalState[] }) {
  if (planned.length === 0) {
    return <p className="text-sm text-muted">No fix was suggested. Nothing in the Action Center was touched.</p>;
  }
  return (
    <ul className="space-y-4" data-testid="proposed-actions">
      {planned.map((p) => {
        const live = p.proposalId ? states.find((s) => s.proposalId === p.proposalId) : undefined;
        return (
          <li key={`${p.exceptionId}-${p.kind}`} className="rounded border border-border p-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold">{KIND_TITLE[p.kind]}</span>
              <Badge tone={PLANNED_TONE[p.status]}>{PLANNED_LABEL[p.status]}</Badge>
              <Link href={`/exceptions/${p.exceptionId}`} className="text-xs text-accent hover:underline">
                Exception #{p.exceptionId} — open the case
              </Link>
            </div>
            <p className="mt-1 font-mono text-[11px] text-muted">params {JSON.stringify(p.params)}</p>
            <p className="mt-1 text-sm">{p.rationale}</p>
            <p className="mt-1 text-xs text-muted">{p.reason}</p>
            {live && (
              <div className="mt-2 space-y-1 rounded bg-surface-2 p-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-muted">Proposal #{live.proposalId}</span>
                  <Badge tone={live.source === "ai" ? "accent" : "neutral"}>source {live.source}</Badge>
                  <Badge>{live.status.replace(/_/g, " ")}</Badge>
                  {isCaseState(live.caseState) && <Badge tone={STATE_TONE[live.caseState]}>case: {STATE_LABEL[live.caseState]}</Badge>}
                </div>
                {live.dryRun && (
                  <p>
                    Dry run {live.dryRun.ok ? "verified" : "failed"} by {live.dryRun.by ?? "—"} · {dateTime(live.dryRun.at)}
                  </p>
                )}
                {live.approvals.map((a) => (
                  <p key={`${a.at}-${a.role}`}>
                    {a.decision === "approved" ? "Approved" : "Rejected"} by {a.role} · {dateTime(a.at)} — “{a.reason}”
                  </p>
                ))}
                {live.execution && (
                  <p className={live.execution.status === "succeeded" && live.execution.verified ? "text-good" : "text-bad"}>
                    Execution {live.execution.status} ({live.execution.actor}, {dateTime(live.execution.at)}); verification{" "}
                    {live.execution.verified === null ? "not recorded" : live.execution.verified ? "passed" : `failed: ${live.execution.problems.join("; ")}`}
                  </p>
                )}
                <p className="font-medium">{nextStep(live)}</p>
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
