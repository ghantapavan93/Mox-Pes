import type { Queryable } from "@/lib/db";
import type { Projection } from "@/lib/adapters/contract";
import { activeCurrencyRules, covered, CURRENCY_UNSTATED, lockCurrencyShared } from "@/lib/currency/coverage";

/**
 * Set-based projection: one statement per target table per batch.
 *
 * Every upsert is guarded by the source clock: a version only overwrites the stored
 * row if it is at least as new (`excluded.source_updated_at >= t.source_updated_at`).
 * That makes projection order-independent — an older version delivered late is a no-op.
 */

export interface ProjectionItem {
  projection: Projection;
  rawEventId: number;
}

type Table = Projection["table"];

/** Natural key per table, used to keep only the newest version of an entity within one batch. */
const KEY: Record<Table, (row: Record<string, unknown>) => string> = {
  leads: (r) => `${r.source}:${r.sourceLeadId}`,
  crm_customers: (r) => String(r.crmCustomerId),
  crm_subscriptions: (r) => String(r.crmSubscriptionId),
  crm_appointments: (r) => String(r.crmAppointmentId),
  crm_tickets: (r) => String(r.crmTicketId),
  crm_payments: (r) => String(r.crmPaymentId),
  ad_spend_daily: (r) => `${r.platform}:${r.externalCampaignId}:${r.spendDate}`,
};

