import Link from "next/link";
import { Suspense } from "react";
import { ExperimentRunner } from "@/components/decisions/ExperimentRunner";
import { ExperimentHistory, SavedScenarios } from "@/components/decisions/History";
import { ScenarioBuilder, type ScenarioChannelOption } from "@/components/decisions/ScenarioBuilder";
import { VerdictMatrix } from "@/components/decisions/VerdictMatrix";
import { ChevronRight, Info, ShieldAlert, ShieldCheck, XCircle } from "lucide-react";
import { Badge, ButtonLink, Card, Forbidden, PageHeader, PeriodTabs, SectionNav, Skeleton } from "@/components/ui";
import { AA_DEFAULTS, listExperiments, runAaExperiment } from "@/lib/decision/experiment";
import { DEFAULT_ASSUMPTIONS, MONTH_DAYS, listScenarios } from "@/lib/decision/scenario";
import { decisionVerdicts, defaultDecisionBranch, type DecisionVerdicts } from "@/lib/decision/verdicts";
import { verifiedReadinessSnapshot, type VerifiedReadiness } from "@/lib/decision/verified";
import { money } from "@/lib/format";
import { parseChannel, parseWeek } from "@/lib/metrics/movement";
import { parsePeriod, type Period } from "@/lib/period";
import { gapStatusesAt, type GapStatus } from "@/lib/reconcile/gap-status";
import { BRAND_BY_ID, BRANCHES, BRANCH_BY_ID, CHANNEL_BY_CODE, type BrandId, type ChannelCode } from "@/lib/reference";
import { getPool, getViewer } from "@/lib/server";
import { ForbiddenError, resolveScope, type Viewer } from "@/lib/viewer";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export const metadata = { title: "Decision Lab" };

export default function DecisionsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<Skeleton lines={12} />}>
      <DecisionLab searchParams={searchParams} />
    </Suspense>
  );
}

async function DecisionLab({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const period = parsePeriod(sp.period);
  const viewer = await getViewer();
  const requested = first(sp.branch);
  const branchId = requested && BRANCH_BY_ID.has(requested) ? requested : defaultDecisionBranch(viewer);
  try {
    resolveScope(viewer, branchId);
  } catch (error) {
    if (error instanceof ForbiddenError) return <Forbidden message={error.message} />;
    throw error;
  }
  const branch = BRANCH_BY_ID.get(branchId)!;
  // A selection carried from the Overview through an incident (channel and week), read after the
  // scope check: Decision Lab does not use it, it only hands it back on the incident links.
  const channel = parseChannel(first(sp.channel));
  const week = parseWeek(first(sp.week));
  const brand = first(sp.brand);
  const brandQuery = brand && BRAND_BY_ID.has(brand as BrandId) ? `&brand=${brand}` : "";
  const incidentQuery = `?period=${period.key}${channel && week ? `&channel=${channel}&week=${week}` : ""}${brandQuery}`;
  const branchOptions = BRANCHES.filter((b) => !viewer.branchIds || viewer.branchIds.includes(b.id));
  // Started now, awaited where the card renders: verified readiness (1.2–1.5 s on the seeded world,
  // one snapshot; 3.3–4.0 s before it read the scorecard once, PERFORMANCE.md §6) runs alongside
  // the verdicts instead of after them. The hold above it never waits for it.
  const verified = verifiedReadinessSnapshot(getPool(), viewer, { branchId, period });
  verified.catch(() => undefined); // awaited by the card; an early rejection is not unhandled

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={`Understand · ${branch.id} ${branch.name} · ${period.label}`}
        title="Decision Lab"
        description={
          <p className="max-w-3xl">
            Can this branch move paid budget on the evidence it has? Three separate questions: are the records right, is there enough reliable evidence to
            act, and did the spend cause the customers. Clean data answers the first two; only a randomized experiment answers the third.
          </p>
        }
        actions={
          <Link href={`/decisions/opportunities?period=${period.key}`} className="rounded-md border border-border bg-surface px-3 py-1.5 text-sm font-medium shadow-raised hover:bg-surface-2">
            Revenue opportunities
          </Link>
        }
        toolbar={
          <>
            {/* A plain GET form: works without JavaScript and from the keyboard. */}
            <form method="get" action="/decisions" className="flex items-center gap-2 text-sm" aria-label="Choose a branch">
              <input type="hidden" name="period" value={period.key} />
              <label className="flex items-center gap-2">
                <span className="text-xs font-medium text-muted">Branch</span>
                <select name="branch" defaultValue={branch.id} className="h-8 rounded-md border border-border-strong bg-surface px-2 text-sm">
                  {branchOptions.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.id} {b.name}
                    </option>
                  ))}
                </select>
              </label>
              <button type="submit" className="h-8 rounded-md border border-border bg-surface px-3 text-sm font-medium shadow-raised hover:bg-surface-2">
                Show
              </button>
            </form>
            <PeriodTabs current={period.key} base="/decisions" extra={`&branch=${branch.id}`} />
          </>
        }
      />

      <SectionNav
        label="Decision Lab sections"
        testId="decision-sections"
        items={[
          ["#readiness", "1 · Are the records right?"],
          ["#verdicts", "2 · Enough evidence?"],
          ["#scenarios", "Scenarios"],
          ["#experiments", "3 · Did spend cause it?"],
        ]}
      />

      <Suspense fallback={<Card title="Verdicts"><Skeleton lines={4} /></Card>}>
        <VerdictsAndScenarios viewer={viewer} branchId={branch.id} period={period} verified={verified} incidentQuery={incidentQuery} />
      </Suspense>

      <Suspense fallback={<Card title="A/A analysis"><Skeleton lines={5} /></Card>}>
        <Experiments viewer={viewer} period={period} />
      </Suspense>
    </div>
  );
}

