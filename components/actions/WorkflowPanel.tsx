import type { ReactNode } from "react";
import { Badge, Card, KV, TableWrap, Td, Th } from "@/components/ui";
import type { SourceName } from "@/lib/adapters/contract";
import { ACTIVE_VERSION, mapperVersions } from "@/lib/adapters/registry";
import { dateTime } from "@/lib/format";
import type { ExceptionRow } from "@/lib/queries";
import { BRANCHES, BRANCH_BY_ID } from "@/lib/reference";
import { getPool } from "@/lib/server";
import { VIEWERS, type Viewer } from "@/lib/viewer";
import { LIVE_PROPOSAL_STATUSES } from "@/lib/workflow/cases";
import { KIND_TITLE, kindsFor, type ProposalKind } from "@/lib/workflow/kinds";
import { OWNER_ROLES, type ProposalStatus } from "@/lib/workflow/proposals";
import { caseAudit, caseForException, caseProposals, caseTimeline, type CaseEvent, type ProposalDetail } from "@/lib/workflow/queries";
import { MANUAL_CLOSE_STATES, STATE_LABEL, canTransition, type CaseState } from "@/lib/workflow/states";
import { CaseControls } from "./CaseControls";
import { ProposalControls } from "./ProposalControls";
import { ProposeForm, type ParamField, type ProposableKind } from "./ProposeForm";
import { SnapshotDiff } from "./SnapshotDiff";
import { CaseStateBadge, ProposalStatusBadge, SourceBadge } from "./badges";

/**
 * The Action Center workflow for one exception: case state and owner, the proposals with
 * their dry runs, approvals and executions (before/after, verification), the propose form,
 * the case timeline and the audit rows for this case. Every control is shown only when the
 * viewer's role may use it; otherwise the panel says which role acts next.
 */
