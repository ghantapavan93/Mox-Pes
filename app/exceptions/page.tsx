import Link from "next/link";
import { Suspense } from "react";
import { ArrowRight, ChevronRight } from "lucide-react";
import { CaseQueue } from "@/components/actions/CaseQueue";
import { ProposalStatusBadge, SourceBadge } from "@/components/actions/badges";
import { ButtonLink, Callout, Card, FilterChips, FilterSelect, Forbidden, KpiTile, PageHeader, Pager, Segmented, Skeleton } from "@/components/ui";
import { KIND_LABEL, count, money } from "@/lib/format";
import { exceptionSummary } from "@/lib/queries";
import { BRANCHES, BRAND_BY_ID } from "@/lib/reference";
import { getPool, getViewer } from "@/lib/server";
import { ForbiddenError, VIEWERS, resolveScope, type Viewer } from "@/lib/viewer";
import { KIND_TITLE } from "@/lib/workflow/kinds";
import { OWNER_ROLES } from "@/lib/workflow/proposals";
import { caseStateCounts, countQueue, exceptionsWithoutCase, listQueue, type StateFilter } from "@/lib/workflow/queries";
import { ACTIVE_STATES, CASE_STATES, CLOSED_STATES, STATE_LABEL, STATE_TONE, isCaseState, type CaseState } from "@/lib/workflow/states";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

const SEVERITIES = ["high", "medium", "low"] as const;
const PAGE_SIZE = 50;

/** The main path of a fix, in order (lib/workflow/states.ts); every other state is a side exit. */
const MAIN_PATH: readonly CaseState[] = ["detected", "investigating", "proposed", "dry_run_verified", "awaiting_approval", "applied", "verified", "resolved"];
const SIDE_EXITS: readonly CaseState[] = CASE_STATES.filter((s) => !MAIN_PATH.includes(s));

/** `?page=` as a positive integer; anything else is page 1. */
function parsePage(value: string | undefined): number {
  if (!value || !/^\d{1,6}$/.test(value)) return 1;
  return Math.max(1, Number(value));
}

/** What the numbers on this page are computed over, in words. */
function scopeLabel(viewer: Viewer, branchIds: string[] | null): string {
  if (branchIds && branchIds.length === 1) return `Branch ${branchIds[0]}`;
  if (viewer.brandIds) return viewer.brandIds.map((b) => BRAND_BY_ID.get(b)!.name).join(", ");
  if (branchIds) return `${branchIds.length} branches`;
  return "All 44 branches";
}

export const metadata = { title: "Incidents" };

export default function IncidentsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<Skeleton lines={10} />}>
      <Incidents searchParams={searchParams} />
    </Suspense>
  );
}

/**
 * Incidents: the Action Center queue. Every reconciliation exception is a case. The page answers,
 * in order: how much is open and at stake; where each case is in the fix workflow; which kinds of
 * problem carry the money; what needs a decision now; then the filterable queue itself.
 * Filters are plain GET parameters (state, severity, branch, kind, owner, page), validated here
 * and applied in SQL with the viewer's branch scope, so a filter never widens what a viewer sees.
 */
