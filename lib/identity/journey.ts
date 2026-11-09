import type { Queryable } from "@/lib/db";
import { listIdentityConflicts, type IdentityConflict } from "./conflicts";
import { journeyPath, type IdentityKind, type IdentityRule, type Lifecycle } from "./types";

/**
 * Customer 360: one person's records from every source, as stored, in one chronological
 * timeline. Every item carries the projection table and id it came from and the raw event that
 * projected it, so any line can be traced back to the exact source payload and mapper version.
 *
 * Nothing is inferred here. Identity comes from identity_links (resolveIdentities), credit from
 * v_acquisitions, money from crm_payments (refunds are negative rows). A field the source did
 * not send is reported as an explicit unknown, never filled in.
 */

export type SourceName = "crm" | "calls" | "web" | "d2d";
export type SourceTable = "leads" | "crm_customers" | "crm_subscriptions" | "crm_appointments" | "crm_tickets" | "crm_payments";

/** Where a record came from: enough to open its raw payload. */
interface Provenance {
  rawEventId: number;
  adapterVersion: string;
  receivedAt: string;
  sourceUpdatedAt: string;
}

export interface JourneyLead extends Provenance {
  id: number;
  source: "calls" | "web" | "d2d";
  sourceLeadId: string;
  branchId: string | null;
  effectiveBranchId: string | null;
  branchOverridden: boolean;
  channelCode: string;
  attributionEvidence: string;
  campaignExternalId: string | null;
  clickId: string | null;
  hasPhone: boolean;
  hasEmail: boolean;
  zip: string | null;
  heardAboutText: string | null;
  occurredAt: string;
  linkRule: IdentityRule | null;
}

export interface JourneyLink {
  id: number;
  source: SourceName;
  sourceRecordId: string;
  recordTable: "crm_customers" | "leads";
  recordId: number;
  rule: IdentityRule;
  confidence: number;
  evidence: Record<string, unknown>;
  linkedAt: string;
}

export interface JourneySubscription extends Provenance {
  id: number;
  serviceType: string;
  soldByRep: string | null;
  sourceLabel: string | null;
  annualValueCents: number;
  status: "active" | "cancelled";
  soldAt: string;
  cancelledAt: string | null;
  branchId: string | null;
}

export interface JourneyAppointment extends Provenance {
  id: number;
  subscriptionId: number;
  kind: "initial" | "recurring";
  status: string;
  scheduledFor: string;
  completedAt: string | null;
}

export interface JourneyTicket extends Provenance {
  id: number;
  appointmentId: number | null;
  templateType: string;
  totalCents: number;
  invoicedAt: string;
}

export interface JourneyPayment extends Provenance {
  id: number;
  ticketId: number | null;
  amountCents: number;
  originalPaymentId: number | null;
  status: "successful" | "failed" | "voided";
  paidAt: string;
  isRefund: boolean;
}

export type TimelineKind =
  | "lead"
  | "customer_created"
  | "subscription_sold"
  | "subscription_cancelled"
  | "appointment"
  | "ticket"
  | "payment"
  | "refund";

export interface TimelineItem {
  key: string;
  at: string;
  kind: TimelineKind;
  source: SourceName;
  sourceTable: SourceTable;
  /** The projection row's id (leads.id or the CRM id). */
  sourceId: string;
  /** The id in the source system (CRM id, CallRail call id, web messageId, D2D saleId). */
  sourceRecordId: string;
  rawEventId: number;
  adapterVersion: string;
  title: string;
  detail: string;
  amountCents: number | null;
  tone: "neutral" | "good" | "bad" | "warn" | "accent";
  /** For leads: the identity rule that attached it; whether attribution credits it. */
  linkRule?: IdentityRule | null;
  credited?: boolean;
}

export interface UnresolvedMatch {
  leadId: number;
  source: string;
  sourceLeadId: string;
  occurredAt: string;
  matchedOn: Array<"phone_hash" | "email_hash">;
  /** linked_elsewhere: a reviewer or a rule attached it to another identity. */
  state: "pending_review" | "linked_elsewhere" | "not_yet_resolved";
  linkedTo: { identityId: number; kind: IdentityKind; crmCustomerId: number | null; rule: IdentityRule } | null;
}

export interface Freshness {
  entity: string;
  records: number;
  latestSourceUpdatedAt: string | null;
  latestReceivedAt: string | null;
}

export interface Unknown {
  subject: string;
  field: string;
  note: string;
}

export interface Attribution {
  subscriptionId: number;
  soldAt: string;
  channelCode: string;
  attributionBasis: "lead_evidence" | "lead_without_evidence" | "no_lead_record";
  attributionEvidence: string | null;
  creditedLeadId: number | null;
  creditedLeadSource: string | null;
  creditedLeadSourceId: string | null;
  creditedLeadAt: string | null;
  creditedLeadLinked: boolean;
  leadBranchId: string | null;
  campaignExternalId: string | null;
  campaignName: string | null;
  campaignPlatform: string | null;
  initialStatus: string;
  initialCompletedAt: string | null;
  channelConflict: boolean;
  annualValueCents: number;
}

