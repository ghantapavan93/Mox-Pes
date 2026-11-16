import Link from "next/link";
import { MapPin } from "lucide-react";
import { Badge, PageHeader } from "@/components/ui";
import { briefCopy, type Brief } from "@/lib/changeguard/brief";
import { driftCase, type ChangedLead, type DriftCaseView, type ReviewView } from "@/lib/changeguard/review";
import { count, date, dateTime } from "@/lib/format";
import type { ExceptionRow } from "@/lib/queries";
import { BRANCH_BY_ID } from "@/lib/reference";
import { getPool } from "@/lib/server";
import { VIEWERS, type Viewer } from "@/lib/viewer";
import { OWNER_ROLES } from "@/lib/workflow/proposals";
import { caseAudit } from "@/lib/workflow/queries";
import { DriftDecision } from "./DriftDecision";
import { EvidenceDrawer } from "./EvidenceDrawer";

/**
 * The case page of a post-release drift, as a decision brief (docs/agent-work/DRIFT-REVIEW.md):
 *
 *   1. what changed and what did not (one sentence each, from the stored facts);
 *   2. the proof: at release against the latest check, and the changed leads with their two
 *      stored versions one click away (a drawer over the case);
 *   3. what to do next: one primary action for this viewer and state.
 *
 * The system finding, the human disposition and the business outcome are three separate lines.
 * A reviewed case leads with the decision and why; a reopened one with what is new since that
 * review. The case history lists every transition; routine checks are in the technical history.
 */
