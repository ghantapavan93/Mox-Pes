import Link from "next/link";
import { Suspense } from "react";
import { ExperimentRunner } from "@/components/decisions/ExperimentRunner";
import { ExperimentHistory, SavedScenarios } from "@/components/decisions/History";
import { ScenarioBuilder, type ScenarioChannelOption } from "@/components/decisions/ScenarioBuilder";
import { VerdictMatrix } from "@/components/decisions/VerdictMatrix";
import { Badge, Card, Forbidden, PeriodTabs, Skeleton } from "@/components/ui";
import { AA_DEFAULTS, listExperiments, runAaExperiment } from "@/lib/decision/experiment";
import { DEFAULT_ASSUMPTIONS, MONTH_DAYS, listScenarios } from "@/lib/decision/scenario";
import { decisionVerdicts, defaultDecisionBranch, type DecisionVerdicts } from "@/lib/decision/verdicts";
import { money } from "@/lib/format";
import { parsePeriod, type Period } from "@/lib/period";
import { BRANCHES, BRANCH_BY_ID, CHANNEL_BY_CODE, type ChannelCode } from "@/lib/reference";
import { getPool, getViewer } from "@/lib/server";
import { ForbiddenError, resolveScope, type Viewer } from "@/lib/viewer";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

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
  const branchOptions = BRANCHES.filter((b) => !viewer.branchIds || viewer.branchIds.includes(b.id));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-faint">
            {branch.id} {branch.name} · {period.label}
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Decision Lab</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            Can this branch move paid budget on the evidence it has? Three separate questions: are the records right, is there enough reliable
            evidence to act, and did the spend cause the customers. Clean data answers the first two; only a randomized experiment answers the third.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {/* A plain GET form: works without JavaScript and from the keyboard. */}
          <form method="get" action="/decisions" className="flex items-center gap-2 text-xs">
            <input type="hidden" name="period" value={period.key} />
            <label className="flex items-center gap-2">
              <span className="text-muted">Branch</span>
              <select name="branch" defaultValue={branch.id} className="rounded border border-border bg-surface px-2 py-1 text-sm">
                {branchOptions.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.id} {b.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit" className="rounded border border-border bg-surface px-2.5 py-1 hover:bg-surface-2">
              Show
            </button>
          </form>
          <PeriodTabs current={period.key} base="/decisions" extra={`&branch=${branch.id}`} />
        </div>
      </div>

      <Suspense fallback={<Card title="Verdicts"><Skeleton lines={4} /></Card>}>
        <VerdictsAndScenarios viewer={viewer} branchId={branch.id} period={period} />
      </Suspense>

      <Suspense fallback={<Card title="A/A analysis"><Skeleton lines={5} /></Card>}>
        <Experiments viewer={viewer} period={period} />
      </Suspense>
    </div>
  );
}

const channelLabel = (code: string) => CHANNEL_BY_CODE.get(code as ChannelCode)?.label ?? code;

async function VerdictsAndScenarios({ viewer, branchId, period }: { viewer: Viewer; branchId: string; period: Period }) {
  const pool = getPool();
  const [verdicts, saved] = await Promise.all([
    decisionVerdicts(pool, viewer, { branchId, period }),
    listScenarios(pool, viewer, { branchId, limit: 10 }),
  ]);
  const canModel = viewer.can.investigate || viewer.can.propose;

  return (
    <>
      <ReadinessSummary verdicts={verdicts} canInvestigate={viewer.can.investigate} />

      <Card
        title={`Verdicts · ${verdicts.branchId} ${verdicts.branchName}`}
        subtitle={`Per paid-media channel · ${period.label} · open a verdict for its reasons and evidence`}
        action={<BudgetSignalNote verdicts={verdicts} />}
      >
        <VerdictMatrix verdicts={verdicts} />
      </Card>

      <div className="grid gap-6 xl:grid-cols-5">
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

/**
 * The answer first: is this branch ready to move paid budget, and if not, which incidents
 * block it. Built from the verdicts' own failing budget-gate reasons, so it can never say
 * something the matrix below does not.
 */
function ReadinessSummary({ verdicts, canInvestigate }: { verdicts: DecisionVerdicts; canInvestigate: boolean }) {
  const notReady = verdicts.channels.filter((c) => c.readiness.status === "not_ready");
  const blockers = new Map<string, string>();
  for (const c of verdicts.channels) {
    for (const r of c.readiness.blockers) {
      if (r.code === "budget_gate" && r.href) blockers.set(r.href, r.text);
    }
  }
  const ready = notReady.length === 0;
  return (
    <div
      className={`rounded border p-3 text-sm ${ready ? "border-good/30 bg-good-soft" : "border-bad/30 bg-bad-soft"}`}
      data-testid="readiness-summary"
    >
      <p className="flex flex-wrap items-center gap-2">
        {ready ? <Badge tone="good">Ready</Badge> : <Badge tone="bad">Not ready</Badge>}
        <span>
          {ready
            ? `Every paid channel at ${verdicts.branchId} passes the readiness checks for ${verdicts.period.label}. Effectiveness is still a separate question.`
            : `${notReady.length} of ${verdicts.channels.length} paid channels at ${verdicts.branchId} are not ready for a budget decision in ${verdicts.period.label}: ${notReady.map((c) => c.label).join(", ")}.`}
        </span>
      </p>
      {blockers.size > 0 && (
        <ul className="mt-2 space-y-1">
          {[...blockers].map(([href, text]) => {
            const id = href.match(/\/exceptions\/(\d+)$/)?.[1];
            return (
              <li key={href} className="flex flex-wrap items-baseline gap-2">
                <span>{text}</span>
                <Link href={href} className="text-accent hover:underline" data-testid="readiness-incident-link">
                  open incident →
                </Link>
                {id && canInvestigate && (
                  <Link href={`/investigator?exception=${id}`} className="text-accent hover:underline">
                    investigate →
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      )}
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
  // Default to the move the budget signal would suggest; otherwise the two biggest channels.
  const bySpend = [...withSpend].sort((a, b) => b.monthlySpendCents - a.monthlySpendCents);
  const s = verdicts.budgetSignal;
  const defaultFrom = s.signal === "shift" && s.from ? s.from.channelCode : bySpend[0].channelCode;
  const defaultTo = s.signal === "shift" && s.to ? s.to.channelCode : bySpend[1].channelCode;
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
    <section id="experiments" className="scroll-mt-6 space-y-6">
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
