import { Pool } from "pg";
import type { Queryable } from "@/lib/db";
import { evidence } from "@/lib/ai/evidence";
import { METRICS } from "@/lib/metrics/definitions";
import { branchRows, freshness, HELD_SPEND, paidCac, type BranchRow, type StreamFreshness } from "@/lib/metrics/scorecard";
import type { Period } from "@/lib/period";
import { BRANCH_BY_ID, platformLabel } from "@/lib/reference";
import { resolveScope, type Viewer } from "@/lib/viewer";

/**
 * Metric trace: "where did this number come from?"
 *
 * A virtual evidence graph over the records that already exist. Nothing is copied into a new
 * store. For one branch, period and metric it returns:
 *
 *   value        the scorecard's number, and the same number REPRODUCED from the rows listed
 *                below; a difference is reported, never hidden;
 *   numerator    each campaign whose media spend counts, with the mapping that assigns it
 *                (and its version), the spend days, the raw events and mapper versions that
 *                produced them, and whether the currency was reported or assumed;
 *   denominator  each new paid customer counted, with the lead that credits them and that
 *                lead's raw event;
 *   excluded     what the definition leaves out, by reason (customers of unmapped campaigns,
 *                non-media paid channels), and source records excluded or quarantined at intake;
 *   missing      evidence the number cannot see (unmapped campaigns whose leads arrive here,
 *                open exceptions, stale feeds);
 *   limitations  stated, from the definition.
 *
 * Every reference carries a stable evidence id (lib/ai/evidence.ts), so the same ids work in
 * the evidence drawer and in investigations. Customer references are CRM ids, never phones or
 * emails. Scope is enforced here, on the server: a branch outside the viewer's scope is refused.
 * Queries are set-based (one per part), never per record.
 */

export const TRACEABLE = ["paid_cac", "paid_spend"] as const;
export type TraceableMetric = (typeof TRACEABLE)[number];

const ROW_LIMIT = 200;

export interface CampaignContribution {
  evidenceId: string;
  campaignId: number;
  externalCampaignId: string;
  name: string;
  platform: string;
  channelCode: string;
  spendCents: number;
  spendDays: number;
  firstDay: string;
  lastDay: string;
  /**
   * Spend counted as USD with nothing establishing it. Zero since currency rules (migration
   * 0020): unstated spend is counted only under an authorized rule, else excluded at intake. A
   * non-zero value would mean money nobody established as dollars, and claims on it are not certified.
   */
  assumedCurrencyCents: number;
  /** Spend whose feed stated no currency, counted as USD under an authorized account rule. */
  ruleCurrencyCents: number;
  lastFetchedAt: string | null;
  mapping: { branchId: string; mappedBy: string; mappedAt: string; version: number | null; changeId: number | null; recordedBy: string | null };
  /** Mapper versions that produced the stored spend rows, with counts. */
  mapperVersions: Record<string, number>;
  /** A few of the raw events behind the spend rows (newest first). */
  sampleRawEventIds: string[];
}

export interface CustomerContribution {
  evidenceId: string;
  crmCustomerId: number;
  soldAt: string;
  initialCompletedAt: string;
  channelCode: string;
  campaignExternalId: string | null;
  attributionBasis: string;
  leadEvidenceId: string | null;
  leadRawEventId: string | null;
}

