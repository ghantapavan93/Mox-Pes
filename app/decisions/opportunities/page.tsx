import { Suspense } from "react";
import { OverrideForm } from "@/components/decisions/OverrideForm";
import { Badge, Card, Forbidden, PageHeader, PeriodTabs, Skeleton } from "@/components/ui";
import { money } from "@/lib/format";
import type { ClaimKind, JourneyBrief } from "@/lib/opportunities/journeys";
import { activeOverride, journeyFor, listOverrides, type OverrideRow } from "@/lib/opportunities/overrides";
import { LEVELS, READINESS_POLICY, type ReadinessLevel } from "@/lib/opportunities/readiness";
import { parsePeriod } from "@/lib/period";
import { BRANCHES, BRANCH_BY_ID } from "@/lib/reference";
import { getPool, getViewer } from "@/lib/server";
import { ForbiddenError, type Viewer } from "@/lib/viewer";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default function OpportunitiesPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<Skeleton lines={12} />}>
      <Opportunities searchParams={searchParams} />
    </Suspense>
  );
}

const KIND_LABEL: Record<ClaimKind, string> = {
  observed_fact: "Observed fact",
  inference: "Inference",
  hypothesis: "Hypothesis",
  recommendation: "Recommendation",
  measured_outcome: "Measured outcome",
};
const KIND_TONE: Record<ClaimKind, "good" | "accent" | "warn" | "neutral"> = {
  observed_fact: "good",
  inference: "accent",
  hypothesis: "warn",
  recommendation: "neutral",
  measured_outcome: "neutral",
};
const LEVEL_TONE: Record<ReadinessLevel, "bad" | "warn" | "accent" | "good"> = { blocked: "bad", monitor: "warn", validate: "accent", act: "good" };

