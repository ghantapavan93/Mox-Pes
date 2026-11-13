import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { OUTCOME_LABEL } from "@/components/changes/MonitoringStatus";
import { Badge, Callout, Card, Forbidden, PageHeader, Skeleton, TableWrap, Td, Th } from "@/components/ui";
import { getMonitorRun, type MonitorOutcome } from "@/lib/changeguard/monitor";
import { supportingRecord } from "@/lib/changeguard/summary";
import { dateTime, money } from "@/lib/format";
import { parseRecordId } from "@/lib/record-id";
import { getPool, getViewer } from "@/lib/server";
import { ForbiddenError } from "@/lib/viewer";

type Params = Promise<{ id: string; runId: string }>;

export const metadata = { title: "Post-release check" };

export default function CheckEvidencePage({ params }: { params: Params }) {
  return (
    <Suspense fallback={<Skeleton lines={12} />}>
      <CheckEvidence params={params} />
    </Suspense>
  );
}

const TONE: Record<MonitorOutcome, "good" | "warn" | "bad" | "neutral"> = { current: "good", insufficient_evidence: "warn", drift: "bad", superseded: "neutral", error: "bad" };

/**
 * One post-release check, read-only: what it compared, what it concluded, and the records behind
 * it. The viewer's branch scope applies to the rows (lib/changeguard/monitor.ts, redactRun).
 */