export interface MetricTrace {
  metric: { key: TraceableMetric; label: string; formula: string; caveat: string; definitionVersion: string };
  scope: { branchId: string; branchName: string; brandId: string; period: { key: string; label: string; from: string; to: string } };
  value: {
    scorecard: { paidSpendCents: number; paidAcquired: number; paidCacCents: number | null };
    reproduced: { paidSpendCents: number; paidAcquired: number; paidCacCents: number | null };
    matches: boolean;
    discrepancies: string[];
  };
  numerator: { totalCents: number; campaigns: CampaignContribution[]; truncated: boolean };
  denominator: { count: number; customers: CustomerContribution[]; truncated: boolean };
  excluded: Array<{ reason: string; code: string; count: number; amountCents: number | null; evidenceIds: string[] }>;
  sourceRecords: Array<{ source: string; status: "excluded" | "quarantined"; code: string; count: number; sampleEvidenceIds: string[] }>;
  /** An unmapped campaign also states its figures as fields, so a sentence rendering them is proved (R-38). */
  /**
   * `campaign_unresolved` (R-46): leads at the branch whose campaign id cannot be matched to one
   * campaign, by `reason` (v_lead_campaigns.status), with how many of this trace's counted paid
   * customers they credit (`customers`).
   */
  missing: Array<{ kind: string; detail: string; evidenceIds: string[]; campaignExternalId?: string; leads?: number; spendCents?: number; reason?: string; customers?: number }>;
  freshness: StreamFreshness[];
  limitations: string[];
  evidenceIds: string[];
}