async function Opportunities({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const period = parsePeriod(sp.period);
  const viewer = await getViewer();
  const requested = first(sp.branch);
  const branch = requested && BRANCH_BY_ID.has(requested) ? requested : null;
  const pool = getPool();
  let briefs: Array<{ brief: JourneyBrief; overrides: OverrideRow[] }>;
  try {
    briefs = await Promise.all(
      (["missed_follow_up", "retention"] as const).map(async (journey) => {
        const brief = await journeyFor(pool, viewer, journey, period.key, branch);
        return { brief, overrides: await listOverrides(pool, journey, period.key, brief.scope) };
      }),
    );
  } catch (error) {
    if (error instanceof ForbiddenError) return <Forbidden message={error.message} />;
    throw error;
  }
  const branchOptions = BRANCHES.filter((b) => !viewer.branchIds || viewer.branchIds.includes(b.id));
  const extra = branch ? `&branch=${branch}` : "";

  return (
    <div className="space-y-6">
      <PageHeader
        crumbs={[{ href: "/decisions", label: "Decision Lab" }, { label: "Revenue opportunities" }]}
        eyebrow={`Understand · ${branch ? `${branch} ${BRANCH_BY_ID.get(branch)!.name}` : viewer.branchIds ? "Your branches" : "All branches"} · ${period.label}`}
        title="Revenue opportunities"
        description={
          <p className="max-w-3xl">
            Two questions the data can start to answer: are inbound prospects lost for lack of follow-up, and are customers lost before their first visit?
            Every sentence says what it is. A fact is counted, an inference is arithmetic on facts, a hypothesis is a possible cause the data does not show, and
            only an intervention against a control produces a measured outcome.
          </p>
        }
        toolbar={
          <>
            <form method="get" action="/decisions/opportunities" className="flex items-center gap-2 text-sm" aria-label="Choose a scope">
              <input type="hidden" name="period" value={period.key} />
              <label htmlFor="opp-branch" className="text-xs text-muted">Scope</label>
              <select id="opp-branch" name="branch" defaultValue={branch ?? ""} className="rounded-md border border-border bg-surface px-2 py-1 text-sm">
                <option value="">{viewer.branchIds ? "All my branches" : "All branches"}</option>
                {branchOptions.map((b) => (
                  <option key={b.id} value={b.id}>{b.id} {b.name}</option>
                ))}
              </select>
              <button type="submit" className="rounded-md border border-border px-2 py-1 text-xs font-medium">Show</button>
            </form>
            <PeriodTabs current={period.key} base="/decisions/opportunities" extra={extra} />
          </>
        }
      />
      {briefs.map(({ brief, overrides }) => (
        <JourneyCard key={brief.journey} brief={brief} overrides={overrides} viewer={viewer} periodKey={period.key} branch={branch} />
      ))}
      <Card title="Readiness policy" subtitle="The same rules for both journeys (lib/opportunities/readiness.ts).">
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
          <li><span className="font-medium text-text">Blocked</span>: a feed is older than {READINESS_POLICY.maxDataAgeMs / 3_600_000} h, a decision-blocking exception is open in scope, or the smaller comparison arm has fewer than {READINESS_POLICY.minArmUnits} units.</li>
          <li><span className="font-medium text-text">Monitor</span>: the value at stake is under {money(READINESS_POLICY.materialityCents)} a year, or the 95% interval does not support the pattern.</li>
          <li><span className="font-medium text-text">Validate</span>: material and supported, but no intervention has been measured. Run the validation step.</li>
          <li><span className="font-medium text-text">Act</span>: a measured outcome exists.</li>
          <li>An override needs the approve permission and a reason, raises the level by one step, and is recorded with the person and the assessment. Stale data and open data-quality exceptions cannot be overridden.</li>
        </ul>
      </Card>
    </div>
  );
}

function JourneyCard({ brief, overrides, viewer, periodKey, branch }: { brief: JourneyBrief; overrides: OverrideRow[]; viewer: Viewer; periodKey: string; branch: string | null }) {
  const r = brief.readiness;
  const nextLevel = LEVELS[LEVELS.indexOf(r.level) + 1];
  const hardFail = r.checks.some((c) => !c.passed && !c.overridable);
  const active = activeOverride(r, overrides);
  const c = brief.comparison;
  return (
    <Card
      id={brief.journey}
      title={brief.title}
      subtitle={brief.question}
      action={
        <span data-testid={`readiness-${brief.journey}`}>
          <Badge tone={LEVEL_TONE[active ? active.overrideLevel : r.level]} dot>
            Readiness: {active ? `${active.overrideLevel} (override; assessed ${r.level})` : r.level}
          </Badge>
        </span>
      }
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <ol className="space-y-3" aria-label={`${brief.title}: statements`}>
          {brief.claims.map((claim, i) => (
            <li key={i} className="space-y-1" data-kind={claim.kind}>
              <Badge tone={KIND_TONE[claim.kind]}>{KIND_LABEL[claim.kind]}</Badge>
              <p className="text-sm leading-6 text-text">{claim.statement}</p>
              <p className="text-xs leading-5 text-muted">{claim.basis}</p>
            </li>
          ))}
        </ol>
        <div className="space-y-4">
          <section aria-label="Comparison" className="rounded-md border border-border p-3 text-sm">
            <p className="font-medium text-text">{c.question}</p>
            <table className="mt-2 w-full text-xs">
              <tbody>
                <tr><td className="py-0.5 text-muted">{c.labelA}</td><td className="text-right tabular-nums">{c.xA.toLocaleString("en-US")} / {c.nA.toLocaleString("en-US")}</td><td className="text-right tabular-nums">{c.rateA === null ? "n/a" : `${(c.rateA * 100).toFixed(1)}%`}</td></tr>
                <tr><td className="py-0.5 text-muted">{c.labelB}</td><td className="text-right tabular-nums">{c.xB.toLocaleString("en-US")} / {c.nB.toLocaleString("en-US")}</td><td className="text-right tabular-nums">{c.rateB === null ? "n/a" : `${(c.rateB * 100).toFixed(1)}%`}</td></tr>
              </tbody>
            </table>
          </section>
          <section aria-label="Readiness checks">
            <ul className="space-y-1 text-xs">
              {r.checks.map((check) => (
                <li key={check.key} className="flex gap-2">
                  <span aria-hidden className={check.passed ? "text-good" : "text-bad"}>{check.passed ? "✓" : "✗"}</span>
                  <span className={check.passed ? "text-muted" : "text-text"}>
                    {check.detail}
                    {!check.passed && !check.overridable && <span className="text-faint"> (cannot be overridden)</span>}
                  </span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs font-medium text-text">Next: {r.next}</p>
          </section>
          <section aria-label="Where" className="text-xs">
            <p className="font-medium text-text">Most affected branches</p>
            <ul className="mt-1 space-y-0.5 text-muted">
              {brief.branches.slice(0, 5).map((b) => (
                <li key={b.branchId} className="flex justify-between gap-2"><span>{b.branchId} {BRANCH_BY_ID.get(b.branchId)?.name}</span><span className="tabular-nums">{b.flagged.toLocaleString("en-US")} of {b.units.toLocaleString("en-US")}</span></li>
              ))}
            </ul>
          </section>
          <section aria-label="Data needed" className="text-xs text-muted">
            <p className="font-medium text-text">Data that would move this past a hypothesis</p>
            <ul className="mt-1 list-disc pl-4">{brief.dataNeeded.map((d) => <li key={d}>{d}</li>)}</ul>
          </section>
          {overrides.length > 0 && (
            <section aria-label="Overrides" className="text-xs">
              <p className="font-medium text-text">Recorded overrides</p>
              <ul className="mt-1 space-y-1 text-muted">
                {overrides.map((o) => (
                  <li key={o.id}>{o.assessedLevel} → {o.overrideLevel} by {o.subject} ({o.role}), accepting {o.acceptedRisks.join(", ")}: “{o.reason}”</li>
                ))}
              </ul>
            </section>
          )}
          {viewer.can.approve && nextLevel && !hardFail && !active && <OverrideForm journey={brief.journey} period={periodKey} branch={branch} to={nextLevel} />}
        </div>
      </div>
    </Card>
  );
}
