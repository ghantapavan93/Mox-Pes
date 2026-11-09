import Link from "next/link";
import { Badge, Card, KV, TableWrap, Td, Th } from "@/components/ui";
import { BudgetSignalCard } from "@/components/BudgetSignalCard";
import { count, date, money } from "@/lib/format";
import { budgetSignal } from "@/lib/metrics/decision";
import { PERIODS } from "@/lib/period";
import type { ExceptionRow } from "@/lib/queries";
import { getPool } from "@/lib/server";

interface CampaignEvidence {
  campaignId: number;
  externalCampaignId: string;
  name: string;
  platform: string;
  campaignType: string | null;
  localServicesEnabled?: boolean;
  firstSpendDate?: string;
  spendSinceGapCents?: number;
  daysSinceGap?: number;
  classifiedAs?: string[] | null;
}

/**
 * Record-level evidence for a channel coverage gap: which campaign stopped, which started in
 * the same account, the stored spend records and the mapper version that classified them,
 * the leads that kept arriving, what those leads became in the CRM (customers, invoices,
 * collected revenue), and the budget decision the gap is distorting.
 */
export async function CoverageGapRecords({ exception }: { exception: ExceptionRow }) {
  const pool = getPool();
  const ev = exception.evidence as Record<string, unknown>;
  const predecessors = (ev.predecessors as CampaignEvidence[] | null) ?? [];
  const successors = (ev.successors as CampaignEvidence[] | null) ?? [];
  const branchId = exception.branchId!;

  const [spend, leads, lineage, signal, outcomes] = await Promise.all([
    pool.query(
      `select re.id, re.adapter_version, re.received_at, re.payload, s.channel_code as projected_channel
       from raw_events re
       left join ad_campaigns c on c.platform = re.payload ->> 'platform' and c.external_campaign_id = re.payload ->> 'campaignId'
       left join ad_spend_daily s on s.campaign_id = c.id and s.raw_event_id = re.id
       where re.source = 'ads' and re.payload ->> 'campaignId' = any($1::text[])
         and (re.payload ->> 'date')::date >= ($2::date - 3)
       order by re.payload ->> 'date', re.id
       limit 14`,
      [[...predecessors, ...successors].map((c) => c.externalCampaignId), ev.gapStart],
    ),
    pool.query(
      `select l.id, l.source, l.occurred_at, l.channel_code, l.attribution_evidence, l.campaign_external_id
       from v_leads l where l.id = any($1::bigint[]) order by l.occurred_at`,
      [(ev.sampleLeadIds as number[]) ?? []],
    ),
    pool.query(
      `select pc.external_campaign_id as predecessor, sc.external_campaign_id as successor, cl.effective_date, cl.recorded_by, cl.recorded_at
       from campaign_lineage cl
       join ad_campaigns pc on pc.id = cl.predecessor_campaign_id
       join ad_campaigns sc on sc.id = cl.successor_campaign_id
       where cl.predecessor_campaign_id = any($1::bigint[])`,
      [predecessors.map((p) => p.campaignId)],
    ),
    budgetSignal(pool, branchId, { from: PERIODS.oct.from, to: PERIODS.oct.to }),
    // CRM outcomes: customers credited to the gap channel since the gap, read from the same
    // attribution view every metric uses, with what the CRM invoiced and collected for them.
    pool.query<{ crm_customer_id: string; sold_at: Date; initial_status: string; lead_id: string | null; invoiced: string; collected: string }>(
      `select a.crm_customer_id, a.sold_at, a.initial_status, a.lead_id,
              coalesce((select sum(t.total_cents) from crm_tickets t where t.crm_customer_id = a.crm_customer_id), 0) as invoiced,
              coalesce(r.collected_cents, 0) as collected
       from v_acquisitions a
       left join v_customer_revenue r using (crm_customer_id)
       where a.branch_id = $1 and a.channel_code = $2 and a.sold_at >= $3::date
       order by a.sold_at, a.crm_customer_id`,
      [branchId, ev.channel, ev.gapStart],
    ),
  ]);
  const crm = outcomes.rows;
  const serviced = crm.filter((r) => r.initial_status === "completed").length;
  const invoicedCents = crm.reduce((n, r) => n + Number(r.invoiced), 0);
  const collectedCents = crm.reduce((n, r) => n + Number(r.collected), 0);

  return (
    <div className="space-y-6">
      <BudgetSignalCard signal={signal} periodLabel={PERIODS.oct.label} periodKey={PERIODS.oct.key} />

      <Card
        title="Campaign lineage"
        subtitle="As captured when the gap was detected: the campaign that stopped, and the one that started in the same ad account. Simulated migration; the Google change it imitates is real."
      >
        <TableWrap>
          <thead>
            <tr><Th>Role</Th><Th>Campaign</Th><Th>Platform · type</Th><Th>Local services</Th><Th>Spend since gap</Th><Th>Filed as (at detection)</Th></tr>
          </thead>
          <tbody>
            {predecessors.map((c) => (
              <tr key={`p${c.campaignId}`}>
                <Td className="text-xs">Stopped {date(String(ev.lastSpendDate))}</Td>
                <Td className="text-xs"><span className="font-mono">{c.externalCampaignId}</span><div className="text-muted">{c.name}</div></Td>
                <Td className="text-xs">{c.platform} · {c.campaignType ?? "not read by ads@1.0"}</Td>
                <Td className="text-xs">—</Td>
                <Td className="text-xs">—</Td>
                <Td className="text-xs"><Badge>{String(ev.channel)}</Badge></Td>
              </tr>
            ))}
            {successors.map((c) => (
              <tr key={`s${c.campaignId}`} className="bg-warn-soft">
                <Td className="text-xs">Started {date(c.firstSpendDate)}</Td>
                <Td className="text-xs"><span className="font-mono">{c.externalCampaignId}</span><div className="text-muted">{c.name}</div></Td>
                <Td className="text-xs">{c.platform} · {c.campaignType ?? "not read by ads@1.0"}</Td>
                <Td className="text-xs">{c.localServicesEnabled ? "true" : "not read by ads@1.0"}</Td>
                <Td className="text-xs tabular-nums">{money(c.spendSinceGapCents ?? 0)} · {count(c.daysSinceGap ?? 0)} days</Td>
                <Td className="text-xs">{(c.classifiedAs ?? []).map((ch) => <Badge key={ch} tone="bad">{ch}</Badge>)}</Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
        {lineage.rows.map((l) => (
          <p key={l.predecessor} className="mt-3 rounded bg-good-soft p-2 text-sm text-good">
            Lineage recorded: {l.predecessor} → {l.successor} from {date(l.effective_date)}, by {l.recorded_by}.
          </p>
        ))}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Stored spend records around the gap" subtitle="Raw log rows, as the platform sent them, with the mapper version that classified each">
          <TableWrap>
            <thead><tr><Th>Raw event</Th><Th>Date · campaign</Th><Th>Type</Th><Th align="right">Cost</Th><Th>Classified</Th></tr></thead>
            <tbody>
              {spend.rows.map((r) => (
                <tr key={r.id}>
                  <Td className="font-mono text-xs">#{r.id}<div className="text-faint">{r.adapter_version}</div></Td>
                  <Td className="text-xs">{r.payload.date}<div className="font-mono text-muted">{r.payload.campaignId}</div></Td>
                  <Td className="text-xs">{r.payload.campaignType ?? "—"}{r.payload.localServicesEnabled ? " · LSA" : ""}</Td>
                  <Td align="right" className="text-xs tabular-nums">{money(Math.round(Number(r.payload.costMicros) / 10_000))}</Td>
                  <Td className="text-xs">{r.projected_channel ? <Badge tone={r.projected_channel === ev.channel ? "good" : "bad"}>{r.projected_channel}</Badge> : <span className="text-faint">superseded version</span>}</Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </Card>
        <Card title={`${String(ev.channelLabel)} leads after the gap (sample)`} subtitle={`${count(Number(ev.leadsSinceGap))} leads in total: the channel did not stop, its spend moved`}>
          <TableWrap>
            <thead><tr><Th>Lead</Th><Th>When</Th><Th>Channel · evidence</Th><Th>Campaign on the lead</Th></tr></thead>
            <tbody>
              {leads.rows.map((l) => (
                <tr key={l.id}>
                  <Td className="text-xs">{l.source} #{l.id}</Td>
                  <Td className="text-xs">{date(l.occurred_at)}</Td>
                  <Td className="text-xs">{l.channel_code} · {l.attribution_evidence}</Td>
                  <Td className="font-mono text-xs">{l.campaign_external_id ?? "—"}</Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </Card>
      </div>

      <Card
        title={`CRM outcomes since ${date(String(ev.gapStart))}`}
        subtitle={`Customers the CRM shows as acquired at ${branchId} and credited to ${String(ev.channelLabel)} by first evidenced touch. They keep arriving while the channel's recorded spend is zero, which is what makes its cost per customer look cheap.`}
      >
        <div className="grid gap-4 lg:grid-cols-3" data-testid="crm-outcomes">
          <KV
            items={[
              ["New customers", count(crm.length)],
              ["Initial service completed", count(serviced)],
              ["Invoiced", money(invoicedCents)],
              ["Collected (payments − refunds)", money(collectedCents)],
            ]}
          />
          <div className="lg:col-span-2">
            {crm.length === 0 ? (
              <p className="text-sm text-muted">No customers credited to this channel since the gap.</p>
            ) : (
              <TableWrap>
                <thead><tr><Th>Customer</Th><Th>Sold</Th><Th>Initial service</Th><Th align="right">Invoiced</Th><Th align="right">Collected</Th></tr></thead>
                <tbody>
                  {crm.slice(0, 8).map((r) => (
                    <tr key={r.crm_customer_id}>
                      <Td className="text-xs">
                        <Link href={`/customers/${r.crm_customer_id}`} className="text-accent hover:underline">#{r.crm_customer_id}</Link>
                        {r.lead_id && <div className="text-faint">lead #{r.lead_id}</div>}
                      </Td>
                      <Td className="text-xs">{date(r.sold_at)}</Td>
                      <Td className="text-xs"><Badge tone={r.initial_status === "completed" ? "good" : "neutral"}>{r.initial_status}</Badge></Td>
                      <Td align="right" className="text-xs tabular-nums">{money(Number(r.invoiced))}</Td>
                      <Td align="right" className="text-xs tabular-nums">{money(Number(r.collected))}</Td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
            )}
            {crm.length > 8 && <p className="mt-2 text-xs text-faint">Showing 8 of {count(crm.length)}; open a customer for the full journey.</p>}
          </div>
        </div>
      </Card>
    </div>
  );
}
