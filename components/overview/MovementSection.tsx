import Link from "next/link";
import { AlertTriangle, CheckCircle2, HelpCircle } from "lucide-react";
import { Callout, Card, metricAnchor, Skeleton } from "@/components/ui";
import { METRICS } from "@/lib/metrics/definitions";
import { shortDay, takeaway } from "@/lib/metrics/movement-copy";
import type { MovementState } from "@/lib/metrics/movement";
import { weekAgainstWindow } from "@/lib/reconcile/gap-status";
import { BRANCH_BY_ID, type Branch } from "@/lib/reference";
import { MovementChart, type Selection } from "./MovementChart";

/**
 * "What changed", on the Overview, decision first: the takeaway for the selected scope and
 * period in one or two sentences, whether the figures support an action or call for review, then
 * the chart, the selected point's explanation and its evidence. The scope (all branches in view,
 * or one branch) and the period (the Overview's tabs) are visible here; the selection is in the URL.
 */

/** Awaits the panel's own reads (started by the page once its own are done) inside its own Suspense boundary. */
export async function MovementSectionAsync({ ready, ...props }: { ready: Promise<MovementState> } & Omit<Parameters<typeof MovementSection>[0], "state">) {
  return <MovementSection state={await ready} {...props} />;
}

/**
 * The panel's place while it loads, about half a second after the hold. It holds the rendered
 * panel's height at each width, so the hold list below does not jump when the panel arrives.
 * Before it did, the B09 hold moved 437 px down at 1440 and 701 px at 390.
 *
 * The rendered height follows the chart, which scales with the width. Measured on the October
 * Overview, all branches: 1,208–1,276 px below 360; 1,041–1,107 at 360–399; 962–1,030 at 400–519;
 * 848–920 at 520–639; 848–871 at 640–767; 822–868 at 768–1023; 686–758 at 1024–1279; 716–776 at
 * 1280–1535; 776–810 at 1536–1920. Each band takes the middle of its range (rem breakpoints, so
 * the bands sort in order).
 */
export function MovementSkeleton() {
  return (
    <Card
      id="movement"
      title="What changed"
      className="min-h-[1240px] min-[22.5rem]:min-h-[1075px] min-[25rem]:min-h-[995px] min-[32.5rem]:min-h-[885px] sm:min-h-[860px] md:min-h-[845px] lg:min-h-[722px] xl:min-h-[746px] 2xl:min-h-[795px]"
    >
      <div aria-busy="true">
        <Skeleton lines={5} />
      </div>
    </Card>
  );
}