const channelLabel = (code: string) => CHANNEL_BY_CODE.get(code as ChannelCode)?.label ?? code;

async function VerdictsAndScenarios({ viewer, branchId, period, verified, incidentQuery }: { viewer: Viewer; branchId: string; period: Period; verified: Promise<VerifiedReadiness>; incidentQuery: string }) {
  const pool = getPool();
  const [verdicts, saved, gaps] = await Promise.all([
    decisionVerdicts(pool, viewer, { branchId, period }),
    listScenarios(pool, viewer, { branchId, limit: 10 }),
    // Coverage gaps verified for a window that overlaps the period: the hold they lifted is said
    // beside what still needs review. The branch passed the scope check above (and in the verdicts).
    gapStatusesAt(pool, branchId, { range: { from: period.from.toISOString().slice(0, 10), to: period.to.toISOString().slice(0, 10) } }),
  ]);
  const canModel = viewer.can.investigate || viewer.can.propose;

  return (
    <>
      <ReadinessSummary verdicts={verdicts} cleared={gaps.filter((g) => !g.held)} verified={verified} canInvestigate={viewer.can.investigate} incidentQuery={incidentQuery} />

      <Card
        id="verdicts"
        className="scroll-mt-28"
        title={`Verdicts · ${verdicts.branchId} ${verdicts.branchName}`}
        subtitle={`Per paid-media channel · ${period.label} · open a verdict for its reasons and evidence`}
        action={<BudgetSignalNote verdicts={verdicts} />}
      >
        <VerdictMatrix verdicts={verdicts} />
      </Card>

      <Suspense fallback={<Card title="Verified readiness"><Skeleton lines={4} /></Card>}>
        <VerifiedReadinessCard verified={verified} />
      </Suspense>

      <div id="scenarios" className="grid scroll-mt-28 gap-6 xl:grid-cols-5">
        <Card
          className="xl:col-span-3"
          title="Scenario builder"
          subtitle={`Shift budget between paid channels at ${verdicts.branchId}; baseline = this branch's ${period.label} cost per customer from SQL`}
        >
          {canModel ? <Builder verdicts={verdicts} period={period} /> : (
            <p className="text-sm text-muted">
              Your role ({viewer.label}) can read verdicts and saved scenarios but cannot model scenarios. Switch to <Badge>Marketing analyst</Badge> to run one.
            </p>
          )}
        </Card>
        <Card className="xl:col-span-2" title="Saved scenarios" subtitle="Stored with parameters, result and who saved it; shown as they were computed">
          <SavedScenarios scenarios={saved} labelFor={channelLabel} />
        </Card>
      </div>
    </>
  );
}

const VERIFIED_TONE = { READY: "good", READY_WITH_LIMITATIONS: "accent", NEEDS_REVIEW: "warn", NOT_READY: "bad" } as const;
const VERIFIED_TINT = { READY: "bg-good-soft text-good", READY_WITH_LIMITATIONS: "bg-accent-soft text-accent", NEEDS_REVIEW: "bg-warn-soft text-warn", NOT_READY: "bg-bad-soft text-bad" } as const;
/** A reason cut at a word boundary for the collapsed row. */
const shorten = (text: string, max = 110) => (text.length <= max ? text : `${text.slice(0, text.lastIndexOf(" ", max)).replace(/[,;:]$/, "")}…`);
const VERIFIED_LABEL = { READY: "ready", READY_WITH_LIMITATIONS: "ready, with limitations", NEEDS_REVIEW: "needs review", NOT_READY: "not ready" } as const;