const SQL: Record<Table, string> = {
  leads: `
    insert into leads as t (source, source_lead_id, branch_id, channel_code, attribution_evidence, campaign_external_id,
      click_id, phone_hash, email_hash, zip, heard_about_text, occurred_at, source_updated_at, raw_event_id)
    select r."source", r."sourceLeadId", r."branchId", r."channelCode", r."attributionEvidence",
      r."campaignExternalId",
      r."clickId", r."phoneHash", r."emailHash", r."zip", r."heardAboutText", r."occurredAt", r."sourceUpdatedAt", r."rawEventId"
    from jsonb_to_recordset($1::jsonb) as r("source" text, "sourceLeadId" text, "branchId" text, "channelCode" text,
      "attributionEvidence" text, "campaignExternalId" text, "clickId" text, "phoneHash" text, "emailHash" text,
      "zip" text, "heardAboutText" text, "occurredAt" timestamptz, "sourceUpdatedAt" timestamptz, "rawEventId" bigint)
    on conflict (source, source_lead_id) do update set
      branch_id = excluded.branch_id, channel_code = excluded.channel_code,
      attribution_evidence = excluded.attribution_evidence, campaign_external_id = excluded.campaign_external_id,
      click_id = excluded.click_id, phone_hash = excluded.phone_hash, email_hash = excluded.email_hash,
      zip = excluded.zip, heard_about_text = excluded.heard_about_text, occurred_at = excluded.occurred_at,
      source_updated_at = excluded.source_updated_at, raw_event_id = excluded.raw_event_id,
      -- A newer qualifying version restores a lead an earlier revision excluded (migration 0018).
      excluded_code = null, excluded_at = null
    -- The same raw event re-read as a lead restores the lead it excluded: a re-projection back
    -- to a mapper that counts it (a rollback of calls@1.2, lib/ingest/replay.ts). The live version
    -- delivered again moves the lead's clock to that later observation, so a held or excluded
    -- version observed in between cannot later beat it (independent review 2026-11-12, data 2).
    where excluded.source_updated_at >= t.source_updated_at
      and (excluded.raw_event_id <> t.raw_event_id or t.excluded_code is not null or excluded.source_updated_at > t.source_updated_at)`,

  crm_customers: `
    insert into crm_customers as t (crm_customer_id, office_id, source_label, phone_hash, email_hash, zip,
      created_at_source, source_updated_at, raw_event_id)
    select r."crmCustomerId", r."officeId", r."sourceLabel", r."phoneHash", r."emailHash", r."zip",
      r."createdAtSource", r."sourceUpdatedAt", r."rawEventId"
    from jsonb_to_recordset($1::jsonb) as r("crmCustomerId" bigint, "officeId" int, "sourceLabel" text,
      "phoneHash" text, "emailHash" text, "zip" text, "createdAtSource" timestamptz, "sourceUpdatedAt" timestamptz,
      "rawEventId" bigint)
    on conflict (crm_customer_id) do update set
      office_id = excluded.office_id, source_label = excluded.source_label, phone_hash = excluded.phone_hash,
      email_hash = excluded.email_hash, zip = excluded.zip, created_at_source = excluded.created_at_source,
      source_updated_at = excluded.source_updated_at, raw_event_id = excluded.raw_event_id
    where excluded.source_updated_at >= t.source_updated_at and excluded.raw_event_id <> t.raw_event_id`,

  crm_subscriptions: `
    insert into crm_subscriptions as t (crm_subscription_id, crm_customer_id, office_id, service_type, sold_by_rep,
      source_label, annual_value_cents, status, sold_at, cancelled_at, source_updated_at, raw_event_id)
    select r."crmSubscriptionId", r."crmCustomerId", r."officeId", r."serviceType", r."soldByRep", r."sourceLabel",
      r."annualValueCents", r."status", r."soldAt", r."cancelledAt", r."sourceUpdatedAt", r."rawEventId"
    from jsonb_to_recordset($1::jsonb) as r("crmSubscriptionId" bigint, "crmCustomerId" bigint, "officeId" int,
      "serviceType" text, "soldByRep" text, "sourceLabel" text, "annualValueCents" bigint, "status" text,
      "soldAt" timestamptz, "cancelledAt" timestamptz, "sourceUpdatedAt" timestamptz, "rawEventId" bigint)
    on conflict (crm_subscription_id) do update set
      crm_customer_id = excluded.crm_customer_id, office_id = excluded.office_id, service_type = excluded.service_type,
      sold_by_rep = excluded.sold_by_rep, source_label = excluded.source_label,
      annual_value_cents = excluded.annual_value_cents, status = excluded.status, sold_at = excluded.sold_at,
      cancelled_at = excluded.cancelled_at, source_updated_at = excluded.source_updated_at,
      raw_event_id = excluded.raw_event_id
    where excluded.source_updated_at >= t.source_updated_at and excluded.raw_event_id <> t.raw_event_id`,

  crm_appointments: `
    insert into crm_appointments as t (crm_appointment_id, crm_subscription_id, crm_customer_id, office_id, kind,
      status, scheduled_for, completed_at, source_updated_at, raw_event_id)
    select r."crmAppointmentId", r."crmSubscriptionId", r."crmCustomerId", r."officeId", r."kind", r."status",
      r."scheduledFor", r."completedAt", r."sourceUpdatedAt", r."rawEventId"
    from jsonb_to_recordset($1::jsonb) as r("crmAppointmentId" bigint, "crmSubscriptionId" bigint,
      "crmCustomerId" bigint, "officeId" int, "kind" text, "status" text, "scheduledFor" timestamptz,
      "completedAt" timestamptz, "sourceUpdatedAt" timestamptz, "rawEventId" bigint)
    on conflict (crm_appointment_id) do update set
      crm_subscription_id = excluded.crm_subscription_id, crm_customer_id = excluded.crm_customer_id,
      office_id = excluded.office_id, kind = excluded.kind, status = excluded.status,
      scheduled_for = excluded.scheduled_for, completed_at = excluded.completed_at,
      source_updated_at = excluded.source_updated_at, raw_event_id = excluded.raw_event_id
    where excluded.source_updated_at >= t.source_updated_at and excluded.raw_event_id <> t.raw_event_id`,

  crm_tickets: `
    insert into crm_tickets as t (crm_ticket_id, crm_appointment_id, crm_customer_id, office_id, template_type,
      total_cents, invoiced_at, source_updated_at, raw_event_id)
    select r."crmTicketId", r."crmAppointmentId", r."crmCustomerId", r."officeId", r."templateType",
      r."totalCents", r."invoicedAt", r."sourceUpdatedAt", r."rawEventId"
    from jsonb_to_recordset($1::jsonb) as r("crmTicketId" bigint, "crmAppointmentId" bigint, "crmCustomerId" bigint,
      "officeId" int, "templateType" text, "totalCents" bigint, "invoicedAt" timestamptz,
      "sourceUpdatedAt" timestamptz, "rawEventId" bigint)
    on conflict (crm_ticket_id) do update set
      crm_appointment_id = excluded.crm_appointment_id, crm_customer_id = excluded.crm_customer_id,
      office_id = excluded.office_id, template_type = excluded.template_type, total_cents = excluded.total_cents,
      invoiced_at = excluded.invoiced_at, source_updated_at = excluded.source_updated_at,
      raw_event_id = excluded.raw_event_id
    where excluded.source_updated_at >= t.source_updated_at and excluded.raw_event_id <> t.raw_event_id`,

  crm_payments: `
    insert into crm_payments as t (crm_payment_id, crm_ticket_id, crm_customer_id, office_id, amount_cents,
      original_payment_id, status, paid_at, source_updated_at, raw_event_id)
    select r."crmPaymentId", r."crmTicketId", r."crmCustomerId", r."officeId", r."amountCents",
      r."originalPaymentId", r."status", r."paidAt", r."sourceUpdatedAt", r."rawEventId"
    from jsonb_to_recordset($1::jsonb) as r("crmPaymentId" bigint, "crmTicketId" bigint, "crmCustomerId" bigint,
      "officeId" int, "amountCents" bigint, "originalPaymentId" bigint, "status" text, "paidAt" timestamptz,
      "sourceUpdatedAt" timestamptz, "rawEventId" bigint)
    on conflict (crm_payment_id) do update set
      crm_ticket_id = excluded.crm_ticket_id, crm_customer_id = excluded.crm_customer_id,
      office_id = excluded.office_id, amount_cents = excluded.amount_cents,
      original_payment_id = excluded.original_payment_id, status = excluded.status, paid_at = excluded.paid_at,
      source_updated_at = excluded.source_updated_at, raw_event_id = excluded.raw_event_id
    where excluded.source_updated_at >= t.source_updated_at and excluded.raw_event_id <> t.raw_event_id`,

  // A spend record carries its own channel classification. The same raw record may be
  // re-projected by a newer mapper version (a replay); that rewrites its classification only,
  // never its money, and never duplicates the row.
  ad_spend_daily: `
    with rows as (
      select * from jsonb_to_recordset($1::jsonb) as r("platform" text, "adAccountId" text,
        "externalCampaignId" text, "campaignName" text, "campaignType" text, "localServicesEnabled" boolean,
        "channelCode" text, "spendDate" date, "costCents" bigint, "currencyBasis" text, "clicks" int, "platformConversions" int,
        "sourceUpdatedAt" timestamptz, "rawEventId" bigint)
    ), campaigns as (
      insert into ad_campaigns (platform, ad_account_id, external_campaign_id, name, channel_code, first_seen_at,
        campaign_type, local_services_enabled)
      select distinct on (r."platform", r."externalCampaignId")
        r."platform", r."adAccountId", r."externalCampaignId", r."campaignName", r."channelCode", r."sourceUpdatedAt",
        r."campaignType", r."localServicesEnabled"
      from rows r
      order by r."platform", r."externalCampaignId", r."sourceUpdatedAt" desc
      on conflict (platform, external_campaign_id) do update set name = excluded.name,
        channel_code = excluded.channel_code,
        campaign_type = coalesce(excluded.campaign_type, ad_campaigns.campaign_type),
        local_services_enabled = excluded.local_services_enabled or ad_campaigns.local_services_enabled
      returning id, platform, external_campaign_id
    )
    insert into ad_spend_daily as t (campaign_id, spend_date, cost_cents, clicks, platform_conversions,
      source_updated_at, raw_event_id, channel_code, currency_basis)
    select c.id, r."spendDate", r."costCents", r."clicks", r."platformConversions", r."sourceUpdatedAt", r."rawEventId",
      -- Set by the currency gate: reported_usd or account_rule_usd, never a default.
      r."channelCode", r."currencyBasis"
    from rows r
    join campaigns c on c.platform = r."platform" and c.external_campaign_id = r."externalCampaignId"
    on conflict (campaign_id, spend_date) do update set
      cost_cents = excluded.cost_cents, currency_basis = excluded.currency_basis, clicks = excluded.clicks,
      platform_conversions = excluded.platform_conversions, source_updated_at = excluded.source_updated_at,
      raw_event_id = excluded.raw_event_id, channel_code = excluded.channel_code
    where (excluded.source_updated_at >= t.source_updated_at and excluded.raw_event_id <> t.raw_event_id)
       or (excluded.raw_event_id = t.raw_event_id and (excluded.channel_code is distinct from t.channel_code
                                                       or excluded.currency_basis is distinct from t.currency_basis))`,
};