async function Incidents({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const viewer = await getViewer();
  const rawState = one(sp.state);
  const state: StateFilter = rawState && (isCaseState(rawState) || ["active", "closed", "all"].includes(rawState)) ? (rawState as StateFilter) : "active";
  const severity = SEVERITIES.find((s) => s === one(sp.severity));
  const rawKind = one(sp.kind);
  // Own keys only: `in` would accept inherited names such as "toString".
  const kind = rawKind && Object.hasOwn(KIND_LABEL, rawKind) ? rawKind : undefined;
  const ownerParam = one(sp.owner);
  const owner = ownerParam === "unassigned" || OWNER_ROLES.some((r) => r === ownerParam) ? ownerParam : undefined;
  const branch = one(sp.branch);
  const page = parsePage(one(sp.page));
  let branchIds: string[] | null;
  try {
    branchIds = resolveScope(viewer, branch ?? null);
  } catch (error) {
    if (error instanceof ForbiddenError) return <Forbidden message={error.message} />;
    throw error;
  }

  const pool = getPool();
  const queueFilters = { branchIds, state, severity, kind, owner };
  const [counts, rows, queueTotal, lane, summary, uncased, highOpen] = await Promise.all([
    caseStateCounts(pool, branchIds),
    listQueue(pool, { ...queueFilters, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    countQueue(pool, queueFilters),
    listQueue(pool, { branchIds, state: "awaiting_approval", limit: 12 }),
    exceptionSummary(pool, branchIds),
    exceptionsWithoutCase(pool, branchIds),
    countQueue(pool, { branchIds, state: "active", severity: "high" }),
  ]);
  const filters = { state: state === "active" ? undefined : state, severity, kind, owner, branch };
  const href = (patch: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...filters, ...patch })) if (v) q.set(k, v);
    const s = q.toString();
    return s ? `/exceptions?${s}` : "/exceptions";
  };
  const total = (states: readonly string[]) => states.reduce((n, s) => n + (counts[s as keyof typeof counts] ?? 0), 0);
  const activeTotal = total(ACTIVE_STATES);
  const closedTotal = total(CLOSED_STATES);
  const awaiting = counts.awaiting_approval ?? 0;
  const kindsWithOpen = summary.filter((s) => s.open > 0).length;
  const maxKindCents = Math.max(1, ...summary.map((s) => s.amountCents));
  const branchOptions = viewer.branchIds ? BRANCHES.filter((b) => viewer.branchIds!.includes(b.id)) : BRANCHES;
  const lastPage = Math.max(1, Math.ceil(queueTotal / PAGE_SIZE));
  const firstShown = (page - 1) * PAGE_SIZE + 1;
  const lastShown = firstShown + rows.length - 1;
  const pageHref = (n: number) => href({ page: n > 1 ? String(n) : undefined });
  const stateTitle = state === "active" ? "Active cases" : state === "closed" ? "Closed cases" : state === "all" ? "All cases" : STATE_LABEL[state];
  const ownerLabel = (r: string) => (r === "unassigned" ? "Unassigned" : (VIEWERS[r as keyof typeof VIEWERS]?.label.split(" · ")[0] ?? r));
  const chips = [
    ...(state !== "active" ? [{ label: <>State: {state === "closed" ? "all closed" : state === "all" ? "all" : STATE_LABEL[state]}</>, removeHref: href({ state: undefined, page: undefined }) }] : []),
    ...(severity ? [{ label: <>Severity: {severity}</>, removeHref: href({ severity: undefined, page: undefined }) }] : []),
    ...(branch ? [{ label: <>Branch: {branch}</>, removeHref: href({ branch: undefined, page: undefined }) }] : []),
    ...(kind ? [{ label: <>Type: {KIND_LABEL[kind]}</>, removeHref: href({ kind: undefined, page: undefined }) }] : []),
    ...(owner ? [{ label: <>Owner: {ownerLabel(owner)}</>, removeHref: href({ owner: undefined, page: undefined }) }] : []),
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={`Action Center · ${scopeLabel(viewer, branchIds)}`}
        title="Incidents"
        description={
          <p className="max-w-3xl">
            Every reconciliation exception is a case. A fix is proposed, dry-run in a transaction that is rolled back, approved by a role other than the
            proposer&apos;s, then executed once by the application, verified and audited. A case closes when reconciliation confirms the data agrees, and
            re-opens if the condition returns. All data is synthetic.
          </p>
        }
        actions={<ButtonLink href="/investigator">Ask the AI investigator</ButtonLink>}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="incident-kpis">
        <KpiTile
          label="Open cases"
          value={count(activeTotal)}
          sub={`across ${count(kindsWithOpen)} incident type${kindsWithOpen === 1 ? "" : "s"}`}
          tone={activeTotal > 0 ? "warn" : "neutral"}
          href={href({ state: undefined, severity: undefined, kind: undefined, owner: undefined, page: undefined })}
          current={state === "active" && !severity && !kind && !owner}
        />
        {/* No money total here: case amounts mix spend and revenue and overlap, so they do not add
            up. The deduplicated revenue at risk is a defined metric, shown on Overview. */}
        <KpiTile
          label="High-severity open cases"
          value={count(highOpen)}
          sub={`of ${count(activeTotal)} open`}
          tone={highOpen > 0 ? "bad" : "good"}
          href={href({ state: undefined, severity: "high", page: undefined })}
          current={state === "active" && severity === "high"}
        />
        <KpiTile
          label="Needs an approval decision"
          value={count(awaiting)}
          sub="Dry run verified; another role decides"
          tone={awaiting > 0 ? "accent" : "neutral"}
          href={href({ state: "awaiting_approval", page: undefined })}
          current={state === "awaiting_approval"}
        />
        <KpiTile
          label="Closed"
          value={count(closedTotal)}
          sub={`${count(counts.resolved ?? 0)} resolved by reconciliation`}
          tone={closedTotal > 0 ? "good" : "neutral"}
          href={href({ state: "closed", page: undefined })}
          current={state === "closed"}
        />
      </div>

      {uncased > 0 && (
        <Callout tone="warn" title={`${count(uncased)} exception${uncased === 1 ? "" : "s"} not in the queue yet`}>
          Raised at ingestion; each gets a case on the next reconciliation run.
        </Callout>
      )}

      <Card title="Where cases are in the fix workflow" subtitle="Each step links to its cases. A fix moves left to right; a side exit closes a case with a reason.">
        <nav aria-label="Cases by state" className="space-y-3" data-testid="state-counts">
          <Segmented
            label="View"
            items={[
              { href: href({ state: undefined, page: undefined }), label: <>Active · {count(activeTotal)}</>, current: state === "active" },
              { href: href({ state: "closed", page: undefined }), label: <>All closed · {count(closedTotal)}</>, current: state === "closed" },
              { href: href({ state: "all", page: undefined }), label: <>All · {count(total(CASE_STATES))}</>, current: state === "all" },
            ]}
          />
          <ol className="flex items-stretch gap-1 overflow-x-auto pb-1" aria-label="Fix workflow states">
            {MAIN_PATH.map((s, i) => (
              <li key={s} className="flex shrink-0 items-center gap-1">
                {i > 0 && <ChevronRight aria-hidden className="size-3.5 shrink-0 text-faint" />}
                <StateStep href={href({ state: s, page: undefined })} label={STATE_LABEL[s]} n={counts[s] ?? 0} current={state === s} tone={STATE_TONE[s]} />
              </li>
            ))}
          </ol>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 text-xs text-faint">Side exits</span>
            {SIDE_EXITS.map((s) => (
              <StateStep key={s} href={href({ state: s, page: undefined })} label={STATE_LABEL[s]} n={counts[s] ?? 0} current={state === s} tone={STATE_TONE[s]} compact />
            ))}
          </div>
        </nav>
      </Card>

      <div className="grid gap-6 xl:grid-cols-3">
        <Card
          className="xl:col-span-2"
          title="Amount at stake by incident type"
          subtitle="Each open case's own amount: spend for spend incidents, revenue for revenue incidents. Amounts overlap, so they are not added up; the deduplicated revenue at risk is on Overview. Select a type to filter the queue."
          flush
        >
          <ul className="divide-y divide-border" data-testid="kind-breakdown">
            {summary.map((s) => {
              const current = kind === s.kind;
              const width = s.amountCents > 0 ? Math.max(2, (s.amountCents / maxKindCents) * 100) : 0;
              return (
                <li key={s.kind}>
                  <Link
                    href={href({ kind: current ? undefined : s.kind, page: undefined })}
                    aria-current={current ? "true" : undefined}
                    className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 px-4 py-2.5 text-sm hover:bg-surface-2 sm:grid-cols-[12rem_minmax(0,1fr)_auto] ${current ? "bg-accent-soft" : ""}`}
                  >
                    <span className="min-w-0 truncate font-medium text-text">{KIND_LABEL[s.kind] ?? s.kind}</span>
                    <span aria-hidden className="col-span-2 row-start-2 h-1.5 rounded-full bg-sunken sm:col-span-1 sm:row-start-auto">
                      <span className="block h-1.5 rounded-full bg-bad" style={{ width: `${width}%` }} />
                    </span>
                    <span className="whitespace-nowrap text-right text-xs tabular-nums text-muted">
                      <span className="font-semibold text-text">{money(s.amountCents)}</span> · {count(s.open)} open · {count(s.resolved)} resolved
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>

        <Card title={`Awaiting approval (${count(awaiting)})`} subtitle="Dry run verified; needs a decision from a role other than the proposer's" flush>
          {lane.length === 0 ? (
            <p className="px-4 py-4 text-sm text-muted">Nothing is waiting for approval.</p>
          ) : (
            <ul className="divide-y divide-border" data-testid="approval-lane">
              {lane.map((r) => (
                <li key={r.caseId} className="px-4 py-2.5 text-sm">
                  <Link href={`/exceptions/${r.exceptionId}`} className="font-medium text-accent hover:underline">
                    {r.proposal ? KIND_TITLE[r.proposal.kind] : "Case"} · {KIND_LABEL[r.kind] ?? r.kind}
                  </Link>
                  <div className="text-xs text-muted">
                    {r.branchId ?? "company"} · case #{r.caseId} · {money(r.amountCents)}
                  </div>
                  {r.proposal && (
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
                      <span className="text-muted">proposed by {r.proposal.proposedRole}</span>
                      <SourceBadge source={r.proposal.source} />
                      <ProposalStatusBadge status={r.proposal.status} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
          {awaiting > lane.length && (
            <Link href={href({ state: "awaiting_approval", page: undefined })} className="flex items-center gap-1 border-t border-border px-4 py-2 text-xs font-medium text-accent hover:underline">
              All {count(awaiting)} awaiting approval <ArrowRight aria-hidden className="size-3" />
            </Link>
          )}
        </Card>
      </div>

      <Card
        id="queue"
        title={`${stateTitle}${kind ? ` · ${KIND_LABEL[kind]}` : ""}${branch && branchIds ? ` · ${branchIds.join(", ")}` : ""} (${count(queueTotal)})`}
        subtitle="What needs someone comes first: awaiting approval, failed, proposed; then by severity and revenue at stake."
        flush
      >
        <form
          method="get"
          action="/exceptions"
          aria-label="Filter cases"
          className="grid grid-cols-2 items-end gap-3 border-b border-border bg-surface-2/60 px-4 py-3 sm:grid-cols-3 lg:grid-cols-[repeat(5,minmax(0,1fr))_auto]"
        >
          <FilterSelect name="state" label="State" value={state} options={[["active", "Active"], ...CASE_STATES.map((s) => [s, STATE_LABEL[s]] as [string, string]), ["closed", "All closed"], ["all", "All"]]} />
          <FilterSelect name="severity" label="Severity" value={severity ?? ""} options={[["", "Any"], ...SEVERITIES.map((s) => [s, s] as [string, string])]} />
          <FilterSelect name="branch" label="Branch" value={branch ?? ""} options={[["", viewer.branchIds ? "My branches" : "All"], ...branchOptions.map((b) => [b.id, `${b.id} ${b.name}`] as [string, string])]} />
          <FilterSelect name="kind" label="Type" value={kind ?? ""} options={[["", "Any"], ...Object.entries(KIND_LABEL)]} />
          <FilterSelect name="owner" label="Owner" value={owner ?? ""} options={[["", "Anyone"], ["unassigned", "Unassigned"], ...OWNER_ROLES.map((r) => [r, ownerLabel(r)] as [string, string])]} />
          <div className="flex items-center gap-3">
            <button type="submit" className="h-8 rounded-md bg-accent px-3 text-sm font-medium text-white hover:bg-accent-hover">
              Apply
            </button>
            <Link href="/exceptions" className="text-sm text-accent hover:underline">
              Reset
            </Link>
          </div>
        </form>
        {chips.length > 0 && (
          <div className="border-b border-border px-4 py-2">
            <FilterChips items={chips} clearHref="/exceptions" testId="queue-filters" />
          </div>
        )}
        {rows.length === 0 && queueTotal > 0 ? (
          <p className="px-4 py-4 text-sm text-muted" data-testid="queue-past-end">
            Page {count(page)} is past the last page of these cases.{" "}
            <Link href={pageHref(lastPage)} className="text-accent hover:underline">
              Go to page {count(lastPage)}
            </Link>
            .
          </p>
        ) : (
          <CaseQueue rows={rows} empty="No cases match these filters in your scope." flush />
        )}
        {queueTotal > 0 && rows.length > 0 && (
          <Pager page={page} lastPage={lastPage} first={firstShown} last={lastShown} total={queueTotal} hrefFor={pageHref} label="Case queue pages" testId="queue-pagination" />
        )}
      </Card>
    </div>
  );
}

/** One state in the workflow strip: its name, its tone dot, and how many cases are in it. */
function StateStep({ href, label, n, current, tone, compact = false }: { href: string; label: string; n: number; current: boolean; tone: string; compact?: boolean }) {
  const dot = tone === "bad" ? "bg-bad" : tone === "warn" ? "bg-warn" : tone === "good" ? "bg-good" : tone === "accent" ? "bg-accent" : "bg-faint";
  const frame = current ? "border-accent bg-accent-soft text-text" : "border-border bg-surface text-muted hover:border-accent";
  if (compact) {
    return (
      <Link href={href} aria-current={current ? "page" : undefined} className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs ${frame}`}>
        <span aria-hidden className={`size-1.5 rounded-full ${dot}`} />
        {label}
        <span className={`font-semibold tabular-nums ${n > 0 ? "text-text" : "text-faint"}`}>{count(n)}</span>
      </Link>
    );
  }
  return (
    <Link href={href} aria-current={current ? "page" : undefined} className={`flex min-w-[6.5rem] flex-col gap-0.5 rounded-md border px-3 py-1.5 ${frame}`}>
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs">
        <span aria-hidden className={`size-1.5 rounded-full ${dot}`} />
        {label}
      </span>
      <span className={`text-base font-semibold tabular-nums ${n > 0 ? "text-text" : "text-faint"}`}>{count(n)}</span>
    </Link>
  );
}