export class TraceError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Exact dollars from integer cents, for sentences (no rounding, no float). */
export const exactDollars = (cents: number) => `${cents < 0 ? "−" : ""}$${Math.floor(Math.abs(cents) / 100).toLocaleString("en-US")}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;

const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

/**
 * A caller that reads several traces of one branch and period inside ONE snapshot (verified
 * readiness does) may read the branch's scorecard row once and give it to each trace: the same
 * query with the same arguments on the same snapshot returns the same row. Until 2026-11-13 each
 * trace read it again, and the row costs 0.7–1.1 s on the demo world whichever branch it is for
 * (the scorecard aggregates every branch, then selects one): four reads were 2.9–3.5 s of
 * verified readiness's 3.3–4.0 s (PERFORMANCE.md §6).
 *
 * Only with the caller's own client or transaction. From a pool the trace opens its own snapshot,
 * which a row read elsewhere might not match (independent review F8), so that is refused, as is a
 * row for another branch.
 */
export function checkGivenScorecard(db: Queryable | Pool, scorecard: BranchRow | undefined, branchId: string): void {
  if (scorecard === undefined) return;
  if (db instanceof Pool) throw new Error("A scorecard row can be given to a trace only with the caller's own client or transaction, so that both read the same snapshot.");
  if (scorecard.branchId !== branchId) throw new Error(`The scorecard row given is for ${scorecard.branchId}, not ${branchId}.`);
}

export async function traceBranchMetric(
  db: Queryable | Pool,
  viewer: Viewer,
  args: { branchId: string; period: Period; metric: TraceableMetric; scorecard?: BranchRow },
): Promise<MetricTrace> {
  checkGivenScorecard(db, args.scorecard, args.branchId);
  // From a pool: every query of the trace reads one snapshot (repeatable read, read only), so an
  // ingest landing between the scorecard and the record queries cannot fake a discrepancy
  // (independent review F8). A caller's own client or transaction (including a pool-shaped
  // wrapper around one, as the workflow and evaluation use) is used as it is.
  if (db instanceof Pool) {
    const client = await db.connect();
    try {
      await client.query("begin isolation level repeatable read read only");
      const trace = await traceIn(client, viewer, args);
      await client.query("commit");
      return trace;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  return traceIn(db as Queryable, viewer, args);
}

async function traceIn(db: Queryable, viewer: Viewer, args: { branchId: string; period: Period; metric: TraceableMetric; scorecard?: BranchRow }): Promise<MetricTrace> {
  const branch = BRANCH_BY_ID.get(args.branchId);
  if (!branch) throw new TraceError(`Unknown branch ${args.branchId}`, 404);
  if (!(TRACEABLE as readonly string[]).includes(args.metric)) throw new TraceError(`Metric ${args.metric} cannot be traced yet`, 400);
  resolveScope(viewer, branch.id); // throws ForbiddenError outside scope
  const { from, to } = args.period;
  const params = [from, to, branch.id];

  // Sequential: `db` may be one transaction client, which must not run queries concurrently.
  // The scorecard row: the caller's, read in this same snapshot (checkGivenScorecard), or read here.
  const row = args.scorecard ?? (await branchRows(db, { from, to, branchIds: [branch.id] }))[0];
  const campaigns = await db.query(
    `with p as (select $1::timestamptz as t0, $2::timestamptz as t1)
     select c.id, c.external_campaign_id, c.name, c.platform, s.channel_code,
            sum(s.cost_cents) as cost, count(*) as days, min(s.spend_date)::text as first_day, max(s.spend_date)::text as last_day,
            coalesce(sum(s.cost_cents) filter (where s.currency_basis not in ('reported_usd', 'account_rule_usd')), 0) as assumed,
            coalesce(sum(s.cost_cents) filter (where s.currency_basis = 'account_rule_usd'), 0) as by_rule,
            max(s.source_updated_at) as last_fetched,
            m.branch_id, m.mapped_by, m.mapped_at, v.version, v.change_id, v.recorded_by,
            (array_agg(s.raw_event_id order by s.spend_date desc))[1:3] as sample_raw,
            (select jsonb_object_agg(av, n) from (
               select re2.adapter_version as av, count(*) as n from ad_spend_daily s2 join raw_events re2 on re2.id = s2.raw_event_id, p p2
               where s2.campaign_id = c.id and s2.channel_code = s.channel_code
                 and s2.spend_date >= (p2.t0 at time zone 'UTC')::date and s2.spend_date < (p2.t1 at time zone 'UTC')::date
               group by re2.adapter_version) x) as version_counts
     from ad_spend_daily s
     join campaign_branch_map m on m.campaign_id = s.campaign_id
     join channels ch on ch.code = s.channel_code and ch.cost_basis = 'media'
     join ad_campaigns c on c.id = s.campaign_id
     left join lateral (
       select version, change_id, recorded_by from campaign_mapping_versions mv
       where mv.campaign_id = c.id order by version desc limit 1
     ) v on true, p
     where m.branch_id = $3
       and s.spend_date >= (p.t0 at time zone 'UTC')::date and s.spend_date < (p.t1 at time zone 'UTC')::date
     group by c.id, c.external_campaign_id, c.name, c.platform, s.channel_code, m.branch_id, m.mapped_by, m.mapped_at, v.version, v.change_id, v.recorded_by
     order by sum(s.cost_cents) desc, c.id`,
    params,
  );
  // The customer's campaign is the one on the platform its lead's own record names
  // (v_lead_campaigns, R-46), as the scorecard reads it; with none or two named, no campaign's
  // mapping or held spend applies and the customer counts.
  const acquired = await db.query(
    `with ${HELD_SPEND}
     select a.crm_customer_id, a.sold_at, a.initial_completed_at, a.channel_code, a.campaign_external_id, a.lead_id,
            a.attribution_basis, l.raw_event_id as lead_raw_event_id, ch.is_paid, ch.cost_basis, lc.platform as campaign_platform,
            (lc.campaign_id is not null and not exists (select 1 from campaign_branch_map um where um.campaign_id = lc.campaign_id)) as unmapped_campaign,
            exists (select 1 from held_campaigns hc where hc.platform = lc.platform and hc.external_campaign_id = lc.campaign_external_id) as held_campaign
     from v_acquisitions a
     join channels ch on ch.code = a.channel_code
     left join leads l on l.id = a.lead_id
     left join v_lead_campaigns lc on lc.lead_id = a.lead_id
     where a.branch_id = $3 and a.initial_status = 'completed'
       and a.initial_completed_at >= $1 and a.initial_completed_at < $2 and ch.is_paid
     order by a.initial_completed_at, a.crm_customer_id`,
    params,
  );
  const records = await db.query(
    `select re.source, re.status, coalesce(re.exclusion_code, re.error_code) as code, count(*) as n,
            (array_agg(re.id order by re.id desc))[1:3] as sample
     from raw_events re
     where re.status in ('excluded', 'quarantined') and re.occurred_at >= $1 and re.occurred_at < $2
       -- The same branch rule as the investigator's tools (migration 0036): spend belongs to the branch
       -- its campaign maps to (independent review F6: held spend was invisible here); any other
       -- record to the branch its payload names (call tag, web branch, D2D branch, CRM office).
       and raw_event_branch(re.source, re.entity, re.payload) = $3
     group by re.source, re.status, coalesce(re.exclusion_code, re.error_code)
     order by count(*) desc`,
    params,
  );
  // Unmapped campaigns whose leads arrive here: matched on the platform each lead names (R-46), so
  // another platform's campaign with the same id, and its spend, is never shown for these leads.
  const unmapped = await db.query(
    `select c.id, c.external_campaign_id, count(*) as leads,
            (select coalesce(sum(s.cost_cents), 0) from ad_spend_daily s where s.campaign_id = c.id
              and s.spend_date >= ($1::timestamptz at time zone 'UTC')::date and s.spend_date < ($2::timestamptz at time zone 'UTC')::date) as spend
     from v_leads l
     join v_lead_campaigns lc on lc.lead_id = l.id
     join ad_campaigns c on c.id = lc.campaign_id
     where l.effective_branch_id = $3 and l.occurred_at >= $1 and l.occurred_at < $2
       and not exists (select 1 from campaign_branch_map m where m.campaign_id = c.id)
     group by c.id, c.external_campaign_id order by count(*) desc limit 20`,
    params,
  );
  // Leads here whose campaign id cannot be matched to one campaign, and the counted paid customers
  // they credit. Only this branch's own leads and their own fields are described: nothing about
  // any campaign that uses the id (it may be another account's, or another branch's).
  // A campaign whose spend was all held may have no record, but its held spend is matched on the
  // platform and id all the same (CAMPAIGN_SPEND_HELD above): that is not "unresolved".
  // The counted paid customers they credit are counted below from `acquired`, not joined here:
  // v_acquisitions joined by lead credits every customer first (+200 ms on the demo world).
  const unresolved = await db.query<{ campaign_external_id: string; status: string; platforms: string[]; lead_ids: string[] }>(
    `with ${HELD_SPEND}
     select lc.campaign_external_id, lc.status, lc.platforms, array_agg(l.id order by l.id) as lead_ids
     from v_leads l
     join v_lead_campaigns lc on lc.lead_id = l.id
     where l.effective_branch_id = $3 and l.occurred_at >= $1 and l.occurred_at < $2 and lc.status <> 'matched'
       and not exists (select 1 from held_campaigns hc where hc.platform = lc.platform and hc.external_campaign_id = lc.campaign_external_id)
     group by lc.campaign_external_id, lc.status, lc.platforms
     order by lc.campaign_external_id, lc.status limit 20`,
    params,
  );
  const exceptions = await db.query(
    "select id, kind, summary from exceptions where status = 'open' and branch_id = $1 order by id desc limit 20",
    [branch.id],
  );
  const feeds = await freshness(db);

  const contributions: CampaignContribution[] = campaigns.rows.map((r) => ({
    evidenceId: evidence.campaign(Number(r.id)),
    campaignId: Number(r.id),
    externalCampaignId: r.external_campaign_id,
    name: r.name,
    platform: r.platform,
    channelCode: r.channel_code,
    spendCents: num(r.cost),
    spendDays: num(r.days),
    firstDay: r.first_day,
    lastDay: r.last_day,
    assumedCurrencyCents: num(r.assumed),
    ruleCurrencyCents: num(r.by_rule),
    lastFetchedAt: iso(r.last_fetched),
    mapping: { branchId: r.branch_id, mappedBy: r.mapped_by, mappedAt: iso(r.mapped_at)!, version: r.version === null ? null : Number(r.version), changeId: r.change_id === null ? null : Number(r.change_id), recordedBy: r.recorded_by },
    mapperVersions: Object.fromEntries(Object.entries((r.version_counts ?? {}) as Record<string, unknown>).map(([k, v]) => [k, Number(v)])),
    sampleRawEventIds: ((r.sample_raw ?? []) as Array<string | number>).filter((x) => x !== null).map((x) => evidence.rawEvent(Number(x))),
  }));

  const counted: CustomerContribution[] = [];
  const unmappedCustomers: number[] = [];
  const heldCustomers: number[] = [];
  const nonMedia: number[] = [];
  for (const r of acquired.rows) {
    if (r.cost_basis !== "media") nonMedia.push(Number(r.crm_customer_id));
    // Held first, as the scorecard counts them: a campaign whose spend is all held has no cost in
    // any figure, mapped or not (its record exists so it can be mapped before authorization).
    else if (r.held_campaign) heldCustomers.push(Number(r.crm_customer_id));
    else if (r.unmapped_campaign) unmappedCustomers.push(Number(r.crm_customer_id));
    else
      counted.push({
        evidenceId: evidence.customer(Number(r.crm_customer_id)),
        crmCustomerId: Number(r.crm_customer_id),
        soldAt: iso(r.sold_at)!,
        initialCompletedAt: iso(r.initial_completed_at)!,
        channelCode: r.channel_code,
        campaignExternalId: r.campaign_external_id,
        attributionBasis: r.attribution_basis,
        leadEvidenceId: r.lead_id === null ? null : evidence.lead(Number(r.lead_id)),
        leadRawEventId: r.lead_raw_event_id === null ? null : evidence.rawEvent(Number(r.lead_raw_event_id)),
      });
  }

  const reproducedSpend = contributions.reduce((t, c) => t + c.spendCents, 0);
  const reproduced = { paidSpendCents: reproducedSpend, paidAcquired: counted.length, paidCacCents: paidCac(reproducedSpend, counted.length) };
  const scorecard = scoreOf(row);
  const discrepancies: string[] = [];
  if (reproduced.paidSpendCents !== scorecard.paidSpendCents) discrepancies.push(`Spend: the scorecard says ${scorecard.paidSpendCents} cents; the listed campaigns add up to ${reproduced.paidSpendCents}.`);
  if (args.metric === "paid_cac" && reproduced.paidAcquired !== scorecard.paidAcquired) discrepancies.push(`Paid customers: the scorecard counts ${scorecard.paidAcquired}; ${reproduced.paidAcquired} are listed.`);

  const assumed = contributions.reduce((t, c) => t + c.assumedCurrencyCents, 0);
  const byRule = contributions.reduce((t, c) => t + c.ruleCurrencyCents, 0);
  const excluded: MetricTrace["excluded"] = [];
  if (args.metric === "paid_cac") {
    if (unmappedCustomers.length) excluded.push({ reason: "New paid customers whose crediting campaign is mapped to no branch: its spend is unallocated, so they are left out of the denominator too", code: "CAMPAIGN_UNMAPPED", count: unmappedCustomers.length, amountCents: null, evidenceIds: unmappedCustomers.slice(0, 10).map(evidence.customer) });
    if (heldCustomers.length) {
      // The held spend records behind the exclusion, so the evidence leads to its cause: the held
      // campaign's own records, on its platform (R-46), not another platform's with the same id.
      const heldCampaigns = [...new Map(acquired.rows.filter((r) => r.held_campaign).map((r) => [`${r.campaign_platform}:${r.campaign_external_id}`, r])).values()];
      const heldRaw = await db.query<{ id: string }>(
        `select re.id from raw_events re
         join unnest($1::text[], $2::text[]) as held(platform, ext) on held.platform = re.payload ->> 'platform' and held.ext = re.payload ->> 'campaignId'
         where re.source = 'ads' and re.status in ('excluded', 'quarantined') order by re.id desc limit 5`,
        [heldCampaigns.map((r) => r.campaign_platform as string), heldCampaigns.map((r) => r.campaign_external_id as string)],
      );
      excluded.push({
        reason: "New paid customers whose crediting campaign's spend was all held at intake (another currency, or no stated currency without a rule): its cost is in no figure, so they are left out of the denominator too",
        code: "CAMPAIGN_SPEND_HELD",
        count: heldCustomers.length,
        amountCents: null,
        evidenceIds: [...heldCustomers.slice(0, 5).map(evidence.customer), ...heldRaw.rows.map((r) => evidence.rawEvent(Number(r.id)))],
      });
    }
    if (nonMedia.length) excluded.push({ reason: "New customers credited to a paid channel that is not media spend (e.g. sponsorship): not in paid-media CAC", code: "NOT_MEDIA", count: nonMedia.length, amountCents: null, evidenceIds: nonMedia.slice(0, 10).map(evidence.customer) });
  }

  const sourceRecords: MetricTrace["sourceRecords"] = records.rows.map((r) => ({
    source: r.source,
    status: r.status,
    code: r.code,
    count: num(r.n),
    sampleEvidenceIds: ((r.sample ?? []) as Array<string | number>).map((x) => evidence.rawEvent(Number(x))),
  }));

  const missing: MetricTrace["missing"] = [];
  for (const u of unmapped.rows) {
    missing.push({
      kind: "unmapped_campaign",
      detail: `Campaign ${u.external_campaign_id} has ${num(u.leads)} lead(s) at ${branch.id} but is mapped to no branch: ${exactDollars(num(u.spend))} of its spend in the period counts nowhere.`,
      evidenceIds: [evidence.campaign(Number(u.id))],
      campaignExternalId: String(u.external_campaign_id),
      leads: num(u.leads),
      spendCents: num(u.spend),
    });
  }
  const countedByLead = new Set(counted.map((k) => k.leadEvidenceId).filter((id): id is string => id !== null));
  for (const u of unresolved.rows) {
    const leads = u.lead_ids.length;
    const customers = u.lead_ids.filter((id) => countedByLead.has(evidence.lead(Number(id)))).length;
    const why =
      u.status === "conflicting_platforms"
        ? `name more than one ad platform (${u.platforms.map(platformLabel).join(" and ")})`
        : u.status === "no_platform"
          ? "name no ad platform (no call-tracking source label for one, no click id, no paid utm_source)"
          : `name ${platformLabel(u.platforms[0])}, and no ${platformLabel(u.platforms[0])} campaign has this id`;
    missing.push({
      kind: "campaign_unresolved",
      detail:
        `Campaign id ${u.campaign_external_id}: ${leads} lead(s) at ${branch.id} ${why}, so they are matched to no campaign; a bare id is not enough.` +
        (customers > 0 ? ` The ${customers} paid customer(s) they credit are counted, as customers whose lead carries no campaign are: no campaign's mapping or held spend applies to them.` : ""),
      evidenceIds: u.lead_ids.slice(0, 5).map((id) => evidence.lead(Number(id))),
      campaignExternalId: u.campaign_external_id,
      leads,
      reason: u.status,
      customers,
    });
  }
  for (const e of exceptions.rows) missing.push({ kind: `open_exception:${e.kind}`, detail: e.summary, evidenceIds: [evidence.exception(Number(e.id))] });
  for (const f of feeds) {
    if (f.lastRunStatus !== "succeeded") missing.push({ kind: "feed_failing", detail: `${f.stream}: the last run did not succeed`, evidenceIds: [] });
  }
  if (sourceRecords.some((r) => r.status === "quarantined")) {
    missing.push({ kind: "quarantined_records", detail: "Some records for this branch are held at intake; they count nowhere until fixed and replayed.", evidenceIds: sourceRecords.filter((r) => r.status === "quarantined").flatMap((r) => r.sampleEvidenceIds) });
  }

  const def = args.metric === "paid_cac" ? METRICS.paidCac : METRICS.paidSpend;
  const limitations = [
    def.caveat,
    "Attribution credits a customer to the first lead with evidence. That is an association, not proof that the advertising caused the sale.",
    "A campaign mapping applies to the campaign's whole history (mappings are not effective-dated).",
    ...(assumed > 0 ? [`${exactDollars(assumed)} of this spend came from a feed that did not state its currency and nothing establishes it as USD.`] : []),
    ...(byRule > 0 ? [`${exactDollars(byRule)} of this spend came from a feed that did not state its currency; it counts as USD because an authorized rule says the account reports in USD.`] : []),
  ];

  const evidenceIds = [
    evidence.metricDefinition(def.key),
    evidence.branchMetrics(branch.id, args.period.key),
    ...contributions.map((c) => c.evidenceId),
    ...counted.slice(0, ROW_LIMIT).map((c) => c.evidenceId),
    ...missing.flatMap((m) => m.evidenceIds),
  ];

  return {
    metric: { key: args.metric, label: def.label, formula: def.formula, caveat: def.caveat, definitionVersion: def.version },
    scope: { branchId: branch.id, branchName: branch.name, brandId: branch.brandId, period: { key: args.period.key, label: args.period.label, from: from.toISOString(), to: to.toISOString() } },
    value: { scorecard, reproduced, matches: discrepancies.length === 0, discrepancies },
    numerator: { totalCents: reproducedSpend, campaigns: contributions.slice(0, ROW_LIMIT), truncated: contributions.length > ROW_LIMIT },
    denominator: { count: counted.length, customers: args.metric === "paid_cac" ? counted.slice(0, ROW_LIMIT) : [], truncated: counted.length > ROW_LIMIT },
    excluded,
    sourceRecords,
    missing,
    freshness: feeds,
    limitations,
    evidenceIds: [...new Set(evidenceIds)],
  };
}