/**
 * Verified readiness (lib/decision/verified.ts): whether a budget decision can rest on PROVED
 * numbers. The state first, then why; each channel opens to every rule of the policy with its
 * result, and the policy itself is shown in full.
 */
async function VerifiedReadinessCard({ verified }: { verified: Promise<VerifiedReadiness> }) {
  const v = await verified;
  return (
    <Card id="verified" className="scroll-mt-28" title="Verified readiness" subtitle="Can a budget decision rest on numbers that are proved, not just computed? One fixed policy, every rule shown.">
      {/* Factor rows, like the verdicts above: a mark tinted by the state, the channel, its state in
          words, the first reason; the row opens in place to every rule of the policy. */}
      <ul className="-mx-2 space-y-0.5 text-sm" data-testid="verified-readiness">
        {v.channels.map((c) => {
          const Mark = c.state === "READY" || c.state === "READY_WITH_LIMITATIONS" ? ShieldCheck : ShieldAlert;
          return (
          <li key={c.channelCode}>
            <details className="group">
              <summary className="flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 transition-colors duration-100 hover:bg-surface-2">
                <span aria-hidden className={`grid size-7 shrink-0 place-items-center rounded-md ${VERIFIED_TINT[c.state]}`}>
                  <Mark className="size-4" />
                </span>
                <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5 pt-1">
                  <span className="font-medium text-text">{c.label}</span>{" "}
                  <Badge tone={VERIFIED_TONE[c.state]}>{VERIFIED_LABEL[c.state]}</Badge>{" "}
                  {/* The first reason, short: the full text is one level down (progressive disclosure). */}
                  {c.because[0] && (
                    <span className="min-w-0 basis-full break-words text-xs text-muted">
                      {shorten(c.because[0])}
                      {c.because.length > 1 ? ` (+${c.because.length - 1} more)` : ""}
                    </span>
                  )}
                </span>
                <ChevronRight aria-hidden className="mt-1.5 size-4 shrink-0 text-faint transition-transform duration-150 group-open:rotate-90" />
              </summary>
              <ul className="mb-2 ml-[2.875rem] mt-1 space-y-1 text-xs">
                {c.rules.map((r) => (
                  <li key={r.code} className="flex gap-2">
                    <span className={r.passed ? "text-good" : "text-bad"} aria-hidden="true">
                      {r.passed ? "✓" : "✗"}
                    </span>
                    <span className="sr-only">{r.passed ? "Passed:" : "Failed:"}</span>
                    <span className="min-w-0 break-words">
                      {r.text}
                      {!r.passed && <span className="text-faint"> (→ {VERIFIED_LABEL[r.forces]})</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          </li>
          );
        })}
      </ul>
      <details className="mt-3 text-xs text-muted">
        <summary className="cursor-pointer">The policy, in order</summary>
        <ol className="mt-1 list-decimal space-y-0.5 pl-5">
          {v.policy.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ol>
      </details>
    </Card>
  );
}

/**
 * The answer first: is this branch ready to move paid budget, and if not, which incidents
 * block it — built from the verdicts' own failing budget-gate reasons, so it can never say
 * something the matrix below does not. Then, read together: a coverage hold that was verified and
 * lifted in this period (the incident's own status, lib/reconcile/gap-status.ts), and what
 * Verified readiness still asks a person to review (its own states, streamed: the hold above never
 * waits for them). "Ready" means the readiness rules pass; it is never an approval.
 */
function ReadinessSummary({
  verdicts,
  cleared,
  verified,
  canInvestigate,
  incidentQuery,
}: {
  verdicts: DecisionVerdicts;
  cleared: GapStatus[];
  verified: Promise<VerifiedReadiness>;
  canInvestigate: boolean;
  incidentQuery: string;
}) {
  const notReady = verdicts.channels.filter((c) => c.readiness.status === "not_ready");
  const blockers = new Map<string, string>();
  for (const c of verdicts.channels) {
    for (const r of c.readiness.blockers) {
      if (r.code === "budget_gate" && r.href) blockers.set(r.href, r.text);
    }
  }
  const ready = notReady.length === 0;
  const Icon = ready ? Info : XCircle;
  // The same incident evidence the Overview and the daily records open, with the selection carried.
  const incidentHref = (id: string | number) => `/exceptions/${id}${incidentQuery}#recovery`;
  return (
    <section
      id="readiness"
      aria-label="Readiness"
      className={`scroll-mt-28 flex gap-3 rounded-lg border px-4 py-3 text-sm ${ready ? "border-border-strong bg-surface" : "border-bad/30 bg-bad-soft"}`}
      data-testid="readiness-summary"
      data-state={ready ? "ready" : "not_ready"}
    >
      <Icon aria-hidden className={`mt-0.5 size-4 shrink-0 ${ready ? "text-accent" : "text-bad"}`} />
      <div className="min-w-0 flex-1 space-y-2.5">
        <p className="flex flex-wrap items-center gap-2">
          {ready ? <Badge tone="accent">Ready for review</Badge> : <Badge tone="bad">Not ready</Badge>}
          <span className="font-medium text-text">
            {ready
              ? `Every paid channel at ${verdicts.branchId} passes the readiness rules for ${verdicts.period.label}: no open incident holds the decision, so a person can review it. Nothing here approves a budget change.`
              : `${notReady.length} of ${verdicts.channels.length} paid channels at ${verdicts.branchId} are not ready for a budget decision in ${verdicts.period.label}: ${notReady.map((c) => c.label).join(", ")}.`}
          </span>
        </p>
        {blockers.size > 0 && (
          <ul className="space-y-2 text-text" data-testid="readiness-blockers">
            {[...blockers].map(([href, text], i) => {
              const id = href.match(/\/exceptions\/(\d+)$/)?.[1];
              return (
                <li key={href} className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                  <span className="basis-full">{text}</span>
                  {id && i === 0 ? (
                    <ButtonLink href={incidentHref(id)} variant="primary" testId="readiness-incident-link">
                      Open incident #{id}
                    </ButtonLink>
                  ) : (
                    <Link href={id ? incidentHref(id) : href} className="font-medium text-accent hover:underline" data-testid="readiness-incident-link">
                      {id ? `Open incident #${id}` : "Open the evidence"}
                    </Link>
                  )}
                  {id && canInvestigate && (
                    <Link href={`/investigator?exception=${id}`} className="font-medium text-accent hover:underline">
                      Investigate
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {cleared.map((g) => (
          <p key={g.exceptionId} className="text-text" data-testid="readiness-cleared" data-state={g.state}>
            <span className="font-semibold">{g.label}, incident #{g.exceptionId}.</span> {g.statusText}
            {g.change ? ` ${g.change}` : ""}{" "}
            <Link href={incidentHref(g.exceptionId)} className="font-medium text-accent underline" data-testid="readiness-cleared-link">
              Open incident #{g.exceptionId}
            </Link>
          </p>
        ))}
        {ready && (
          <Suspense
            fallback={
              <p className="text-muted" aria-busy="true" data-testid="readiness-other-checks-loading">
                Checking what else needs review…
              </p>
            }
          >
            <OtherChecks verified={verified} />
          </Suspense>
        )}
      </div>
    </section>
  );
}

/**
 * What Verified readiness (the card below) still asks a person to look at, in the summary, so a
 * lifted hold is never read as "every check passed". Its own states and first reasons, quoted.
 */
async function OtherChecks({ verified }: { verified: Promise<VerifiedReadiness> }) {
  const v = await verified;
  const review = v.channels.filter((c) => c.state === "NEEDS_REVIEW" || c.state === "NOT_READY");
  const rest = v.channels.filter((c) => !review.includes(c));
  const restByState = [...new Set(rest.map((c) => c.state))].map((s) => `${rest.filter((c) => c.state === s).map((c) => c.label).join(" and ")} ${rest.filter((c) => c.state === s).length === 1 ? "is" : "are"} ${VERIFIED_LABEL[s]}`);
  return (
    <div className="space-y-2 text-text" data-testid="readiness-other-checks">
      <p>
        <span className="font-semibold">{review.length > 0 ? `Other checks need review: ${review.length} of ${v.channels.length} channels.` : "No other check needs review."}</span>
        {restByState.length > 0 ? ` ${restByState.join("; ")}.` : ""}
      </p>
      {review.length > 0 && (
        <ul className="list-disc space-y-1 pl-5">
          {review.map((c) => (
            // The whole reason, readable here without opening anything (R-56: it was cut at 140 characters).
            <li key={c.channelCode} className="break-words" data-testid="readiness-other-check">
              <span className="font-medium">{c.label}</span> ({VERIFIED_LABEL[c.state]}): {c.because.join(" ")}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted">&ldquo;Ready&rdquo; in the table below means a channel&apos;s readiness rules pass. It is not an approval, and it does not cover these checks.</p>
      <ButtonLink href="#verified" variant="primary" testId="readiness-review-link">
        {review.length > 0 ? `Review the ${review.length === 1 ? "channel" : `${review.length} channels`}` : "See verified readiness"}
      </ButtonLink>
    </div>
  );
}

function BudgetSignalNote({ verdicts }: { verdicts: DecisionVerdicts }) {
  const s = verdicts.budgetSignal;
  const text =
    s.signal === "shift" && s.from && s.to
      ? `Budget signal: ${s.from.label} costs ${s.ratio!.toFixed(1)}× ${s.to.label} per customer`
      : "Budget signal: no shift signalled";
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-muted">{text}</span>
      {s.trustworthy ? <Badge tone="good">gate open</Badge> : <Badge tone="bad">gated</Badge>}
      <Link href={`/branches/${verdicts.branchId}?period=${verdicts.period.key}`} className="text-accent hover:underline">
        branch →
      </Link>
    </div>
  );
}

function Builder({ verdicts, period }: { verdicts: DecisionVerdicts; period: Period }) {
  const days = Math.round((period.to.getTime() - period.from.getTime()) / 86_400_000);
  const options: ScenarioChannelOption[] = verdicts.channels.map((c) => ({
    channelCode: c.channelCode,
    label: c.label,
    monthlySpendCents: Math.round((c.spendCents * MONTH_DAYS) / days),
  }));
  const withSpend = options.filter((o) => o.monthlySpendCents > 0);
  if (withSpend.length < 2) {
    return <p className="text-sm text-muted">Fewer than two paid channels have spend at {verdicts.branchId} in this period: there is nothing to shift between.</p>;
  }
  // Default to the move the budget signal would suggest; otherwise the two biggest channels. While
  // the signal is not trustworthy (an open incident gates it) nothing is preselected: a default
  // would read as a recommendation of the very move the incident distorts (UX red team 2026-11-12).
  const bySpend = [...withSpend].sort((a, b) => b.monthlySpendCents - a.monthlySpendCents);
  const s = verdicts.budgetSignal;
  const defaultFrom = !s.trustworthy ? "" : s.signal === "shift" && s.from ? s.from.channelCode : bySpend[0].channelCode;
  const defaultTo = !s.trustworthy ? "" : s.signal === "shift" && s.to ? s.to.channelCode : bySpend[1].channelCode;
  return (
    <div className="space-y-3">
      <p className="text-xs text-faint">
        Paid spend at {verdicts.branchId}: {money(withSpend.reduce((n, o) => n + o.monthlySpendCents, 0))} per {MONTH_DAYS} days. Results are a forecast from observational data, not causal.
      </p>
      <ScenarioBuilder
        branchId={verdicts.branchId}
        periodKey={period.key}
        channels={options}
        defaultFrom={defaultFrom}
        defaultTo={defaultTo}
        defaults={DEFAULT_ASSUMPTIONS}
      />
    </div>
  );
}

async function Experiments({ viewer, period }: { viewer: Viewer; period: Period }) {
  const pool = getPool();
  const [live, stored] = await Promise.all([
    runAaExperiment(pool, viewer, { period: period.key, windowDays: AA_DEFAULTS.windowDays, salt: AA_DEFAULTS.salt }),
    listExperiments(pool, viewer),
  ]);
  return (
    <section id="experiments" className="scroll-mt-28 space-y-6">
      <Card
        title="A/A analysis · statistics self-check"
        subtitle={`Synthetic web leads in ${viewer.branchIds ? viewer.branchIds.join(", ") : "all branches"}, split at analysis time by a stable hash into two identical arms. It checks the unit definition, outcome join and statistics only — not assignment or exposure logging — is kept apart from the scenario forecasts above, and measures no channel.`}
      >
        <ExperimentRunner initial={live} canRecord={viewer.can.investigate} />
      </Card>
      <Card title="Recorded experiment runs" subtitle="Config and result stored per run; assignments are re-derivable from the salt">
        <ExperimentHistory experiments={stored} />
      </Card>
    </section>
  );
}