export interface CustomerJourney {
  ref: { kind: IdentityKind; identityId: number | null; crmCustomerId: number | null; path: string; anchorKey: string | null };
  overview: {
    branchId: string | null;
    lifecycle: Lifecycle;
    customerSince: string | null;
    firstTouch: { at: string; source: string; sourceLeadId: string; channelCode: string } | null;
    leadRecords: number;
    flags: {
      pendingConflicts: number;
      d2dPaidConflict: boolean;
      openExceptions: Array<{ id: number; kind: string; status: string }>;
      noLeadRecord: boolean;
    };
    /** Prospect identities whose leads now belong to a CRM customer are retired, not deleted. */
    retired: { at: string; nowPartOf: Array<{ identityId: number; crmCustomerId: number | null }> } | null;
  };
  customer: (Provenance & { crmCustomerId: number; officeId: number; sourceLabel: string | null; hasPhone: boolean; hasEmail: boolean; zip: string | null; createdAtSource: string }) | null;
  attribution: Attribution | null;
  links: JourneyLink[];
  conflicts: IdentityConflict[];
  unresolvedMatches: UnresolvedMatch[];
  leads: JourneyLead[];
  subscriptions: JourneySubscription[];
  appointments: JourneyAppointment[];
  tickets: JourneyTicket[];
  payments: JourneyPayment[];
  money: { paymentsCents: number; refundsCents: number; collectedCents: number; failedOrVoidedCents: number; invoicedCents: number };
  timeline: TimelineItem[];
  freshness: Freshness[];
  unknowns: Unknown[];
  resolution: { identityResolved: boolean; lastRunAt: string | null };
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const num = (v: string | number | null | undefined) => (v === null || v === undefined ? null : Number(v));

interface ProvenanceRow {
  raw_event_id: string;
  adapter_version: string;
  received_at: Date;
  source_updated_at: Date;
}

const provenance = (r: ProvenanceRow): Provenance => ({
  rawEventId: Number(r.raw_event_id),
  adapterVersion: r.adapter_version,
  receivedAt: r.received_at.toISOString(),
  sourceUpdatedAt: r.source_updated_at.toISOString(),
});

/**
 * Out of scope is indistinguishable from missing, as on every other route: a journey outside the
 * viewer's branches is reported as absent (null), never refused with a message naming its
 * branch, so a branch-scoped viewer cannot probe which ids exist or where they belong.
 */
function inScope(scope: string[] | null, branchId: string | null): boolean {
  return scope === null || (branchId !== null && scope.includes(branchId));
}

/**
 * The journey of one CRM customer. Null when the customer does not exist or belongs to a branch
 * outside `scope` (resolveScope output; null = all branches): the two cases are identical.
 */
export async function getCustomerJourney(db: Queryable, crmCustomerId: number, scope: string[] | null): Promise<CustomerJourney | null> {
  const customer = await db.query<
    ProvenanceRow & { crm_customer_id: string; office_id: number; branch_id: string | null; source_label: string | null; phone_hash: string | null; email_hash: string | null; zip: string | null; created_at_source: Date }
  >(
    `select c.crm_customer_id, c.office_id, b.id as branch_id, c.source_label, c.phone_hash, c.email_hash, c.zip,
            c.created_at_source, c.source_updated_at, c.raw_event_id, r.adapter_version, r.received_at
     from crm_customers c
     join raw_events r on r.id = c.raw_event_id
     left join branches b on b.crm_office_id = c.office_id
     where c.crm_customer_id = $1`,
    [crmCustomerId],
  );
  const c = customer.rows[0];
  if (!c || !inScope(scope, c.branch_id)) return null;

  const identity = await db.query<{ id: string; anchor_key: string }>("select id, anchor_key from identities where crm_customer_id = $1", [crmCustomerId]);
  const identityId = num(identity.rows[0]?.id);

  const [links, leads, subs, appts, tickets, payments, acquisition, unresolved, conflicts, exceptions, lastRun] = await Promise.all([
    identityId === null ? Promise.resolve([]) : loadLinks(db, identityId),
    identityId === null ? Promise.resolve([]) : loadLeads(db, identityId),
    db.query<ProvenanceRow & { crm_subscription_id: string; service_type: string; sold_by_rep: string | null; source_label: string | null; annual_value_cents: string; status: "active" | "cancelled"; sold_at: Date; cancelled_at: Date | null; branch_id: string | null }>(
      `select s.crm_subscription_id, s.service_type, s.sold_by_rep, s.source_label, s.annual_value_cents, s.status, s.sold_at,
              s.cancelled_at, s.source_updated_at, s.raw_event_id, r.adapter_version, r.received_at, b.id as branch_id
       from crm_subscriptions s join raw_events r on r.id = s.raw_event_id
       left join branches b on b.crm_office_id = s.office_id
       where s.crm_customer_id = $1 order by s.sold_at, s.crm_subscription_id`,
      [crmCustomerId],
    ),
    db.query<ProvenanceRow & { crm_appointment_id: string; crm_subscription_id: string; kind: "initial" | "recurring"; status: string; scheduled_for: Date; completed_at: Date | null }>(
      `select a.crm_appointment_id, a.crm_subscription_id, a.kind, a.status, a.scheduled_for, a.completed_at,
              a.source_updated_at, a.raw_event_id, r.adapter_version, r.received_at
       from crm_appointments a join raw_events r on r.id = a.raw_event_id
       where a.crm_customer_id = $1 order by a.scheduled_for, a.crm_appointment_id`,
      [crmCustomerId],
    ),
    db.query<ProvenanceRow & { crm_ticket_id: string; crm_appointment_id: string | null; template_type: string; total_cents: string; invoiced_at: Date }>(
      `select t.crm_ticket_id, t.crm_appointment_id, t.template_type, t.total_cents, t.invoiced_at,
              t.source_updated_at, t.raw_event_id, r.adapter_version, r.received_at
       from crm_tickets t join raw_events r on r.id = t.raw_event_id
       where t.crm_customer_id = $1 order by t.invoiced_at, t.crm_ticket_id`,
      [crmCustomerId],
    ),
    db.query<ProvenanceRow & { crm_payment_id: string; crm_ticket_id: string | null; amount_cents: string; original_payment_id: string | null; status: "successful" | "failed" | "voided"; paid_at: Date }>(
      `select p.crm_payment_id, p.crm_ticket_id, p.amount_cents, p.original_payment_id, p.status, p.paid_at,
              p.source_updated_at, p.raw_event_id, r.adapter_version, r.received_at
       from crm_payments p join raw_events r on r.id = p.raw_event_id
       where p.crm_customer_id = $1 order by p.paid_at, p.crm_payment_id`,
      [crmCustomerId],
    ),
    db.query<{
      crm_subscription_id: string; sold_at: Date; channel_code: string; attribution_basis: Attribution["attributionBasis"];
      attribution_evidence: string | null; lead_id: string | null; lead_branch_id: string | null; campaign_external_id: string | null;
      initial_status: string; initial_completed_at: Date | null; channel_conflict: boolean; annual_value_cents: string;
      lead_source: string | null; lead_source_id: string | null; lead_at: Date | null; campaign_name: string | null; campaign_platform: string | null;
    }>(
      `select a.crm_subscription_id, a.sold_at, a.channel_code, a.attribution_basis, a.attribution_evidence, a.lead_id,
              a.lead_branch_id, a.campaign_external_id, a.initial_status, a.initial_completed_at, a.channel_conflict,
              a.annual_value_cents, l.source as lead_source, l.source_lead_id as lead_source_id, l.occurred_at as lead_at,
              cp.name as campaign_name, cp.platform as campaign_platform
       from v_acquisitions a
       left join leads l on l.id = a.lead_id
       left join lateral (
         select name, platform from ad_campaigns where external_campaign_id = a.campaign_external_id order by id limit 1
       ) cp on true
       where a.crm_customer_id = $1`,
      [crmCustomerId],
    ),
    loadUnresolvedMatches(db, identityId, c.phone_hash, c.email_hash, scope),
    listIdentityConflicts(db, { status: "all", crmCustomerId, limit: 200 }, scope),
    db.query<{ id: string; kind: string; status: string; branch_id: string | null }>(
      `select id, kind, status, branch_id from exceptions
       where ($1::bigint = any(customer_ids) or (subject_type = 'acquisition' and subject_id = $1::text))
       order by (status = 'open') desc, id desc`,
      [crmCustomerId],
    ),
    lastFullRun(db),
  ]);

  const subscriptions: JourneySubscription[] = subs.rows.map((s) => ({
    ...provenance(s),
    id: Number(s.crm_subscription_id),
    serviceType: s.service_type,
    soldByRep: s.sold_by_rep,
    sourceLabel: s.source_label,
    annualValueCents: Number(s.annual_value_cents),
    status: s.status,
    soldAt: s.sold_at.toISOString(),
    cancelledAt: iso(s.cancelled_at),
    branchId: s.branch_id,
  }));
  const appointments: JourneyAppointment[] = appts.rows.map((a) => ({
    ...provenance(a),
    id: Number(a.crm_appointment_id),
    subscriptionId: Number(a.crm_subscription_id),
    kind: a.kind,
    status: a.status,
    scheduledFor: a.scheduled_for.toISOString(),
    completedAt: iso(a.completed_at),
  }));
  const ticketRows: JourneyTicket[] = tickets.rows.map((t) => ({
    ...provenance(t),
    id: Number(t.crm_ticket_id),
    appointmentId: num(t.crm_appointment_id),
    templateType: t.template_type,
    totalCents: Number(t.total_cents),
    invoicedAt: t.invoiced_at.toISOString(),
  }));
  const paymentRows: JourneyPayment[] = payments.rows.map((p) => ({
    ...provenance(p),
    id: Number(p.crm_payment_id),
    ticketId: num(p.crm_ticket_id),
    amountCents: Number(p.amount_cents),
    originalPaymentId: num(p.original_payment_id),
    status: p.status,
    paidAt: p.paid_at.toISOString(),
    isRefund: Number(p.amount_cents) < 0,
  }));

  const a = acquisition.rows[0];
  const attribution: Attribution | null = a
    ? {
        subscriptionId: Number(a.crm_subscription_id),
        soldAt: a.sold_at.toISOString(),
        channelCode: a.channel_code,
        attributionBasis: a.attribution_basis,
        attributionEvidence: a.attribution_evidence,
        creditedLeadId: num(a.lead_id),
        creditedLeadSource: a.lead_source,
        creditedLeadSourceId: a.lead_source_id,
        creditedLeadAt: iso(a.lead_at),
        creditedLeadLinked: a.lead_id !== null && leads.some((l) => l.id === Number(a.lead_id)),
        leadBranchId: a.lead_branch_id,
        campaignExternalId: a.campaign_external_id,
        campaignName: a.campaign_name,
        campaignPlatform: a.campaign_platform,
        initialStatus: a.initial_status,
        initialCompletedAt: iso(a.initial_completed_at),
        channelConflict: a.channel_conflict,
        annualValueCents: Number(a.annual_value_cents),
      }
    : null;

  const successful = paymentRows.filter((p) => p.status === "successful");
  const money = {
    paymentsCents: successful.filter((p) => p.amountCents > 0).reduce((s, p) => s + p.amountCents, 0),
    refundsCents: -successful.filter((p) => p.amountCents < 0).reduce((s, p) => s + p.amountCents, 0),
    collectedCents: successful.reduce((s, p) => s + p.amountCents, 0),
    failedOrVoidedCents: paymentRows.filter((p) => p.status !== "successful").reduce((s, p) => s + p.amountCents, 0),
    invoicedCents: ticketRows.reduce((s, t) => s + t.totalCents, 0),
  };

  const lifecycle: Lifecycle =
    subscriptions.length === 0
      ? "unknown"
      : subscriptions.every((s) => s.status === "cancelled")
        ? "cancelled"
        : appointments.some((x) => x.status === "completed")
          ? "serviced"
          : "sold";

  const creditedId = attribution?.creditedLeadId ?? null;
  const customerRow = {
    ...provenance(c),
    crmCustomerId: Number(c.crm_customer_id),
    officeId: c.office_id,
    sourceLabel: c.source_label,
    hasPhone: c.phone_hash !== null,
    hasEmail: c.email_hash !== null,
    zip: c.zip,
    createdAtSource: c.created_at_source.toISOString(),
  };

  const timeline = buildTimeline({ customer: customerRow, leads, subscriptions, appointments, tickets: ticketRows, payments: paymentRows, creditedLeadId: creditedId });
  const firstLead = leads[0];

  return {
    ref: { kind: "customer", identityId, crmCustomerId, path: journeyPath({ kind: "customer", crmCustomerId, identityId: identityId ?? 0 }), anchorKey: identity.rows[0]?.anchor_key ?? null },
    overview: {
      branchId: c.branch_id,
      lifecycle,
      customerSince: c.created_at_source.toISOString(),
      firstTouch: firstLead ? { at: firstLead.occurredAt, source: firstLead.source, sourceLeadId: firstLead.sourceLeadId, channelCode: firstLead.channelCode } : null,
      leadRecords: leads.length,
      flags: {
        pendingConflicts: conflicts.rows.filter((k) => k.status === "pending").length,
        d2dPaidConflict: attribution?.channelConflict ?? false,
        openExceptions: exceptions.rows
          .filter((e) => inScope(scope, e.branch_id))
          .map((e) => ({ id: Number(e.id), kind: e.kind, status: e.status })),
        noLeadRecord: attribution?.attributionBasis === "no_lead_record",
      },
      retired: null,
    },
    customer: customerRow,
    attribution,
    links,
    conflicts: conflicts.rows,
    unresolvedMatches: unresolved,
    leads,
    subscriptions,
    appointments,
    tickets: ticketRows,
    payments: paymentRows,
    money,
    timeline,
    freshness: freshness({ customer: customerRow, leads, subscriptions, appointments, tickets: ticketRows, payments: paymentRows }),
    unknowns: unknowns({ customer: customerRow, leads, subscriptions, tickets: ticketRows, payments: paymentRows, attribution }),
    resolution: { identityResolved: identityId !== null, lastRunAt: lastRun },
  };
}

/** The journey of a prospect identity (leads only, no CRM customer). Same scope rules: out of scope → null. */
export async function getProspectJourney(db: Queryable, identityId: number, scope: string[] | null): Promise<CustomerJourney | null> {
  const found = await db.query<{ id: string; anchor_key: string; branch_id: string | null; retired_at: Date | null }>(
    "select id, anchor_key, branch_id, retired_at from identities where id = $1 and kind = 'prospect'",
    [identityId],
  );
  const p = found.rows[0];
  if (!p || !inScope(scope, p.branch_id)) return null;

  const [links, leads, lastRun] = await Promise.all([loadLinks(db, identityId), loadLeads(db, identityId), lastFullRun(db)]);
  const conflicts = leads.length
    ? (await listIdentityConflicts(db, { status: "all", leadIds: leads.map((l) => l.id), limit: 200 }, scope)).rows
    : [];

  // A retired prospect: where did its leads go? Look them up by the anchor hash.
  let retired: CustomerJourney["overview"]["retired"] = null;
  if (p.retired_at) {
    const [keyKind, hash] = p.anchor_key.split(":");
    // Only successors in the viewer's scope are named; others would leak another branch's ids.
    const now = await db.query<{ identity_id: string; crm_customer_id: string | null }>(
      `select distinct i.id as identity_id, i.crm_customer_id
       from leads l
       join identity_links k on k.record_table = 'leads' and k.record_id = l.id
       join identities i on i.id = k.identity_id
       where (case when $1 = 'phone' then l.phone_hash else l.email_hash end) = $2
         and ($3::text[] is null or i.branch_id = any($3::text[]))
       order by i.id`,
      [keyKind, hash, scope],
    );
    retired = { at: p.retired_at.toISOString(), nowPartOf: now.rows.map((r) => ({ identityId: Number(r.identity_id), crmCustomerId: num(r.crm_customer_id) })) };
  }

  const firstLead = leads[0];
  return {
    ref: { kind: "prospect", identityId, crmCustomerId: null, path: journeyPath({ kind: "prospect", crmCustomerId: null, identityId }), anchorKey: p.anchor_key },
    overview: {
      branchId: p.branch_id,
      lifecycle: "prospect",
      customerSince: null,
      firstTouch: firstLead ? { at: firstLead.occurredAt, source: firstLead.source, sourceLeadId: firstLead.sourceLeadId, channelCode: firstLead.channelCode } : null,
      leadRecords: leads.length,
      flags: { pendingConflicts: conflicts.filter((k) => k.status === "pending").length, d2dPaidConflict: false, openExceptions: [], noLeadRecord: false },
      retired,
    },
    customer: null,
    attribution: null,
    links,
    conflicts,
    unresolvedMatches: [],
    leads,
    subscriptions: [],
    appointments: [],
    tickets: [],
    payments: [],
    money: { paymentsCents: 0, refundsCents: 0, collectedCents: 0, failedOrVoidedCents: 0, invoicedCents: 0 },
    timeline: buildTimeline({ customer: null, leads, subscriptions: [], appointments: [], tickets: [], payments: [], creditedLeadId: null }),
    freshness: freshness({ customer: null, leads, subscriptions: [], appointments: [], tickets: [], payments: [] }),
    unknowns: unknowns({ customer: null, leads, subscriptions: [], tickets: [], payments: [], attribution: null }),
    resolution: { identityResolved: true, lastRunAt: lastRun },
  };
}

async function lastFullRun(db: Queryable): Promise<string | null> {
  const { rows } = await db.query<{ business_now: Date }>("select business_now from identity_runs where scope = 'all' order by id desc limit 1");
  return iso(rows[0]?.business_now);
}

async function loadLinks(db: Queryable, identityId: number): Promise<JourneyLink[]> {
  const { rows } = await db.query<{ id: string; source: SourceName; source_record_id: string; record_table: "crm_customers" | "leads"; record_id: string; rule: IdentityRule; confidence: string; evidence: Record<string, unknown>; linked_at: Date }>(
    // The anchor first, then the leads in the order they happened.
    `select k.id, k.source, k.source_record_id, k.record_table, k.record_id, k.rule, k.confidence, k.evidence, k.linked_at
     from identity_links k
     left join leads l on k.record_table = 'leads' and l.id = k.record_id
     where k.identity_id = $1
     order by (k.record_table = 'crm_customers') desc, l.occurred_at, k.id`,
    [identityId],
  );
  return rows.map((k) => ({
    id: Number(k.id),
    source: k.source,
    sourceRecordId: k.source_record_id,
    recordTable: k.record_table,
    recordId: Number(k.record_id),
    rule: k.rule,
    confidence: Number(k.confidence),
    evidence: k.evidence,
    linkedAt: k.linked_at.toISOString(),
  }));
}

async function loadLeads(db: Queryable, identityId: number): Promise<JourneyLead[]> {
  const { rows } = await db.query<
    ProvenanceRow & {
      id: string; source: "calls" | "web" | "d2d"; source_lead_id: string; branch_id: string | null; effective_branch_id: string | null;
      branch_overridden: boolean; channel_code: string; attribution_evidence: string; campaign_external_id: string | null;
      click_id: string | null; phone_hash: string | null; email_hash: string | null; zip: string | null; heard_about_text: string | null;
      occurred_at: Date; rule: IdentityRule;
    }
  >(
    `select l.id, l.source, l.source_lead_id, l.branch_id, l.effective_branch_id, l.branch_overridden, l.channel_code,
            l.attribution_evidence, l.campaign_external_id, l.click_id, l.phone_hash, l.email_hash, l.zip, l.heard_about_text,
            l.occurred_at, l.source_updated_at, l.raw_event_id, r.adapter_version, r.received_at, k.rule
     from identity_links k
     join v_leads l on l.id = k.record_id
     join raw_events r on r.id = l.raw_event_id
     where k.identity_id = $1 and k.record_table = 'leads'
     order by l.occurred_at, l.id`,
    [identityId],
  );
  return rows.map((l) => ({
    ...provenance(l),
    id: Number(l.id),
    source: l.source,
    sourceLeadId: l.source_lead_id,
    branchId: l.branch_id,
    effectiveBranchId: l.effective_branch_id,
    branchOverridden: l.branch_overridden,
    channelCode: l.channel_code,
    attributionEvidence: l.attribution_evidence,
    campaignExternalId: l.campaign_external_id,
    clickId: l.click_id,
    hasPhone: l.phone_hash !== null,
    hasEmail: l.email_hash !== null,
    zip: l.zip,
    heardAboutText: l.heard_about_text,
    occurredAt: l.occurred_at.toISOString(),
    linkRule: l.rule,
  }));
}

/**
 * Leads that share this customer's phone or email hash but are NOT on this identity: waiting
 * for a reviewer, attached elsewhere by a decision, or delivered after the last resolution run.
 * Shown so nothing that could belong to the customer is silently missing from the journey. Where
 * a lead now sits is named only when that identity is in the viewer's scope.
 */
async function loadUnresolvedMatches(
  db: Queryable,
  identityId: number | null,
  phoneHash: string | null,
  emailHash: string | null,
  scope: string[] | null,
): Promise<UnresolvedMatch[]> {
  if (!phoneHash && !emailHash) return [];
  const { rows } = await db.query<{
    id: string; source: string; source_lead_id: string; occurred_at: Date; via_phone: boolean; via_email: boolean;
    identity_id: string | null; kind: IdentityKind | null; crm_customer_id: string | null; rule: IdentityRule | null; pending: boolean;
    identity_branch_id: string | null;
  }>(
    `select l.id, l.source, l.source_lead_id, l.occurred_at,
            coalesce(l.phone_hash = $2, false) as via_phone, coalesce(l.email_hash = $3, false) as via_email,
            k.identity_id, i.kind, i.crm_customer_id, k.rule, i.branch_id as identity_branch_id,
            exists (select 1 from identity_conflicts x where x.lead_id = l.id and x.status = 'pending') as pending
     from (
       select * from leads where phone_hash = $2
       union
       select * from leads where email_hash = $3
     ) l
     left join identity_links k on k.record_table = 'leads' and k.record_id = l.id
     left join identities i on i.id = k.identity_id
     where k.identity_id is distinct from $1::bigint
     order by l.occurred_at, l.id`,
    [identityId, phoneHash, emailHash],
  );
  return rows.map((r) => ({
    leadId: Number(r.id),
    source: r.source,
    sourceLeadId: r.source_lead_id,
    occurredAt: r.occurred_at.toISOString(),
    matchedOn: [...(r.via_phone ? (["phone_hash"] as const) : []), ...(r.via_email ? (["email_hash"] as const) : [])],
    state: r.pending ? "pending_review" : r.identity_id !== null ? "linked_elsewhere" : "not_yet_resolved",
    linkedTo:
      r.identity_id !== null && r.kind !== null && r.rule !== null && inScope(scope, r.identity_branch_id)
        ? { identityId: Number(r.identity_id), kind: r.kind, crmCustomerId: num(r.crm_customer_id), rule: r.rule }
        : null,
  }));
}

const LEAD_SOURCE_LABEL: Record<string, string> = { calls: "Call", web: "Web form", d2d: "Door-to-door sale" };
const APPOINTMENT_TONE: Record<string, TimelineItem["tone"]> = { completed: "good", pending: "neutral", no_show: "warn", cancelled: "bad", rescheduled: "warn" };
/** Same-instant ordering: the order things happen in the business. */
const KIND_RANK: Record<TimelineKind, number> = {
  lead: 0, customer_created: 1, subscription_sold: 2, appointment: 3, ticket: 4, payment: 5, refund: 6, subscription_cancelled: 7,
};

function buildTimeline(input: {
  customer: (Provenance & { crmCustomerId: number; createdAtSource: string; sourceLabel: string | null }) | null;
  leads: JourneyLead[];
  subscriptions: JourneySubscription[];
  appointments: JourneyAppointment[];
  tickets: JourneyTicket[];
  payments: JourneyPayment[];
  creditedLeadId: number | null;
}): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const l of input.leads) {
    items.push({
      key: `lead:${l.id}`,
      at: l.occurredAt,
      kind: "lead",
      source: l.source,
      sourceTable: "leads",
      sourceId: String(l.id),
      sourceRecordId: l.sourceLeadId,
      rawEventId: l.rawEventId,
      adapterVersion: l.adapterVersion,
      title: `${LEAD_SOURCE_LABEL[l.source] ?? l.source} · ${l.channelCode}`,
      detail: `evidence ${l.attributionEvidence}${l.campaignExternalId ? ` · campaign ${l.campaignExternalId}` : ""} · branch ${l.effectiveBranchId ?? "unknown"}${l.branchOverridden ? " (override)" : ""}`,
      amountCents: null,
      tone: l.id === input.creditedLeadId ? "accent" : "neutral",
      linkRule: l.linkRule,
      credited: l.id === input.creditedLeadId,
    });
  }
  const c = input.customer;
  if (c) {
    items.push({
      key: `customer:${c.crmCustomerId}`,
      at: c.createdAtSource,
      kind: "customer_created",
      source: "crm",
      sourceTable: "crm_customers",
      sourceId: String(c.crmCustomerId),
      sourceRecordId: String(c.crmCustomerId),
      rawEventId: c.rawEventId,
      adapterVersion: c.adapterVersion,
      title: "CRM customer created",
      detail: c.sourceLabel ? `source typed in CRM: "${c.sourceLabel}"` : "source not recorded in CRM",
      amountCents: null,
      tone: "neutral",
    });
  }
  for (const s of input.subscriptions) {
    const base = { source: "crm" as const, sourceTable: "crm_subscriptions" as const, sourceId: String(s.id), sourceRecordId: String(s.id), rawEventId: s.rawEventId, adapterVersion: s.adapterVersion };
    items.push({ ...base, key: `subscription:${s.id}`, at: s.soldAt, kind: "subscription_sold", title: `Subscription sold · ${s.serviceType}`, detail: `annual value · sold by ${s.soldByRep ?? "rep not recorded"}`, amountCents: s.annualValueCents, tone: "accent" });
    if (s.cancelledAt) {
      items.push({ ...base, key: `subscription-cancelled:${s.id}`, at: s.cancelledAt, kind: "subscription_cancelled", title: "Subscription cancelled", detail: s.serviceType, amountCents: null, tone: "bad" });
    }
  }
  for (const a of input.appointments) {
    items.push({
      key: `appointment:${a.id}`,
      at: a.completedAt ?? a.scheduledFor,
      kind: "appointment",
      source: "crm",
      sourceTable: "crm_appointments",
      sourceId: String(a.id),
      sourceRecordId: String(a.id),
      rawEventId: a.rawEventId,
      adapterVersion: a.adapterVersion,
      title: `${a.kind === "initial" ? "Initial" : "Recurring"} service · ${a.status.replace("_", "-")}`,
      detail: a.completedAt ? `completed (scheduled ${a.scheduledFor.slice(0, 16).replace("T", " ")} UTC)` : `scheduled for this time · subscription ${a.subscriptionId}`,
      amountCents: null,
      tone: APPOINTMENT_TONE[a.status] ?? "neutral",
    });
  }
  for (const t of input.tickets) {
    items.push({
      key: `ticket:${t.id}`,
      at: t.invoicedAt,
      kind: "ticket",
      source: "crm",
      sourceTable: "crm_tickets",
      sourceId: String(t.id),
      sourceRecordId: String(t.id),
      rawEventId: t.rawEventId,
      adapterVersion: t.adapterVersion,
      title: `Invoice (${t.templateType === "I" ? "initial" : "recurring"})`,
      detail: t.appointmentId ? `for appointment ${t.appointmentId} · invoiced, not collected` : "no appointment given by source · invoiced, not collected",
      amountCents: t.totalCents,
      tone: "neutral",
    });
  }
  for (const p of input.payments) {
    items.push({
      key: `payment:${p.id}`,
      at: p.paidAt,
      kind: p.isRefund ? "refund" : "payment",
      source: "crm",
      sourceTable: "crm_payments",
      sourceId: String(p.id),
      sourceRecordId: String(p.id),
      rawEventId: p.rawEventId,
      adapterVersion: p.adapterVersion,
      title: p.isRefund ? "Refund" : `Payment · ${p.status}`,
      detail: p.isRefund
        ? `refunds payment ${p.originalPaymentId}`
        : `${p.ticketId ? `for invoice ${p.ticketId}` : "no invoice given by source"}${p.status === "successful" ? "" : " · does not count as collected"}`,
      amountCents: p.amountCents,
      tone: p.isRefund ? "warn" : p.status === "successful" ? "good" : "bad",
    });
  }
  return items.sort((x, y) => x.at.localeCompare(y.at) || KIND_RANK[x.kind] - KIND_RANK[y.kind] || x.key.localeCompare(y.key));
}

