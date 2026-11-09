import Link from "next/link";
import { Suspense } from "react";
import { CaseQueue } from "@/components/actions/CaseQueue";
import { ProposalStatusBadge, SourceBadge } from "@/components/actions/badges";
import { Card, Forbidden, Skeleton } from "@/components/ui";
import { KIND_LABEL, count, money } from "@/lib/format";
import { exceptionSummary } from "@/lib/queries";
import { BRANCHES } from "@/lib/reference";
import { getPool, getViewer } from "@/lib/server";
import { ForbiddenError, VIEWERS, resolveScope } from "@/lib/viewer";
import { KIND_TITLE } from "@/lib/workflow/kinds";
import { OWNER_ROLES } from "@/lib/workflow/proposals";
import { caseStateCounts, exceptionsWithoutCase, listQueue, type StateFilter } from "@/lib/workflow/queries";
import { ACTIVE_STATES, CASE_STATES, CLOSED_STATES, STATE_LABEL, STATE_TONE, isCaseState } from "@/lib/workflow/states";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

const SEVERITIES = ["high", "medium", "low"] as const;

export default function ActionCenterPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<Skeleton lines={10} />}>
      <ActionCenter searchParams={searchParams} />
    </Suspense>
  );
}

/**
 * The Action Center queue. Every exception has a case; the queue shows where each case is
 * in its workflow, who owns it, and its latest proposal. Filters are plain GET parameters
 * (state, severity, branch, kind, owner), validated here and applied in SQL with the
 * viewer's branch scope.
 */
