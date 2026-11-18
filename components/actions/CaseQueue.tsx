import Link from "next/link";
import { Activity, ArrowLeftRight, CalendarX2, FileDiff, FileWarning, MapPinned, ReceiptText, Unlink, type LucideIcon } from "lucide-react";
import { Badge, EmptyState, SeverityBadge, StateBadge, TableWrap, Td, Th } from "@/components/ui";
import { KIND_LABEL, count, date, money } from "@/lib/format";
import { DECISION_BLOCKING_KINDS } from "@/lib/metrics/decision";
import { KIND_TITLE } from "@/lib/workflow/kinds";
import type { QueueGroup, QueueRow } from "@/lib/workflow/queries";
import { CaseStateBadge, ProposalStatusBadge, SourceBadge } from "./badges";
import { QueueGroups, type QueueGroupView } from "./QueueGroups";

/** One icon per incident type, drawn in a tinted square whose tint is the group's highest severity. */
const KIND_ICON: Record<string, LucideIcon> = {
  quarantined_source_records: FileWarning,
  payment_without_ticket: ReceiptText,
  branch_mismatch: MapPinned,
  unmapped_spend: Unlink,
  channel_conflict: ArrowLeftRight,
  payload_conflict: FileDiff,
  channel_coverage_gap: CalendarX2,
  mapping_drift: Activity,
};
const SEVERITY_TINT = { high: "bg-bad-soft text-bad", medium: "bg-warn-soft text-warn", low: "bg-surface-2 text-muted" } as const;

/** What a case's amount is: spend for a spend incident, revenue for the rest (each says which). */
const amountWord = (kind: string) => (kind === "channel_coverage_gap" || kind === "unmapped_spend" ? "spend" : "revenue");

function TableHead() {
  return (
    <thead>
      <tr>
        <Th>Case</Th>
        <Th>Branch</Th>
        <Th>Severity</Th>
        <Th>State</Th>
        <Th>Owner</Th>
        <Th>Latest proposal</Th>
        <Th align="right">At stake</Th>
        <Th align="right">Detected</Th>
      </tr>
    </thead>
  );
}

const BLOCKING: ReadonlySet<string> = new Set(DECISION_BLOCKING_KINDS);

/**
 * The product state a case's incident is in, beside its workflow state (release design §5.8): an
 * open incident of a kind that gates budget decisions holds its branch's decision; a resolved one
 * whose latest proposal was executed was corrected by it.
 */
function IncidentState({ r }: { r: QueueRow }) {
  if (r.exceptionStatus === "open" && r.branchId && BLOCKING.has(r.kind)) return <StateBadge state="held" detail="budget decision" />;
  if (r.exceptionStatus === "resolved" && r.proposal?.status === "executed") return <StateBadge state="corrected" />;
  return null;
}

/** A case's cells after the first, the same in the list and in a group. */
function CaseCells({ r }: { r: QueueRow }) {
  return (
    <>
      <Td>{r.branchId ?? <span className="text-faint">company</span>}</Td>
      <Td>
        <SeverityBadge severity={r.severity} />
      </Td>
      <Td>
        <div className="flex flex-wrap items-center gap-1">
          <CaseStateBadge state={r.state} />
          <IncidentState r={r} />
        </div>
        {r.reopenCount > 0 && <div className="mt-0.5 text-[11px] text-warn">re-opened {r.reopenCount}×</div>}
      </Td>
      <Td className="text-xs">{r.owner ?? <span className="text-faint">unassigned</span>}</Td>
      <Td className="text-xs">
        {r.proposal ? (
          <div className="space-y-0.5">
            <div>
              #{r.proposal.id} {KIND_TITLE[r.proposal.kind]} <SourceBadge source={r.proposal.source} />
            </div>
            <ProposalStatusBadge status={r.proposal.status} />
          </div>
        ) : (
          <span className="text-faint">none</span>
        )}
      </Td>
      <Td align="right">{money(r.amountCents)}</Td>
      <Td align="right">{date(r.firstDetectedAt)}</Td>
    </>
  );
}

/** A case as a phone card's facts: state, severity, where, who, the latest proposal. */
function CaseFacts({ r }: { r: QueueRow }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <SeverityBadge severity={r.severity} />
        <CaseStateBadge state={r.state} />
        <IncidentState r={r} />
        <span className="text-muted">
          {r.branchId ?? "company"} · {r.owner ?? "unassigned"} · detected {date(r.firstDetectedAt)}
        </span>
      </div>
      {r.proposal && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted">
            #{r.proposal.id} {KIND_TITLE[r.proposal.kind]}
          </span>
          <SourceBadge source={r.proposal.source} />
          <ProposalStatusBadge status={r.proposal.status} />
        </div>
      )}
    </>
  );
}