export async function WorkflowPanel({ exception, viewer }: { exception: ExceptionRow; viewer: Viewer }) {
  const pool = getPool();
  const kase = await caseForException(pool, exception.id);
  const [proposals, timeline, audit] = kase
    ? [await caseProposals(pool, kase.id), await caseTimeline(pool, kase.id), await caseAudit(pool, kase.id, exception.id)]
    : [[], [], []];

  const canTakeProposal = exception.status === "open" && (!kase || kase.state === "proposed" || canTransition(kase.state, "proposed"));
  const kinds = kindsFor(exception.kind);
  const proposable: ProposableKind[] = kinds
    .filter((k) => k.available)
    .map((k) => ({ kind: k.kind, title: KIND_TITLE[k.kind], label: k.label, fields: fieldsFor(k.kind, exception) }));
  const unavailable = kinds.filter((k) => !k.available);

  return (
    <Card
      title="Workflow"
      subtitle="Propose → dry run (rolled back) → approval by a different role → execution by the application, verified and audited"
      action={kase ? <span className="text-xs text-faint">Case #{kase.id}</span> : undefined}
    >
      <div className="space-y-5" data-testid="workflow-panel">
        {kase ? (
          <div className="grid gap-4 md:grid-cols-2">
            <KV
              items={[
                ["State", <CaseStateBadge key="s" state={kase.state} />],
                ["Owner", kase.owner ? VIEWERS[kase.owner as keyof typeof VIEWERS]?.label ?? kase.owner : <span className="text-faint">unassigned</span>],
                ["Opened", dateTime(kase.openedAt)],
                ["Re-opened", String(kase.reopenCount)],
              ]}
            />
            <CaseControls
              caseId={kase.id}
              owner={kase.owner}
              canAssign={viewer.can.propose}
              ownerOptions={OWNER_ROLES.map((r) => ({ value: r, label: VIEWERS[r].label }))}
              closeOptions={
                viewer.can.decide
                  ? MANUAL_CLOSE_STATES.filter((s) => canTransition(kase.state, s)).map((s) => ({ value: s, label: STATE_LABEL[s] }))
                  : []
              }
            />
          </div>
        ) : (
          <p className="text-sm text-muted">
            No case yet: this exception was raised at ingestion and gets its case on the next reconciliation run, or when someone proposes a fix.
          </p>
        )}

        <section aria-labelledby="proposals-heading" className="space-y-3">
          <h3 id="proposals-heading" className="text-xs font-semibold uppercase tracking-wide text-faint">
            Proposals
          </h3>
          {proposals.length === 0 && <p className="text-sm text-muted">No proposals yet.</p>}
          {proposals.map((p) => (
            <ProposalCard key={p.id} proposal={p} viewer={viewer} />
          ))}
        </section>

        <section aria-labelledby="propose-heading" className="space-y-2">
          <h3 id="propose-heading" className="text-xs font-semibold uppercase tracking-wide text-faint">
            Propose a fix
          </h3>
          {!canTakeProposal ? (
            <p className="text-sm text-muted">
              {exception.status !== "open" ? `The exception is ${exception.status}; there is nothing to propose.` : `A case that is ${STATE_LABEL[kase!.state].toLowerCase()} takes no new proposals.`}
            </p>
          ) : !viewer.can.propose ? (
            <p className="text-sm text-muted">
              Proposals are made by a marketing analyst or an integration engineer. Your role ({viewer.label}) can read this case.
            </p>
          ) : proposable.length === 0 ? (
            <p className="text-sm text-muted">No fix kind is available for this exception.</p>
          ) : (
            <>
              {proposals.some((p) => (LIVE_PROPOSAL_STATUSES as readonly string[]).includes(p.status)) && (
                <p className="text-xs text-warn">A new proposal supersedes the live one above, including its dry run and any approval.</p>
              )}
              <ProposeForm exceptionId={exception.id} kinds={proposable} />
            </>
          )}
          {unavailable.length > 0 && (
            <p className="text-xs text-faint">
              Not available yet: {unavailable.map((k) => `${KIND_TITLE[k.kind]} (${k.unavailableReason})`).join("; ")}.
            </p>
          )}
        </section>

        {kase && (
          <div className="grid gap-5 lg:grid-cols-2">
            <section aria-labelledby="timeline-heading">
              <h3 id="timeline-heading" className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">
                Case timeline
              </h3>
              <Timeline events={timeline} />
            </section>
            <section aria-labelledby="case-audit-heading">
              <h3 id="case-audit-heading" className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">
                Audit history ({audit.length})
              </h3>
              {audit.length === 0 ? (
                <p className="text-sm text-muted">No audit rows for this case yet.</p>
              ) : (
                <TableWrap>
                  <thead>
                    <tr>
                      <Th>When</Th>
                      <Th>Actor</Th>
                      <Th>Action</Th>
                      <Th>Subject</Th>
                    </tr>
                  </thead>
                  <tbody data-testid="case-audit">
                    {audit.map((a) => (
                      <tr key={a.id}>
                        <Td className="whitespace-nowrap text-xs">{dateTime(a.at)}</Td>
                        <Td className="text-xs">{a.actor}</Td>
                        <Td className="font-mono text-xs">{a.action}</Td>
                        <Td className="font-mono text-xs">{a.subject}</Td>
                      </tr>
                    ))}
                  </tbody>
                </TableWrap>
              )}
            </section>
          </div>
        )}
      </div>
    </Card>
  );
}

const DRY_RUNNABLE: ProposalStatus[] = ["draft", "dry_run_failed", "dry_run_ok", "stale", "approved"];

function ProposalCard({ proposal: p, viewer }: { proposal: ProposalDetail; viewer: Viewer }) {
  const live = (LIVE_PROPOSAL_STATUSES as readonly string[]).includes(p.status);
  const sameRole = viewer.role === p.proposedRole;
  const canDryRun = viewer.can.dryRun && DRY_RUNNABLE.includes(p.status);
  const canDecide = viewer.can.approve && p.status === "dry_run_ok" && !sameRole;
  const canExecute = viewer.can.approve && p.status === "approved";
  const blocked: string[] = [];
  if (live) {
    if (["draft", "dry_run_failed", "stale"].includes(p.status) && !viewer.can.dryRun) blocked.push("Next: a dry run by an integration engineer.");
    if (p.status === "dry_run_ok" && !viewer.can.approve) blocked.push("Next: approval by the revenue ops approver, a different role from the proposer's.");
    if (p.status === "dry_run_ok" && viewer.can.approve && sameRole) blocked.push(`This was proposed by the ${p.proposedRole} role, so a different role must approve it.`);
    if (p.status === "approved" && !viewer.can.approve) blocked.push("Approved. The approver triggers the execution; the application performs it.");
    if (p.status === "approved" && viewer.can.dryRun) blocked.push("A new dry run withdraws the approval: it covers one dry run only.");
  }
  const approval = [...p.approvals].reverse().find((a) => a.decision === "approved");

  return (
    <article className={`rounded border p-3 ${live ? "border-accent/40" : "border-border"}`} data-testid="proposal">
      <header className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">#{p.id} {KIND_TITLE[p.kind]}</span>
        <ProposalStatusBadge status={p.status} />
        <SourceBadge source={p.source} />
        <span className="text-xs text-muted">
          proposed by {p.proposedRole} · {dateTime(p.createdAt)}
        </span>
      </header>
      <p className="mt-1 text-sm">{p.rationale}</p>
      {Object.keys(p.params).length > 0 && (
        <p className="mt-1 font-mono text-[11px] text-muted">
          {Object.entries(p.params)
            .map(([k, v]) => `${k}=${String(v)}`)
            .join(" · ")}
        </p>
      )}

      {p.dryRun && (
        <details className="mt-2 rounded bg-surface-2 p-2" open={live}>
          <summary className="text-xs font-medium">
            Dry run {p.dryRun.ok ? <Badge tone="good">verified</Badge> : <Badge tone="bad">did not verify</Badge>}{" "}
            <span className="text-faint">
              by {p.dryRun.by} · {dateTime(p.dryRun.at)} · rolled back
              {p.dryRun.fingerprint ? ` · precondition ${p.dryRun.fingerprint.slice(0, 12)}` : ""}
            </span>
          </summary>
          <div className="mt-2 space-y-2">
            {p.dryRun.error && <p className="text-xs text-bad">{p.dryRun.error}</p>}
            {p.dryRun.result && <ResultLine result={p.dryRun.result} />}
            {p.dryRun.before && <SnapshotDiff before={p.dryRun.before} after={p.dryRun.after} verification={p.dryRun.verification} />}
          </div>
        </details>
      )}

      {p.approvals.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs">
          {p.approvals.map((a) => (
            <li key={a.id}>
              <Badge tone={a.decision === "approved" ? "good" : "neutral"}>{a.decision}</Badge> by {a.role} · {dateTime(a.decidedAt)} — {a.reason}
              {a.decision === "approved" && a.preconditionFingerprint && a !== approval && <span className="text-faint"> (earlier dry run)</span>}
            </li>
          ))}
        </ul>
      )}

      {p.execution && (
        <div className={`mt-2 rounded p-2 ${p.execution.status === "succeeded" ? "bg-good-soft" : "bg-bad-soft"}`} data-testid="execution-result">
          <p className="text-xs font-medium">
            Execution {p.execution.status === "succeeded" ? "succeeded and verified" : "failed and was rolled back"} · {p.execution.actor} · {dateTime(p.execution.finishedAt)}
          </p>
          <p className="font-mono text-[11px] text-faint">Idempotency-Key: {p.execution.idempotencyKey}</p>
          {p.execution.error && <p className="text-xs text-bad">{p.execution.error}</p>}
          {p.execution.result && <ResultLine result={p.execution.result} />}
          {p.execution.before && <SnapshotDiff before={p.execution.before} after={p.execution.after} verification={p.execution.verification} />}
        </div>
      )}

      {live && (
        <div className="mt-3">
          <ProposalControls
            proposalId={p.id}
            canDryRun={canDryRun}
            canDecide={canDecide}
            canExecute={canExecute}
            dryRunLabel={p.dryRun ? "Run the dry run again" : "Run dry run (rolled back)"}
            blocked={blocked}
          />
        </div>
      )}
    </article>
  );
}

