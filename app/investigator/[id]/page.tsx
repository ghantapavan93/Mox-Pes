import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { FindingsView } from "@/components/investigator/FindingsView";
import { ProposedActions } from "@/components/investigator/ProposedActions";
import { RefreshWhileRunning } from "@/components/investigator/RefreshWhileRunning";
import { ModeBadge, TraceTable } from "@/components/investigator/TraceTable";
import { Badge, Card, KV, Skeleton } from "@/components/ui";
import { MODE_LABEL } from "@/lib/ai/contract";
import { getInvestigation, proposalStates, type InvestigationDetail } from "@/lib/ai/queries";
import { count, dateTime } from "@/lib/format";
import { getPool, getViewer } from "@/lib/server";
import type { Viewer } from "@/lib/viewer";

type Props = { params: Promise<{ id: string }> };

export default function InvestigationPage(props: Props) {
  return (
    <Suspense fallback={<Skeleton lines={12} />}>
      <Investigation {...props} />
    </Suspense>
  );
}

/** Model cost in dollars from integer micro-dollars; the deterministic path costs nothing. */
const usd = (micros: number) => `$${(micros / 1_000_000).toFixed(micros > 0 && micros < 10_000 ? 4 : 2)}`;

async function Investigation({ params }: Props) {
  const { id } = await params;
  if (!/^\d{1,15}$/.test(id)) notFound();
  const viewer = await getViewer();
  // Out of scope is indistinguishable from missing, as on every other page.
  const inv = await getInvestigation(getPool(), viewer, Number(id));
  if (!inv) notFound();
  const r = inv.result;
  const toolSteps = inv.steps.filter((s) => s.kind === "tool_call");
  const returnedIds = [...new Set(toolSteps.flatMap((s) => s.evidenceIds))];

  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs text-faint">
          <Link href="/investigator" className="hover:underline">
            AI Investigator
          </Link>{" "}
          / #{inv.id}
        </p>
        <h1 className="mt-1 text-xl font-semibold tracking-tight">{inv.question}</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <ModeBadge mode={inv.mode} label={r?.modeLabel ?? MODE_LABEL[inv.mode]} />
          <Badge tone={inv.status === "completed" ? "good" : inv.status === "failed" ? "bad" : "accent"}>{inv.status}</Badge>
          {r && <Badge tone={r.confidence.level === "high" ? "good" : r.confidence.level === "medium" ? "accent" : "neutral"}>{r.confidence.level} confidence</Badge>}
          {r?.approvalRequired && <Badge tone="warn">approval required</Badge>}
          {r && r.warnings.length > 0 && <Badge tone="warn">{r.warnings.length} injection warning(s)</Badge>}
        </div>
      </div>

      <RefreshWhileRunning running={inv.status === "running"} />
      {inv.status === "failed" && (
        <p role="alert" className="rounded border border-bad/30 bg-bad-soft p-3 text-sm text-bad">
          The investigation failed: {inv.error ?? "unknown error"}. The steps recorded before the failure are below.
        </p>
      )}
      {r?.refusal && (
        <p role="note" className="rounded border border-warn/30 bg-warn-soft p-3 text-sm text-warn">
          <span className="font-semibold">Action refused.</span> {r.refusal.reason}
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Findings" subtitle="Every finding cites the evidence a tool returned in this run — click an id to open the stored record">
          {r ? <FindingsView investigationId={inv.id} result={r} returnedIds={returnedIds} /> : <p className="text-sm text-muted">No result yet.</p>}
        </Card>
        <div className="space-y-6">
          <Card title="Run">
            <RunFacts
              items={[
                ["Asked by", inv.actor],
                ["Scope", inv.branchId ?? (inv.scopeBranchIds ? inv.scopeBranchIds.join(", ") : "all branches")],
                ["Intent", inv.intent ?? "—"],
                ["Tool calls", count(toolSteps.length)],
                ["Latency", inv.latencyMs === null ? "—" : `${count(inv.latencyMs)} ms`],
                ["Tokens in / out", `${count(inv.inputTokens)} / ${count(inv.outputTokens)}`],
                ["Estimated cost", usd(inv.costMicros)],
                ["Started", dateTime(inv.createdAt)],
              ]}
            />
          </Card>
          {r && (
            <Card title="Assessment">
              <dl className="space-y-3 text-sm">
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-faint">Confidence</dt>
                  <dd className="mt-0.5">{r.confidence.why}</dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-faint">Recommended next action</dt>
                  <dd className="mt-0.5">{r.recommendedNextAction}</dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-faint">Expected effect</dt>
                  <dd className="mt-0.5">{r.expectedEffect}</dd>
                </div>
                <div>
                  <dt className="text-xs font-semibold uppercase tracking-wide text-faint">Risks</dt>
                  <dd className="mt-0.5">
                    {r.risks.length === 0 ? (
                      <span className="text-muted">None noted.</span>
                    ) : (
                      <ul className="list-disc space-y-1 pl-5">
                        {r.risks.map((x) => (
                          <li key={x}>{x}</li>
                        ))}
                      </ul>
                    )}
                  </dd>
                </div>
              </dl>
            </Card>
          )}
        </div>
      </div>

      {r && (
        <Card title="Proposed actions" subtitle="Created in the Action Center as drafts: dry run by an integration engineer, approval by a different role">
          <Suspense fallback={<Skeleton lines={3} />}>
            <Proposals inv={inv} viewer={viewer} />
          </Suspense>
        </Card>
      )}

      {r && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="Grounding" subtitle="Claims citing evidence no tool returned in this run are dropped and counted">
            <KV
              items={[
                ["Evidence ids returned by tools", count(r.grounding.returnedEvidence)],
                ["Claims drafted", count(r.grounding.claimsIn)],
                ["Kept", count(r.grounding.claimsKept)],
                ["Dropped (unsupported)", count(r.grounding.claimsDropped)],
                ["Downgraded to hypothesis", count(r.grounding.downgraded)],
              ]}
            />
            {r.grounding.dropped.length > 0 && (
              <ul className="mt-3 space-y-2 text-xs">
                {r.grounding.dropped.map((d, i) => (
                  <li key={i} className="rounded bg-warn-soft p-2 text-warn">
                    <span className="font-semibold">{d.where}:</span> “{d.text}” — {d.reason}
                    {d.unsupported.length > 0 && <span className="font-mono"> ({d.unsupported.join(", ")})</span>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Prompt-injection warnings" subtitle="Instruction-like text found inside record data; treated as data and ignored">
            {r.warnings.length === 0 ? (
              <p className="text-sm text-muted">None found in this run&apos;s tool outputs.</p>
            ) : (
              <ul className="space-y-2 text-xs">
                {r.warnings.map((w, i) => (
                  <li key={i} className="rounded bg-warn-soft p-2 text-warn">
                    <span className="font-mono">{w.tool}</span> · <span className="font-mono">{w.path}</span> · {w.pattern}: “{w.excerpt}”
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}

      <Card title="Tool trace" subtitle="Every tool call with its input, output summary, evidence ids and time; then the analyst and planner">
        <TraceTable steps={inv.steps} />
      </Card>
    </div>
  );
}

/** Single-column facts: the side column is too narrow for KV's two-column grid. */
function RunFacts({ items }: { items: Array<[string, string]> }) {
  return (
    <dl className="space-y-1.5 text-sm">
      {items.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-3 border-b border-dashed border-border pb-1">
          <dt className="text-muted">{k}</dt>
          <dd className="text-right font-medium tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

async function Proposals({ inv, viewer }: { inv: InvestigationDetail; viewer: Viewer }) {
  const planned = inv.result?.proposals ?? [];
  const ids = planned.map((p) => p.proposalId).filter((p): p is number => p !== null);
  const states = await proposalStates(getPool(), viewer, ids);
  return <ProposedActions planned={planned} states={states} />;
}
