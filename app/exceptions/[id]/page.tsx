import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { Bot, Lock, MapPin } from "lucide-react";
import { CoverageGapRecords } from "@/components/CoverageGap";
import { WorkflowPanel } from "@/components/actions/WorkflowPanel";
import { DecisionForm } from "@/components/DecisionForm";
import { ReplayPanel } from "@/components/ReplayPanel";
import { DriftReview } from "@/components/incidents/DriftReview";
import { GapRecovery } from "@/components/incidents/GapRecovery";
import { FixResult } from "@/components/incidents/FixResult";
import { RevisionHold } from "@/components/incidents/RevisionHold";
import { Badge, ButtonLink, Callout, Card, KV, PageHeader, SectionNav, SeverityBadge, Skeleton, StateBadge, StatusBadge, TableWrap, Td, Th } from "@/components/ui";
import { ACTIVE_VERSION, compareVersions, mapperVersions, replayableVersions } from "@/lib/adapters/registry";
import { KIND_LABEL, count, dateTime, money } from "@/lib/format";
import { quarantineGroupIds } from "@/lib/ingest/replay";
import { planReplay } from "@/lib/ingest/replay-plan";
import { acquisitionTrail, getException, lastReplayForException, quarantineSamples, type ExceptionRow } from "@/lib/queries";
import type { ReplayResult } from "@/lib/ingest/replay";
import { DECISION_BLOCKING_KINDS, decisionHolds } from "@/lib/metrics/decision";
import { parseChannel, parseWeek, WINDOW, windowWeeks } from "@/lib/metrics/movement";
import { weekLabel } from "@/lib/metrics/movement-copy";
import { branchRows, freshness, type StreamFreshness } from "@/lib/metrics/scorecard";
import { feedAttention } from "@/lib/health/feeds";
import { PERIODS, type PeriodKey } from "@/lib/period";
import { dateRanges, gapCoverage } from "@/lib/reconcile/gap-coverage";
import { gapStatus } from "@/lib/reconcile/gap-status";
import { dayEvidence, defaultDay, windowFacts } from "@/lib/reconcile/gap-days";
import { correctionsOf, dayKey, holdMoney, isCorrection, isRefusedRevisionHold, revisionsOf, unattributedSentence, unattributedSpend } from "@/lib/reconcile/refused-revisions";
import { BRAND_BY_ID, BRANCH_BY_ID, type BrandId } from "@/lib/reference";
import { demoModeEnabled } from "@/lib/demo-mode";
import { businessNow, getPool, getViewer } from "@/lib/server";
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

/** "Oct 13–Oct 30": the decision window's dates in words. */
const dateRangesLabel = (c: { required: string[]; window: { from: string } }) => dateRanges(c.required.length ? c.required : [c.window.from]);
/** "October": a date's month, in UTC like every date on the page. */
const monthOf = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });

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
    "Nothing failed validation. A paid channel kept producing leads at this branch while its spend stopped, because the spend now arrives under a new campaign that the mapper files in a different channel. Cost per customer is wrong for both channels until the stored records are re-mapped. This demo simulates the move Google is making for eligible Local Services advertisers, to Performance Max campaigns with pay-per-lead goals. The branch, dates and amounts are synthetic, and the misfiling is ours: our older mapper filed the migrated campaign's spend as Google Search. Google did not.",
};

/**
 * The same kinds once resolved, in the past tense: the hold is over, so what it did is history.
 * Kinds not listed read the same either way.
 */
const RESOLVED_WHY: Record<string, string> = {
  quarantined_source_records:
    "Records failed validation and were held back instead of being guessed at. While they were held, every downstream number that depended on them was understated — here, customers who called in looked like they came from nowhere.",
};

/** A hold on refused spend revisions (lib/reconcile/refused-revisions.ts): spend, not lead records. */
const REVISION_WHY =
  "The source sent a newer revision of this spend, and intake refused it. The ledger keeps counting the last accepted amount and never counts the refused one, so the date is neither $0 nor the refused amount. Until a newer revision is accepted, the budget decision that reads this date is held.";
