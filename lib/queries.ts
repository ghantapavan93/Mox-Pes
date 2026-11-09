import type { Queryable } from "@/lib/db";
import { PERIODS } from "@/lib/period";

/** Read models for the investigation screens. Branch scope is always applied in SQL. */

export interface ExceptionRow {
  id: number;
  kind: string;
  severity: "high" | "medium" | "low";
  branchId: string | null;
  subjectType: string;
  subjectId: string;
  summary: string;
  evidence: Record<string, unknown>;
  amountCents: number;
  status: "open" | "resolved" | "acknowledged";
  resolution: string | null;
  firstDetectedAt: Date;
  lastDetectedAt: Date;
  resolvedAt: Date | null;
}

const toException = (r: Record<string, unknown>): ExceptionRow => ({
  id: Number(r.id),
  kind: r.kind as string,
  severity: r.severity as ExceptionRow["severity"],
  branchId: (r.branch_id as string) ?? null,
  subjectType: r.subject_type as string,
  subjectId: r.subject_id as string,
  summary: r.summary as string,
  evidence: r.evidence as Record<string, unknown>,
  amountCents: Number(r.amount_cents),
  status: r.status as ExceptionRow["status"],
  resolution: (r.resolution as string) ?? null,
  firstDetectedAt: r.first_detected_at as Date,
  lastDetectedAt: r.last_detected_at as Date,
  resolvedAt: (r.resolved_at as Date) ?? null,
});

export async function listExceptions(
  db: Queryable,
  f: { branchIds: string[] | null; status?: "open" | "resolved" | "acknowledged"; kind?: string; limit?: number },
): Promise<ExceptionRow[]> {
  const { rows } = await db.query(
    `select * from exceptions
     where ($1::text[] is null or branch_id = any($1::text[]))
       and ($2::text is null or status = $2) and ($3::text is null or kind = $3)
     order by (status = 'open') desc, case severity when 'high' then 0 when 'medium' then 1 else 2 end,
              amount_cents desc, id
     limit $4`,
    [f.branchIds, f.status ?? null, f.kind ?? null, f.limit ?? 200],
  );
  return rows.map(toException);
}

export async function exceptionSummary(db: Queryable, branchIds: string[] | null) {
  const { rows } = await db.query(
    `select kind, count(*) filter (where status = 'open') as open, count(*) filter (where status = 'resolved') as resolved,
            coalesce(sum(amount_cents) filter (where status = 'open'), 0) as amount
     from exceptions where ($1::text[] is null or branch_id = any($1::text[]))
     group by kind order by amount desc`,
    [branchIds],
  );
  return rows.map((r) => ({ kind: r.kind as string, open: Number(r.open), resolved: Number(r.resolved), amountCents: Number(r.amount) }));
}

export async function getException(db: Queryable, id: number): Promise<ExceptionRow | null> {
  const { rows } = await db.query("select * from exceptions where id = $1", [id]);
  return rows[0] ? toException(rows[0]) : null;
}

export interface WeekPoint {
  weekStart: string;
  spendCents: number;
  acquired: number;
  paidAcquired: number;
  unknownAcquired: number;
}

/** Weekly series for one branch (or all in scope), Monday-start weeks. */
export async function weeklySeries(db: Queryable, branchIds: string[] | null): Promise<WeekPoint[]> {
  const { rows } = await db.query(
    `with weeks as (
       select generate_series(date_trunc('week', $2::timestamptz at time zone 'UTC')::date,
                              ($3::timestamptz at time zone 'UTC')::date - 1, interval '7 days')::date as w),
     spend as (
       select date_trunc('week', s.spend_date)::date as w, sum(s.cost_cents) as cost
       from ad_spend_daily s join campaign_branch_map m on m.campaign_id = s.campaign_id
       where $1::text[] is null or m.branch_id = any($1::text[]) group by 1),
     acq as (
       select date_trunc('week', a.initial_completed_at at time zone 'UTC')::date as w, count(*) as acquired,
              count(*) filter (where ch.is_paid) as paid, count(*) filter (where a.channel_code = 'unknown') as unknown
       from v_acquisitions a join channels ch on ch.code = a.channel_code
       where a.initial_status = 'completed' and ($1::text[] is null or a.branch_id = any($1::text[]))
       group by 1)
     select weeks.w, spend.cost, acq.acquired, acq.paid, acq.unknown
     from weeks left join spend on spend.w = weeks.w left join acq on acq.w = weeks.w order by weeks.w`,
    [branchIds, PERIODS.all.from, PERIODS.all.to],
  );
  return rows.map((r) => ({
    weekStart: (r.w as Date).toISOString().slice(0, 10),
    spendCents: Number(r.cost ?? 0),
    acquired: Number(r.acquired ?? 0),
    paidAcquired: Number(r.paid ?? 0),
    unknownAcquired: Number(r.unknown ?? 0),
  }));
}