/** Executor result as one readable line (counts, ids), straight from the stored JSON. */
function ResultLine({ result }: { result: Record<string, unknown> }) {
  const parts = Object.entries(result)
    .filter(([, v]) => v !== null && typeof v !== "object")
    .map(([k, v]) => `${k} ${String(v)}`);
  const lineage = result.lineage as { predecessorCampaignId: number; successorCampaignId: number; effectiveDate: string } | null | undefined;
  return (
    <p className="text-xs text-muted">
      {parts.join(" · ")}
      {lineage && ` · campaign ${lineage.predecessorCampaignId} → ${lineage.successorCampaignId} from ${lineage.effectiveDate}`}
    </p>
  );
}

const EVENT_LABEL: Record<string, string> = {
  owner_assigned: "Owner assigned",
  proposal_created: "Proposal created",
  proposal_superseded: "Proposal superseded",
  dry_run: "Dry run",
  approval: "Approved",
  rejection: "Rejected",
  execution: "Execution",
  execution_refused: "Execution refused",
};

function Timeline({ events }: { events: CaseEvent[] }) {
  if (events.length === 0) return <p className="text-sm text-muted">No events.</p>;
  return (
    <ol className="space-y-1.5 text-xs" data-testid="case-timeline">
      {events.map((e) => (
        <li key={e.id} className="flex gap-2">
          <span className="w-28 shrink-0 text-faint">{dateTime(e.at)}</span>
          <span className="min-w-0">
            {e.event === "transition" ? (
              <>
                {e.fromState ? <CaseStateLabel state={e.fromState} /> : <span className="text-faint">new</span>} → <CaseStateLabel state={e.toState!} />
              </>
            ) : (
              <span className="font-medium">{EVENT_LABEL[e.event] ?? e.event}</span>
            )}
            {e.proposalId && <span className="text-faint"> · proposal #{e.proposalId}</span>}
            <span className="text-muted"> · {e.actor}</span>
            <EventDetail detail={e.detail} />
          </span>
        </li>
      ))}
    </ol>
  );
}

function CaseStateLabel({ state }: { state: CaseState }) {
  return <span className="font-medium">{STATE_LABEL[state]}</span>;
}

function EventDetail({ detail }: { detail: Record<string, unknown> }) {
  const bits: ReactNode[] = [];
  if (typeof detail.reason === "string") bits.push(detail.reason);
  if (typeof detail.ok === "boolean") bits.push(detail.ok ? "verified" : `did not verify${detail.error ? `: ${String(detail.error)}` : ""}`);
  if (typeof detail.status === "string") bits.push(detail.status === "failed" ? `failed: ${String(detail.error ?? "")}` : detail.status);
  if (detail.to !== undefined && detail.from !== undefined && !("reason" in detail)) bits.push(`${String(detail.from ?? "unassigned")} → ${String(detail.to ?? "unassigned")}`);
  if (bits.length === 0) return null;
  return <span className="block text-muted">{bits.join(" · ")}</span>;
}

/** Parameter inputs per kind, with defaults taken from the exception's evidence. */
function fieldsFor(kind: ProposalKind, exception: ExceptionRow): ParamField[] {
  const ev = exception.evidence as Record<string, unknown>;
  const versionField = (source: SourceName): ParamField => {
    const versions = mapperVersions(source);
    return {
      name: "mapperVersion",
      label: "Mapper",
      type: "select",
      options: versions.map((v) => ({ value: v, label: `${source}@${v}${v === ACTIVE_VERSION[source] ? " (deployed)" : ""}` })),
      defaultValue: ACTIVE_VERSION[source],
    };
  };
  switch (kind) {
    case "remap_channel":
      return [versionField("ads")];
    case "replay_quarantine":
      return [versionField(String(ev.source) as SourceName)];
    case "map_campaign": {
      const suggested = String(ev.name ?? "").match(/^(B\d{2})\b/)?.[1];
      return [
        {
          name: "branchId",
          label: "Branch",
          type: "select",
          options: BRANCHES.map((b) => ({ value: b.id, label: `${b.id} ${b.name}` })),
          defaultValue: suggested ?? BRANCHES[0].id,
          hint: suggested ? `${suggested} is suggested from the campaign name: a suggestion, not a fact.` : undefined,
        },
      ];
    }
    case "override_lead_branch": {
      const options = [...new Set([ev.crmBranch, ev.territoryBranch].filter(Boolean) as string[])];
      return [
        {
          name: "branchId",
          label: "Branch",
          type: "select",
          options: options.map((b) => ({ value: b, label: `${b} ${BRANCH_BY_ID.get(b)?.name ?? ""} (${b === ev.territoryBranch ? "territory" : "CRM office"})` })),
          defaultValue: options[0] ?? "",
        },
      ];
    }
    case "acknowledge_exception":
      return [];
    case "resolve_identity_conflict":
      return [
        { name: "conflictId", label: "Conflict #", type: "number", defaultValue: "" },
        {
          name: "decision",
          label: "Decision",
          type: "select",
          options: [
            { value: "accepted", label: "Accept the match" },
            { value: "rejected", label: "Reject the match" },
          ],
          defaultValue: "rejected",
        },
      ];
    case "trigger_sync": {
      const office = exception.branchId ? BRANCH_BY_ID.get(exception.branchId)?.crmOfficeId : undefined;
      return [
        { name: "connectorId", label: "Connector #", type: "number", defaultValue: "" },
        { name: "officeId", label: "Office", type: "number", defaultValue: office ? String(office) : "" },
        {
          name: "entity",
          label: "Records",
          type: "select",
          options: ["ticket", "payment", "appointment", "subscription", "customer"].map((e) => ({ value: e, label: e })),
          defaultValue: "ticket",
        },
      ];
    }
  }
}