/** Refused ad spend records that hold no branch's decision (the reasons are on the page). */
const UNATTRIBUTED_WHY = "Ad spend records failed validation and were held back instead of being guessed at. None of them is a newer revision of spend the ledger counts at a branch.";

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
  const period = PERIODS[periodKey];
  const otherHolds = coverage ? (await decisionHolds(getPool(), [exception.branchId!], 8, period)).filter((h) => h.exceptionId !== exception.id) : [];
  // A hold on refused spend revisions (R-54): the revisions it holds and those already corrected.
  // A company-level group of refused spend records says why it holds no branch's decision.
  const isQuarantine = exception.kind === "quarantined_source_records";
  const corrections = isQuarantine ? correctionsOf(ev) : [];
  const revisions = isQuarantine && exception.status !== "resolved" ? revisionsOf(ev) : [];
  const revisionHold = isQuarantine && exception.branchId !== null && (revisions.length > 0 || corrections.length > 0);
  const unattributed = isQuarantine && exception.branchId === null && ev.source === "ads" ? unattributedSentence(await unattributedSpend(getPool(), await quarantineGroupIds(getPool(), { source: "ads", errorCode: String(ev.errorCode), branchId: null }))) : null;
  // The branch's paid spend in the reader's period, counted now: said beside a lifted hold, and beside
  // a verified reclassification (the move added nothing), from the same scorecard row every view uses.
  const branchSpend =
    (revisionHold && exception.status === "resolved") || status?.reclassified
      ? { periodLabel: period.label, cents: (await branchRows(getPool(), { from: period.from, to: period.to, branchIds: [exception.branchId!] }))[0]?.paidSpendCents ?? 0 }
      : null;
  const holdWeek = revisions[0] ? parseWeek(mondayOf(revisions[0].date)) : null;
  const holdMonths = [...new Set(revisions.map((r) => monthOf(r.date)))];
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

  // The decision window, date by date: each date's evidence, whether it is in the week the reader
  // picked, and its records on the daily evidence (the existing view of that week's records).
  const pickedWeek = selectedHere ? windowWeeks(WINDOW, null).find((w) => w.start === selectedHere) ?? null : null;
  const stripDays = coverage
    ? coverage.days.map((d) => {
        const week = parseWeek(mondayOf(d.date));
        return {
          ...dayEvidence(d, { branchId: coverage.branchId, channelLabel: coverage.channelLabel }),
          inWeek: pickedWeek !== null && d.date >= pickedWeek.start && d.date <= pickedWeek.end,
          records: week ? { href: traceHref(coverage.channel, week), week: recordsWeekLabel(week) } : null,
        };
      })
    : [];
  const strip = coverage ? { days: stripDays, facts: windowFacts(coverage, pickedWeek ? { start: pickedWeek.start, end: pickedWeek.end } : null), defaultDate: defaultDay(stripDays) } : null;
  // The quiet scope line above the verdict: the branch, then the channel and the window the decision
  // needs, or, for a refused-revision hold, the campaign-days it holds or held and their months.
  const branchName = branch ? `${branch.id} ${branch.name}` : (coverage?.branchId ?? exception.branchId ?? "");
  // Campaign-days, never refused records: a day refused on every re-fetch is still one day (K1).
  const heldDays = [...revisions, ...corrections];
  const heldDayCount = new Set(heldDays.map(dayKey)).size;
  const scopeLine = coverage
    ? `${branchName} · ${coverage.channelLabel} · decision window ${dateRangesLabel(coverage)}`
    : revisionHold && heldDayCount > 0
      ? `${branchName} · ${heldDayCount === 1 ? "one campaign-day" : `${heldDayCount} campaign-days`} · ${[...new Set(heldDays.map((d) => monthOf(d.date)))].join(" and ")}`
      : null;
  // What the ledger counts for those days, once per campaign-day (lib/reconcile/refused-revisions.ts).
  const holdCents = revisionHold ? holdMoney(revisions, corrections) : null;

  const why =
    (exception.evidence as { conflict?: unknown } | null)?.conflict === "earlier_version_after_later"
      ? HELD_VERSION_WHY
      : revisionHold
        ? REVISION_WHY
        : unattributed
          ? UNATTRIBUTED_WHY
          : exception.status === "resolved"
            ? (RESOLVED_WHY[exception.kind] ?? WHY[exception.kind])
            : WHY[exception.kind];
  // An incident with a decision panel (a coverage gap, a hold on refused revisions) leads with it,
  // straight after the title: on a phone the decision, why and the one next action come first in
  // reading and focus order. What was detected, what the kind means and the secondary actions follow.
  const leadsWithDecision = Boolean((coverage && status) || revisionHold);
  const headerActions = (
    <>
      {/* A public-demo guest asks in their own workspace (app/investigator/page.tsx). */}
      {viewer.can.investigate || viewer.can.workspace ? (
        // Secondary beside a decision panel (the panel's next action is the page's one primary), and
        // for the guest, who has no action on an incident: asking is reading, not acting.
        <ButtonLink
          href={`/investigator?exception=${exception.id}`}
          variant={leadsWithDecision || !viewer.can.investigate ? "secondary" : "primary"}
          testId="investigate-link"
          icon={<Bot aria-hidden className="size-4" />}
        >
          Investigate with AI
        </ButtonLink>
      ) : (
        <span className="text-xs text-muted">Investigations need any role except guest.</span>
      )}
      {exception.branchId && DECISION_KINDS.has(exception.kind) && <ButtonLink href={decisionsHref}>Decision readiness for {exception.branchId}</ButtonLink>}
      {exception.branchId && <ButtonLink href={`/branches/${exception.branchId}`}>Branch {exception.branchId}</ButtonLink>}
    </>
  );

  return (
    <div className="space-y-6">
      <PageHeader
        crumbs={[{ href: "/exceptions", label: "Incidents" }, { label: `#${exception.id}` }]}
        title={revisionHold ? "Spend revision refused" : (KIND_LABEL[exception.kind] ?? exception.kind)}
        quiet={leadsWithDecision}
        badges={
          <>
            <SeverityBadge severity={exception.severity} />
            <StatusBadge status={exception.status} />
            {/* The product state (release design §5.8): this incident holds its branch's budget decision. */}
            {(status?.held || (revisionHold && exception.status === "open")) && <StateBadge state="held" detail="budget decision" testId="incident-held" />}
            {exception.branchId && (
              <Link href={`/branches/${exception.branchId}`} className="inline-flex items-center gap-1 rounded border border-border bg-surface px-1.5 py-0.5 text-[11px] font-medium text-accent hover:bg-accent-soft">
                <MapPin aria-hidden className="size-3" />
                {exception.branchId} {branch?.name}
              </Link>
            )}
          </>
        }
        description={
          leadsWithDecision ? (
            scopeLine && (
              <p className="text-sm text-muted" data-testid="incident-scope">
                {scopeLine}
              </p>
            )
          ) : (
            <>
              <p className="font-medium text-text" data-testid="exception-summary">{exception.summary}</p>
              <p className="mt-1 max-w-3xl">{why}</p>
            </>
          )
        }
        actions={leadsWithDecision ? undefined : headerActions}
      />

      {/* A resolved incident leads with what its fix did, before the evidence that was the problem. */}
      {!leadsWithDecision && <FixResult exception={exception} viewer={viewer} />}

      {coverage && status && strip && (
        <GapRecovery
          exception={exception}
          coverage={coverage}
          status={status}
          otherHolds={otherHolds}
          branchSpend={branchSpend}
          strip={strip}
          links={{
            records: { href: traceHref(coverage.channel, recordsWeek), week: recordsWeekLabel(recordsWeek) },
            back: selected ? traceHref(selected.channel, selected.week) : null,
            decisions: `${decisionsHref}#readiness`,
            // The run's row on the ingestion pipeline, which only company-wide roles may open.
            run: viewer.branchIds ? null : (runId) => `/integrations?view=pipeline&run=${runId}#run-${runId}`,
          }}
        />
      )}

      {revisionHold && (
        <RevisionHold
          exception={exception}
          revisions={revisions}
          corrections={corrections}
          branchSpend={branchSpend}
          links={{
            records: holdWeek && revisions[0] ? { href: traceHref(revisions[0].channel, holdWeek), week: recordsWeekLabel(holdWeek) } : null,
            decisions: `${decisionsHref}#readiness`,
            run: viewer.branchIds ? null : (runId) => `/integrations?view=pipeline&run=${runId}#run-${runId}`,
          }}
        />
      )}

      {leadsWithDecision && (
        <section aria-label="What was detected" className="space-y-2" data-testid="incident-context">
          <p className="text-sm font-medium text-text" data-testid="exception-summary">
            {exception.summary}
          </p>
          <p className="max-w-3xl text-sm leading-6 text-muted">{why}</p>
          <div className="flex flex-wrap items-center gap-2">{headerActions}</div>
        </section>
      )}

      {unattributed && (
        <Callout tone="warn" title="Which decision these records affect cannot be verified" testId="unattributed-spend">
          {unattributed}
        </Callout>
      )}

      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-border ring-1 ring-text/10 md:grid-cols-4" data-testid="incident-impact">
        {(
          [
            holdCents
              ? exception.status === "resolved"
                ? holdCents.notCounted === 0
                  ? ["Counted now, corrected dates", money(holdCents.countedNowCents)]
                  : // A day the ledger counts nothing for is not a $0.00 day (K2).
                    [
                      "Counted now, dates no longer held",
                      `${holdCents.countedNowCents > 0 ? `${money(holdCents.countedNowCents)}; ` : ""}${holdCents.notCounted} date${holdCents.notCounted === 1 ? "" : "s"} not counted`,
                    ]
                : ["Still counted, held dates", money(holdCents.heldCents)]
              : [amountLabel, money(exception.amountCents)],
            ["First detected", dateTime(exception.firstDetectedAt)],
            [exception.resolvedAt ? "Resolved" : "Last detected", dateTime(exception.resolvedAt ?? exception.lastDetectedAt)],
            [
              "Budget decisions",
              !DECISION_KINDS.has(exception.kind)
                ? "Not gated by this kind"
                : exception.status !== "open"
                  ? // A day that left without a correction is held elsewhere now: in Decision Lab, or at another branch (K2).
                    revisionHold && corrections.some((c) => !isCorrection(c))
                    ? "No longer held by this incident"
                    : "No longer held"
                  : exception.branchId === null && isQuarantine
                    ? "Holds no branch's decision"
                    : revisionHold
                      ? `On hold for ${holdMonths.join(" and ")}`
                      : "On hold while open",
            ],
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
                  // A refused spend revision has no lead record and no revenue at stake: those facts belong to held leads.
                  .filter(([k]) => !revisionHold || !["customersWithoutLead", "annualContractValueCents"].includes(k))
                  .map(([k, v]) => [labelFor(k), formatEvidence(k, v)] as [string, ReactNode]),
              ]}
            />
            {/* The amount is repeated here so the evidence card stands alone when printed or linked. */}
            {!revisionHold && (
              <p className="mt-3 text-xs text-muted">
                {amountLabel}: <span className="font-medium text-text">{money(exception.amountCents)}</span>
              </p>
            )}
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

        {/* The rail: a stack of small cards, one job each (docs/design-system.md, "Incident detail"): what this
            role can do now, who does each step of a fix, and how current the records behind it are. */}
        <aside className="space-y-3 lg:sticky lg:top-28 lg:self-start" aria-label="Decision and role">
          <Card size="sm" title="Decision" subtitle={actionSubtitle(exception, viewer)} testId="rail-decision">
            <Suspense fallback={<Skeleton lines={2} />}>
              <Actions exception={exception} viewer={viewer} />
            </Suspense>
          </Card>
          <Card size="sm" title="How a fix is applied" subtitle={`Viewing as ${viewer.label}`} testId="rail-steps">
            <ol className="space-y-2 text-xs leading-5 text-muted">
              {[
                ["Propose", "an analyst or engineer names the fix", viewer.can.propose],
                ["Dry run", "an engineer runs it in a transaction that rolls back", viewer.can.dryRun],
                ["Approve", "a different role approves that exact dry run", viewer.can.approve],
                ["Execute", "the application applies it once and verifies the ledger", viewer.can.approve],
              ].map(([step, what, can], i) => (
                <li key={String(step)} className="flex gap-2">
                  <span aria-hidden className={`grid size-5 shrink-0 place-items-center rounded-full text-[10px] font-semibold ${can ? "bg-good-soft text-good" : "bg-surface-2 text-text"}`}>
                    {i + 1}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="font-medium text-text">{step}</span>: {what}.
                  </span>{" "}
                  {can ? (
                    <span className="shrink-0 whitespace-nowrap font-medium text-good">You can</span>
                  ) : (
                    <span className="inline-flex shrink-0 items-center gap-1 self-start whitespace-nowrap pt-0.5 text-faint">
                      <Lock aria-hidden className="size-3" />
                      Not your role
                    </span>
                  )}
                </li>
              ))}
            </ol>
            <p className="mt-2.5 border-t border-border pt-2 text-[11px] text-faint">Permissions are checked on the server; these labels only explain them.</p>
          </Card>
          <Suspense fallback={null}>
            <Freshness exception={exception} />
          </Suspense>
        </aside>
      </div>
    </div>
  );
}

