import { z } from "zod";
import { ActionError } from "@/lib/actions";
import type { SourceName } from "@/lib/adapters/contract";
import { ACTIVE_VERSION, mapperFor, mapperVersions, referenceContext } from "@/lib/adapters/registry";
import type { Queryable } from "@/lib/db";
import { decisionVerdicts } from "@/lib/decision/verdicts";
import { getCustomerJourney } from "@/lib/identity";
import { METRICS } from "@/lib/metrics/definitions";
import { branchRows, channelRows, freshness, paidCac } from "@/lib/metrics/scorecard";
import { PERIODS, type PeriodKey } from "@/lib/period";
import { exceptionSummary, getException, listExceptions, type ExceptionRow } from "@/lib/queries";
import { BRANCH_BY_ID } from "@/lib/reference";
import { ForbiddenError, canSeeBranch, resolveScope, type Viewer } from "@/lib/viewer";
import { auditFeed, caseAudit, caseForException } from "@/lib/workflow/queries";
import { evidence, uniqueIds } from "./evidence";

/**
 * The investigator's tool registry. Fixed, read-only, executed by the backend.
 *
 *   * No model-written SQL and no code execution: a tool is a named function with a zod input
 *     schema; the model (or the deterministic plan) can only choose a tool and its arguments.
 *   * Every tool enforces the VIEWER's branch scope with lib/viewer.ts, exactly like the API:
 *     an explicit branch outside scope is refused (ForbiddenError); a record id outside scope is
 *     reported as "not found in your scope" so the refusal does not confirm it exists.
 *   * Every output carries stable evidence ids (lib/ai/evidence.ts). Claims may only cite ids a
 *     tool returned in the same run; outputs are bounded samples, never whole tables.
 *   * Nothing here writes. Writing happens only through the planner → Action Center, which has
 *     its own permission, dry-run and approval gates.
 */

export interface ToolContext {
  db: Queryable;
  viewer: Viewer;
  /** Business clock (app_clock). */
  now: Date;
}

export interface ToolOutput<O> {
  data: O;
  evidenceIds: string[];
  /** One line for the trace. */
  summary: string;
}

export interface ToolDef<S extends z.ZodType, O> {
  name: string;
  description: string;
  /** Validates (and defaults) the input before run(); a ZodError is reported back as a tool error. */
  input: S;
  run(ctx: ToolContext, input: z.output<S>): Promise<ToolOutput<O>>;
}

function defineTool<S extends z.ZodType, O>(def: ToolDef<S, O>): ToolDef<S, O> {
  return def;
}

const branchId = z.string().regex(/^B\d{2}$/, "a branch id like B09");
const period = z.enum(["oct", "sep", "all"]).default("oct");
const source = z.enum(["crm", "calls", "web", "d2d", "ads"]);
const version = z.string().regex(/^\d+\.\d+$/, "a mapper version like 1.1");
const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/** A record the viewer may not see is indistinguishable from one that does not exist. */
function notInScope(viewer: Viewer, what: string): Error {
  return viewer.branchIds ? new ForbiddenError(`${what} not found in your scope`) : new ActionError(`${what} not found`, 404);
}

function knownBranch(id: string): void {
  if (!BRANCH_BY_ID.has(id)) throw new ActionError(`Unknown branch ${id}`, 404);
}

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

/**
 * The branch a raw event belongs to: the branch its payload names (branch tag or CRM office),
 * else — for ad spend, which names a campaign, not a branch — the branch the campaign is
 * mapped to. Null = company-wide (an unmapped campaign or an unknown branch).
 */
const RAW_EVENT_BRANCH = `coalesce(payload_branch(re.payload), (
    select m.branch_id from ad_campaigns c join campaign_branch_map m on m.campaign_id = c.id
    where c.platform = re.payload ->> 'platform' and c.external_campaign_id = re.payload ->> 'campaignId'))`;

async function campaignBranch(db: Queryable, campaignId: number): Promise<{ found: boolean; branchId: string | null }> {
  const { rows } = await db.query<{ branch_id: string | null }>(
    "select m.branch_id from ad_campaigns c left join campaign_branch_map m on m.campaign_id = c.id where c.id = $1",
    [campaignId],
  );
  return rows[0] ? { found: true, branchId: rows[0].branch_id } : { found: false, branchId: null };
}

async function exceptionInScope(ctx: ToolContext, exceptionId: number): Promise<ExceptionRow> {
  const exception = await getException(ctx.db, exceptionId);
  if (!exception || !canSeeBranch(ctx.viewer, exception.branchId)) throw notInScope(ctx.viewer, `Exception ${exceptionId}`);
  return exception;
}

