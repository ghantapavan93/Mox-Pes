import Link from "next/link";
import { SeverityBadge, TableWrap, Td, Th } from "@/components/ui";
import { KIND_LABEL, date, money } from "@/lib/format";
import { KIND_TITLE } from "@/lib/workflow/kinds";
import type { QueueRow } from "@/lib/workflow/queries";
import { CaseStateBadge, ProposalStatusBadge, SourceBadge } from "./badges";

/** The Action Center queue: one row per case, linked to its exception page. */
export function CaseQueue({ rows, empty }: { rows: QueueRow[]; empty: string }) {
  if (rows.length === 0) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <TableWrap>
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
              <div className="text-xs text-muted">{r.summary}</div>
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
  );
}