function scoreOf(row: BranchRow | undefined) {
  return { paidSpendCents: row?.paidSpendCents ?? 0, paidAcquired: row?.paidAcquired ?? 0, paidCacCents: row ? paidCac(row.paidSpendCents, row.paidAcquired) : null };
}

/** What changed between two traces of the same branch and metric: by campaign, and in the denominator. */
export function compareTraces(before: MetricTrace, after: MetricTrace) {
  const key = (c: CampaignContribution) => `${c.campaignId}:${c.channelCode}`;
  const a = new Map(before.numerator.campaigns.map((c) => [key(c), c]));
  const b = new Map(after.numerator.campaigns.map((c) => [key(c), c]));
  const campaigns = [...new Set([...a.keys(), ...b.keys()])]
    .map((k) => {
      const x = a.get(k);
      const y = b.get(k);
      const ref = (y ?? x)!;
      return {
        evidenceId: ref.evidenceId,
        externalCampaignId: ref.externalCampaignId,
        channelCode: ref.channelCode,
        beforeCents: x?.spendCents ?? 0,
        afterCents: y?.spendCents ?? 0,
        deltaCents: (y?.spendCents ?? 0) - (x?.spendCents ?? 0),
        status: !x ? ("new" as const) : !y ? ("gone" as const) : ("changed" as const),
      };
    })
    .filter((c) => c.deltaCents !== 0 || c.status !== "changed")
    .sort((p, q) => Math.abs(q.deltaCents) - Math.abs(p.deltaCents));
  return {
    before: { period: before.scope.period.label, ...before.value.reproduced },
    after: { period: after.scope.period.label, ...after.value.reproduced },
    spendDeltaCents: after.value.reproduced.paidSpendCents - before.value.reproduced.paidSpendCents,
    customersDelta: after.value.reproduced.paidAcquired - before.value.reproduced.paidAcquired,
    campaigns,
  };
}
