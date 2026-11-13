import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ChangeActions } from "@/components/changes/ChangeActions";
import { ChangeForm } from "@/components/changes/ChangeForm";
import { DecisionSummary } from "@/components/changes/DecisionSummary";
import { MonitoringStatus } from "@/components/changes/MonitoringStatus";
import { monitorView } from "@/lib/changeguard/monitor";
import { decisionSummary } from "@/lib/changeguard/summary";
import { RolloutEvaluation } from "@/components/changes/RolloutEvaluation";
import { VARIANTS } from "@/lib/twin/scenario";
import { evaluationsForPage } from "@/lib/twin/store";
import { codeFingerprint } from "@/lib/twin/world";
import { Badge, Card, Forbidden, PageHeader, Skeleton } from "@/components/ui";
import { CHECK_LABEL, type PreflightCheck } from "@/lib/changeguard/model";
import { getChange, listCampaignOptions, type ChangeRow } from "@/lib/changeguard/service";
import { dateTime, money } from "@/lib/format";
import { parseRecordId } from "@/lib/record-id";
import { BRANCHES, BRANCH_BY_ID } from "@/lib/reference";
import { businessNow, getPool, getViewer } from "@/lib/server";
import { ForbiddenError, type Viewer } from "@/lib/viewer";
import { STATUS_TONE } from "../status";

type Params = Promise<{ id: string }>;

export const metadata = { title: "Change" };

export default function ChangePage({ params }: { params: Params }) {
  return (
    <Suspense fallback={<Skeleton lines={14} />}>
      <Change params={params} />
    </Suspense>
  );
}

const CHECK_TONE = { pass: "good", warn: "warn", fail: "bad", not_applicable: "neutral" } as const;
const CHECK_MARK = { pass: "✓", warn: "!", fail: "✗", not_applicable: "–" } as const;

function Question({ n, title, children, testId, id }: { n: number | string; title: string; children: React.ReactNode; testId?: string; id?: string }) {
  return (
    <section id={id} className="grid scroll-mt-28 gap-3 border-t border-border py-4 first:border-t-0 first:pt-0 md:grid-cols-[220px_minmax(0,1fr)]" data-testid={testId}>
      <h2 className="flex items-start gap-2 text-sm font-semibold text-text">
        <span className="inline-flex size-5 flex-none items-center justify-center rounded-full bg-text text-[10px] font-bold text-white">{n}</span>
        {title}
      </h2>
      <div className="min-w-0 space-y-2 text-sm">{children}</div>
    </section>
  );
}

function CheckRow({ check }: { check: PreflightCheck }) {
  return (
    <li className="flex gap-2" data-check={check.id} data-status={check.status}>
      <span aria-hidden className={`w-3 flex-none font-bold ${check.status === "fail" ? "text-bad" : check.status === "warn" ? "text-warn" : check.status === "pass" ? "text-good" : "text-faint"}`}>
        {CHECK_MARK[check.status]}
      </span>
      <span className="min-w-0">
        <span className="font-medium text-text">{CHECK_LABEL[check.id]}</span>{" "}
        <Badge tone={CHECK_TONE[check.status]}>{check.status.replace("_", " ")}</Badge>
        {check.code && <code className="ml-1 text-[11px] text-muted">{check.code}</code>}
        <span className="block text-muted">{check.detail}</span>
      </span>
    </li>
  );
}

/** The correction the evidence points to, when a failure names one. */
function correctionOf(change: ChangeRow): { branchId: string; why: string } | null {
  const coverage = change.preflight?.checks.find((c) => c.id === "mapping_coverage");
  const evidence = (coverage?.evidence?.leadEvidence as Array<{ branchId: string; leads: number }> | undefined) ?? [];
  if (coverage?.code !== "LEAD_EVIDENCE_DISAGREES" || evidence.length === 0) return null;
  const top = evidence[0];
  return { branchId: top.branchId, why: `${top.leads} of this campaign's leads arrive at ${top.branchId} ${BRANCH_BY_ID.get(top.branchId)?.name ?? ""}.` };
}