/**
 * The currency gate (lib/currency/rules.ts). A spend row whose feed stated no currency counts as
 * dollars only under an authorized account rule: then it is stored as account_rule_usd. Without
 * one it is NOT projected: its raw event is marked excluded (CURRENCY_UNSTATED), visible wherever
 * held records are, and a projected older version of the same campaign-day leaves the metrics too
 * (the newest observation decides). Every path that projects (intake, replay, re-projection after
 * a rule) goes through here, so none can count unstated money as USD.
 */
async function currencyGate(db: Queryable, items: ProjectionItem[]): Promise<{ kept: ProjectionItem[]; held: number[] }> {
  const isSpend = (i: ProjectionItem) => i.projection.table === "ad_spend_daily";
  const unstated = (i: ProjectionItem) => i.projection.table === "ad_spend_daily" && i.projection.row.currencyBasis !== "reported_usd" && i.projection.row.currencyBasis !== "account_rule_usd";
  if (!items.some(isSpend)) return { kept: items, held: [] };
  // Held until this transaction ends, so a rule cannot be revoked or authorized between this read
  // and the commit of what it decided (lib/currency/coverage.ts).
  await lockCurrencyShared(db);
  const rules = items.some(unstated) ? await activeCurrencyRules(db) : new Set<string>();
  const held: Array<{ rawEventId: number; platform: string; externalCampaignId: string; spendDate: string; sourceUpdatedAt: string; adAccountId: string }> = [];
  const heldRows: Array<Record<string, unknown>> = [];
  const kept: ProjectionItem[] = [];
  for (const item of items) {
    if (!unstated(item) || item.projection.table !== "ad_spend_daily") {
      kept.push(item);
      continue;
    }
    const row = item.projection.row;
    if (covered(rules, row.platform, row.adAccountId)) {
      kept.push({ ...item, projection: { ...item.projection, row: { ...row, currencyBasis: "account_rule_usd" } } });
    } else {
      held.push({ rawEventId: item.rawEventId, platform: row.platform, externalCampaignId: row.externalCampaignId, spendDate: row.spendDate, sourceUpdatedAt: row.sourceUpdatedAt.toISOString(), adAccountId: row.adAccountId });
      heldRows.push(row as unknown as Record<string, unknown>);
    }
  }
  // The newest observation decides: a spend version older than a held one is not counted, whether
  // the held one is in this batch or stored (a late delivery, a replay keeping its receipt time).
  const keyOf = (p: string, c: string, d: string) => `${p}:${c}:${d}`;
  const newestHeld = new Map<string, number>();
  for (const h of held) newestHeld.set(keyOf(h.platform, h.externalCampaignId, h.spendDate), Math.max(newestHeld.get(keyOf(h.platform, h.externalCampaignId, h.spendDate)) ?? 0, Date.parse(h.sourceUpdatedAt)));
  const keptSpend = kept.filter(isSpend);
  if (keptSpend.length > 0) {
    const stored = await db.query<{ platform: string; ext: string; day: string; fetched: Date }>(
      `select r."platform" as platform, r."externalCampaignId" as ext, r."spendDate"::text as day, max((re.payload ->> 'fetchedAt')::timestamptz) as fetched
       from jsonb_to_recordset($1::jsonb) as r("platform" text, "externalCampaignId" text, "spendDate" date)
       join raw_events re on re.source = 'ads' and re.status = 'excluded' and re.exclusion_code = $2
        and re.payload ->> 'platform' = r."platform" and re.payload ->> 'campaignId' = r."externalCampaignId" and re.payload ->> 'date' = r."spendDate"::text
        -- Not the batch's own records: a held record re-projected under a new rule is still
        -- marked excluded until its caller stamps it, and must not hold itself back.
        and re.id <> all($3::bigint[])
       group by 1, 2, 3`,
      [
        JSON.stringify(keptSpend.map((i) => { const row = i.projection.row as { platform: string; externalCampaignId: string; spendDate: string }; return { platform: row.platform, externalCampaignId: row.externalCampaignId, spendDate: row.spendDate }; })),
        CURRENCY_UNSTATED,
        items.map((i) => i.rawEventId),
      ],
    );
    for (const s of stored.rows) {
      const k = keyOf(s.platform, s.ext, s.day);
      newestHeld.set(k, Math.max(newestHeld.get(k) ?? 0, new Date(s.fetched).getTime()));
    }
  }
  const counted = kept.filter((i) => {
    if (!isSpend(i)) return true;
    const row = i.projection.row as { platform: string; externalCampaignId: string; spendDate: string; sourceUpdatedAt: Date };
    const newer = newestHeld.get(keyOf(row.platform, row.externalCampaignId, row.spendDate));
    return newer === undefined || row.sourceUpdatedAt.getTime() > newer;
  });
  if (held.length > 0) {
    // The campaign exists whatever its money's currency: its identity is recorded (no spend), so it
    // can be mapped, reviewed and attributed before the spend is authorized. Before 2026-11-12 a
    // campaign whose spend was all held had no record and could not be mapped at all (VP
    // acceptance, first contact: VP-10). An existing record is never changed by a held version.
    await db.query(
      `insert into ad_campaigns (platform, ad_account_id, external_campaign_id, name, channel_code, first_seen_at, campaign_type, local_services_enabled)
       select distinct on (r."platform", r."externalCampaignId")
         r."platform", r."adAccountId", r."externalCampaignId", r."campaignName", r."channelCode", r."sourceUpdatedAt", r."campaignType", r."localServicesEnabled"
       from jsonb_to_recordset($1::jsonb) as r("platform" text, "adAccountId" text, "externalCampaignId" text, "campaignName" text, "channelCode" text,
         "sourceUpdatedAt" timestamptz, "campaignType" text, "localServicesEnabled" boolean)
       order by r."platform", r."externalCampaignId", r."sourceUpdatedAt"
       on conflict (platform, external_campaign_id) do nothing`,
      [JSON.stringify(heldRows)],
    );
    await db.query(
      `update raw_events set status = 'excluded', error_code = null, error_detail = null, exclusion_code = $2,
         exclusion_detail = 'the feed stated no currency and no authorized rule says this ad account reports in USD; not counted', projected_at = null
       where id = any($1::bigint[])`,
      [held.map((h) => h.rawEventId), CURRENCY_UNSTATED],
    );
    await db.query(
      `delete from ad_spend_daily s
       using ad_campaigns c, jsonb_to_recordset($1::jsonb) as r("platform" text, "externalCampaignId" text, "spendDate" date, "sourceUpdatedAt" timestamptz)
       where c.id = s.campaign_id and c.platform = r."platform" and c.external_campaign_id = r."externalCampaignId"
         and s.spend_date = r."spendDate" and s.source_updated_at <= r."sourceUpdatedAt"`,
      [JSON.stringify(held)],
    );
  }
  return { kept: counted, held: held.map((h) => h.rawEventId) };
}