export async function recentRuns(db: Queryable, limit = 40) {
  const { rows } = await db.query(
    `select id, stream, adapter_version, window_start, window_end, started_at, status, fetched, inserted, duplicates,
            conflicts, projected, quarantined, error
     from ingestion_runs order by started_at desc, id desc limit $1`,
    [limit],
  );
  return rows;
}

export async function failedRunsWithRecovery(db: Queryable) {
  const { rows } = await db.query(
    `select f.id, f.stream, f.started_at, f.error,
            (select r.id from ingestion_runs r where r.stream = f.stream and r.status = 'succeeded' and r.started_at > f.started_at
             order by r.started_at limit 1) as recovered_by,
            (select r.window_start from ingestion_runs r where r.stream = f.stream and r.status = 'succeeded' and r.started_at > f.started_at
             order by r.started_at limit 1) as recovery_window_start
     from ingestion_runs f where f.status = 'failed' order by f.started_at desc`,
  );
  return rows;
}

export async function streamTotals(db: Queryable) {
  const { rows } = await db.query(
    `select source, count(*) as events, sum(delivery_count) as deliveries,
            count(*) filter (where status = 'quarantined') as quarantined, max(received_at) as last_received
     from raw_events group by source order by source`,
  );
  return rows;
}

export async function replayHistory(db: Queryable) {
  const { rows } = await db.query("select * from replays order by requested_at desc, id desc limit 20");
  return rows;
}

export async function lastReplayForException(db: Queryable, exceptionId: number) {
  const { rows } = await db.query(
    "select * from replays where exception_id = $1 and projected > 0 order by requested_at desc, id desc limit 1",
    [exceptionId],
  );
  return rows[0] ?? null;
}

export async function auditTrail(db: Queryable, limit = 30) {
  const { rows } = await db.query("select * from audit_log order by at desc, id desc limit $1", [limit]);
  return rows;
}

/** Records behind a quarantine group, plus the CRM customers each would re-attach to. */
export async function quarantineSamples(db: Queryable, rawEventIds: number[]) {
  const { rows } = await db.query(
    `select re.id, re.entity, re.entity_id, re.occurred_at, re.received_at, re.adapter_version, re.error_code,
            re.error_detail, re.delivery_count, re.payload,
            (select json_agg(json_build_object('customerId', a.crm_customer_id, 'soldAt', a.sold_at,
                     'basis', a.attribution_basis, 'channel', a.channel_code))
               from crm_customers c join v_acquisitions a on a.crm_customer_id = c.crm_customer_id
               where c.phone_hash = any(
                 select substr(v #>> '{}', 9)
                 from jsonb_path_query(re.payload, 'strict $.** ? (@.type() == "string" && @ starts with "h:phone:")') v)
            ) as customers
     from raw_events re where re.id = any($1::bigint[]) order by re.occurred_at`,
    [rawEventIds],
  );
  return rows;
}

/** Everything known about one acquisition: the customer, their leads, their money. */
export async function acquisitionTrail(db: Queryable, customerId: number) {
  const acquisition = await db.query("select * from v_acquisitions where crm_customer_id = $1", [customerId]);
  const customer = await db.query("select * from crm_customers where crm_customer_id = $1", [customerId]);
  const c = customer.rows[0];
  const leads = c
    ? await db.query(
        `select l.id, l.source, l.source_lead_id, l.branch_id, l.effective_branch_id, l.branch_overridden, l.channel_code,
                l.attribution_evidence, l.campaign_external_id, l.occurred_at, l.raw_event_id
         from v_leads l where (l.phone_hash = $1 or l.email_hash = $2) order by l.occurred_at`,
        [c.phone_hash, c.email_hash],
      )
    : { rows: [] };
  const money = await db.query(
    `select 'appointment' as kind, a.crm_appointment_id::text as id, a.status as detail, coalesce(a.completed_at, a.scheduled_for) as at, null::bigint as cents
       from crm_appointments a where a.crm_customer_id = $1
     union all
     select 'ticket', t.crm_ticket_id::text, t.template_type, t.invoiced_at, t.total_cents from crm_tickets t where t.crm_customer_id = $1
     union all
     select 'payment', p.crm_payment_id::text, p.status, p.paid_at, p.amount_cents from crm_payments p where p.crm_customer_id = $1
     order by at`,
    [customerId],
  );
  return { acquisition: acquisition.rows[0] ?? null, customer: c ?? null, leads: leads.rows, events: money.rows };
}
