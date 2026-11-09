import { Suspense } from "react";
import { Badge, Card, PeriodTabs, Skeleton, TableWrap, Td, Th } from "@/components/ui";
import { DECISION_LABEL, feedbackRows, feedbackSummary, toDataManagerEvent, type FeedbackDecision } from "@/lib/feedback";
import { count, dateTime, money } from "@/lib/format";
import { parsePeriod } from "@/lib/period";
import { businessNow, getPool, getViewer } from "@/lib/server";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const TONE: Record<FeedbackDecision, "good" | "bad" | "warn" | "neutral"> = {
  upload: "good",
  retract: "bad",
  held_channel_conflict: "warn",
  no_click_id: "neutral",
  click_too_old: "neutral",
  not_serviced: "neutral",
};

export default function FeedbackPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<Skeleton lines={8} />}>
      <Feedback searchParams={searchParams} />
    </Suspense>
  );
}

async function Feedback({ searchParams }: { searchParams: SearchParams }) {
  const period = parsePeriod((await searchParams).period);
  const viewer = await getViewer();
  const pool = getPool();
  const now = await businessNow();
  const scope = { from: period.from, to: period.to, branchIds: viewer.branchIds };
  const [summary, rows] = await Promise.all([feedbackSummary(pool, scope, now), feedbackRows(pool, scope, now, 25)]);
  const example = rows.find((r) => r.decision === "upload");

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Google Ads conversion feedback</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            Bidding learns from what you report back. This ledger decides, from reconciled CRM outcomes, which Google Search customers
            become conversions — and which must not. <strong className="text-text">Dry run: nothing is sent.</strong>
          </p>
        </div>
        <PeriodTabs current={period.key} base="/feedback" />
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {(Object.keys(DECISION_LABEL) as FeedbackDecision[]).map((d) => (
          <div key={d} className="rounded-lg border border-border bg-surface p-3">
            <div className="text-xs text-muted">{DECISION_LABEL[d]}</div>
            <div className="mt-1 text-xl font-semibold tabular-nums" data-testid={`feedback-${d}`}>{count(summary[d])}</div>
          </div>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Latest decisions" subtitle={`Google Search acquisitions sold in ${period.label}`}>
          <TableWrap>
            <thead>
              <tr><Th>Customer</Th><Th>Branch</Th><Th>Click</Th><Th>Serviced</Th><Th align="right">Plan value</Th><Th>Decision</Th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.customerId}>
                  <Td className="font-mono text-xs">#{r.customerId}</Td>
                  <Td>{r.branchId}</Td>
                  <Td className="text-xs">{r.clickId ? dateTime(r.clickAt) : <span className="text-faint">no gclid</span>}</Td>
                  <Td className="text-xs">{dateTime(r.convertedAt)}</Td>
                  <Td align="right">{money(r.valueCents)}</Td>
                  <Td><Badge tone={TONE[r.decision]}>{DECISION_LABEL[r.decision]}</Badge></Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </Card>
        <Card title="What would be sent" subtitle="One event, shaped for the Data Manager API (verify field names before use)">
          {example ? (
            <pre className="overflow-x-auto rounded bg-surface-2 p-3 text-[11px]">{JSON.stringify(toDataManagerEvent(example), null, 2)}</pre>
          ) : (
            <p className="text-sm text-muted">No uploadable conversions in scope.</p>
          )}
          <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-muted">
            <li>transactionId is derived from the lead and stage, so re-sending is an adjustment, never a second conversion.</li>
            <li>Value is booked annual plan value: a bidding signal, not revenue.</li>
            <li>Consent signals must come from the site&apos;s consent platform before anything is sent.</li>
          </ul>
        </Card>
      </div>
    </div>
  );
}
