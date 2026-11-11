import Link from "next/link";
import { EmptyState, SeverityBadge, TableWrap, Td, Th } from "@/components/ui";
import { KIND_LABEL, date, money } from "@/lib/format";
import { KIND_TITLE } from "@/lib/workflow/kinds";
import type { QueueRow } from "@/lib/workflow/queries";
import { CaseStateBadge, ProposalStatusBadge, SourceBadge } from "./badges";

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
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <SeverityBadge severity={r.severity} />
              <CaseStateBadge state={r.state} />
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
          </li>
        ))}
      </ul>
      <div className="hidden md:block">
        <TableWrap label="Case queue" flush={flush} minWidth={880}>
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
                <Td>{r.branchId ?? <span className="text-faint">company</span>}</Td>
                <Td>
                  <SeverityBadge severity={r.severity} />
                </Td>
                <Td>
                  <CaseStateBadge state={r.state} />
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
              </tr>
            ))}
          </tbody>
        </TableWrap>
      </div>
    </>
  );
}
