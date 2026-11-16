import { Suspense } from "react";
import { Badge, Card, EmptyState, PageHeader, PeriodTabs, Skeleton, TableWrap, Td, Th } from "@/components/ui";
import { DECISION_LABEL, feedbackRows, feedbackSummary, toDataManagerEvent, type FeedbackDecision } from "@/lib/feedback";
import { count, dateTime, money } from "@/lib/format";
import { parsePeriod } from "@/lib/period";
import { businessNow, getPool, getViewer } from "@/lib/server";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const TONE: Record<FeedbackDecision, "good" | "bad" | "warn" | "neutral"> = {
  upload: "good",
  suppress_cancelled: "bad",
  held_channel_conflict: "warn",
  no_click_id: "neutral",
  click_too_old: "neutral",
  not_serviced: "neutral",
};

/** The six decisions, grouped by what happens to the customer: sent, deliberately withheld, or not eligible. */
const GROUPS: Array<{ title: string; note: string; decisions: FeedbackDecision[] }> = [
  { title: "Would be sent", note: "Serviced Google Search customers with a click id inside the window", decisions: ["upload"] },
  { title: "Withheld on purpose", note: "Sending these would teach bidding the wrong lesson", decisions: ["suppress_cancelled", "held_channel_conflict"] },
  { title: "Not eligible yet, or not matchable", note: "No click id, a stale click, or no completed service", decisions: ["no_click_id", "click_too_old", "not_serviced"] },
];

const VALUE_TONE = { good: "text-good", bad: "text-bad", warn: "text-warn", neutral: "text-text" } as const;

export const metadata = { title: "Feedback" };

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

  const total = (Object.keys(DECISION_LABEL) as FeedbackDecision[]).reduce((n, d) => n + summary[d], 0);
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={`Understand · ${viewer.branchIds ? viewer.branchIds.join(", ") : "All 44 branches"} · ${period.label}`}
        title="Google Ads conversion feedback"
        badges={<Badge tone="accent">Dry run · nothing is sent</Badge>}
        description={
          <p className="max-w-3xl">
            Bidding learns from what you report back. This ledger decides, from reconciled CRM outcomes, which Google Search customers become conversions,
            and which must not. <strong className="text-text">Dry run: nothing is sent.</strong>
          </p>
        }
        toolbar={<PeriodTabs current={period.key} base="/feedback" />}
      />

      <section aria-label="Decisions" className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_minmax(0,3fr)]" data-testid="feedback-groups">
        {GROUPS.map((g) => (
          <div key={g.title} className="rounded-xl bg-surface p-4 ring-1 ring-text/10">
            <h2 className="text-[13px] font-semibold text-text">{g.title}</h2>
            <p className="mt-0.5 text-xs text-muted">{g.note}</p>
            <dl className={`mt-3 grid gap-3 ${g.decisions.length === 1 ? "" : g.decisions.length === 2 ? "sm:grid-cols-2" : "sm:grid-cols-3"}`}>
              {g.decisions.map((d) => (
                <div key={d}>
                  <dt className="text-xs leading-4 text-muted">{DECISION_LABEL[d]}</dt>
                  <dd className={`mt-1 text-[22px] font-semibold leading-7 tabular-nums ${summary[d] > 0 ? VALUE_TONE[TONE[d]] : "text-text"}`} data-testid={`feedback-${d}`}>
                    {count(summary[d])}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </section>
      <p className="-mt-3 text-xs text-muted">{count(total)} Google Search acquisitions sold in {period.label} in your scope.</p>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2" title="Latest decisions" subtitle={`The 25 most recent Google Search acquisitions sold in ${period.label}`} flush>
          {rows.length === 0 ? (
            <div className="p-4">
              <EmptyState title="No Google Search acquisitions in scope for this period." />
            </div>
          ) : (
            <TableWrap label="Latest feedback decisions" flush minWidth={720}>
              <thead>
                <tr><Th>Customer</Th><Th>Branch</Th><Th>Lead</Th><Th>Serviced</Th><Th align="right">Plan value</Th><Th>Decision</Th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.customerId}>
                    <Td className="font-mono text-xs">#{r.customerId}</Td>
                    <Td>{r.branchId}</Td>
                    <Td className="whitespace-nowrap text-xs">{r.clickId ? dateTime(r.clickAt) : <span className="text-muted">no gclid</span>}</Td>
                    <Td className="whitespace-nowrap text-xs">{dateTime(r.convertedAt)}</Td>
                    <Td align="right">{money(r.valueCents)}</Td>
                    <Td><Badge tone={TONE[r.decision]}>{DECISION_LABEL[r.decision]}</Badge></Td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Card>
        <Card title="What would be sent" subtitle="One event, shaped for the Data Manager API (verify field names before use)">
          {example ? (
            <pre role="region" aria-label="Event that would be sent" tabIndex={0} className="overflow-x-auto rounded-md bg-surface-2 p-3 font-mono text-[11px] leading-4">{JSON.stringify(toDataManagerEvent(example), null, 2)}</pre>
          ) : (
            <p className="text-sm text-muted">No uploadable conversions in scope.</p>
          )}
          <h3 className="mt-4 text-xs font-semibold text-text">Rules and limits</h3>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-xs text-muted">
            <li>transactionId is derived from the lead and stage, so re-sending is an adjustment, never a second conversion.</li>
            <li>Value is booked annual plan value: a bidding signal, not revenue.</li>
            <li>A cancelled plan is never sent: Google&apos;s Data Manager API cannot retract a conversion, only restate its value.</li>
            <li>Rows without a gclid could still match on hashed email or phone (enhanced conversions for leads); that path is not built.</li>
            <li>Click age is measured from the lead time, which is at or after the click; the real limit is the conversion action&apos;s click-through window.</li>
            <li>No consent fields are sent. Google requires them for EEA users only; a real uploader should pass them explicitly.</li>
          </ul>
        </Card>
      </div>
    </div>
  );
}
