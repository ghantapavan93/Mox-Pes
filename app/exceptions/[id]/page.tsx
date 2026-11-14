import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { Bot, MapPin } from "lucide-react";
import { CoverageGapRecords } from "@/components/CoverageGap";
import { WorkflowPanel } from "@/components/actions/WorkflowPanel";
import { DecisionForm } from "@/components/DecisionForm";
import { ReplayPanel } from "@/components/ReplayPanel";
import { DriftReview } from "@/components/incidents/DriftReview";
import { GapRecovery } from "@/components/incidents/GapRecovery";
import { Badge, ButtonLink, Callout, Card, KV, PageHeader, SectionNav, SeverityBadge, Skeleton, StatusBadge, TableWrap, Td, Th } from "@/components/ui";
import { ACTIVE_VERSION, mapperVersions } from "@/lib/adapters/registry";
import { KIND_LABEL, count, dateTime, money } from "@/lib/format";
import { quarantineGroupIds } from "@/lib/ingest/replay";
import { planReplay } from "@/lib/ingest/replay-plan";
import { acquisitionTrail, getException, lastReplayForException, quarantineSamples, type ExceptionRow } from "@/lib/queries";
import type { ReplayResult } from "@/lib/ingest/replay";
import { DECISION_BLOCKING_KINDS, decisionHolds } from "@/lib/metrics/decision";
import { parseChannel, parseWeek, WINDOW, windowWeeks } from "@/lib/metrics/movement";
import { weekLabel } from "@/lib/metrics/movement-copy";
import { PERIODS, type PeriodKey } from "@/lib/period";
import { gapCoverage } from "@/lib/reconcile/gap-coverage";
import { gapStatus } from "@/lib/reconcile/gap-status";
import { BRAND_BY_ID, BRANCHES, BRANCH_BY_ID, type BrandId } from "@/lib/reference";
import { getPool, getViewer } from "@/lib/server";
import { canSeeBranch, type Viewer } from "@/lib/viewer";
import { parseRecordId } from "@/lib/record-id";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

/** Exception kinds that gate a budget decision: their page links to the Decision Lab. */
const DECISION_KINDS: ReadonlySet<string> = new Set(DECISION_BLOCKING_KINDS);