async function ActionCenter({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const viewer = await getViewer();
  const rawState = one(sp.state);
  const state: StateFilter = rawState && (isCaseState(rawState) || ["active", "closed", "all"].includes(rawState)) ? (rawState as StateFilter) : "active";
  const severity = SEVERITIES.find((s) => s === one(sp.severity));
  const kind = one(sp.kind) && one(sp.kind)! in KIND_LABEL ? one(sp.kind) : undefined;
  const ownerParam = one(sp.owner);
  const owner = ownerParam === "unassigned" || OWNER_ROLES.some((r) => r === ownerParam) ? ownerParam : undefined;
  const branch = one(sp.branch);
  let branchIds: string[] | null;
  try {
    branchIds = resolveScope(viewer, branch ?? null);
  } catch (error) {
    if (error instanceof ForbiddenError) return <Forbidden message={error.message} />;
    throw error;
  }

  const pool = getPool();
  const [counts, rows, lane, summary, uncased] = await Promise.all([
    caseStateCounts(pool, branchIds),
    listQueue(pool, { branchIds, state, severity, kind, owner }),
    listQueue(pool, { branchIds, state: "awaiting_approval", limit: 12 }),
    exceptionSummary(pool, branchIds),
    exceptionsWithoutCase(pool, branchIds),
  ]);
  const filters = { state: state === "active" ? undefined : state, severity, kind, owner, branch };
  const href = (patch: Record<string, string | undefined>) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...filters, ...patch })) if (v) q.set(k, v);
    const s = q.toString();
    return s ? `/exceptions?${s}` : "/exceptions";
  };
  const total = (states: readonly string[]) => states.reduce((n, s) => n + (counts[s as keyof typeof counts] ?? 0), 0);
  const branchOptions = viewer.branchIds ? BRANCHES.filter((b) => viewer.branchIds!.includes(b.id)) : BRANCHES;
  const stateTitle = state === "active" ? "Active cases" : state === "closed" ? "Closed cases" : state === "all" ? "All cases" : STATE_LABEL[state];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Action Center</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Every reconciliation exception is a case. A fix is proposed, dry-run in a transaction that is rolled back, approved by a role other
          than the proposer&apos;s, then executed once by the application, verified and audited. A case closes when reconciliation confirms the
          data agrees, and re-opens if the condition returns. All data is synthetic.
        </p>
      </div>

      <nav aria-label="Cases by state" className="flex flex-wrap gap-2 text-xs" data-testid="state-counts">
        <StateChip href={href({ state: undefined })} label="Active" n={total(ACTIVE_STATES)} current={state === "active"} />
        {CASE_STATES.map((s) => (
          <StateChip key={s} href={href({ state: s })} label={STATE_LABEL[s]} n={counts[s] ?? 0} current={state === s} tone={STATE_TONE[s]} />
        ))}
        <StateChip href={href({ state: "closed" })} label="All closed" n={total(CLOSED_STATES)} current={state === "closed"} />
        <StateChip href={href({ state: "all" })} label="All" n={total(CASE_STATES)} current={state === "all"} />
      </nav>
      {uncased > 0 && (
        <p className="text-xs text-warn">
          {count(uncased)} exception{uncased === 1 ? "" : "s"} raised at ingestion get a case on the next reconciliation run.
        </p>
      )}

      <Card title={`Awaiting approval (${count(counts.awaiting_approval ?? 0)})`} subtitle="Dry run verified; needs a decision from a role other than the proposer's">
        {lane.length === 0 ? (
          <p className="text-sm text-muted">Nothing is waiting for approval.</p>
        ) : (
          <ul className="divide-y divide-border" data-testid="approval-lane">
            {lane.map((r) => (
              <li key={r.caseId} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <div className="min-w-0">
                  <Link href={`/exceptions/${r.exceptionId}`} className="font-medium text-accent hover:underline">
                    {r.proposal ? KIND_TITLE[r.proposal.kind] : "Case"} · {KIND_LABEL[r.kind] ?? r.kind}
                  </Link>
                  <span className="ml-2 text-xs text-muted">{r.branchId ?? "company"} · case #{r.caseId}</span>
                  <div className="truncate text-xs text-muted">{r.summary}</div>
                </div>
                {r.proposal && (
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-muted">proposed by {r.proposal.proposedRole}</span>
                    <SourceBadge source={r.proposal.source} />
                    <ProposalStatusBadge status={r.proposal.status} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-7">
        {summary.map((s) => (
          <Link
            key={s.kind}
            href={href({ kind: kind === s.kind ? undefined : s.kind })}
            aria-current={kind === s.kind ? "true" : undefined}
            className={`rounded-lg border bg-surface p-3 text-sm hover:border-accent ${kind === s.kind ? "border-accent" : "border-border"}`}
          >
            <div className="text-xs text-muted">{KIND_LABEL[s.kind] ?? s.kind}</div>
            <div className="mt-1 text-xl font-semibold tabular-nums">{count(s.open)}</div>
            <div className="text-[11px] text-faint">
              {money(s.amountCents)} open · {count(s.resolved)} resolved
            </div>
          </Link>
        ))}
      </div>

      <Card
        title={`${stateTitle}${kind ? ` · ${KIND_LABEL[kind]}` : ""}${branchIds ? ` · ${branchIds.join(", ")}` : ""} (${count(rows.length)})`}
        action={
          <form method="get" action="/exceptions" className="flex flex-wrap items-end gap-2 text-xs" aria-label="Filter cases">
            <Select name="state" label="State" value={state} options={[["active", "Active"], ...CASE_STATES.map((s) => [s, STATE_LABEL[s]] as [string, string]), ["closed", "All closed"], ["all", "All"]]} />
            <Select name="severity" label="Severity" value={severity ?? ""} options={[["", "Any"], ...SEVERITIES.map((s) => [s, s] as [string, string])]} />
            <Select name="branch" label="Branch" value={branch ?? ""} options={[["", viewer.branchIds ? "My branches" : "All"], ...branchOptions.map((b) => [b.id, `${b.id} ${b.name}`] as [string, string])]} />
            <Select name="kind" label="Kind" value={kind ?? ""} options={[["", "Any"], ...Object.entries(KIND_LABEL)]} />
            <Select name="owner" label="Owner" value={owner ?? ""} options={[["", "Anyone"], ["unassigned", "Unassigned"], ...OWNER_ROLES.map((r) => [r, VIEWERS[r].label.split(" · ")[0]] as [string, string])]} />
            <button type="submit" className="rounded bg-text px-2.5 py-1 font-medium text-white">
              Apply
            </button>
            <Link href="/exceptions" className="py-1 text-accent hover:underline">
              Reset
            </Link>
          </form>
        }
      >
        <CaseQueue rows={rows} empty="No cases match these filters in your scope." />
      </Card>
    </div>
  );
}

function StateChip({ href, label, n, current, tone }: { href: string; label: string; n: number; current: boolean; tone?: string }) {
  const dot = tone === "bad" ? "bg-bad" : tone === "warn" ? "bg-warn" : tone === "good" ? "bg-good" : tone === "accent" ? "bg-accent" : "bg-faint";
  return (
    <Link
      href={href}
      aria-current={current ? "page" : undefined}
      className={`inline-flex items-center gap-1.5 rounded border px-2 py-1 hover:border-accent ${current ? "border-accent bg-accent-soft text-text" : "border-border bg-surface text-muted"} ${n === 0 && !current ? "opacity-60" : ""}`}
    >
      {tone && <span aria-hidden className={`h-1.5 w-1.5 rounded-full ${dot}`} />}
      {label}
      <span className="font-semibold tabular-nums text-text">{count(n)}</span>
    </Link>
  );
}

function Select({ name, label, value, options }: { name: string; label: string; value: string; options: Array<[string, string]> }) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-faint">{label}</span>
      <select name={name} defaultValue={value} className="rounded border border-border bg-surface px-1.5 py-1 text-xs">
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}