async function Change({ params }: { params: Params }) {
  const id = parseRecordId((await params).id);
  if (id === null) notFound();
  const viewer = await getViewer();
  let data: Awaited<ReturnType<typeof getChange>>;
  try {
    data = await getChange(getPool(), viewer, id);
  } catch (error) {
    if (error instanceof ForbiddenError) return <Forbidden message={error.message} />;
    if ((error as { status?: number }).status === 404) notFound();
    throw error;
  }
  const { change, events } = data;
  const pre = change.preflight;
  const payload = change.payload as { campaignId?: number; branchId?: string; source?: string; entity?: string };
  const previous = (change.base.currentBranchId as string | null | undefined) ?? null;
  const failing = pre?.checks.filter((c) => c.status === "fail") ?? [];
  const warnings = pre?.checks.filter((c) => c.status === "warn") ?? [];
  const correction = correctionOf(change);
  const canCorrect = viewer.can.propose && change.status === "preflight_failed" && change.kind === "campaign_mapping" && correction !== null;
  const campaigns = canCorrect ? await listCampaignOptions(getPool(), viewer) : [];
  // Staged rollout evaluations (Reliability Twin): company-scope viewers only.
  const rollout =
    change.kind === "source_contract" && payload.source === "calls" && viewer.branchIds === null
      ? await evaluationsForPage(getPool(), viewer, change.id, codeFingerprint())
      : null;
  // Post-release monitoring, judged on the business clock the schedule runs on.
  const monitoring = await monitorView(getPool(), change, await businessNow());
  const summary = monitoring ? await decisionSummary(getPool(), viewer, change, monitoring) : null;

  return (
    <div className="space-y-6">
      <PageHeader
        crumbs={[{ label: "Systems" }, { href: "/changes", label: "ChangeGuard" }, { label: `Change #${change.id}` }]}
        title={change.title}
        badges={
          <span data-testid="change-status">
            <Badge tone={STATUS_TONE[change.status]} dot>
              {change.status.replaceAll("_", " ")}
            </Badge>
          </span>
        }
        description={<p>Proposed by {change.authorSubject} ({change.authorRole}) on {dateTime(change.createdAt)}.{change.supersedes ? ` Corrects change #${change.supersedes}.` : ""}</p>}
      />

      {summary && <DecisionSummary summary={summary} detailsHref="#after-release" />}

      <Card>
        <Question n={1} title="What is changing?" testId="q-what">
          {change.kind === "campaign_mapping" ? (
            <p>
              Campaign <strong>{String((change.base.campaign as { externalId?: string } | null)?.externalId ?? payload.campaignId)}</strong> maps to{" "}
              <strong>{previous ?? "no branch"}</strong> now; this change maps it to <strong>{payload.branchId} {BRANCH_BY_ID.get(payload.branchId ?? "")?.name}</strong>{" "}
              (brand {BRANCH_BY_ID.get(payload.branchId ?? "")?.brandId}).
            </p>
          ) : (
            <p>
              A changed shape of <strong>{payload.source} {payload.entity}</strong> records, checked with sample payloads against the deployed mapper.
            </p>
          )}
          <p className="text-xs text-muted">
            Configuration hash <code>{change.configHash.slice(0, 16)}</code>
          </p>
        </Question>

        <Question n={2} title="What depends on it?">
          <p>Reporting that reads it: {pre?.dependentMetrics.join(", ") || "—"}.</p>
          {pre && pre.impact.length > 0 && <p className="text-muted">Branches whose numbers move: {pre.impact.map((i) => `${i.branchId} (${i.role})`).join(", ")}.</p>}
        </Question>

        <Question n={3} title="What did we test?" testId="q-tested">
          {pre ? (
            <>
              <p className="text-muted">
                {pre.checks.length} checks, {change.kind === "campaign_mapping" ? "with the production write path run in a transaction that was rolled back" : "through the deployed mapper, reading only"}, on{" "}
                {change.preflightedAt ? dateTime(change.preflightedAt) : "—"}. Verdict: <Badge tone={pre.verdict === "fail" ? "bad" : pre.verdict === "warn" ? "warn" : "good"}>{pre.verdict}</Badge>
              </p>
              <ul className="space-y-1.5" aria-label="Preflight checks">
                {pre.checks.map((c) => (
                  <CheckRow key={c.id} check={c} />
                ))}
              </ul>
            </>
          ) : (
            <p className="text-muted">Not preflighted yet.</p>
          )}
        </Question>

        <Question n={4} title="What failed?" testId="q-failed">
          {failing.length === 0 ? (
            <p className="text-good">Nothing failed.{warnings.length ? ` ${warnings.length} warning(s) for the reviewer: ${warnings.map((w) => CHECK_LABEL[w.id]).join(", ")}.` : ""}</p>
          ) : (
            <ul className="space-y-1.5" aria-label="Failed checks">
              {failing.map((c) => (
                <CheckRow key={c.id} check={c} />
              ))}
            </ul>
          )}
        </Question>

        <Question n={5} title="What could be affected?" testId="q-affected">
          {pre && pre.impact.length > 0 ? (
            <table className="w-full max-w-xl text-xs">
              <thead>
                <tr className="text-left text-faint">
                  <th className="py-1 font-medium">Branch</th>
                  <th className="py-1 text-right font-medium">Paid spend</th>
                  <th className="py-1 text-right font-medium">Paid customers</th>
                  <th className="py-1 text-right font-medium">Paid CAC</th>
                </tr>
              </thead>
              <tbody>
                {pre.impact.map((i) => (
                  <tr key={i.branchId} className="border-t border-border">
                    <td className="py-1">
                      <Link href={`/branches/${i.branchId}/trace?period=all&metric=paid_cac`} className="text-accent hover:underline" data-testid="impact-trace-link">{i.branchId}</Link>{" "}
                      <span className="text-muted">({i.role.replace("_", " ")})</span>
                    </td>
                    <td className="py-1 text-right tabular-nums">
                      {money(i.before.paidSpendCents)} → {money(i.after.paidSpendCents)}
                    </td>
                    <td className="py-1 text-right tabular-nums">
                      {i.before.paidAcquired} → {i.after.paidAcquired}
                    </td>
                    <td className="py-1 text-right tabular-nums">
                      {money(i.before.paidCacCents)} → {money(i.after.paidCacCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            change.kind === "source_contract" &&
            pre?.samples && (
              <ul className="text-xs text-muted">
                {pre.samples.map((s) => (
                  <li key={s.index}>
                    Sample {s.index + 1}: <code>{s.outcome}</code>
                    {s.addedFields.length > 0 && ` · added ${s.addedFields.join(", ")}`}
                    {s.removedFields.length > 0 && ` · missing ${s.removedFields.join(", ")}`}
                  </li>
                ))}
              </ul>
            )
          )}
          {pre && change.kind === "campaign_mapping" && (
            <p className="text-muted">
              Exceptions that would clear: {pre.exceptionsCleared.map((e) => e.summary).join("; ") || "none"}. Would open: {pre.exceptionsOpened.map((e) => e.summary).join("; ") || "none"}.
              Other branches changed in the preview: {pre.unrelatedBranchesChanged.join(", ") || "none"}.
            </p>
          )}
          {pre && <p className="text-xs text-faint">Limits of this preview: {pre.limitations.join(" ")}</p>}
        </Question>

        <Question n={6} title="What must be corrected?" testId="q-correct">
          {failing.length === 0 ? (
            <p className="text-muted">Nothing.</p>
          ) : correction ? (
            <>
              <p>
                Map it to <strong>{correction.branchId}</strong> instead: {correction.why}
              </p>
              {canCorrect && (
                <ChangeForm
                  campaigns={campaigns}
                  branches={BRANCHES.filter((b) => !viewer.branchIds || viewer.branchIds.includes(b.id)).map((b) => ({ id: b.id, label: `${b.id} ${b.name} (${b.brandId})` }))}
                  defaults={{ campaignId: payload.campaignId, branchId: correction.branchId, reason: `Corrected: ${correction.why}` }}
                  supersedes={change.id}
                  submitLabel="Resubmit corrected change"
                />
              )}
            </>
          ) : (
            <p>Resolve the failed checks above; the change cannot be reviewed as it stands.</p>
          )}
        </Question>

        <Question n={7} title="Who can approve?" testId="q-approve">
          <p>
            A person with the approve permission, other than the author ({change.authorSubject}), with {[previous, payload.branchId].filter(Boolean).join(" and ") || "the scope"} in scope. The
            database refuses an approval by the author. The approval is bound to the configuration and preflight hashes, and to the mapping and evidence it was checked
            against; if those move before release, the approval is invalidated.
          </p>
          {change.approvedSubject && (
            <p>
              <Badge tone={change.status === "rejected" ? "bad" : "good"}>{change.status === "rejected" ? "Rejected" : "Approved"}</Badge> by {change.approvedSubject} ({change.approvedRole}) on{" "}
              {change.approvedAt ? dateTime(change.approvedAt) : "—"}: “{change.decisionReason}”
            </p>
          )}
          <ChangeActions changeId={change.id} can={capabilities(change, viewer)} hashes={{ configHash: change.configHash, preflightHash: change.preflightHash }} />
        </Question>

        <Question n={8} title="What happened after release?" testId="q-after" id="after-release">
          <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[max-content_1fr]" aria-label="Evidence levels" data-testid="evidence-levels">
            <dt className="font-medium text-text">Previewed impact</dt>
            <dd className="text-muted">{pre ? `Measured on the real write path in a rolled-back transaction${change.preflightedAt ? `, ${dateTime(change.preflightedAt)}` : ""}. A prediction, not a fact about the live data.` : "No preview yet."}</dd>
            <dt className="font-medium text-text">Verified configuration effect</dt>
            <dd className="text-muted">
              {change.verification
                ? `${change.verification.checks.filter((c) => c.passed).length} of ${change.verification.checks.length} release checks passed on the live data, in the release transaction.`
                : "Not released."}
            </dd>
            <dt className="font-medium text-text">Observed since release</dt>
            <dd className="text-muted">
              {monitoring
                ? `Checked on a schedule after the release: ${monitoring.runs} check(s) so far, latest ${monitoring.latest ? dateTime(monitoring.latest.ranAt) : "none yet"} (below).`
                : change.verification ? "Not monitored: only campaign mappings are." : "Not released."}
            </dd>
            <dt className="font-medium text-text">Measured business outcome</dt>
            <dd className="text-muted"><strong className="text-text">Not measured.</strong> Revenue or CAC improvement needs a controlled measurement; none exists.</dd>
          </dl>
          {change.verification ? (
            <>
              <ul className="space-y-1" aria-label="Verification">
                {change.verification.checks.map((c) => (
                  <li key={c.id} className="flex gap-2">
                    <span aria-hidden className={c.passed ? "text-good" : "text-bad"}>
                      {c.passed ? "✓" : "✗"}
                    </span>
                    <span>
                      <span className="font-medium">{c.layer.replace("_", " ")} success</span>: {c.detail}
                    </span>
                  </li>
                ))}
              </ul>
              {monitoring && <MonitoringStatus changeId={change.id} view={monitoring} viewer={viewer} />}
              <p className="text-muted">
                Measured business improvement: <strong>not measured</strong>. A correct configuration is not evidence of more revenue; that needs an experiment.
              </p>
              {change.status === "recovery_required" && (
                <p className="text-bad">
                  Recovery required: a person reviews the evidence before anything changes. A compensating change is one possible outcome, not the default. Nothing was rolled back automatically.
                </p>
              )}
            </>
          ) : (
            <p className="text-muted">Not released.</p>
          )}
          <ol className="mt-2 space-y-0.5 border-l border-border pl-3 text-xs text-muted" aria-label="History">
            {events.map((e, i) => (
              <li key={i}>
                {dateTime(e.at)} · {e.from ? `${e.from.replaceAll("_", " ")} → ` : ""}
                <span className="text-text">{e.to.replaceAll("_", " ")}</span> · {e.subject}
              </li>
            ))}
          </ol>
        </Question>

        {change.kind === "source_contract" && payload.source === "calls" && (
          <Question n={9} title="Would a staged rollout hold? (simulated)" testId="q-rollout">
            {rollout ? (
              <RolloutEvaluation changeId={change.id} initial={rollout} canRun={viewer.can.propose} variants={Object.entries(VARIANTS).map(([id, v]) => ({ id, label: v.label, description: v.description }))} />
            ) : (
              <p className="text-muted">A rollout evaluation covers all 44 branches; {viewer.label} cannot see it.</p>
            )}
          </Question>
        )}
      </Card>
    </div>
  );
}

function capabilities(change: ChangeRow, viewer: Viewer) {
  const isAuthor = change.authorSubject === viewer.subject;
  const reviewable = change.status === "ready_for_review";
  return {
    preflight: viewer.can.propose && ["draft", "preflight_failed", "ready_for_review"].includes(change.status),
    decide: viewer.can.approve && !isAuthor && reviewable && change.kind === "campaign_mapping",
    release: viewer.can.propose && change.status === "approved",
    monitor: (viewer.can.propose || viewer.can.approve) && (change.status === "verified" || change.status === "degraded"),
    decideReason: reviewable
      ? isAuthor
        ? "You proposed this change; a different person must decide it."
        : !viewer.can.approve
          ? `${viewer.label} cannot approve; an approver decides.`
          : change.kind === "source_contract"
            ? "A source contract check stops at review: activating a mapper version is a code deploy."
            : null
      : null,
  };
}