function freshness(input: {
  customer: (Provenance & { crmCustomerId: number }) | null;
  leads: JourneyLead[];
  subscriptions: JourneySubscription[];
  appointments: JourneyAppointment[];
  tickets: JourneyTicket[];
  payments: JourneyPayment[];
}): Freshness[] {
  const latest = (entity: string, rows: Provenance[]): Freshness => ({
    entity,
    records: rows.length,
    latestSourceUpdatedAt: rows.reduce<string | null>((m, r) => (m === null || r.sourceUpdatedAt > m ? r.sourceUpdatedAt : m), null),
    latestReceivedAt: rows.reduce<string | null>((m, r) => (m === null || r.receivedAt > m ? r.receivedAt : m), null),
  });
  const out: Freshness[] = [];
  if (input.customer) {
    out.push(
      latest("CRM customer", [input.customer]),
      latest("CRM subscriptions", input.subscriptions),
      latest("CRM appointments", input.appointments),
      latest("CRM invoices", input.tickets),
      latest("CRM payments", input.payments),
    );
  }
  for (const source of ["calls", "web", "d2d"] as const) {
    out.push(latest(`${LEAD_SOURCE_LABEL[source]}s`, input.leads.filter((l) => l.source === source)));
  }
  return out;
}

/** Fields the source did not send. Listed, so the page can say "unknown" instead of guessing. */
function unknowns(input: {
  customer: { hasEmail: boolean; hasPhone: boolean; zip: string | null; sourceLabel: string | null } | null;
  leads: JourneyLead[];
  subscriptions: JourneySubscription[];
  tickets: JourneyTicket[];
  payments: JourneyPayment[];
  attribution: Attribution | null;
}): Unknown[] {
  const out: Unknown[] = [];
  const c = input.customer;
  if (c) {
    if (!c.hasEmail) out.push({ subject: "CRM customer", field: "email", note: "not provided by the CRM; email-hash matching is impossible for this customer" });
    if (!c.hasPhone) out.push({ subject: "CRM customer", field: "phone", note: "not provided by the CRM; phone-hash matching is impossible for this customer" });
    if (!c.zip) out.push({ subject: "CRM customer", field: "zip", note: "not provided by the CRM" });
    if (!c.sourceLabel) out.push({ subject: "CRM customer", field: "source", note: "not recorded by the agent" });
  }
  for (const s of input.subscriptions) {
    if (!s.soldByRep) out.push({ subject: `Subscription ${s.id}`, field: "sold by", note: "no rep recorded by the CRM (expected for inbound sales)" });
  }
  for (const t of input.tickets) if (t.appointmentId === null) out.push({ subject: `Invoice ${t.id}`, field: "appointment", note: "not linked to an appointment by the CRM" });
  for (const p of input.payments) if (p.ticketId === null) out.push({ subject: `Payment ${p.id}`, field: "invoice", note: "not linked to an invoice by the CRM" });
  for (const l of input.leads) {
    const subject = `${LEAD_SOURCE_LABEL[l.source] ?? l.source} ${l.sourceLeadId}`;
    if (l.attributionEvidence === "none") out.push({ subject, field: "channel", note: "no tracking evidence; stays unknown, never guessed" });
    if (l.source !== "d2d" && l.campaignExternalId === null && l.attributionEvidence !== "none") out.push({ subject, field: "campaign", note: "not sent by the source" });
    if (!l.hasEmail) out.push({ subject, field: "email", note: "not captured" });
    if (!l.zip) out.push({ subject, field: "zip", note: "not captured" });
  }
  if (input.attribution?.attributionBasis === "no_lead_record") {
    out.push({ subject: "Acquisition", field: "first touch", note: "no lead record matches this customer in the 60-day window; credited channel is unknown" });
  }
  return out;
}

