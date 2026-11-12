import Link from "next/link";
import { KIND_LABEL, date, money } from "@/lib/format";
import type { ExceptionRow } from "@/lib/queries";
import { SeverityBadge, StatusBadge, TableWrap, Td, Th } from "./ui";

export function ExceptionTable({ rows, empty = "No exceptions in scope." }: { rows: ExceptionRow[]; empty?: string }) {
  if (rows.length === 0) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <TableWrap label="Open exceptions">
      <thead>
        <tr>
          <Th>Exception</Th>
          <Th>Branch</Th>
          <Th>Severity</Th>
          <Th>Status</Th>
          {/* Spend for a coverage gap or unmapped spend, revenue for the rest: each row says which
              (UX red team 2026-11-12: "Revenue at stake" showed $2,124 of spend). */}
          <Th align="right">At stake</Th>
          <Th align="right">Detected</Th>
        </tr>
      </thead>
      <tbody data-testid="exception-table">
        {rows.map((e) => (
          <tr key={e.id}>
            <Td>
              <Link href={`/exceptions/${e.id}`} className="font-medium text-accent hover:underline">
                {KIND_LABEL[e.kind] ?? e.kind}
              </Link>
              <div className="text-xs text-muted">{e.summary}</div>
            </Td>
            <Td>{e.branchId ?? <span className="text-faint">company</span>}</Td>
            <Td><SeverityBadge severity={e.severity} /></Td>
            <Td><StatusBadge status={e.status} /></Td>
            <Td align="right">
              {money(e.amountCents)}
              <div className="text-[11px] text-faint">{e.kind === "channel_coverage_gap" || e.kind === "unmapped_spend" ? "spend" : "revenue"}</div>
            </Td>
            <Td align="right">{date(e.firstDetectedAt)}</Td>
          </tr>
        ))}
      </tbody>
    </TableWrap>
  );
}