/** The Monday of an ISO date's week (the Overview's weeks run Monday–Sunday). */
const mondayOf = (date: string) => {
  const t = new Date(`${date}T00:00:00Z`);
  return new Date(t.getTime() - ((t.getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
};

export const metadata = { title: "Incident" };

export default function ExceptionPage(props: Props) {
  return (
    <Suspense fallback={<Skeleton lines={10} />}>
      <ExceptionDetail {...props} />
    </Suspense>
  );
}

/** A held payment version (R-37, lib/ingest/ingest.ts): a payload conflict of another shape. */
const HELD_VERSION_WHY =
  "The CRM sent a payment version that would put cash back, after a later version had removed it (a void, a lower amount or a larger refund). Payments carry no update time, so a stale copy cannot be told from a real reversal: the later version was kept and this one is stored as evidence. Check the payment in the CRM; close this once checked.";

const WHY: Record<string, string> = {
  quarantined_source_records:
    "Records failed validation and were held back instead of being guessed at. Until they are replayed, every downstream number that depends on them is understated — here, customers who called in look like they came from nowhere.",
  branch_mismatch:
    "The lead was captured for one branch but the customer is serviced by another. Spend and lead credit land on one branch while the revenue lands on another — which matters when branch partners are measured on their own economics.",
  unmapped_spend: "Money was spent on a campaign that no branch owns. It is excluded from every branch's CAC until someone maps it.",
  channel_conflict:
    "A paid touch reached this customer first, then a door-to-door rep signed them. Credit follows the first evidenced touch; this list exists so commission and media spend are not both counted as the reason for one sale.",
  payment_without_ticket: "A payment arrived for an invoice the CRM feed has not delivered yet — usually ordering. It clears itself when the invoice arrives.",
  payload_conflict: "The source sent two different payloads under the same record version. The first was kept; a person must decide whether the source has a bug.",
  channel_coverage_gap:
    "Nothing failed validation. A paid channel kept producing leads at this branch while its spend stopped, because the spend now arrives under a new campaign that the mapper files in a different channel. Cost per customer is wrong for both channels until the stored records are re-mapped. This demo simulates Google migrating a Local Services campaign into Performance Max: the Google change is real, this branch, date and pipeline failure are invented.",
};

async function ExceptionDetail({ params, searchParams }: Props) {
  const { id } = await params;
  const exceptionId = parseRecordId(id);
  if (exceptionId === null) notFound();
  const [viewer, exception] = await Promise.all([getViewer(), getException(getPool(), exceptionId)]);
  if (!exception) notFound();
  // Out of scope reads as missing, as for customers and investigations: naming the branch would
  // confirm the id exists and where (audit 2026-11-09, E6).
  if (!canSeeBranch(viewer, exception.branchId)) notFound();
  // A post-release drift has its own decision brief: the review is recorded there, not through
  // the generic fix workflow (lib/changeguard/review.ts).
  if (exception.kind === "mapping_drift") {
    const since = (await searchParams).since;
    return <DriftReview exception={exception} viewer={viewer} sinceRunId={typeof since === "string" ? parseRecordId(since) : null} />;
  }
  const ev = exception.evidence;

  const amountLabel = exception.kind === "channel_coverage_gap" || exception.kind === "unmapped_spend" ? "Spend affected" : "Revenue at stake";
  const branch = exception.branchId ? BRANCH_BY_ID.get(exception.branchId) : null;

  // The selection the reviewer arrived with (Overview → daily evidence → here), read only after the
  // scope check above, and carried on so Decision Lab and the way back keep it.
  const sp = await searchParams;
  const periodKey: PeriodKey = typeof sp.period === "string" && Object.hasOwn(PERIODS, sp.period) ? (sp.period as PeriodKey) : "oct";
  const selected = parseChannel(sp.channel) && parseWeek(sp.week) ? { channel: parseChannel(sp.channel)!, week: parseWeek(sp.week)! } : null;
  const brandQuery = typeof sp.brand === "string" && BRAND_BY_ID.has(sp.brand as BrandId) ? `&brand=${sp.brand}` : "";
  const decisionsHref = `/decisions?branch=${exception.branchId}&period=${periodKey}${selected ? `&channel=${selected.channel}&week=${selected.week}` : ""}${brandQuery}`;
  const traceHref = (channel: string, week: string | null) =>
    `/branches/${exception.branchId}/trace?period=${periodKey}&metric=paid_spend&channel=${channel}${week ? `&week=${week}` : ""}${brandQuery}#selection`;
  // A coverage gap's recovery: its window as the accepted records cover it now (lib/reconcile/gap-coverage.ts),
  // and its status in the words every view uses (lib/reconcile/gap-status.ts).
  const coverage = exception.kind === "channel_coverage_gap" && exception.branchId ? await gapCoverage(getPool(), ev, exception.branchId) : null;
  const status = coverage ? gapStatus({ id: exception.id, status: exception.status, evidence: ev, resolution: exception.resolution }, coverage) : null;
  const otherHolds = coverage ? (await decisionHolds(getPool(), [exception.branchId!])).filter((h) => h.exceptionId !== exception.id) : [];
  // The records to open next: the week of the first date that still needs spend, else the selected
  // week, else the window's first. The week the reviewer came from stays one link away ("back").
  const needing = coverage ? [...coverage.missing, ...coverage.recordedZero, ...coverage.misfiled.map((m) => m.date)].sort() : [];
  const selectedHere = selected && coverage && selected.channel === coverage.channel ? selected.week : null;
  const recordsWeek = coverage ? ((needing[0] ? parseWeek(mondayOf(needing[0])) : null) ?? selectedHere ?? parseWeek(mondayOf(coverage.window.from))) : null;
  /** "Oct 12–Oct 18": a week as the daily evidence lists it (the window can end it early). */
  const recordsWeekLabel = (week: string | null) => {
    const w = week ? windowWeeks(WINDOW, null).find((x) => x.start === week) : undefined;
    return w ? weekLabel(w) : "the window";
  };

  return (
    <div className="space-y-6">
      <PageHeader
        crumbs={[{ href: "/exceptions", label: "Incidents" }, { label: `#${exception.id}` }]}
        title={KIND_LABEL[exception.kind] ?? exception.kind}
        badges={
          <>
            <SeverityBadge severity={exception.severity} />
            <StatusBadge status={exception.status} />
            {exception.branchId && (
              <Link href={`/branches/${exception.branchId}`} className="inline-flex items-center gap-1 rounded border border-border bg-surface px-1.5 py-0.5 text-[11px] font-medium text-accent hover:bg-accent-soft">
                <MapPin aria-hidden className="size-3" />
                {exception.branchId} {branch?.name}
              </Link>
            )}
          </>
        }
        description={
          <>
            <p className="font-medium text-text" data-testid="exception-summary">{exception.summary}</p>
            <p className="mt-1 max-w-3xl">{(exception.evidence as { conflict?: unknown } | null)?.conflict === "earlier_version_after_later" ? HELD_VERSION_WHY : WHY[exception.kind]}</p>
          </>
        }
        actions={
          <>
            {viewer.can.investigate ? (
              // Secondary beside a coverage gap's recovery: that panel's next action is the page's one primary.
              <ButtonLink href={`/investigator?exception=${exception.id}`} variant={coverage ? "secondary" : "primary"} testId="investigate-link" icon={<Bot aria-hidden className="size-4" />}>
                Investigate with AI
              </ButtonLink>
            ) : (
              <span className="text-xs text-muted">Investigations need any role except guest.</span>
            )}
            {exception.branchId && DECISION_KINDS.has(exception.kind) && (
              <ButtonLink href={decisionsHref}>Decision readiness for {exception.branchId}</ButtonLink>
            )}
            {exception.branchId && <ButtonLink href={`/branches/${exception.branchId}`}>Branch {exception.branchId}</ButtonLink>}
          </>
        }
      />

      {coverage && status && (
        <GapRecovery
          exception={exception}
          coverage={coverage}
          status={status}
          otherHolds={otherHolds}
          links={{
            records: { href: traceHref(coverage.channel, recordsWeek), week: recordsWeekLabel(recordsWeek) },
            back: selected ? traceHref(selected.channel, selected.week) : null,
            decisions: `${decisionsHref}#readiness`,
            // The run's row on the ingestion pipeline, which only company-wide roles may open.
            run: viewer.branchIds ? null : (runId) => `/integrations?view=pipeline&run=${runId}#run-${runId}`,
          }}
        />
      )}

      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border shadow-raised md:grid-cols-4" data-testid="incident-impact">
        {(
          [
            [amountLabel, money(exception.amountCents)],
            ["First detected", dateTime(exception.firstDetectedAt)],
            [exception.resolvedAt ? "Resolved" : "Last detected", dateTime(exception.resolvedAt ?? exception.lastDetectedAt)],
            ["Budget decisions", DECISION_KINDS.has(exception.kind) ? (exception.status === "open" ? "On hold while open" : "No longer held") : "Not gated by this kind"],
          ] as Array<[string, ReactNode]>
        ).map(([k, v]) => (
          <div key={k} className="bg-surface px-4 py-3">
            <dt className="text-xs text-muted">{k}</dt>
            <dd className="mt-0.5 text-[15px] font-semibold tabular-nums text-text">{v}</dd>
          </div>
        ))}
      </dl>

      <SectionNav
        label="Incident sections"
        testId="incident-sections"
        items={[
          ["#evidence", "Evidence"],
          ["#action-center", "Fix & approval"],
          ["#records", "Records"],
          ["#case-audit", "Audit"],
        ]}
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-6">
          <Card id="evidence" title="Evidence" subtitle="Structured facts the classification rests on">
            <KV
              items={[
                ...Object.entries(ev)
                  .filter(([, v]) => v === null || typeof v !== "object")
                  .map(([k, v]) => [labelFor(k), formatEvidence(k, v)] as [string, ReactNode]),
              ]}
            />
            {/* The amount is repeated here so the evidence card stands alone when printed or linked. */}
            <p className="mt-3 text-xs text-muted">
              {amountLabel}: <span className="font-medium text-text">{money(exception.amountCents)}</span>
            </p>
            {exception.resolution && <Callout tone="good" title="Resolution">{exception.resolution}</Callout>}
          </Card>

          <div id="action-center" className="scroll-mt-28">
            <Suspense fallback={<Skeleton lines={6} />}>
              <WorkflowPanel exception={exception} viewer={viewer} />
            </Suspense>
          </div>

          <div id="records" className="scroll-mt-28 space-y-6">
            <Suspense fallback={<Skeleton lines={6} />}>
              <Records exception={exception} />
            </Suspense>
          </div>
        </div>

        <aside className="space-y-4 lg:sticky lg:top-28 lg:self-start" aria-label="Decision and role">
          <Card title="Decision" subtitle={actionSubtitle(exception, viewer)}>
            <Suspense fallback={<Skeleton lines={2} />}>
              <Actions exception={exception} viewer={viewer} />
            </Suspense>
          </Card>
          <Card title="How a fix is applied">
            <ol className="space-y-2 text-xs leading-5 text-muted">
              {[
                ["Propose", "an analyst or engineer names the fix", viewer.can.propose],
                ["Dry run", "an engineer runs it in a transaction that rolls back", viewer.can.dryRun],
                ["Approve", "a different role approves that exact dry run", viewer.can.approve],
                ["Execute", "the application applies it once and verifies the ledger", viewer.can.approve],
              ].map(([step, what, can], i) => (
                <li key={String(step)} className="flex gap-2">
                  <span aria-hidden className="grid size-5 shrink-0 place-items-center rounded-full bg-surface-2 text-[10px] font-semibold text-text">{i + 1}</span>
                  <span>
                    <span className="font-medium text-text">{step}</span>: {what}.{" "}
                    <span className={can ? "text-good" : "text-faint"}>{can ? "You can." : "Not your role."}</span>
                  </span>
                </li>
              ))}
            </ol>
            <p className="mt-3 border-t border-border pt-2 text-[11px] text-faint">Viewing as {viewer.label}. Permissions are checked on the server; these labels only explain them.</p>
          </Card>
        </aside>
      </div>
    </div>
  );
}

/** camelCase evidence keys → readable labels ("annualContractValueCents" → "Annual contract value"). */
function labelFor(key: string): string {
  const words = key.replace(/Cents$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function formatEvidence(key: string, value: unknown): ReactNode {
  if (value === null || value === undefined) return "—";
  if (/Cents$/.test(key) && typeof value === "number") return money(value);
  if (/At$/.test(key) && typeof value === "string") return dateTime(value);
  return String(value);
}

function actionSubtitle(e: ExceptionRow, viewer: Viewer): string {
  if (e.status === "resolved") return "Closed — re-opens automatically if the condition returns";
  if (e.kind === "quarantined_source_records") return viewer.can.replay ? "Replay held records through a fixed mapper" : "Integration engineers replay records";
  if (e.kind === "channel_coverage_gap") return viewer.can.replay ? "Re-map the stored spend records through the fixed mapper" : "Integration engineers re-map records";
  if (e.kind === "unmapped_spend" || e.kind === "branch_mismatch") return viewer.can.decide ? "Record a decision (audited)" : "Read-only for your role";
  if (e.kind === "payload_conflict") return viewer.can.closeConflicts ? "Close with a reason once the source is checked" : "Integration engineers close conflicts";
  if (e.kind === "channel_conflict") return viewer.can.decide ? "Acknowledge after commission review (audited)" : "Read-only for your role";
  return "No manual action — clears when the data agrees";
}

async function Actions({ exception, viewer }: { exception: ExceptionRow; viewer: Viewer }) {
  const ev = exception.evidence as Record<string, unknown>;

  if (exception.kind === "quarantined_source_records" || exception.kind === "channel_coverage_gap") {
    const source = exception.kind === "channel_coverage_gap" ? "ads" : (ev.source as "calls");
    const [plan, last] = await Promise.all([
      exception.status === "resolved" ? Promise.resolve(null) : planReplay(getPool(), exception, ACTIVE_VERSION[source]),
      lastReplayForException(getPool(), exception.id),
    ]);
    const ids = plan?.rawEventIds ?? [];
    const lastReplay: ReplayResult | null = last
      ? {
          idempotencyKey: last.idempotency_key,
          dryRun: false,
          alreadyProcessed: false,
          requested: last.requested_ids.length,
          claimed: last.claimed,
          projected: last.projected,
          stillQuarantined: last.still_quarantined,
          errors: [],
          before: last.metric_before,
          after: last.metric_after,
        }
      : null;
    if (!viewer.can.replay) {
      return exception.status === "resolved" ? (
        <p className="text-sm text-muted">Resolved. Nothing to do.</p>
      ) : (
        <p className="text-sm text-muted">Switch to <Badge>Integration engineer</Badge> to dry-run or {plan?.mode === "reproject" ? "re-map" : "replay"} these {count(ids.length)} records.</p>
      );
    }
    return (
      <ReplayPanel
        exceptionId={exception.id}
        source={source}
        versions={mapperVersions(source)}
        defaultVersion={ACTIVE_VERSION[source]}
        records={ids.length}
        lastReplay={lastReplay}
        verb={exception.kind === "channel_coverage_gap" ? "Re-map" : "Replay"}
      />
    );
  }

  if (exception.status === "resolved") return <p className="text-sm text-muted">Nothing to do.</p>;

  if (exception.kind === "unmapped_spend") {
    if (!viewer.can.decide) return <p className="text-sm text-muted">Read-only for your role.</p>;
    const suggested = String(ev.name ?? "").match(/^(B\d{2})\b/)?.[1];
    return (
      <DecisionForm
        exceptionId={exception.id}
        action="map_campaign"
        branchOptions={BRANCHES.map((b) => ({ id: b.id, label: `${b.id} ${b.name}` }))}
        defaultBranch={suggested}
        submitLabel="Map campaign to branch"
        hint={suggested ? `${suggested} is suggested from the campaign name — a suggestion, not a fact. Confirm with the campaign owner.` : undefined}
      />
    );
  }

  if (exception.kind === "branch_mismatch") {
    if (!viewer.can.decide) return <p className="text-sm text-muted">Read-only for your role.</p>;
    const options = [...new Set([ev.crmBranch, ev.territoryBranch].filter(Boolean) as string[])];
    return (
      <DecisionForm
        exceptionId={exception.id}
        action="override_lead_branch"
        branchOptions={options.map((b) => ({ id: b, label: `${b} ${BRANCH_BY_ID.get(b)?.name ?? ""} (${b === ev.territoryBranch ? "territory" : "CRM office"})` }))}
        submitLabel="Credit the lead to this branch"
        hint="Writes an override in this system only. The website's zip lookup still needs fixing at the source — that is a separate ticket."
      />
    );
  }

  if (exception.kind === "payload_conflict") {
    if (!viewer.can.closeConflicts) return <p className="text-sm text-muted">Read-only for your role.</p>;
    return <DecisionForm exceptionId={exception.id} action="close" submitLabel="Close conflict" />;
  }

  if (exception.kind === "channel_conflict") {
    if (exception.status === "acknowledged") return <p className="text-sm text-muted">Acknowledged.</p>;
    if (!viewer.can.decide) return <p className="text-sm text-muted">Read-only for your role.</p>;
    return (
      <DecisionForm
        exceptionId={exception.id}
        action="acknowledge"
        submitLabel="Acknowledge"
        hint="Credit stays with the first evidenced touch. Acknowledging records that commission and media were both reviewed for this customer."
      />
    );
  }

  return <p className="text-sm text-muted">No manual action. This clears when the underlying records agree.</p>;
}

async function Records({ exception }: { exception: ExceptionRow }) {
  const pool = getPool();
  const ev = exception.evidence as Record<string, unknown>;

  if (exception.kind === "quarantined_source_records") {
    const ids = await quarantineGroupIds(pool, { source: String(ev.source), errorCode: String(ev.errorCode), branchId: exception.branchId });
    const sampleIds = ids.length > 0 ? ids.slice(0, 12) : ((ev.sampleRawEventIds as number[]) ?? []);
    const samples = await quarantineSamples(pool, sampleIds);
    return (
      <Card title={`Held records (${count(ids.length)} quarantined now)`} subtitle="Payloads are stored redacted: contact details are hashed before anything else sees them">
        <TableWrap label="Raw events behind this incident">
          <thead>
            <tr>
              <Th>Raw event</Th>
              <Th>Source time</Th>
              <Th>Status / error</Th>
              <Th>Payload (redacted)</Th>
              <Th>CRM customer it would attach to</Th>
            </tr>
          </thead>
          <tbody>
            {samples.map((s) => (
              <tr key={s.id}>
                <Td className="font-mono text-xs">#{s.id}<div className="text-faint">{s.adapter_version}</div></Td>
                <Td className="text-xs">{dateTime(s.occurred_at)}</Td>
                <Td className="text-xs">
                  {s.error_code ? <Badge tone="bad">{s.error_code}</Badge> : <Badge tone="good">projected</Badge>}
                  <div className="mt-1 text-muted">{s.error_detail}</div>
                </Td>
                <Td><pre role="region" aria-label="Payload sample" tabIndex={0} className="max-w-xs overflow-x-auto whitespace-pre-wrap break-all text-[10px] text-muted">{JSON.stringify(s.payload, null, 1).slice(0, 420)}</pre></Td>
                <Td className="text-xs">
                  {(s.customers as Array<{ customerId: number; basis: string; channel: string }> | null)?.map((c) => (
                    <div key={c.customerId}>
                      #{c.customerId} · <Badge tone={c.basis === "no_lead_record" ? "bad" : "good"}>{c.basis === "no_lead_record" ? "no lead record" : c.channel}</Badge>
                    </div>
                  )) ?? <span className="text-faint">no CRM customer (yet)</span>}
                </Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      </Card>
    );
  }

  if (exception.kind === "channel_coverage_gap") return <CoverageGapRecords exception={exception} />;

  if (exception.subjectType === "acquisition") {
    const trail = await acquisitionTrail(pool, Number(exception.subjectId));
    return (
      <Card title={`Customer #${exception.subjectId} — record trail`} subtitle="Every lead record that matches this customer's phone or email, then their CRM history">
        <div className="grid gap-6 lg:grid-cols-2">
          <TableWrap label="Matching lead records">
            <thead><tr><Th>Lead</Th><Th>When</Th><Th>Branch</Th><Th>Channel / evidence</Th></tr></thead>
            <tbody>
              {trail.leads.map((l) => (
                <tr key={l.id} className={trail.acquisition?.lead_id === l.id ? "bg-accent-soft" : ""}>
                  <Td className="text-xs">{l.source} #{l.id}{trail.acquisition?.lead_id === l.id && <div className="text-accent">credited touch</div>}</Td>
                  <Td className="text-xs">{dateTime(l.occurred_at)}</Td>
                  <Td className="text-xs">{l.branch_id}{l.branch_overridden && <div className="text-good">→ {l.effective_branch_id} (override)</div>}</Td>
                  <Td className="text-xs">{l.channel_code} · {l.attribution_evidence}</Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
          <TableWrap label="Matching CRM records">
            <thead><tr><Th>CRM record</Th><Th>When</Th><Th>Detail</Th><Th align="right">Amount</Th></tr></thead>
            <tbody>
              {trail.events.map((e) => (
                <tr key={`${e.kind}${e.id}`}>
                  <Td className="text-xs">{e.kind} #{e.id}</Td>
                  <Td className="text-xs">{dateTime(e.at)}</Td>
                  <Td className="text-xs">{e.detail}</Td>
                  <Td align="right" className="text-xs">{e.cents === null ? "" : money(Number(e.cents))}</Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </div>
      </Card>
    );
  }

  if (exception.kind === "payload_conflict") {
    const stored = await pool.query("select payload from raw_events where id = $1", [Number(ev.storedRawEventId)]);
    return (
      <Card title="Stored vs incoming payload">
        <div className="grid gap-4 md:grid-cols-2">
          <pre role="region" aria-label="Stored payload" tabIndex={0} className="overflow-x-auto rounded bg-surface-2 p-3 text-[11px]">{JSON.stringify(stored.rows[0]?.payload, null, 2)}</pre>
          <pre role="region" aria-label="Incoming payload" tabIndex={0} className="overflow-x-auto rounded bg-warn-soft p-3 text-[11px]">{JSON.stringify(ev.incomingPayload, null, 2)}</pre>
        </div>
      </Card>
    );
  }

  return null;
}