export interface RawEventView {
  id: number;
  source: string;
  entity: string;
  entityId: string;
  externalId: string;
  adapterVersion: string;
  status: string;
  errorCode: string | null;
  errorDetail: string | null;
  occurredAt: string;
  receivedAt: string;
  projectedAt: string | null;
  deliveryCount: number;
  payload: unknown;
  /** Every stored version of the same source record, oldest first. */
  versions: Array<{ id: number; externalId: string; adapterVersion: string; status: string; receivedAt: string; current: boolean }>;
}

/**
 * One stored raw payload (already redacted at ingest) — only if it is a version of a record in
 * this journey. Scope is carried by `journey`: getCustomerJourney/getProspectJourney return null
 * for an out-of-scope id, so a caller holding a journey already passed the branch check.
 */
export async function getJourneyRawEvent(db: Queryable, journey: CustomerJourney, rawEventId: number): Promise<RawEventView | null> {
  const current = [...new Set(journey.timeline.map((t) => t.rawEventId))];
  if (current.length === 0) return null;
  const { rows } = await db.query<{
    id: string; source: string; entity: string; entity_id: string; external_id: string; adapter_version: string; status: string;
    error_code: string | null; error_detail: string | null; occurred_at: Date; received_at: Date; projected_at: Date | null;
    delivery_count: number; payload: unknown;
  }>(
    `with mine as (select distinct source, entity, entity_id from raw_events where id = any($1::bigint[]))
     select r.id, r.source, r.entity, r.entity_id, r.external_id, r.adapter_version, r.status, r.error_code, r.error_detail,
            r.occurred_at, r.received_at, r.projected_at, r.delivery_count, r.payload
     from raw_events r join mine m on m.source = r.source and m.entity = r.entity and m.entity_id = r.entity_id
     where r.id = $2`,
    [current, rawEventId],
  );
  const r = rows[0];
  if (!r) return null;
  const versions = await db.query<{ id: string; external_id: string; adapter_version: string; status: string; received_at: Date }>(
    `select id, external_id, adapter_version, status, received_at from raw_events
     where source = $1 and entity = $2 and entity_id = $3 order by received_at, id`,
    [r.source, r.entity, r.entity_id],
  );
  return {
    id: Number(r.id),
    source: r.source,
    entity: r.entity,
    entityId: r.entity_id,
    externalId: r.external_id,
    adapterVersion: r.adapter_version,
    status: r.status,
    errorCode: r.error_code,
    errorDetail: r.error_detail,
    occurredAt: r.occurred_at.toISOString(),
    receivedAt: r.received_at.toISOString(),
    projectedAt: iso(r.projected_at),
    deliveryCount: r.delivery_count,
    payload: r.payload,
    versions: versions.rows.map((v) => ({
      id: Number(v.id),
      externalId: v.external_id,
      adapterVersion: v.adapter_version,
      status: v.status,
      receivedAt: v.received_at.toISOString(),
      current: current.includes(Number(v.id)),
    })),
  };
}