/**
 * The feeds an incident's records come from, when its evidence names them: the source a quarantine
 * group was held from, the ads feed for spend incidents, the CRM's payments and invoices for a
 * payment without its invoice. null: the evidence names no single feed, so the card reads them all.
 */
function feedsFor(e: ExceptionRow): ((s: StreamFreshness) => boolean) | null {
  const ev = e.evidence as Record<string, unknown>;
  if (e.kind === "quarantined_source_records" && typeof ev.source === "string") return (s) => s.source === ev.source;
  if (e.kind === "channel_coverage_gap" || e.kind === "unmapped_spend") return (s) => s.source === "ads";
  if (e.kind === "payment_without_ticket") return (s) => s.stream === "crm.payment" || s.stream === "crm.ticket";
  return null;
}

/**
 * Freshness, in the rail: how current the records behind this incident are, by the rule the top bar
 * uses (lib/health/feeds.ts). Each feed's state is a word beside its dot. When the evidence names no
 * feed, the card speaks for all of them and lists only those that need attention.
 */
async function Freshness({ exception }: { exception: ExceptionRow }) {
  const [streams, now] = await Promise.all([freshness(getPool()), businessNow()]);
  const match = feedsFor(exception);
  const feeds = match ? streams.filter(match) : streams;
  if (feeds.length === 0) return null;
  const { stale, failing } = feedAttention(feeds, now);
  const state = (s: StreamFreshness) => (failing.includes(s) ? "failing" : stale.includes(s) ? "stale" : "fresh");
  const attention = feeds.filter((s) => state(s) !== "fresh");
  const listed = match ? feeds : attention;
  const oldest = feeds.map((s) => s.lastSuccessAt).filter((d): d is Date => d !== null).sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0] ?? null;
  return (
    <Card
      size="sm"
      title="Freshness"
      subtitle={match ? `The feed${feeds.length === 1 ? "" : "s"} these records come from` : `All ${feeds.length} feeds this page reads`}
      action={
        <Link href="/audit" className="inline-flex min-h-6 items-center text-xs font-medium text-accent hover:underline">
          Audit &amp; Health
        </Link>
      }
      testId="rail-freshness"
    >
      <ul className="space-y-2 text-xs">
        {listed.map((s) => (
          <li key={s.stream}>
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-mono text-[11px] text-text">{s.stream}</span>
              <Badge dot tone={state(s) === "fresh" ? "good" : state(s) === "stale" ? "warn" : "bad"}>
                {state(s)}
              </Badge>
            </div>
            <p className="mt-0.5 text-muted">
              last success {dateTime(s.lastSuccessAt)}
              {s.quarantined > 0 && <span className="font-medium text-bad"> · {count(s.quarantined)} quarantined in source</span>}
            </p>
          </li>
        ))}
        {!match && attention.length === 0 && (
          <li className="flex items-center justify-between gap-2">
            <span className="text-muted">Every feed succeeded within 36 hours; the oldest success {dateTime(oldest)}</span>
            <Badge dot tone="good">
              fresh
            </Badge>
          </li>
        )}
      </ul>
    </Card>
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
  // A refused spend revision has no replay to offer: no shipped mapper accepts it correctly (K6).
  if (e.kind === "quarantined_source_records" && isRefusedRevisionHold(e.evidence as Record<string, unknown>)) return "Lifts when the source sends a newer revision";
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
    // A held record replays only through a mapper that still applies the check that refused it (K6).
    // A refused spend revision was refused by the deployed mapper and no newer one ships, so a replay
    // could only refuse it again: the way out is a newer revision from the source.
    const versions = exception.kind === "quarantined_source_records" ? replayableVersions(source, [String(ev.errorCode)]) : mapperVersions(source);
    if (exception.status !== "resolved" && exception.kind === "quarantined_source_records" && isRefusedRevisionHold(ev) && !versions.some((v) => compareVersions(v, ACTIVE_VERSION[source]) > 0)) {
      return (
        <p className="text-sm text-muted" data-testid="replay-none">
          No shipped mapper accepts these records correctly: {source}@{ACTIVE_VERSION[source]} refuses them again, and older versions skip the check that refused them. The source has to send a newer revision; the hold then lifts by itself.
        </p>
      );
    }
    if (!viewer.can.replay) {
      return exception.status === "resolved" ? (
        <p className="text-sm text-muted">Resolved. Nothing to do.</p>
      ) : (
        <p className="text-sm text-muted">
          {/* Roles switch only in demo mode; on the hosted demo the guest cannot become an engineer. */}
          {demoModeEnabled() ? (
            <>
              Switch to <Badge>Integration engineer</Badge> to dry-run or {plan?.mode === "reproject" ? "re-map" : "replay"} these {count(ids.length)} records.
            </>
          ) : (
            <>
              An integration engineer dry-runs, then {plan?.mode === "reproject" ? "re-maps" : "replays"} these {count(ids.length)} records after an approval; on the public demo
              they are shown read-only.
            </>
          )}
        </p>
      );
    }
    return (
      <ReplayPanel
        exceptionId={exception.id}
        source={source}
        versions={versions}
        defaultVersion={ACTIVE_VERSION[source]}
        records={ids.length}
        lastReplay={lastReplay}
        verb={exception.kind === "channel_coverage_gap" ? "Re-map" : "Replay"}
      />
    );
  }

  if (exception.status === "resolved") return <p className="text-sm text-muted">Nothing to do.</p>;

  if (exception.kind === "unmapped_spend") {
    // Mapping moves a branch's spend and CAC, so it is a fix with two people, not one form (N7).
    return (
      <p className="text-sm text-muted" data-testid="map-campaign-pointer">
        Mapping the campaign changes a branch&apos;s CAC, so it goes through the fix workflow:{" "}
        <a href="#workflow" className="inline-flex min-h-6 items-center font-medium text-accent hover:underline">
          propose &ldquo;Map the campaign to a branch&rdquo;
        </a>
        , and a different role approves it after a dry run. Only branches the campaign&apos;s leads name are offered.
      </p>
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
    // Resolved: the records shown are the ones that were held, as they are stored now.
    const resolved = exception.status === "resolved";
    return (
      <Card
        title={resolved ? `Records that were held (${count(ids.length)} held now)` : `Held records (${count(ids.length)} quarantined now)`}
        subtitle="Payloads are stored redacted: contact details are hashed before anything else sees them"
      >
        <TableWrap label="Raw events behind this incident">
          <thead>
            <tr>
              <Th>Raw event</Th>
              <Th>Source time</Th>
              <Th>Status / error</Th>
              <Th>Payload (redacted)</Th>
              <Th>{resolved ? "CRM customer it attached to" : "CRM customer it would attach to"}</Th>
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
                <Td>
                  {/* One region per row, each named for its record: regions that share a name are one landmark repeated (axe landmark-unique). */}
                  <pre role="region" aria-label={`Payload of raw event #${s.id}`} tabIndex={0} className="max-w-xs overflow-x-auto whitespace-pre-wrap break-all text-[10px] text-muted">{JSON.stringify(s.payload, null, 1).slice(0, 420)}</pre>
                </Td>
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