async function CheckEvidence({ params }: { params: Params }) {
  const p = await params;
  const changeId = parseRecordId(p.id);
  const runId = parseRecordId(p.runId);
  if (changeId === null || runId === null) notFound();
  const viewer = await getViewer();
  let data: Awaited<ReturnType<typeof getMonitorRun>>;
  try {
    data = await getMonitorRun(getPool(), viewer, changeId, runId);
  } catch (error) {
    if (error instanceof ForbiddenError) return <Forbidden message={error.message} />;
    if ((error as { status?: number }).status === 404) notFound();
    throw error;
  }
  const { change, redacted } = data;
  const { run, hidden } = redacted;
  const e = run.evidence;
  const reasons = e.reasons ?? [];
  // Each contradicting lead's own record (its customer or prospect page, every stored version), where the viewer may open it.
  const records = await Promise.all((e.conflicting ?? []).slice(0, 20).map((c) => supportingRecord(getPool(), viewer, c)));

  return (
    <div className="space-y-6">
      <PageHeader
        crumbs={[{ label: "Systems" }, { href: "/changes", label: "ChangeGuard" }, { href: `/changes/${change.id}`, label: `Change #${change.id}` }, { label: `Check #${run.id}` }]}
        title={`Post-release check #${run.id}`}
        badges={
          <span data-testid="check-outcome">
            <Badge tone={TONE[run.outcome]} dot>
              {OUTCOME_LABEL[run.outcome]}
            </Badge>
          </span>
        }
        description={
          <p>
            {change.title}. {run.trigger === "scheduled" ? `Scheduled check for the slot ${dateTime(run.slotAt!)}` : `Run on request by ${run.ranBy}`}, recorded {dateTime(run.ranAt)} (business clock) by {run.ranBy}. Read-only: a check never changes the mapping.
          </p>
        }
      />

      {hidden.branches > 0 && (
        <Callout tone="info" title="Part of this evidence is outside your scope">
          {hidden.branches} branch(es) outside your scope appear in this check{hidden.leads ? `, with ${hidden.leads} lead record(s)` : ""}. They are counted here, not listed. A company-wide role can read the full evidence.
        </Callout>
      )}
      {run.outcome === "error" && (
        <Callout tone="bad" title="The check did not run to a conclusion">
          {run.error}. Nothing was concluded and the last successful verification was not refreshed; the slot is tried again.
        </Callout>
      )}

      {run.outcome !== "error" && (
        <>
          <Card title="Conclusion" subtitle={reasons.length ? `Reasons: ${reasons.join(", ")}` : "No reason to doubt the mapping was found"}>
            <ul className="space-y-1.5 text-sm" aria-label="Checks">
              {run.checks.map((c) => (
                <li key={c.id} className="flex gap-2" data-check={c.id} data-status={c.status ?? (c.passed ? "pass" : "fail")}>
                  <span aria-hidden className={c.status === "unknown" ? "text-warn" : c.passed ? "text-good" : "text-bad"}>
                    {c.status === "unknown" ? "?" : c.passed ? "✓" : "✗"}
                  </span>
                  <span className="min-w-0">
                    <span className="font-medium text-text">{c.id.replaceAll("_", " ")}</span> <Badge tone={c.status === "unknown" ? "warn" : c.passed ? "good" : "bad"}>{c.status ?? (c.passed ? "pass" : "fail")}</Badge>
                    <span className="block text-muted">{c.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
            {e.missedSlots ? <p className="mt-2 text-xs text-warn">{e.missedSlots} scheduled slot(s) passed with no run before this one; it covers everything since the release.</p> : null}
            {run.exceptionId && (
              <p className="mt-2 text-sm">
                Review item:{" "}
                <Link href={`/exceptions/${run.exceptionId}`} className="text-accent underline" data-testid="check-review-item">
                  incident #{run.exceptionId}
                </Link>{" "}
                (one per change: later checks update it).
              </p>
            )}
          </Card>

          <Card title="Where the campaign's leads arrive" subtitle={`Campaign ${e.campaign?.externalId ?? "—"} (${e.campaign?.platform ?? "—"}), released to ${e.releasedBranchId ?? "—"}; live mapping ${e.liveBranchId ?? "unmapped"}, version ${e.mapping?.version ?? "—"}`}>
            <div className="grid gap-4 md:grid-cols-2">
              <TableWrap label="Lead evidence when the release was approved">
                <thead>
                  <tr>
                    <Th>At release ({e.atRelease?.verdict ?? "—"})</Th>
                    <Th align="right">Leads</Th>
                  </tr>
                </thead>
                <tbody>
                  {(e.atRelease?.leadEvidence ?? []).map((r) => (
                    <tr key={r.branchId}>
                      <Td>{r.branchId}</Td>
                      <Td align="right">{r.leads}</Td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
              <TableWrap label="Lead evidence at this check">
                <thead>
                  <tr>
                    <Th>At this check ({e.now?.verdict ?? "—"})</Th>
                    <Th align="right">Leads</Th>
                  </tr>
                </thead>
                <tbody>
                  {(e.now?.leadEvidence ?? []).map((r) => (
                    <tr key={r.branchId} className={(e.newBranches ?? []).includes(r.branchId) ? "bg-bad-soft" : ""}>
                      <Td>
                        {r.branchId}
                        {(e.newBranches ?? []).includes(r.branchId) && <span className="ml-1 text-bad">not in the approved evidence</span>}
                      </Td>
                      <Td align="right">{r.leads}</Td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
            </div>
            {e.sinceRelease && (
              <p className="mt-2 text-xs text-muted">
                Delivered since the release: {e.sinceRelease.newLeads} new lead(s), {e.sinceRelease.revisions} revision(s) of earlier leads, {e.sinceRelease.excluded} excluded.
              </p>
            )}
          </Card>

          {(e.conflicting ?? []).length > 0 && (
            <Card title="Records that contradict the approval" subtitle="The stored version now, and the version before it when this is a revision">
              <TableWrap label="Contradicting lead records">
                <thead>
                  <tr>
                    <Th>Lead</Th>
                    <Th>Branch now</Th>
                    <Th>Before</Th>
                    <Th>Raw event</Th>
                    <Th>Delivered</Th>
                  </tr>
                </thead>
                <tbody>
                  {e.conflicting!.map((c, i) => (
                    <tr key={c.leadId}>
                      <Td className="text-xs">
                        {records[i] ? (
                          <Link href={records[i]!} className="text-accent underline" data-testid="conflicting-record-link">
                            {c.source} {c.sourceLeadId}
                          </Link>
                        ) : (
                          <>
                            {c.source} {c.sourceLeadId}
                          </>
                        )}{" "}
                        (#{c.leadId})
                      </Td>
                      <Td className="text-xs">
                        {c.branchId}
                        {c.overridden ? " (override)" : ""}
                      </Td>
                      <Td className="text-xs">{c.previousRawEventId ? `${c.previousBranchId ?? "—"} (raw #${c.previousRawEventId})` : "first version"}</Td>
                      <Td className="text-xs">#{c.rawEventId}</Td>
                      <Td className="text-xs">{dateTime(c.deliveredAt)}</Td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
            </Card>
          )}

          {(e.sharedId ?? []).length > 0 && (
            <Card title="Other campaigns using this id (R-46, open)" subtitle="Leads carry the id without a platform, so these campaigns' leads cannot be told apart. Nothing was chosen between them.">
              <ul className="text-sm">
                {e.sharedId!.map((s) => (
                  <li key={s.campaignId}>
                    {s.platform} · {s.name} · mapped to {s.branchId ?? "no branch"}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <Card title="Feeds and scope">
            <ul className="space-y-1 text-sm" aria-label="Feeds">
              {(e.feeds ?? []).map((f, i) => (
                <li key={i}>
                  <span className="font-medium">{f.stream ?? f.source}</span>: {f.stale ? <span className="text-warn">{f.stale}</span> : <span className="text-good">current</span>}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-muted">
              Affected branches{hidden.branches ? " in your scope" : ""}: {(run.scope.branches ?? []).join(", ") || "—"}. Spend whose branch depends on this mapping: {money(run.scope.spendAtStakeCents ?? 0)}. Raw events: {(run.scope.rawEventIds ?? []).map((id) => `#${id}`).join(", ") || "none"}.
              {e.reevaluated ? " A release landed while this check ran; it was judged again under the mapping lock." : ""}
            </p>
            <ul className="mt-2 list-disc space-y-0.5 pl-4 text-xs text-faint" aria-label="Limits of this check">
              {(e.limitations ?? []).map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}