/** The Action Center queue: one row per case, linked to its exception page. */
export function CaseQueue({ rows, empty, flush = false }: { rows: QueueRow[]; empty: string; flush?: boolean }) {
  if (rows.length === 0)
    return (
      <div className={flush ? "p-4" : ""}>
        <EmptyState title={empty}>Try another state, or remove a filter.</EmptyState>
      </div>
    );
  return (
    <>
      {/* Below md: one card per case, no sideways scrolling. The table is display:none there, so
          assistive tech meets each case once at any width. */}
      <ul className={`divide-y divide-border md:hidden ${flush ? "" : "-mx-4"}`} data-testid="case-queue-cards">
        {rows.map((r) => (
          <li key={r.caseId} className="space-y-1.5 px-4 py-3">
            <div className="flex items-baseline justify-between gap-3">
              <Link href={`/exceptions/${r.exceptionId}`} className="min-w-0 font-medium text-accent hover:underline">
                {KIND_LABEL[r.kind] ?? r.kind} <span className="text-xs font-normal text-muted">#{r.caseId}</span>
              </Link>
              <span className="shrink-0 text-sm font-semibold tabular-nums">{money(r.amountCents)}</span>
            </div>
            <p className="line-clamp-2 text-xs text-muted">{r.summary}</p>
            <CaseFacts r={r} />
          </li>
        ))}
      </ul>
      <div className="hidden md:block">
        <TableWrap label="Case queue" flush={flush} minWidth={880}>
          <TableHead />
          <tbody data-testid="case-queue">
            {rows.map((r) => (
              <tr key={r.caseId}>
                <Td>
                  <Link href={`/exceptions/${r.exceptionId}`} className="font-medium text-accent hover:underline">
                    {KIND_LABEL[r.kind] ?? r.kind}
                  </Link>
                  <span className="ml-1 text-xs text-faint">#{r.caseId}</span>
                  <div className="line-clamp-2 max-w-xl text-xs text-muted" title={r.summary}>
                    {r.summary}
                  </div>
                </Td>
                <CaseCells r={r} />
              </tr>
            ))}
          </tbody>
        </TableWrap>
      </div>
    </>
  );
}

/**
 * The queue grouped by incident type (lib/workflow/queries.ts, listQueueGroups): a header row per
 * type (icon, name, count, where, highest severity, its own amount and what that amount is) over
 * its most urgent cases, one level in. Amounts are summed within a type only, where they are all
 * spend or all revenue; types are never added together (behaviour rule 7). `listHref` is the
 * type's full, paged list.
 */
export function CaseQueueGrouped({ groups, empty, listHref }: { groups: QueueGroup[]; empty: string; listHref: (kind: string) => string }) {
  if (groups.length === 0)
    return (
      <div className="p-4">
        <EmptyState title={empty}>Try another state, or remove a filter.</EmptyState>
      </div>
    );
  const views: QueueGroupView[] = groups.map((g) => {
    const Icon = KIND_ICON[g.kind] ?? FileWarning;
    const name = KIND_LABEL[g.kind] ?? g.kind;
    const where = g.branchId ?? (g.branches === 0 ? "company" : `${count(g.branches)} ${g.branches === 1 ? "branch" : "branches"}${g.company ? " and company" : ""}`);
    // The type's own list, paged: every case when only the most urgent are shown here, and the way
    // in without this page's script (a closed group's rows are not rendered as visible).
    const more = g.rows.length < g.cases;
    const shown = more ? `${count(g.rows.length)} most urgent shown · ` : "";
    const all = (
      <Link href={listHref(g.kind)} className="inline-flex min-h-6 items-center font-medium text-accent hover:underline">
        {more ? `List all ${count(g.cases)}` : "Open as a list"}
        <span className="sr-only"> of {name} cases</span>
      </Link>
    );
    const amount = (
      <>
        <span className="font-semibold text-text">{money(g.amountCents)}</span>
        <span className="text-faint"> {amountWord(g.kind)}</span>
      </>
    );
    return {
      id: g.kind,
      title: (
        <>
          <span aria-hidden className={`grid size-7 shrink-0 place-items-center rounded-md ${SEVERITY_TINT[g.severity]}`}>
            <Icon className="size-4" />
          </span>
          <span className="min-w-0 truncate text-sm font-medium text-text">{name}</span>{" "}
          <Badge>
            {count(g.cases)}
            <span className="sr-only"> {g.cases === 1 ? "case" : "cases"}</span>
          </Badge>
        </>
      ),
      cells: (
        <>
          <td className="whitespace-nowrap border-b border-border px-3 py-2 align-middle text-sm">{where}</td>
          <td className="border-b border-border px-3 py-2 align-middle">
            <SeverityBadge severity={g.severity} />
          </td>
          <td colSpan={3} className="border-b border-border px-3 py-2 align-middle text-xs text-muted">
            {shown}
            {all}
          </td>
          <td className="whitespace-nowrap border-b border-border px-3 py-2 text-right align-middle text-sm tabular-nums">{amount}</td>
          <td className="border-b border-border px-3 py-2" />
        </>
      ),
      summary: (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <SeverityBadge severity={g.severity} />
          <span className="tabular-nums">{amount}</span>
          <span>{where}</span>
          <span>
            {shown}
            {all}
          </span>
        </div>
      ),
      rows: g.rows.map((r) => ({
        key: String(r.caseId),
        cells: (
          <>
            <Td className="pl-14">
              <Link href={`/exceptions/${r.exceptionId}`} className="font-medium text-accent hover:underline">
                <span className="sr-only">{name} </span>#{r.caseId}
              </Link>
              <div className="line-clamp-2 max-w-xl text-xs text-muted" title={r.summary}>
                {r.summary}
              </div>
            </Td>
            <CaseCells r={r} />
          </>
        ),
        card: (
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-3">
              <Link href={`/exceptions/${r.exceptionId}`} className="min-w-0 text-sm font-medium text-accent hover:underline">
                <span className="sr-only">{name} </span>#{r.caseId}
              </Link>
              <span className="shrink-0 text-sm font-semibold tabular-nums">{money(r.amountCents)}</span>
            </div>
            <p className="line-clamp-2 text-xs text-muted">{r.summary}</p>
            <CaseFacts r={r} />
          </div>
        ),
      })),
    };
  });
  // Keyed by its groups: when a filter changes which types are listed, the most urgent one opens again.
  return <QueueGroups key={views.map((v) => v.id).join(",")} groups={views} head={<TableHead />} label="Case queue, by incident type" />;
}