/** Ids an exception's stored evidence names, as evidence ids (they are part of what it returned). */
function exceptionEvidenceIds(e: ExceptionRow): string[] {
  const ev = e.evidence;
  const ids = [evidence.exception(e.id)];
  const nums = (v: unknown) => (Array.isArray(v) ? v : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  for (const raw of nums(ev.sampleRawEventIds)) ids.push(evidence.rawEvent(raw));
  if (Number.isInteger(Number(ev.rawEventId)) && ev.rawEventId) ids.push(evidence.rawEvent(Number(ev.rawEventId)));
  for (const lead of nums(ev.sampleLeadIds)) ids.push(evidence.lead(lead));
  if (ev.leadId) ids.push(evidence.lead(Number(ev.leadId)));
  if (ev.customerId) ids.push(evidence.customer(Number(ev.customerId)));
  if (ev.paymentId) ids.push(evidence.payment(Number(ev.paymentId)));
  if (ev.campaignId) ids.push(evidence.campaign(Number(ev.campaignId)));
  for (const c of [...((ev.predecessors as Array<{ campaignId: number }> | null) ?? []), ...((ev.successors as Array<{ campaignId: number }> | null) ?? [])]) {
    ids.push(evidence.campaign(Number(c.campaignId)));
  }
  return uniqueIds(ids);
}

// ── getBranchMetrics ─────────────────────────────────────────────────────────

export interface BranchMetrics {
  branchId: string;
  branchName: string;
  period: { key: PeriodKey; label: string };
  paidSpendCents: number;
  acquired: number;
  paidAcquired: number;
  unknownAcquired: number;
  paidCacCents: number | null;
  unknownShare: number | null;
  rawLeads: number;
  prospects: number;
  platformClaimed: number;
  collectedCents: number;
  refundsCents: number;
  openExceptions: number;
  atRiskCents: number;
  channels: Array<{ channelCode: string; label: string; isPaid: boolean; spendCents: number; acquired: number; cacCents: number | null; prospects: number }>;
}

export const getBranchMetrics = defineTool({
  name: "getBranchMetrics",
  description:
    "Scorecard metrics for one branch and period (oct, sep or all): paid spend, new customers serviced (all / paid / unknown channel), paid-media CAC, unknown share, collected revenue, refunds, open exceptions, and per-channel spend, customers and cost per customer. Money is integer cents.",
  input: z.strictObject({ branchId, period }),
  async run(ctx, input): Promise<ToolOutput<BranchMetrics>> {
    knownBranch(input.branchId);
    const scope = resolveScope(ctx.viewer, input.branchId);
    const p = PERIODS[input.period];
    const [row] = await branchRows(ctx.db, { from: p.from, to: p.to, branchIds: scope });
    const channels = await channelRows(ctx.db, { from: p.from, to: p.to, branchIds: scope });
    const shown = channels.filter((c) => c.costBasis === "media" || c.acquired > 0);
    const data: BranchMetrics = {
      branchId: row.branchId,
      branchName: row.name,
      period: { key: p.key, label: p.label },
      paidSpendCents: row.paidSpendCents,
      acquired: row.acquired,
      paidAcquired: row.paidAcquired,
      unknownAcquired: row.unknownAcquired,
      paidCacCents: paidCac(row.paidSpendCents, row.paidAcquired),
      unknownShare: row.acquired > 0 ? row.unknownAcquired / row.acquired : null,
      rawLeads: row.rawLeads,
      prospects: row.prospects,
      platformClaimed: row.platformClaimed,
      collectedCents: row.collectedCents,
      refundsCents: row.refundsCents,
      openExceptions: row.openExceptions,
      atRiskCents: row.atRiskCents,
      channels: shown.map((c) => ({
        channelCode: c.channelCode,
        label: c.label,
        isPaid: c.isPaid,
        spendCents: c.spendCents,
        acquired: c.acquired,
        cacCents: c.cacCents,
        prospects: c.prospects,
      })),
    };
    return {
      data,
      evidenceIds: [evidence.branchMetrics(input.branchId, p.key), ...shown.map((c) => evidence.channelMetrics(input.branchId, p.key, c.channelCode))],
      summary: `${input.branchId} ${p.key}: paid CAC ${data.paidCacCents === null ? "n/a" : `${data.paidCacCents}¢`}, ${data.paidAcquired}/${data.acquired} paid customers, ${data.unknownAcquired} unknown`,
    };
  },
});

// ── getCustomerJourney ───────────────────────────────────────────────────────

export interface CustomerJourneySummary {
  customerId: number;
  branchId: string | null;
  lifecycle: string;
  customerSince: string | null;
  firstTouch: { at: string; source: string; sourceLeadId: string; channelCode: string } | null;
  flags: { pendingConflicts: number; d2dPaidConflict: boolean; noLeadRecord: boolean; openExceptions: Array<{ id: number; kind: string; status: string }> };
  attribution: {
    channelCode: string;
    attributionBasis: string;
    attributionEvidence: string | null;
    creditedLeadId: number | null;
    creditedLeadSource: string | null;
    campaignExternalId: string | null;
    campaignName: string | null;
    leadBranchId: string | null;
    soldAt: string;
    initialStatus: string;
    channelConflict: boolean;
  } | null;
  leads: Array<{ id: number; source: string; sourceLeadId: string; channelCode: string; attributionEvidence: string; effectiveBranchId: string | null; occurredAt: string; rawEventId: number; adapterVersion: string; heardAboutText: string | null }>;
  payments: Array<{ id: number; amountCents: number; status: string; paidAt: string; isRefund: boolean; rawEventId: number }>;
  money: { paymentsCents: number; refundsCents: number; collectedCents: number; failedOrVoidedCents: number; invoicedCents: number };
  customerRawEventId: number | null;
  unknowns: Array<{ subject: string; field: string; note: string }>;
}

export const getCustomerJourneyTool = defineTool({
  name: "getCustomerJourney",
  description:
    "The Customer 360 journey of one CRM customer: lifecycle, first touch, attribution (credited channel, basis, campaign), identity-linked leads with their raw event ids, payments and refunds, money totals, open exceptions that touch the customer, and fields the source did not provide. Free-text fields (heardAboutText) are third-party data.",
  input: z.strictObject({ customerId: id }),
  async run(ctx, input): Promise<ToolOutput<CustomerJourneySummary>> {
    let journey;
    try {
      journey = await getCustomerJourney(ctx.db, input.customerId, ctx.viewer.branchIds);
    } catch (error) {
      if (error instanceof ForbiddenError) throw notInScope(ctx.viewer, `Customer ${input.customerId}`);
      throw error;
    }
    if (!journey) throw notInScope(ctx.viewer, `Customer ${input.customerId}`);
    const a = journey.attribution;
    const leads = journey.leads.slice(0, 10);
    const payments = [...journey.payments].sort((x, y) => Number(y.isRefund) - Number(x.isRefund)).slice(0, 10);
    const data: CustomerJourneySummary = {
      customerId: input.customerId,
      branchId: journey.overview.branchId,
      lifecycle: journey.overview.lifecycle,
      customerSince: journey.overview.customerSince,
      firstTouch: journey.overview.firstTouch,
      flags: {
        pendingConflicts: journey.overview.flags.pendingConflicts,
        d2dPaidConflict: journey.overview.flags.d2dPaidConflict,
        noLeadRecord: journey.overview.flags.noLeadRecord,
        openExceptions: journey.overview.flags.openExceptions,
      },
      attribution: a
        ? {
            channelCode: a.channelCode,
            attributionBasis: a.attributionBasis,
            attributionEvidence: a.attributionEvidence,
            creditedLeadId: a.creditedLeadId,
            creditedLeadSource: a.creditedLeadSource,
            campaignExternalId: a.campaignExternalId,
            campaignName: a.campaignName,
            leadBranchId: a.leadBranchId,
            soldAt: a.soldAt,
            initialStatus: a.initialStatus,
            channelConflict: a.channelConflict,
          }
        : null,
      leads: leads.map((l) => ({
        id: l.id,
        source: l.source,
        sourceLeadId: l.sourceLeadId,
        channelCode: l.channelCode,
        attributionEvidence: l.attributionEvidence,
        effectiveBranchId: l.effectiveBranchId,
        occurredAt: l.occurredAt,
        rawEventId: l.rawEventId,
        adapterVersion: l.adapterVersion,
        heardAboutText: l.heardAboutText,
      })),
      payments: payments.map((p) => ({ id: p.id, amountCents: p.amountCents, status: p.status, paidAt: p.paidAt, isRefund: p.isRefund, rawEventId: p.rawEventId })),
      money: journey.money,
      customerRawEventId: journey.customer?.rawEventId ?? null,
      unknowns: journey.unknowns.slice(0, 10),
    };
    const ids = [
      evidence.customer(input.customerId),
      ...(data.customerRawEventId ? [evidence.rawEvent(data.customerRawEventId)] : []),
      ...leads.flatMap((l) => [evidence.lead(l.id), evidence.rawEvent(l.rawEventId)]),
      ...payments.flatMap((p) => [evidence.payment(p.id), evidence.rawEvent(p.rawEventId)]),
      ...data.flags.openExceptions.map((e) => evidence.exception(e.id)),
    ];
    return {
      data,
      evidenceIds: uniqueIds(ids),
      summary: `customer ${input.customerId} (${data.branchId ?? "?"}, ${data.lifecycle}): credited ${a?.channelCode ?? "—"} via ${a?.attributionBasis ?? "—"}, ${journey.leads.length} lead(s), ${journey.payments.length} payment row(s)`,
    };
  },
});

// ── getSourceLineage ─────────────────────────────────────────────────────────

export type SourceLineage =
  | {
      kind: "raw_event";
      rawEvent: {
        id: number; source: string; entity: string; entityId: string; externalId: string; adapterVersion: string; status: string;
        errorCode: string | null; errorDetail: string | null; occurredAt: string | null; receivedAt: string | null; deliveryCount: number;
        ingestionRunId: number | null; branchId: string | null; payload: unknown;
      };
      versions: Array<{ id: number; adapterVersion: string; status: string; receivedAt: string | null }>;
      projection: { table: string; id: string } | null;
    }
  | {
      kind: "campaign";
      campaign: { id: number; platform: string; adAccountId: string; externalCampaignId: string; name: string; channelCode: string; campaignType: string | null; localServicesEnabled: boolean; mappedBranch: string | null };
      lineage: { predecessorOf: Array<{ campaignId: number; effectiveDate: string }>; successorOf: Array<{ campaignId: number; effectiveDate: string }> };
      spendByMapper: Array<{ adapterVersion: string; channelCode: string; days: number; costCents: number; firstDate: string; lastDate: string }>;
      sampleRawEventIds: number[];
    }
  | {
      kind: "lead";
      lead: { id: number; source: string; sourceLeadId: string; branchId: string | null; effectiveBranchId: string | null; channelCode: string; attributionEvidence: string; campaignExternalId: string | null; occurredAt: string | null; rawEventId: number; adapterVersion: string };
    };

export const getSourceLineage = defineTool({
  name: "getSourceLineage",
  description:
    "Where a record came from. Give exactly one of: rawEventId (the stored, redacted source payload, its mapper version, status, every stored version of the same source record and the projection row it produced), campaignId (the ad campaign, its branch mapping, predecessor/successor lineage and its spend grouped by the mapper version and channel that classified it), or leadId (the lead row and its raw event).",
  input: z
    .strictObject({ rawEventId: id.optional(), campaignId: id.optional(), leadId: id.optional() })
    .refine((v) => [v.rawEventId, v.campaignId, v.leadId].filter((x) => x !== undefined).length === 1, "give exactly one of rawEventId, campaignId, leadId"),
  async run(ctx, input): Promise<ToolOutput<SourceLineage>> {
    if (input.rawEventId !== undefined) return rawEventLineage(ctx, input.rawEventId);
    if (input.campaignId !== undefined) return campaignLineage(ctx, input.campaignId);
    return leadLineage(ctx, input.leadId!);
  },
});

async function rawEventLineage(ctx: ToolContext, rawEventId: number): Promise<ToolOutput<SourceLineage>> {
  const { rows } = await ctx.db.query(
    `select re.*, ${RAW_EVENT_BRANCH} as branch_id from raw_events re where re.id = $1`,
    [rawEventId],
  );
  const r = rows[0];
  if (!r || !canSeeBranch(ctx.viewer, r.branch_id ?? null)) throw notInScope(ctx.viewer, `Raw event ${rawEventId}`);
  const versions = await ctx.db.query(
    `select id, adapter_version, status, received_at from raw_events
     where source = $1 and entity = $2 and entity_id = $3 order by received_at, id limit 10`,
    [r.source, r.entity, r.entity_id],
  );
  const projection = await ctx.db.query<{ t: string; id: string }>(
    `select 'leads' as t, id::text from leads where raw_event_id = $1
     union all select 'crm_customers', crm_customer_id::text from crm_customers where raw_event_id = $1
     union all select 'crm_subscriptions', crm_subscription_id::text from crm_subscriptions where raw_event_id = $1
     union all select 'crm_appointments', crm_appointment_id::text from crm_appointments where raw_event_id = $1
     union all select 'crm_tickets', crm_ticket_id::text from crm_tickets where raw_event_id = $1
     union all select 'crm_payments', crm_payment_id::text from crm_payments where raw_event_id = $1
     union all select 'ad_spend_daily', campaign_id || ':' || spend_date from ad_spend_daily where raw_event_id = $1
     limit 1`,
    [rawEventId],
  );
  const proj = projection.rows[0] ? { table: projection.rows[0].t, id: projection.rows[0].id } : null;
  const ids = [evidence.rawEvent(rawEventId), ...versions.rows.map((v) => evidence.rawEvent(Number(v.id)))];
  if (r.ingestion_run_id) ids.push(evidence.ingestionRun(Number(r.ingestion_run_id)));
  if (proj?.table === "leads") ids.push(evidence.lead(Number(proj.id)));
  if (proj?.table === "crm_customers") ids.push(evidence.customer(Number(proj.id)));
  if (proj?.table === "crm_payments") ids.push(evidence.payment(Number(proj.id)));
  if (proj?.table === "ad_spend_daily") ids.push(evidence.campaign(Number(proj.id.split(":")[0])));
  return {
    data: {
      kind: "raw_event",
      rawEvent: {
        id: rawEventId,
        source: r.source,
        entity: r.entity,
        entityId: r.entity_id,
        externalId: r.external_id,
        adapterVersion: r.adapter_version,
        status: r.status,
        errorCode: r.error_code ?? null,
        errorDetail: r.error_detail ?? null,
        occurredAt: iso(r.occurred_at),
        receivedAt: iso(r.received_at),
        deliveryCount: Number(r.delivery_count),
        ingestionRunId: r.ingestion_run_id === null ? null : Number(r.ingestion_run_id),
        branchId: r.branch_id ?? null,
        payload: r.payload,
      },
      versions: versions.rows.map((v) => ({ id: Number(v.id), adapterVersion: v.adapter_version, status: v.status, receivedAt: iso(v.received_at) })),
      projection: proj,
    },
    evidenceIds: uniqueIds(ids),
    summary: `raw_event ${rawEventId}: ${r.source}.${r.entity} ${r.entity_id} via ${r.adapter_version}, ${r.status}${r.error_code ? ` (${r.error_code})` : ""}${proj ? ` → ${proj.table} ${proj.id}` : ""}`,
  };
}

async function campaignLineage(ctx: ToolContext, campaignId: number): Promise<ToolOutput<SourceLineage>> {
  const scope = await campaignBranch(ctx.db, campaignId);
  if (!scope.found || !canSeeBranch(ctx.viewer, scope.branchId)) throw notInScope(ctx.viewer, `Campaign ${campaignId}`);
  const { rows } = await ctx.db.query("select * from ad_campaigns where id = $1", [campaignId]);
  const c = rows[0];
  const lineage = await ctx.db.query(
    `select predecessor_campaign_id, successor_campaign_id, effective_date from campaign_lineage
     where predecessor_campaign_id = $1 or successor_campaign_id = $1`,
    [campaignId],
  );
  const spend = await ctx.db.query(
    `select re.adapter_version, s.channel_code, count(*) as days, sum(s.cost_cents) as cost, min(s.spend_date) as first_date, max(s.spend_date) as last_date
     from ad_spend_daily s join raw_events re on re.id = s.raw_event_id
     where s.campaign_id = $1 group by 1, 2 order by 1, 2`,
    [campaignId],
  );
  const samples = await ctx.db.query<{ id: string }>(
    `select re.id from raw_events re where re.source = 'ads' and re.payload ->> 'platform' = $1 and re.payload ->> 'campaignId' = $2
     order by re.received_at desc, re.id desc limit 10`,
    [c.platform, c.external_campaign_id],
  );
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const data: SourceLineage = {
    kind: "campaign",
    campaign: {
      id: campaignId,
      platform: c.platform,
      adAccountId: c.ad_account_id,
      externalCampaignId: c.external_campaign_id,
      name: c.name,
      channelCode: c.channel_code,
      campaignType: c.campaign_type ?? null,
      localServicesEnabled: Boolean(c.local_services_enabled),
      mappedBranch: scope.branchId,
    },
    lineage: {
      predecessorOf: lineage.rows.filter((l) => Number(l.predecessor_campaign_id) === campaignId).map((l) => ({ campaignId: Number(l.successor_campaign_id), effectiveDate: day(l.effective_date) })),
      successorOf: lineage.rows.filter((l) => Number(l.successor_campaign_id) === campaignId).map((l) => ({ campaignId: Number(l.predecessor_campaign_id), effectiveDate: day(l.effective_date) })),
    },
    spendByMapper: spend.rows.map((s) => ({
      adapterVersion: s.adapter_version,
      channelCode: s.channel_code,
      days: num(s.days),
      costCents: num(s.cost),
      firstDate: day(s.first_date),
      lastDate: day(s.last_date),
    })),
    sampleRawEventIds: samples.rows.map((s) => Number(s.id)),
  };
  const lineageIds = [...data.lineage.predecessorOf, ...data.lineage.successorOf].map((l) => evidence.campaign(l.campaignId));
  return {
    data,
    evidenceIds: uniqueIds([evidence.campaign(campaignId), ...lineageIds, ...data.sampleRawEventIds.map(evidence.rawEvent)]),
    summary: `campaign ${campaignId} "${c.name}" (${c.platform}, filed as ${c.channel_code}), mapped to ${scope.branchId ?? "no branch"}; spend by mapper: ${data.spendByMapper.map((s) => `${s.adapterVersion}/${s.channelCode} ${s.days}d`).join(", ") || "none"}`,
  };
}

async function leadLineage(ctx: ToolContext, leadId: number): Promise<ToolOutput<SourceLineage>> {
  const { rows } = await ctx.db.query(
    `select l.*, re.adapter_version from v_leads l join raw_events re on re.id = l.raw_event_id where l.id = $1`,
    [leadId],
  );
  const l = rows[0];
  if (!l || !canSeeBranch(ctx.viewer, l.effective_branch_id ?? null)) throw notInScope(ctx.viewer, `Lead ${leadId}`);
  return {
    data: {
      kind: "lead",
      lead: {
        id: leadId,
        source: l.source,
        sourceLeadId: l.source_lead_id,
        branchId: l.branch_id ?? null,
        effectiveBranchId: l.effective_branch_id ?? null,
        channelCode: l.channel_code,
        attributionEvidence: l.attribution_evidence,
        campaignExternalId: l.campaign_external_id ?? null,
        occurredAt: iso(l.occurred_at),
        rawEventId: Number(l.raw_event_id),
        adapterVersion: l.adapter_version,
      },
    },
    evidenceIds: [evidence.lead(leadId), evidence.rawEvent(Number(l.raw_event_id))],
    summary: `lead ${leadId}: ${l.source} ${l.source_lead_id}, ${l.channel_code} (${l.attribution_evidence}) at ${l.effective_branch_id ?? "?"} via ${l.adapter_version}`,
  };
}

// ── getIngestionFailures ─────────────────────────────────────────────────────

export interface IngestionFailures {
  scope: string[] | null;
  quarantineGroups: Array<{
    source: string; errorCode: string; branchId: string | null; records: number; adapterVersions: string[];
    firstOccurredAt: string | null; lastOccurredAt: string | null; sampleError: string | null; sampleRawEventIds: number[]; exceptionId: number | null;
  }>;
  duplicates: Array<{ source: string; recordsRedelivered: number; duplicateDeliveries: number; storedEvents: number | null; sampleRawEventIds: number[] }>;
  payloadConflicts: Array<{ exceptionId: number; summary: string; status: string }>;
  streams: Array<{ stream: string; source: string; lastRunStatus: string | null; lastSuccessAt: string | null; hoursSinceSuccess: number | null; lastSuccessRunId: number | null; latestEventAt: string | null }>;
  failedRuns: Array<{ id: number; stream: string; startedAt: string | null; error: string | null; recoveredByRunId: number | null }>;
}

export const getIngestionFailures = defineTool({
  name: "getIngestionFailures",
  description:
    "Ingestion health in the viewer's scope (optionally one source and/or branch): quarantined record groups (source, error code, branch, count, sample raw event ids, the mapper versions that refused them, the exception that tracks the group), duplicate deliveries absorbed by exactly-once ingest, open payload conflicts, per-stream freshness against the business clock, and failed ingestion runs with the run that recovered them.",
  input: z.strictObject({ source: source.optional(), branchId: branchId.optional() }),
  async run(ctx, input): Promise<ToolOutput<IngestionFailures>> {
    if (input.branchId) knownBranch(input.branchId);
    const scope = resolveScope(ctx.viewer, input.branchId ?? null);
    const groups = await ctx.db.query(
      `with q as (
         select re.id, re.source, re.error_code, re.error_detail, re.adapter_version, re.occurred_at, payload_branch(re.payload) as branch_id
         from raw_events re where re.status = 'quarantined' and ($1::text is null or re.source = $1))
       select q.source, q.error_code, q.branch_id, count(*) as records, array_agg(distinct q.adapter_version) as versions,
              min(q.occurred_at) as first_at, max(q.occurred_at) as last_at, min(q.error_detail) as sample_error,
              (array_agg(q.id order by q.id))[1:10] as sample_ids,
              (select e.id from exceptions e where e.fingerprint = 'quarantine:' || q.source || ':' || q.error_code || ':' || coalesce(q.branch_id, '-')) as exception_id
       from q where ($2::text[] is null or q.branch_id = any($2::text[]))
       group by q.source, q.error_code, q.branch_id order by count(*) desc limit 20`,
      [input.source ?? null, scope],
    );
    // Redelivered versions only (delivery_count > 1): filtering first keeps the branch lookup off
    // the whole raw log. Totals of stored events are company-wide, so only unscoped viewers get them.
    const duplicates = await ctx.db.query(
      `with d as (
         select re.id, re.source, re.delivery_count from raw_events re
         where re.delivery_count > 1 and ($1::text is null or re.source = $1)
           and ($2::text[] is null or payload_branch(re.payload) = any($2::text[])))
       select d.source, count(*) as redelivered, sum(d.delivery_count - 1) as extra,
              (array_agg(d.id order by d.delivery_count desc, d.id))[1:5] as sample_ids
       from d group by d.source order by d.source`,
      [input.source ?? null, scope],
    );
    const stored =
      scope === null
        ? await ctx.db.query<{ source: string; n: string }>("select source, count(*) as n from raw_events where ($1::text is null or source = $1) group by source", [input.source ?? null])
        : { rows: [] as Array<{ source: string; n: string }> };
    const storedBySource = new Map(stored.rows.map((r) => [r.source, Number(r.n)]));
    const conflicts = await listExceptions(ctx.db, { branchIds: scope, kind: "payload_conflict", limit: 10 });
    const streams = await freshness(ctx.db);
    const lastSuccess = await ctx.db.query<{ stream: string; id: string }>(
      `select distinct on (stream) stream, id from ingestion_runs where status = 'succeeded' order by stream, started_at desc, id desc`,
    );
    const lastSuccessByStream = new Map(lastSuccess.rows.map((r) => [r.stream, Number(r.id)]));
    const failed = await ctx.db.query(
      `select f.id, f.stream, f.started_at, f.error,
              (select r.id from ingestion_runs r where r.stream = f.stream and r.status = 'succeeded' and r.started_at > f.started_at
               order by r.started_at limit 1) as recovered_by
       from ingestion_runs f where f.status = 'failed' and ($1::text is null or f.source = $1)
       order by f.started_at desc limit 10`,
      [input.source ?? null],
    );
    const hours = (d: Date | null) => (d ? Math.round(((ctx.now.getTime() - new Date(d).getTime()) / 3_600_000) * 10) / 10 : null);
    const data: IngestionFailures = {
      scope,
      quarantineGroups: groups.rows.map((g) => ({
        source: g.source,
        errorCode: g.error_code,
        branchId: g.branch_id ?? null,
        records: num(g.records),
        adapterVersions: g.versions,
        firstOccurredAt: iso(g.first_at),
        lastOccurredAt: iso(g.last_at),
        sampleError: g.sample_error ?? null,
        sampleRawEventIds: (g.sample_ids as string[]).map(Number),
        exceptionId: g.exception_id === null ? null : Number(g.exception_id),
      })),
      duplicates: duplicates.rows.map((d) => ({
        source: d.source,
        recordsRedelivered: num(d.redelivered),
        duplicateDeliveries: num(d.extra),
        storedEvents: storedBySource.get(d.source) ?? null,
        sampleRawEventIds: ((d.sample_ids as string[] | null) ?? []).map(Number),
      })),
      payloadConflicts: conflicts.map((c) => ({ exceptionId: c.id, summary: c.summary, status: c.status })),
      streams: streams
        .filter((s) => !input.source || s.source === input.source)
        .map((s) => ({
          stream: s.stream,
          source: s.source,
          lastRunStatus: s.lastRunStatus,
          lastSuccessAt: iso(s.lastSuccessAt),
          hoursSinceSuccess: hours(s.lastSuccessAt),
          lastSuccessRunId: lastSuccessByStream.get(s.stream) ?? null,
          latestEventAt: iso(s.latestEventAt),
        })),
      failedRuns: failed.rows.map((f) => ({
        id: Number(f.id),
        stream: f.stream,
        startedAt: iso(f.started_at),
        error: f.error ?? null,
        recoveredByRunId: f.recovered_by === null ? null : Number(f.recovered_by),
      })),
    };
    const ids = [
      ...data.quarantineGroups.flatMap((g) => [...g.sampleRawEventIds.map(evidence.rawEvent), ...(g.exceptionId ? [evidence.exception(g.exceptionId)] : [])]),
      ...data.duplicates.flatMap((d) => d.sampleRawEventIds.map(evidence.rawEvent)),
      ...data.payloadConflicts.map((c) => evidence.exception(c.exceptionId)),
      ...data.streams.flatMap((s) => (s.lastSuccessRunId ? [evidence.ingestionRun(s.lastSuccessRunId)] : [])),
      ...data.failedRuns.flatMap((f) => [evidence.ingestionRun(f.id), ...(f.recoveredByRunId ? [evidence.ingestionRun(f.recoveredByRunId)] : [])]),
    ];
    const quarantined = data.quarantineGroups.reduce((s, g) => s + g.records, 0);
    const dupes = data.duplicates.reduce((s, d) => s + d.duplicateDeliveries, 0);
    return {
      data,
      evidenceIds: uniqueIds(ids),
      summary: `${quarantined} quarantined record(s) in ${data.quarantineGroups.length} group(s); ${dupes} duplicate deliveries absorbed; ${data.failedRuns.length} failed run(s); ${data.payloadConflicts.length} payload conflict(s)`,
    };
  },
});

// ── getReconciliationExceptions ──────────────────────────────────────────────

export interface ExceptionView {
  id: number;
  kind: string;
  severity: string;
  status: string;
  branchId: string | null;
  summary: string;
  amountCents: number;
  evidence: Record<string, unknown>;
  firstDetectedAt: string | null;
  lastDetectedAt: string | null;
  resolution: string | null;
  caseId: number | null;
  caseState: string | null;
}

export interface ReconciliationExceptions {
  scope: string[] | null;
  counts: Array<{ kind: string; open: number; resolved: number; amountCents: number }>;
  exceptions: ExceptionView[];
}

export const getReconciliationExceptions = defineTool({
  name: "getReconciliationExceptions",
  description:
    "Reconciliation exceptions in the viewer's scope: either one exception by exceptionId (with its full stored evidence and its Action Center case state), or a filtered list (branchId, kind, status, limit ≤ 25) plus open/resolved counts by kind. Kinds: quarantined_source_records, payment_without_ticket, branch_mismatch, unmapped_spend, channel_conflict, payload_conflict, channel_coverage_gap.",
  input: z.strictObject({
    exceptionId: id.optional(),
    branchId: branchId.optional(),
    kind: z
      .enum(["quarantined_source_records", "payment_without_ticket", "branch_mismatch", "unmapped_spend", "channel_conflict", "payload_conflict", "channel_coverage_gap"])
      .optional(),
    status: z.enum(["open", "resolved", "acknowledged"]).optional(),
    limit: z.number().int().min(1).max(25).default(10),
  }),
  async run(ctx, input): Promise<ToolOutput<ReconciliationExceptions>> {
    let exceptions: ExceptionRow[];
    let scope: string[] | null;
    if (input.exceptionId !== undefined) {
      const e = await exceptionInScope(ctx, input.exceptionId);
      exceptions = [e];
      scope = ctx.viewer.branchIds;
    } else {
      if (input.branchId) knownBranch(input.branchId);
      scope = resolveScope(ctx.viewer, input.branchId ?? null);
      exceptions = await listExceptions(ctx.db, { branchIds: scope, kind: input.kind, status: input.status, limit: input.limit });
    }
    const counts = await exceptionSummary(ctx.db, scope);
    const cases = await ctx.db.query<{ exception_id: string; id: string; state: string }>(
      "select exception_id, id, state from cases where exception_id = any($1::bigint[])",
      [exceptions.map((e) => e.id)],
    );
    const caseBy = new Map(cases.rows.map((c) => [Number(c.exception_id), { id: Number(c.id), state: c.state }]));
    const data: ReconciliationExceptions = {
      scope,
      counts,
      exceptions: exceptions.map((e) => ({
        id: e.id,
        kind: e.kind,
        severity: e.severity,
        status: e.status,
        branchId: e.branchId,
        summary: e.summary,
        amountCents: e.amountCents,
        evidence: e.evidence,
        firstDetectedAt: iso(e.firstDetectedAt),
        lastDetectedAt: iso(e.lastDetectedAt),
        resolution: e.resolution,
        caseId: caseBy.get(e.id)?.id ?? null,
        caseState: caseBy.get(e.id)?.state ?? null,
      })),
    };
    const ids = exceptions.flatMap((e) => [...exceptionEvidenceIds(e), ...(caseBy.get(e.id) ? [evidence.case(caseBy.get(e.id)!.id)] : [])]);
    return {
      data,
      evidenceIds: uniqueIds(ids),
      summary:
        input.exceptionId !== undefined
          ? `exception ${input.exceptionId}: ${exceptions[0].kind} (${exceptions[0].status}) — ${exceptions[0].summary}`
          : `${exceptions.length} exception(s)${input.kind ? ` of kind ${input.kind}` : ""}${input.branchId ? ` at ${input.branchId}` : ""}${input.status ? `, ${input.status}` : ""}`,
    };
  },
});

// ── compareMappingVersions ───────────────────────────────────────────────────

export interface MappingComparison {
  source: SourceName;
  fromVersion: string;
  toVersion: string;
  records: number;
  /** Mapper versions that projected (or refused) the compared records, as stored. */
  storedVersions: Record<string, number>;
  outcomes: { unchanged: number; changed: number; nowProjects: number; nowFails: number; stillFails: number };
  fieldChanges: Array<{ field: string; from: string; to: string; records: number; entities: number; costCents: number | null }>;
  samples: { changed: number[]; nowProjects: number[]; stillFails: Array<{ rawEventId: number; code: string; detail: string }> };
  truncated: boolean;
}

const COMPARE_LIMIT = 500;

/** Changes that move money or credit are listed first. */
const fieldRank = (field: string) => (field === "channelCode" ? 0 : field === "costCents" ? 1 : 2);

/** Scalar view of a projection field for diffing: dates as ISO strings, everything else JSON. */
function fieldValue(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  return typeof v === "string" ? v : JSON.stringify(v ?? null);
}

export const compareMappingVersions = defineTool({
  name: "compareMappingVersions",
  description:
    "Runs two mapper versions of one source over STORED raw records, read-only (pure mappers, nothing is written), and diffs the projections: how many records change, which fields change from what to what (with the spend affected for ad records), which held records would now project, and which still fail. Give exactly one record set: exceptionId (a quarantine group or a channel coverage gap's successor campaigns), campaignId, or rawEventIds (≤ 50).",
  input: z
    .strictObject({
      source,
      fromVersion: version,
      toVersion: version,
      exceptionId: id.optional(),
      campaignId: id.optional(),
      rawEventIds: z.array(id).min(1).max(50).optional(),
    })
    .refine((v) => [v.exceptionId, v.campaignId, v.rawEventIds].filter((x) => x !== undefined).length === 1, "give exactly one of exceptionId, campaignId, rawEventIds"),
  async run(ctx, input): Promise<ToolOutput<MappingComparison>> {
    for (const v of [input.fromVersion, input.toVersion]) {
      if (!mapperVersions(input.source).includes(v)) throw new ActionError(`No mapper ${input.source}@${v} (shipped: ${mapperVersions(input.source).join(", ")})`, 400);
    }
    const scopeIds: string[] = [];
    let rawIds: number[];
    if (input.exceptionId !== undefined) {
      const e = await exceptionInScope(ctx, input.exceptionId);
      scopeIds.push(evidence.exception(e.id));
      if (e.kind === "quarantined_source_records") {
        // The same group lib/ingest/replay.ts#quarantineGroupIds replays: source + error + branch.
        const { rows } = await ctx.db.query<{ id: string }>(
          `select re.id from raw_events re
           where re.status = 'quarantined' and re.source = $1 and re.error_code = $2
             and payload_branch(re.payload) is not distinct from $3
           order by re.id`,
          [String(e.evidence.source), String(e.evidence.errorCode), e.branchId],
        );
        rawIds = rows.map((r) => Number(r.id));
      } else if (e.kind === "channel_coverage_gap") {
        const successors = (e.evidence.successors as Array<{ externalCampaignId: string; platform: string; campaignId: number }> | null) ?? [];
        successors.forEach((s) => scopeIds.push(evidence.campaign(Number(s.campaignId))));
        const { rows } = await ctx.db.query<{ id: string }>(
          `select re.id from raw_events re where re.source = 'ads' and re.payload ->> 'campaignId' = any($1::text[]) order by re.id`,
          [successors.map((s) => s.externalCampaignId)],
        );
        rawIds = rows.map((r) => Number(r.id));
      } else {
        throw new ActionError(`A ${e.kind} exception has no stored records to re-map`, 400);
      }
    } else if (input.campaignId !== undefined) {
      const scope = await campaignBranch(ctx.db, input.campaignId);
      if (!scope.found || !canSeeBranch(ctx.viewer, scope.branchId)) throw notInScope(ctx.viewer, `Campaign ${input.campaignId}`);
      scopeIds.push(evidence.campaign(input.campaignId));
      const { rows } = await ctx.db.query<{ id: string }>(
        `select re.id from raw_events re join ad_campaigns c on c.id = $1
         where re.source = 'ads' and re.payload ->> 'platform' = c.platform and re.payload ->> 'campaignId' = c.external_campaign_id order by re.id`,
        [input.campaignId],
      );
      rawIds = rows.map((r) => Number(r.id));
    } else {
      rawIds = input.rawEventIds!;
    }

    const truncated = rawIds.length > COMPARE_LIMIT;
    const { rows } = await ctx.db.query(
      `select re.id, re.source, re.entity, re.entity_id, re.payload, re.received_at, re.adapter_version, ${RAW_EVENT_BRANCH} as branch_id
       from raw_events re where re.id = any($1::bigint[]) order by re.id`,
      [rawIds.slice(0, COMPARE_LIMIT)],
    );
    for (const r of rows) {
      if (r.source !== input.source) throw new ActionError(`Raw event ${r.id} is from ${r.source}, not ${input.source}`, 400);
      // Explicit id lists are checked record by record; exception/campaign sets were checked above.
      if (input.rawEventIds && !canSeeBranch(ctx.viewer, r.branch_id ?? null)) throw notInScope(ctx.viewer, `Raw event ${r.id}`);
    }
    if (input.rawEventIds && rows.length !== input.rawEventIds.length) throw notInScope(ctx.viewer, "Some raw events");

    const from = mapperFor(input.source, input.fromVersion);
    const to = mapperFor(input.source, input.toVersion);
    const outcomes = { unchanged: 0, changed: 0, nowProjects: 0, nowFails: 0, stillFails: 0 };
    const changes = new Map<string, { field: string; from: string; to: string; records: number; entities: Map<string, { at: number; cost: number | null }> }>();
    const samples: MappingComparison["samples"] = { changed: [], nowProjects: [], stillFails: [] };
    const storedVersions: Record<string, number> = {};
    for (const r of rows) {
      storedVersions[r.adapter_version] = (storedVersions[r.adapter_version] ?? 0) + 1;
      const record = { entity: r.entity, payload: r.payload };
      const mapCtx = { ...referenceContext, receivedAt: r.received_at as Date };
      const a = from.map(record, mapCtx);
      const b = to.map(record, mapCtx);
      if (!a.ok && !b.ok) {
        outcomes.stillFails++;
        if (samples.stillFails.length < 10) samples.stillFails.push({ rawEventId: Number(r.id), code: b.code, detail: b.detail });
      } else if (!a.ok && b.ok) {
        outcomes.nowProjects++;
        if (samples.nowProjects.length < 10) samples.nowProjects.push(Number(r.id));
      } else if (a.ok && !b.ok) {
        outcomes.nowFails++;
      } else if (a.ok && b.ok) {
        const ra = a.projection.row as unknown as Record<string, unknown>;
        const rb = b.projection.row as unknown as Record<string, unknown>;
        const diffs = [...new Set([...Object.keys(ra), ...Object.keys(rb)])].filter((k) => fieldValue(ra[k]) !== fieldValue(rb[k]));
        if (diffs.length === 0) {
          outcomes.unchanged++;
          continue;
        }
        outcomes.changed++;
        if (samples.changed.length < 10) samples.changed.push(Number(r.id));
        const cost = typeof rb.costCents === "number" ? rb.costCents : null;
        const at = new Date(r.received_at).getTime();
        for (const field of diffs) {
          const key = `${field}|${fieldValue(ra[field])}|${fieldValue(rb[field])}`;
          const entry = changes.get(key) ?? { field, from: fieldValue(ra[field]), to: fieldValue(rb[field]), records: 0, entities: new Map() };
          entry.records++;
          // A restated day is several stored versions of one entity: count its spend once (latest version).
          const prev = entry.entities.get(r.entity_id);
          if (!prev || prev.at <= at) entry.entities.set(r.entity_id, { at, cost });
          changes.set(key, entry);
        }
      }
    }
    const fieldChanges = [...changes.values()]
      .sort((x, y) => fieldRank(x.field) - fieldRank(y.field) || y.records - x.records)
      .slice(0, 10)
      .map((c) => {
        const costs = [...c.entities.values()].map((e) => e.cost);
        return {
          field: c.field,
          from: c.from,
          to: c.to,
          records: c.records,
          entities: c.entities.size,
          costCents: costs.every((x) => x === null) ? null : costs.reduce<number>((s, x) => s + (x ?? 0), 0),
        };
      });
    const data: MappingComparison = {
      source: input.source,
      fromVersion: input.fromVersion,
      toVersion: input.toVersion,
      records: rows.length,
      storedVersions,
      outcomes,
      fieldChanges,
      samples,
      truncated,
    };
    const ids = [...scopeIds, ...samples.changed.map(evidence.rawEvent), ...samples.nowProjects.map(evidence.rawEvent), ...samples.stillFails.map((s) => evidence.rawEvent(s.rawEventId))];
    const top = fieldChanges[0];
    return {
      data,
      evidenceIds: uniqueIds(ids),
      summary: `${input.source}@${input.fromVersion} → @${input.toVersion} over ${rows.length} stored record(s): ${outcomes.changed} change, ${outcomes.nowProjects} now project, ${outcomes.stillFails} still fail${top ? `; top change ${top.field} ${top.from} → ${top.to} (${top.records})` : ""}`,
    };
  },
});

// ── inspectCampaignClassification ────────────────────────────────────────────

export interface CampaignClassification {
  campaigns: Array<{
    campaignId: number;
    name: string;
    platform: string;
    adAccountId: string;
    externalCampaignId: string;
    mappedBranch: string | null;
    storedChannel: string;
    payloadCampaignType: string | null;
    payloadLocalServicesEnabled: boolean | null;
    latestRawEventId: number | null;
    latestAdapterVersion: string | null;
    /** The channel the deployed ads mapper assigns to the latest stored payload. */
    activeMapperChannel: string | null;
    activeMapperVersion: string;
    /** Stored classification differs from what the deployed mapper says. */
    mismatch: boolean;
    spendByClassification: Array<{ adapterVersion: string; channelCode: string; days: number; costCents: number }>;
  }>;
}

export const inspectCampaignClassification = defineTool({
  name: "inspectCampaignClassification",
  description:
    "How ad campaigns are classified into channels: for one campaignId, or every campaign mapped to a branchId. Shows the stored channel, the campaign type and local-services flag in the latest stored raw payload, the channel the deployed ads mapper assigns to that payload, whether they disagree, and spend grouped by the mapper version and channel that classified it.",
  input: z
    .strictObject({ campaignId: id.optional(), branchId: branchId.optional() })
    .refine((v) => (v.campaignId === undefined) !== (v.branchId === undefined), "give exactly one of campaignId, branchId"),
  async run(ctx, input): Promise<ToolOutput<CampaignClassification>> {
    let campaignIds: number[];
    if (input.campaignId !== undefined) {
      const scope = await campaignBranch(ctx.db, input.campaignId);
      if (!scope.found || !canSeeBranch(ctx.viewer, scope.branchId)) throw notInScope(ctx.viewer, `Campaign ${input.campaignId}`);
      campaignIds = [input.campaignId];
    } else {
      knownBranch(input.branchId!);
      resolveScope(ctx.viewer, input.branchId);
      const { rows } = await ctx.db.query<{ campaign_id: string }>(
        "select campaign_id from campaign_branch_map where branch_id = $1 order by campaign_id limit 20",
        [input.branchId],
      );
      campaignIds = rows.map((r) => Number(r.campaign_id));
    }
    const { rows } = await ctx.db.query(
      `select c.*, m.branch_id as mapped_branch,
              (select re.id from raw_events re where re.source = 'ads' and re.payload ->> 'platform' = c.platform
                 and re.payload ->> 'campaignId' = c.external_campaign_id order by re.received_at desc, re.id desc limit 1) as latest_raw_id
       from ad_campaigns c left join campaign_branch_map m on m.campaign_id = c.id
       where c.id = any($1::bigint[]) order by c.id`,
      [campaignIds],
    );
    const latestIds = rows.map((r) => r.latest_raw_id).filter(Boolean).map(Number);
    const latest = await ctx.db.query("select id, entity, payload, received_at, adapter_version from raw_events where id = any($1::bigint[])", [latestIds]);
    const latestById = new Map(latest.rows.map((r) => [Number(r.id), r]));
    const spend = await ctx.db.query(
      `select s.campaign_id, re.adapter_version, s.channel_code, count(*) as days, sum(s.cost_cents) as cost
       from ad_spend_daily s join raw_events re on re.id = s.raw_event_id
       where s.campaign_id = any($1::bigint[]) group by 1, 2, 3 order by 1, 2, 3`,
      [campaignIds],
    );
    const active = mapperFor("ads");
    const data: CampaignClassification = {
      campaigns: rows.map((c) => {
        const raw = c.latest_raw_id ? latestById.get(Number(c.latest_raw_id)) : undefined;
        const payload = (raw?.payload ?? null) as Record<string, unknown> | null;
        const mapped = raw ? active.map({ entity: raw.entity, payload: raw.payload }, { ...referenceContext, receivedAt: raw.received_at }) : null;
        const activeChannel = mapped && mapped.ok && mapped.projection.table === "ad_spend_daily" ? mapped.projection.row.channelCode : null;
        const spendRows = spend.rows.filter((s) => Number(s.campaign_id) === Number(c.id));
        const storedChannels = new Set<string>([c.channel_code, ...spendRows.map((s) => s.channel_code as string)]);
        return {
          campaignId: Number(c.id),
          name: c.name,
          platform: c.platform,
          adAccountId: c.ad_account_id,
          externalCampaignId: c.external_campaign_id,
          mappedBranch: c.mapped_branch ?? null,
          storedChannel: c.channel_code,
          payloadCampaignType: typeof payload?.campaignType === "string" ? payload.campaignType : null,
          payloadLocalServicesEnabled: typeof payload?.localServicesEnabled === "boolean" ? payload.localServicesEnabled : null,
          latestRawEventId: raw ? Number(raw.id) : null,
          latestAdapterVersion: raw?.adapter_version ?? null,
          activeMapperChannel: activeChannel,
          activeMapperVersion: ACTIVE_VERSION.ads,
          mismatch: activeChannel !== null && [...storedChannels].some((ch) => ch !== activeChannel),
          spendByClassification: spendRows.map((s) => ({ adapterVersion: s.adapter_version, channelCode: s.channel_code, days: num(s.days), costCents: num(s.cost) })),
        };
      }),
    };
    const ids = data.campaigns.flatMap((c) => [evidence.campaign(c.campaignId), ...(c.latestRawEventId ? [evidence.rawEvent(c.latestRawEventId)] : [])]);
    const mismatched = data.campaigns.filter((c) => c.mismatch);
    return {
      data,
      evidenceIds: uniqueIds(ids),
      summary: `${data.campaigns.length} campaign(s); ${mismatched.length} classified differently from ads@${ACTIVE_VERSION.ads}${mismatched.length ? `: ${mismatched.map((c) => `${c.campaignId} stored ${c.storedChannel} vs ${c.activeMapperChannel}`).join(", ")}` : ""}`,
    };
  },
});

// ── getMetricDefinition ──────────────────────────────────────────────────────

const METRIC_KEYS = Object.keys(METRICS) as [string, ...string[]];

export const getMetricDefinition = defineTool({
  name: "getMetricDefinition",
  description: `The registered definition of a metric: formula, sources and caveat. Keys: ${METRIC_KEYS.join(", ")}.`,
  input: z.strictObject({ key: z.enum(METRIC_KEYS) }),
  async run(_ctx, input) {
    const def = METRICS[input.key];
    return { data: def, evidenceIds: [evidence.metricDefinition(def.key)], summary: `${def.label}: ${def.formula}` };
  },
});

// ── getAuditHistory ──────────────────────────────────────────────────────────

export interface AuditHistory {
  exceptionId: number | null;
  caseId: number | null;
  rows: Array<{ id: number; at: string | null; actor: string; action: string; subject: string; detail: Record<string, unknown> }>;
}

export const getAuditHistory = defineTool({
  name: "getAuditHistory",
  description:
    "Audit log rows: for one exceptionId (its case's events, decisions and the writes its executions made), or — for viewers with company-wide scope only — by subject prefix (e.g. 'campaign:12', 'case:', 'investigation:'). Newest first, limit ≤ 50.",
  input: z
    .strictObject({ exceptionId: id.optional(), subject: z.string().min(2).max(60).regex(/^[a-z_]+:[A-Za-z0-9_:-]*$/).optional(), limit: z.number().int().min(1).max(50).default(20) })
    .refine((v) => (v.exceptionId === undefined) !== (v.subject === undefined), "give exactly one of exceptionId, subject"),
  async run(ctx, input): Promise<ToolOutput<AuditHistory>> {
    let rows;
    let caseId: number | null = null;
    if (input.exceptionId !== undefined) {
      await exceptionInScope(ctx, input.exceptionId);
      const kase = await caseForException(ctx.db, input.exceptionId);
      caseId = kase?.id ?? null;
      rows = kase ? await caseAudit(ctx.db, kase.id, input.exceptionId, input.limit) : await auditFeed(ctx.db, { subject: `exception:${input.exceptionId}`, limit: input.limit });
    } else {
      // Audit rows carry no branch, so a branch-scoped viewer may only read them through an
      // exception they can see.
      if (ctx.viewer.branchIds) throw new ForbiddenError(`${ctx.viewer.label} can read audit history per exception only`);
      rows = await auditFeed(ctx.db, { subject: input.subject, limit: input.limit });
    }
    const data: AuditHistory = {
      exceptionId: input.exceptionId ?? null,
      caseId,
      rows: rows.map((r) => ({ id: r.id, at: iso(r.at), actor: r.actor, action: r.action, subject: r.subject, detail: r.detail })),
    };
    return {
      data,
      evidenceIds: uniqueIds([...(caseId ? [evidence.case(caseId)] : []), ...data.rows.map((r) => evidence.audit(r.id))]),
      summary: `${data.rows.length} audit row(s)${input.exceptionId ? ` for exception ${input.exceptionId}` : ` for ${input.subject}`}`,
    };
  },
});

// ── getDecisionReadiness ─────────────────────────────────────────────────────

export interface DecisionReadiness {
  branchId: string;
  period: string;
  budgetSignal: { signal: string; ratio: number | null; trustworthy: boolean; from: string | null; to: string | null };
  channels: Array<{
    channelCode: string;
    label: string;
    spendCents: number;
    acquired: number;
    cacCents: number | null;
    integrity: { status: string; failing: Array<{ code: string; status: string; text: string }> };
    readiness: { status: string; blockers: Array<{ code: string; text: string }> };
    effectiveness: { status: string };
  }>;
}

export const getDecisionReadiness = defineTool({
  name: "getDecisionReadiness",
  description:
    "Decision Lab verdicts for every paid-media channel at a branch and period: data integrity (are the records classified and reconciled), decision readiness (enough reliable evidence to move budget, with blockers) and business effectiveness (only a randomized experiment can say; attribution never does), plus the budget signal and whether it is trustworthy.",
  input: z.strictObject({ branchId, period }),
  async run(ctx, input): Promise<ToolOutput<DecisionReadiness>> {
    knownBranch(input.branchId);
    const v = await decisionVerdicts(ctx.db, ctx.viewer, { branchId: input.branchId, period: PERIODS[input.period] });
    const exceptionIds = new Set<number>();
    const collect = (href?: string) => {
      const m = href ? /^\/exceptions\/(\d+)$/.exec(href) : null;
      if (m) exceptionIds.add(Number(m[1]));
    };
    const data: DecisionReadiness = {
      branchId: v.branchId,
      period: input.period,
      budgetSignal: {
        signal: v.budgetSignal.signal,
        ratio: v.budgetSignal.ratio,
        trustworthy: v.budgetSignal.trustworthy,
        from: v.budgetSignal.from?.channelCode ?? null,
        to: v.budgetSignal.to?.channelCode ?? null,
      },
      channels: v.channels.map((c) => {
        [...c.integrity.reasons, ...c.readiness.reasons].forEach((r) => collect(r.href));
        return {
          channelCode: c.channelCode,
          label: c.label,
          spendCents: c.spendCents,
          acquired: c.acquired,
          cacCents: c.cacCents,
          integrity: { status: c.integrity.status, failing: c.integrity.reasons.filter((r) => r.status === "fail" || r.status === "warn").map((r) => ({ code: r.code, status: r.status, text: r.text })) },
          readiness: { status: c.readiness.status, blockers: c.readiness.blockers.map((r) => ({ code: r.code, text: r.text })) },
          effectiveness: { status: c.effectiveness.status },
        };
      }),
    };
    return {
      data,
      evidenceIds: uniqueIds([...data.channels.map((c) => evidence.readiness(input.branchId, input.period, c.channelCode)), ...[...exceptionIds].map(evidence.exception)]),
      summary: `${input.branchId} ${input.period}: ${data.channels.filter((c) => c.readiness.status === "ready").length}/${data.channels.length} channel(s) decision-ready; budget signal ${data.budgetSignal.signal}${data.budgetSignal.trustworthy ? "" : " (not trustworthy)"}`,
    };
  },
});

// ── registry ─────────────────────────────────────────────────────────────────

export const TOOLS = {
  getBranchMetrics,
  getCustomerJourney: getCustomerJourneyTool,
  getSourceLineage,
  getIngestionFailures,
  getReconciliationExceptions,
  compareMappingVersions,
  inspectCampaignClassification,
  getMetricDefinition,
  getAuditHistory,
  getDecisionReadiness,
} as const;

export type ToolName = keyof typeof TOOLS;
export const TOOL_NAMES = Object.keys(TOOLS) as ToolName[];

export function isToolName(value: string): value is ToolName {
  return Object.hasOwn(TOOLS, value);
}

/** The output type of a tool, for typed deterministic plans. */
export type ToolData<N extends ToolName> = Awaited<ReturnType<(typeof TOOLS)[N]["run"]>>["data"];

/** The input a caller may pass to a tool (before defaults are applied). */
export type ToolInput<N extends ToolName> = z.input<(typeof TOOLS)[N]["input"]>;