export async function DriftReview({ exception, viewer, sinceRunId }: { exception: ExceptionRow; viewer: Viewer; sinceRunId: number | null }) {
  const pool = getPool();
  const view = await driftCase(pool, viewer, exception, { sinceRunId });
  const brief = briefCopy(view);
  const audit = await caseAudit(pool, view.caseId, exception.id);
  const branch = exception.branchId ? BRANCH_BY_ID.get(exception.branchId) : null;

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader
        crumbs={[{ href: "/exceptions", label: "Incidents" }, { label: `Case #${view.caseId}` }]}
        title="Mapping drift after release"
        badges={
          <>
            <span data-testid="case-status">
              <Badge tone={brief.status.tone} dot>
                {brief.status.label}
              </Badge>
            </span>
            {exception.branchId && (
              <Link href={`/branches/${exception.branchId}`} className="inline-flex items-center gap-1 rounded border border-border bg-surface px-1.5 py-0.5 text-[11px] font-medium text-accent hover:bg-accent-soft">
                <MapPin aria-hidden className="size-3" />
                {exception.branchId} {branch?.name}
              </Link>
            )}
          </>
        }
        description={
          <p className="text-xs text-muted">
            Campaign <span className="font-medium text-text">{view.change.campaign}</span> · released to {view.change.releasedBranch} by{" "}
            <Link href={`/changes/${view.change.id}`} className="text-accent underline">
              change #{view.change.id}
            </Link>{" "}
            on {date(view.change.releasedAt)} · owner {view.owner ? roleName(view.owner) : "unassigned"}
          </p>
        }
      />

      <section aria-labelledby="brief-headline" className="space-y-5" data-testid="drift-brief" data-state={brief.state}>
        {brief.state === "reviewed" && view.decision && <DecisionBanner review={view.decision} tone="good" />}
        {brief.state === "investigating" && view.decision && <DecisionBanner review={view.decision} tone="warn" />}
        {view.sinceCheck && <SinceCheck view={view} />}
        {brief.state === "reopened" && view.reopened && <WhatsNew brief={brief} view={view} />}

        <div>
          <h2 id="brief-headline" className="text-xl font-semibold leading-7 text-text" data-testid="brief-headline">
            {brief.headline}
          </h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-muted" data-testid="brief-detail">
            {brief.detail}
          </p>
        </div>

        <Proof view={view} />

        <dl className="divide-y divide-border overflow-hidden rounded-xl bg-surface ring-1 ring-text/10" data-testid="brief-facts">
          {(
            [
              ["System finding", brief.finding, "brief-finding"],
              ["Decision", brief.disposition, "brief-disposition"],
              ["Business outcome", brief.outcome, "brief-outcome"],
            ] as const
          ).map(([label, text, id]) => (
            <div key={id} className="grid gap-1 px-4 py-3 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4">
              <dt className="text-sm font-semibold text-text">{label}</dt>
              <dd className="text-sm leading-6 text-muted" data-testid={id}>
                {text}
                {id === "brief-finding" && view.latest && (
                  <>
                    {" "}
                    <Link href={`/changes/${view.change.id}/checks/${view.latest.runId}`} className="text-accent underline" data-testid="drift-evidence-link">
                      Open the check&apos;s evidence
                    </Link>
                  </>
                )}
              </dd>
            </div>
          ))}
        </dl>

        <section aria-labelledby="next-heading" className="space-y-2" data-testid="brief-next">
          <h3 id="next-heading" className="text-[11px] font-semibold uppercase tracking-wider text-faint">
            What to do next
          </h3>
          {brief.state === "reviewed" ? (
            <p className="text-sm text-muted" data-testid="next-none">
              Nothing to do. This case reopens on its own only if a later check finds a contradiction this review did not see.{" "}
              <Link href="/exceptions" className="text-accent underline">
                Back to Incidents
              </Link>
            </p>
          ) : view.readOnlyReason ? (
            <p className="text-sm text-muted" data-testid="next-readonly">
              {view.readOnlyReason}
            </p>
          ) : null}
          <DriftDecision
            exceptionId={exception.id}
            runId={view.latest?.runId ?? 0}
            evidenceKey={view.latest?.evidenceKey ?? ""}
            leadCount={view.leads.length + view.hiddenLeads}
            ownerOptions={OWNER_ROLES.map((r) => ({ value: r, label: VIEWERS[r].label }))}
            canDecide={view.canDecide && view.latest !== null}
            reopened={brief.state === "reopened"}
            replacedBy={view.change.liveChangeId !== null && view.change.liveChangeId !== view.change.id ? view.change.liveChangeId : null}
          />
        </section>
      </section>

      {/* The decision in force is in the banner above; this lists the others (a reopened case keeps its earlier review here). */}
      {view.reviews.some((r) => r.id !== view.decision?.id) && (
        <Decisions title={view.decision ? "Earlier decisions" : "Decisions on this case"} reviews={view.reviews.filter((r) => r.id !== view.decision?.id)} />
      )}

      <section aria-labelledby="history-heading" className="space-y-2">
        <h2 id="history-heading" className="text-[13px] font-semibold text-text">
          Case history
        </h2>
        <ol className="space-y-0 rounded-xl bg-surface ring-1 ring-text/10" data-testid="case-history">
          {view.history.map((h) => (
            <li key={h.id} className="grid gap-1 border-b border-border px-4 py-2.5 last:border-b-0 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-4" data-title={h.title}>
              <time dateTime={h.at} className="text-xs tabular-nums text-muted">
                {dateTime(h.at)}
              </time>
              <div className="min-w-0 text-sm">
                <span className="font-medium text-text">{h.title}</span> <span className="text-muted">· {h.actor}</span>
                {h.note && <p className="text-xs text-muted">{h.note}</p>}
              </div>
            </li>
          ))}
        </ol>
      </section>

      <details className="rounded-xl bg-surface ring-1 ring-text/10" data-testid="technical-history">
        <summary className="cursor-pointer px-4 py-3 text-[13px] font-semibold text-text">
          Technical history{" "}
          <span className="font-normal text-muted">
            · {count(view.checks.length)} {view.checks.length === 1 ? "check" : "checks"}, {count(audit.length)} audit {audit.length === 1 ? "row" : "rows"}
          </span>
        </summary>
        <div className="space-y-4 border-t border-border p-4">
          <p className="text-xs text-muted">
            Every post-release check of{" "}
            <Link href={`/changes/${view.change.id}`} className="text-accent underline">
              change #{view.change.id}
            </Link>
            , newest first. A check that repeats evidence already reviewed changes nothing on this case.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[32rem] border-collapse text-sm" data-testid="check-history">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted">
                  <th scope="col" className="py-2 pr-3 font-semibold">Check</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">When</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">Outcome</th>
                  <th scope="col" className="py-2 font-semibold">Against the latest review</th>
                </tr>
              </thead>
              <tbody>
                {view.checks.map((c) => (
                  <tr key={c.id} className="border-b border-border last:border-b-0" data-run={c.id}>
                    <td className="py-2 pr-3">
                      <Link href={`/changes/${view.change.id}/checks/${c.id}`} className="text-accent underline">
                        #{c.id}
                      </Link>{" "}
                      <span className="text-xs text-muted">{c.trigger}</span>
                    </td>
                    <td className="py-2 pr-3 tabular-nums text-muted">{dateTime(c.ranAt)}</td>
                    <td className="py-2 pr-3">{OUTCOME[c.outcome] ?? c.outcome}</td>
                    <td className="py-2 text-muted">{c.versusReview === "same" ? "Same evidence" : c.versusReview === "new" ? "New evidence" : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[32rem] border-collapse text-xs" aria-label="Audit rows of this case">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-wide text-muted">
                  <th scope="col" className="py-2 pr-3 font-semibold">When</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">Actor</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">Action</th>
                  <th scope="col" className="py-2 font-semibold">Subject</th>
                </tr>
              </thead>
              <tbody>
                {audit.map((a) => (
                  <tr key={a.id} className="border-b border-border last:border-b-0">
                    <td className="py-1.5 pr-3 tabular-nums text-muted">{dateTime(a.at)}</td>
                    <td className="py-1.5 pr-3">{a.actor}</td>
                    <td className="py-1.5 pr-3 font-mono">{a.action}</td>
                    <td className="py-1.5 font-mono">{a.subject}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </details>
    </div>
  );
}

const OUTCOME: Record<string, string> = {
  current: "Current",
  drift: "Confirmed drift",
  insufficient_evidence: "Insufficient evidence",
  superseded: "Replaced",
  error: "Did not run",
};

const roleName = (role: string) => (role in VIEWERS ? VIEWERS[role as keyof typeof VIEWERS].label.split(" · ")[0] : role);

function Quote({ review }: { review: ReviewView }) {
  return review.rationale ? (
    <blockquote className="border-l-2 border-border-strong pl-3 text-sm text-text" data-testid="review-rationale">
      {review.rationale}
    </blockquote>
  ) : (
    <p className="text-sm italic text-muted" data-testid="review-rationale-withheld">
      The reviewer&apos;s note is withheld: the evidence it refers to includes a branch outside your scope.
    </p>
  );
}

function DecisionBanner({ review, tone }: { review: ReviewView; tone: "good" | "warn" }) {
  const box = tone === "good" ? "border-good/30 bg-good-soft" : "border-warn/30 bg-warn-soft";
  return (
    <div id="case-decision" tabIndex={-1} className={`space-y-2 rounded-lg border p-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${box}`} data-testid="case-decision" data-disposition={review.disposition}>
      <p className="text-[15px] font-semibold text-text">
        {review.disposition === "reviewed_no_change" ? "Reviewed — no mapping change" : `Needs investigation — owner: ${review.ownerLabel}`}
      </p>
      <p className="text-xs text-muted" data-testid="decision-meta">
        {review.actorLabel} · {dateTime(review.reviewedAt)} · reviewed check #{review.runId} ({review.leadsReviewed} changed {review.leadsReviewed === 1 ? "lead" : "leads"})
      </p>
      <Quote review={review} />
      <p className="text-xs text-muted">
        {review.disposition === "reviewed_no_change"
          ? "The check's finding stands and the mapping was not re-verified: this records a person's judgement, not a new check."
          : "The case stays open until someone records a decision."}
      </p>
    </div>
  );
}

function WhatsNew({ brief, view }: { brief: Brief; view: DriftCaseView }) {
  const r = view.reopened!;
  // What reopened the case: the leads the last review did not see (a refused save adds its own callout).
  const fresh = view.leads.filter((l) => l.sinceReview);
  return (
    <div id="whats-new" tabIndex={-1} className="space-y-3 rounded-lg border border-bad/30 bg-bad-soft p-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent" data-testid="whats-new">
      <p className="text-[15px] font-semibold text-text">{brief.whatsNew}</p>
      <p className="text-xs text-muted">
        Check #{r.runId} reopened this case on {dateTime(r.at)}. The review of {date(r.previous.reviewedAt)} had seen {r.previous.leadsReviewed} changed{" "}
        {r.previous.leadsReviewed === 1 ? "lead" : "leads"}; it is kept below.
      </p>
      {fresh.length > 0 && (
        <ul className="space-y-2">
          {fresh.map((l) => (
            <li key={l.fact} className="flex flex-col gap-2 rounded-md border border-border bg-surface p-3 sm:flex-row sm:items-center sm:justify-between" data-testid="new-lead">
              <span className="text-sm text-text">
                {l.noun} <span className="font-mono text-xs">{l.sourceLeadId}</span> now points to <span className="font-semibold">{l.branchNow}</span>
                {l.branchAtRelease && l.branchAtRelease !== l.branchNow ? <span className="text-muted"> (it was {l.branchAtRelease} at release)</span> : null}
                {l.atReleaseWithheld ? <span className="text-muted"> (at release it was at a branch outside your scope)</span> : null}
              </span>
              <EvidenceDrawer lead={l} />
            </li>
          ))}
        </ul>
      )}
      {r.hiddenNewLeads > 0 && <p className="text-sm text-muted">{r.hiddenNewLeads} new {r.hiddenNewLeads === 1 ? "lead points" : "leads point"} to a branch outside your scope.</p>}
    </div>
  );
}

function SinceCheck({ view }: { view: DriftCaseView }) {
  const s = view.sinceCheck!;
  return (
    <div id="new-since-check" tabIndex={-1} className="space-y-1 rounded-lg border border-bad/30 bg-bad-soft p-4 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent" data-testid="since-check">
      <p className="text-[15px] font-semibold text-text">
        New since check #{s.runId}, which you were reviewing: {s.newLeads === 1 ? "one more lead" : `${s.newLeads} more leads`} outside the approved branches.
      </p>
      <p className="text-xs text-muted">
        Marked <span className="font-semibold">New since check #{s.runId}</span> below{s.hiddenNewLeads > 0 ? `; ${s.hiddenNewLeads} of them at a branch outside your scope` : ""}. Your note is kept in the form.
      </p>
    </div>
  );
}

function Proof({ view }: { view: DriftCaseView }) {
  const target = view.change.releasedBranch;
  return (
    <section aria-label="Proof" className="space-y-3" data-testid="brief-proof">
      <div className="grid grid-cols-2 overflow-hidden rounded-xl bg-surface ring-1 ring-text/10">
        <div className="p-4" data-testid="proof-release">
          <p className="text-xs text-muted">At release · {date(view.change.releasedAt)}</p>
          <p className="mt-1 text-[26px] font-semibold leading-8 tabular-nums text-text">
            {view.release.atTarget} of {view.release.total}
          </p>
          <p className="text-xs text-muted">leads at {target}</p>
        </div>
        <div className="border-l border-border bg-warn-soft p-4" data-testid="proof-latest">
          <p className="text-xs text-muted">Latest check · {view.latest ? date(view.latest.ranAt) : "—"}</p>
          <p className="mt-1 text-[26px] font-semibold leading-8 tabular-nums text-text">
            {view.latest ? `${view.latest.atTarget} of ${view.latest.total}` : "—"}
          </p>
          <p className="text-xs text-muted">leads at {target}</p>
        </div>
      </div>
      {view.leads.length > 0 && (
        <ul className="divide-y divide-border rounded-xl bg-surface ring-1 ring-text/10" aria-label="Changed leads" data-testid="changed-leads">
          {view.leads.map((l) => (
            <LeadRow key={l.fact} lead={l} sinceRunId={view.sinceCheck?.runId ?? null} />
          ))}
        </ul>
      )}
      {view.hiddenLeads > 0 && (
        <p className="text-sm text-muted" data-testid="hidden-leads">
          {view.hiddenLeads} changed {view.hiddenLeads === 1 ? "lead is" : "leads are"} at a branch outside your scope: counted here, not shown.
        </p>
      )}
    </section>
  );
}

function LeadRow({ lead, sinceRunId }: { lead: ChangedLead; sinceRunId: number | null }) {
  const atRelease = lead.atReleaseWithheld ? "a branch outside your scope" : (lead.branchAtRelease ?? "—");
  return (
    <li className="grid gap-2 p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-4" data-testid="changed-lead" data-new={lead.isNew} data-new-since={lead.newSince ?? ""}>
      <div className="min-w-0 space-y-0.5">
        <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-text">
          {lead.noun} <span className="font-mono text-xs">{lead.sourceLeadId}</span>
          {lead.newSince === "check" && <Badge tone="bad">New since check #{sinceRunId}</Badge>}
          {lead.newSince === "review" && <Badge tone="bad">New since the last review</Badge>}
        </p>
        <p className="text-sm text-text">
          <span className="text-muted">At release</span> <span className="font-semibold">{atRelease}</span> <span aria-hidden className="text-faint">→</span>
          <span className="sr-only">, </span> <span className="text-muted">now</span> <span className="font-semibold">{lead.branchNow}</span>
        </p>
        <p className="text-xs text-muted">
          {lead.branchAtRelease || lead.atReleaseWithheld ? `Moved to ${lead.branchNow} at the source` : "First arrived"} {dateTime(lead.movedAt)}
        </p>
      </div>
      <EvidenceDrawer lead={lead} />
    </li>
  );
}

function Decisions({ title, reviews }: { title: string; reviews: ReviewView[] }) {
  return (
    <section aria-labelledby="decisions-heading" className="space-y-2" data-testid="review-log">
      <h2 id="decisions-heading" className="text-[13px] font-semibold text-text">
        {title}
      </h2>
      <ul className="space-y-0 rounded-xl bg-surface ring-1 ring-text/10">
        {reviews.map((r) => (
          <li key={r.id} className="space-y-1 border-b border-border px-4 py-3 last:border-b-0" data-testid="review-entry" data-disposition={r.disposition}>
            <p className="text-sm">
              <span className="font-semibold text-text">{r.disposition === "reviewed_no_change" ? "Reviewed — no mapping change" : `Needs investigation — owner: ${r.ownerLabel}`}</span>{" "}
              <span className="text-muted">
                · {r.actorLabel} · {dateTime(r.reviewedAt)} · check #{r.runId}
              </span>
            </p>
            <Quote review={r} />
          </li>
        ))}
      </ul>
    </section>
  );
}