/**
 * Projects a batch. `report.held` receives the raw event ids the currency gate held (excluded,
 * not projected), so a caller does not mark or count them as projected.
 */
export async function projectAll(db: Queryable, all: ProjectionItem[], report?: { held: number[] }): Promise<number> {
  const gated = await currencyGate(db, all);
  if (report) report.held.push(...gated.held);
  const items = gated.kept;
  const byTable = new Map<Table, Map<string, ProjectionItem>>();
  for (const item of items) {
    const { table, row } = item.projection;
    const key = KEY[table](row as unknown as Record<string, unknown>);
    const bucket = byTable.get(table) ?? new Map<string, ProjectionItem>();
    const current = bucket.get(key);
    const newer =
      !current ||
      (item.projection.row.sourceUpdatedAt as Date).getTime() >= (current.projection.row.sourceUpdatedAt as Date).getTime();
    if (newer) bucket.set(key, item);
    byTable.set(table, bucket);
  }
  const order: Table[] = ["ad_spend_daily", "crm_customers", "crm_subscriptions", "crm_appointments", "crm_tickets", "crm_payments", "leads"];
  // Rows actually written: each upsert skips rows that already point at this raw event or hold
  // a newer version, so an unchanged re-read counts 0. Ingest uses this to tell a re-observed
  // version that changed live rows (an A -> B -> A flip) from a quiet poll.
  let changed = 0;
  for (const table of order) {
    const bucket = byTable.get(table);
    if (!bucket || bucket.size === 0) continue;
    const rows = [...bucket.values()].map(({ projection, rawEventId }) => ({ ...projection.row, rawEventId }));
    const result = await db.query(SQL[table], [JSON.stringify(rows)]);
    changed += result.rowCount ?? 0;
  }
  return changed;
}