export function MovementSection({
  state,
  branchOptions,
  periodKey,
  brandParam,
  selection,
}: {
  state: MovementState;
  branchOptions: Branch[];
  periodKey: string;
  brandParam: string | null;
  selection: Selection | null;
}) {
  const selectedBranch = state.kind === "ready" ? (state.movement.scope.branchId ?? "") : state.branchId;
  const picker = (
    <form action="/" method="get" className="flex flex-wrap items-center gap-2" data-testid="movement-scope">
      <input type="hidden" name="period" value={periodKey} />
      {brandParam && <input type="hidden" name="brand" value={brandParam} />}
      <label className="flex items-center gap-2 text-xs text-muted">
        <span>Branch</span>
        <select name="branch" defaultValue={selectedBranch} className="min-h-9 rounded-md border border-border-strong bg-surface px-2 text-sm text-text">
          {branchOptions.length > 1 && <option value="">All branches in view</option>}
          {branchOptions.map((b) => (
            <option key={b.id} value={b.id}>
              {b.id} {b.name}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="inline-flex min-h-9 items-center rounded-md border border-border bg-surface px-3 text-sm font-medium hover:bg-surface-2">
        Show
      </button>
    </form>
  );

  if (state.kind !== "ready") {
    return (
      <Card id="movement" title="What changed" action={picker}>
        <Callout tone="bad" title={state.kind === "outside_scope" ? `${state.branchId} is outside your scope` : `There is no branch ${state.branchId}`} testId="movement-unavailable">
          {state.kind === "outside_scope" ? "Nothing about it is shown here: not its spend, its records or whether it has any." : "Choose a branch from the list."}
        </Callout>
      </Card>
    );
  }

  const m = state.movement;
  const branch: Branch | null = m.scope.branchId ? (BRANCH_BY_ID.get(m.scope.branchId) ?? null) : null;
  const scopeLabel = branch ? `${branch.id} ${branch.name}` : branchOptions.length === 1 ? `${branchOptions[0].id}` : "the branches in view";
  const t = takeaway(m, branch ? branch.id : scopeLabel);
  const def = METRICS.paidSpend;
  const TrustIcon = t.trust.tone === "review" ? AlertTriangle : t.trust.tone === "clear" ? CheckCircle2 : HelpCircle;
  const evidenceBase = branch ? `/branches/${branch.id}/trace?period=${m.period.key}&metric=paid_spend${brandParam ? `&brand=${brandParam}` : ""}` : null;
  const defaultSelection = selection && m.series.some((s) => s.channel === selection.channel) && m.weeks.some((w) => w.start === selection.week) ? selection : null;
  // The incident the decision status rests on, at its recovery: the same evidence the daily records
  // and Decision Lab open. The chart's selection is not carried: the status is about the decision
  // window, not the week picked here, and the browser's Back returns to that week.
  const statusHref = t.trust.exceptionId ? `/exceptions/${t.trust.exceptionId}?period=${m.period.key}${brandParam ? `&brand=${brandParam}` : ""}#recovery` : null;
  // For each week of a channel with a decision window: how that week stands against the window.
  const windowNotes: Record<string, string> = {};
  for (const r of m.recoveries ?? []) {
    for (const w of m.weeks) {
      const note = weekAgainstWindow(r, w);
      if (note) windowNotes[`${r.channel}|${w.start}`] = note;
    }
  }

  return (
    <Card id="movement" title="What changed" subtitle={`${branch ? `${branch.id} ${branch.name}` : scopeLabel} · ${m.period.label}`} action={picker}>
      <div className="space-y-4" data-testid="movement" data-scope={branch?.id ?? "all"}>
        <div>
          <p className="text-lg font-semibold leading-7 text-text" data-testid="movement-headline">
            {t.headline}
          </p>
          {t.detail && (
            <p className="mt-1 max-w-3xl text-sm leading-6 text-muted" data-testid="movement-detail">
              {t.detail}
            </p>
          )}
        </div>
        <p
          className={`flex items-start gap-2 rounded-md px-3 py-2 text-sm ${t.trust.tone === "review" ? "bg-warn-soft" : t.trust.tone === "clear" ? "bg-good-soft" : "bg-surface-2"}`}
          data-testid="movement-trust"
          data-tone={t.trust.tone}
        >
          <TrustIcon aria-hidden className={`mt-0.5 size-4 shrink-0 ${t.trust.tone === "review" ? "text-warn" : t.trust.tone === "clear" ? "text-good" : "text-muted"}`} />
          <span>
            <span className="font-semibold text-text">{t.trust.label}.</span> <span className="text-text">{t.trust.text}</span>
            {statusHref ? (
              <>
                {" "}
                <Link href={statusHref} className="font-medium text-accent underline" data-testid="movement-status-link">
                  Open incident #{t.trust.exceptionId}
                </Link>
              </>
            ) : (
              m.holds[0] &&
              branch && (
                <>
                  {" "}
                  <Link href={`/exceptions/${m.holds[0].exceptionId}`} className="font-medium text-accent underline">
                    Open incident #{m.holds[0].exceptionId}
                  </Link>
                </>
              )
            )}
            {t.suggestion && (
              <>
                {" "}
                <Link href={`/?period=${m.period.key}${brandParam ? `&brand=${brandParam}` : ""}&branch=${t.suggestion.branchId}#movement`} className="font-medium text-accent underline" data-testid="movement-suggestion">
                  {t.suggestion.label}
                </Link>
              </>
            )}
          </span>
        </p>

        {m.series.length === 0 ? (
          <p className="text-sm text-muted" data-testid="movement-empty">
            No paid media spend is recorded for this scope between {m.weeks[0]?.start} and {m.weeks[m.weeks.length - 1]?.end}. That is no record, not $0.
          </p>
        ) : (
          <MovementChart
            weeks={m.weeks}
            series={m.series}
            markers={m.markers}
            scopeLabel={branch ? branch.id : scopeLabel}
            initial={defaultSelection}
            defaultChannel={m.markers[0]?.channel ?? m.series[0].channel}
            evidenceBase={evidenceBase}
            periodLabel={m.period.label.split(",")[0]}
            windowNotes={windowNotes}
          />
        )}

        <p className="text-xs leading-5 text-muted" data-testid="movement-definition">
          <span className="font-medium text-text">{def.label}</span>: {def.formula}. US dollars per week, Monday–Sunday (UTC). The ads feed has delivered spend through{" "}
          {m.deliveredThrough ? shortDay(m.deliveredThrough) : "no date yet"}
          {m.feedStale ? ` — ${m.feedStale}` : ""}. Lead counts beside a point are context in another unit, not part of the line.{" "}
          <Link href={`/definitions#${metricAnchor(def.key)}`} className="text-accent underline">
            Definition
          </Link>
        </p>
      </div>
    </Card>
  );
}
