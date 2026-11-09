import type { CrmEntity } from "./types";

/**
 * The FieldRoutes → canonical field mapping, as data.
 *
 * This is the human-readable contract of what FieldRoutesMapper (lib/adapters/crm-fieldroutes.ts)
 * does with each wire field. It is DECLARATIVE and does not drive the mapper — the mapper is the
 * code that runs. tests/integration/connectors.test.ts proves the two agree in both directions:
 * every field listed here is read by the mapper and changes its output, and every field the
 * mapper reads is listed here. A field added to one and not the other fails the build.
 *
 * `evidence` says how sure we are the WIRE field behaves as described (research/17 labels):
 *   documented — stated in the official FieldRoutes docs
 *   inferred   — our reading where the docs are silent
 *   deviation  — the mapper reads it differently from the current docs; `deviation` explains
 *                (gap ids G1–G10 refer to research/17 "Gaps in crm-fieldroutes.ts"). These are
 *                the changes a real tenant needs before go-live; the synthetic world matches the
 *                mapper, so the demo is internally consistent.
 */

export type Evidence = "documented" | "inferred" | "deviation";

export interface FieldSpec {
  entity: CrmEntity;
  /** Wire field name as the mapper reads it. */
  field: string;
  /** Canonical destination ("table.column"), or a non-column role in brackets. */
  target: string;
  transform: string;
  rule: string;
  evidence: Evidence;
  deviation?: string;
}

const ZERO_DATE_RULE = "\"0000-00-00 00:00:00\" means not set and maps to null, never to year 0.";
const WALL_TIME = "Zone-less wall time interpreted in the office's IANA zone (branches.timezone via officeID).";
const G1 = "G1: current docs say every datetime is Pacific time (America/Los_Angeles), not office-local. A real tenant needs wireTimeZone=\"America/Los_Angeles\" on the connector AND the mapper converting with that zone.";

export const FIELDROUTES_FIELD_MAP: FieldSpec[] = [
  // ── customer ──────────────────────────────────────────────────────────────
  { entity: "customer", field: "customerID", target: "crm_customers.crm_customer_id", transform: "numeric string → bigint", rule: "A SOURCE identity (unique within this CRM), never a global person key: cross-source matching is identity resolution's job, by hashed phone/email.", evidence: "documented" },
  { entity: "customer", field: "officeID", target: "crm_customers.office_id → branches.crm_office_id", transform: "numeric string → integer", rule: "officeID is the branch. It must match a known office (branches.crm_office_id) or the record is quarantined UNKNOWN_OFFICE; it also picks the time zone for every timestamp.", evidence: "deviation", deviation: "G2: a negative officeID marks a soft-deleted customer (docs); the mapper's id rule rejects it, so a deleted customer is quarantined rather than tombstoned." },
  { entity: "customer", field: "phone1", target: "crm_customers.phone_hash", transform: "redacted at the boundary → SHA-256 of E.164", rule: "PII never reaches projections; the hash is the identity-resolution join key.", evidence: "documented" },
  { entity: "customer", field: "email", target: "crm_customers.email_hash", transform: "redacted → SHA-256 of lower-cased email", rule: "PII never reaches projections.", evidence: "documented" },
  { entity: "customer", field: "zip", target: "crm_customers.zip", transform: "5-digit string", rule: "Service-territory evidence for branch mismatch checks.", evidence: "deviation", deviation: "G8: docs say \"ZIP or postal code\"; ZIP+4 would be quarantined." },
  { entity: "customer", field: "source", target: "crm_customers.source_label", transform: "free text", rule: "Self-reported, typed by an agent or rep: shown as context, never used as attribution evidence.", evidence: "deviation", deviation: "G10: `source` is the FIRST SUBSCRIPTION's source; the customer-level field is customerSource." },
  { entity: "customer", field: "dateAdded", target: "crm_customers.created_at_source", transform: WALL_TIME, rule: "When the CRM record was created.", evidence: "deviation", deviation: G1 },
  { entity: "customer", field: "dateUpdated", target: "raw_events.external_id (version) + crm_customers.source_updated_at", transform: WALL_TIME, rule: "The version clock: customer:ID:dateUpdated identifies a version; an older version arriving late never overwrites a newer one.", evidence: "deviation", deviation: G1 },

  // ── subscription ──────────────────────────────────────────────────────────
  { entity: "subscription", field: "subscriptionID", target: "crm_subscriptions.crm_subscription_id", transform: "numeric string → bigint", rule: "Source identity of the sale.", evidence: "documented" },
  { entity: "subscription", field: "customerID", target: "crm_subscriptions.crm_customer_id", transform: "numeric string → bigint", rule: "Links the sale to the source customer; no foreign key — a subscription may arrive before its customer.", evidence: "documented" },
  { entity: "subscription", field: "officeID", target: "crm_subscriptions.office_id → branches", transform: "numeric string → integer", rule: "The selling branch; must be a known office.", evidence: "documented" },
  { entity: "subscription", field: "serviceType", target: "crm_subscriptions.service_type", transform: "non-empty string", rule: "Descriptive only.", evidence: "documented" },
  { entity: "subscription", field: "soldBy", target: "crm_subscriptions.sold_by_rep", transform: "\"0\" → null, else employee id", rule: "A rep id is D2D evidence for channel conflicts.", evidence: "documented" },
  { entity: "subscription", field: "source", target: "crm_subscriptions.source_label", transform: "free text", rule: "Self-reported context, never attribution evidence.", evidence: "documented" },
  { entity: "subscription", field: "contractValue", target: "crm_subscriptions.annual_value_cents", transform: "decimal string → integer cents, exact (no float)", rule: "Contracted value, not revenue: revenue is only ever payments.", evidence: "documented" },
  { entity: "subscription", field: "active", target: "crm_subscriptions.status", transform: "\"1\" → active, \"0\" → cancelled", rule: "Cancellation updates the lifecycle state ONLY: tickets and payments already collected are separate rows and are never deleted or reversed by it.", evidence: "deviation", deviation: "G9: docs: 0 = Frozen and -3 = Lead. The connector excludes leads with an explicit active IN (0,1) filter." },
  { entity: "subscription", field: "dateAdded", target: "crm_subscriptions.sold_at", transform: WALL_TIME, rule: "The sold date: when a customer counts as acquired.", evidence: "deviation", deviation: G1 },
  { entity: "subscription", field: "dateCancelled", target: "crm_subscriptions.cancelled_at", transform: `${WALL_TIME} ${ZERO_DATE_RULE}`, rule: "An inactive subscription must carry a cancel date, or it is quarantined.", evidence: "deviation", deviation: G1 },
  { entity: "subscription", field: "dateUpdated", target: "raw_events.external_id (version) + crm_subscriptions.source_updated_at", transform: WALL_TIME, rule: "Version clock; newest source time wins.", evidence: "deviation", deviation: G1 },

  // ── appointment ───────────────────────────────────────────────────────────
  { entity: "appointment", field: "appointmentID", target: "crm_appointments.crm_appointment_id", transform: "numeric string → bigint", rule: "Source identity of the visit.", evidence: "documented" },
  { entity: "appointment", field: "subscriptionID", target: "crm_appointments.crm_subscription_id", transform: "numeric string → bigint", rule: "Links the visit to its sale.", evidence: "deviation", deviation: "G2: docs use -1 for stand-alone/reservice appointments; the mapper's id rule quarantines them." },
  { entity: "appointment", field: "customerID", target: "crm_appointments.crm_customer_id", transform: "numeric string → bigint", rule: "Source customer.", evidence: "documented" },
  { entity: "appointment", field: "officeID", target: "crm_appointments.office_id → branches", transform: "numeric string → integer", rule: "Servicing branch; must be a known office.", evidence: "documented" },
  { entity: "appointment", field: "salesAnchor", target: "crm_appointments.kind", transform: "\"1\" → initial, \"0\" → recurring", rule: "Initial service completion is the acquisition milestone.", evidence: "deviation", deviation: "G3: the RESPONSE field is isInitial; salesAnchor is only the search filter name." },
  { entity: "appointment", field: "status", target: "crm_appointments.status", transform: "0 pending · 1 completed · 2 no_show · -1 cancelled · -2 rescheduled", rule: "Unknown codes are quarantined, never guessed. The connector asks for every status explicitly: search hides -2/-1/2 by default.", evidence: "documented" },
  { entity: "appointment", field: "date", target: "crm_appointments.scheduled_for", transform: "date + start, office wall time", rule: "Scheduled window start.", evidence: "inferred" },
  { entity: "appointment", field: "start", target: "crm_appointments.scheduled_for", transform: "HH:MM:SS joined to date", rule: "Scheduled window start.", evidence: "inferred" },
  { entity: "appointment", field: "dateCompleted", target: "crm_appointments.completed_at", transform: `${WALL_TIME} ${ZERO_DATE_RULE}`, rule: "Set exactly when status is completed, else the record is quarantined.", evidence: "deviation", deviation: G1 },
  { entity: "appointment", field: "dateUpdated", target: "raw_events.external_id (version) + crm_appointments.source_updated_at", transform: WALL_TIME, rule: "Version clock; pending → completed arrives as a newer version.", evidence: "deviation", deviation: G1 },

  // ── ticket (invoice) ──────────────────────────────────────────────────────
  { entity: "ticket", field: "ticketID", target: "crm_tickets.crm_ticket_id", transform: "numeric string → bigint", rule: "Source identity of the invoice.", evidence: "documented" },
  { entity: "ticket", field: "customerID", target: "crm_tickets.crm_customer_id", transform: "numeric string → bigint", rule: "Source customer.", evidence: "documented" },
  { entity: "ticket", field: "appointmentID", target: "crm_tickets.crm_appointment_id", transform: "\"0\" → null (not linked)", rule: "Joins invoice to visit when present.", evidence: "documented" },
  { entity: "ticket", field: "officeID", target: "crm_tickets.office_id → branches", transform: "numeric string → integer", rule: "Invoicing branch; must be a known office.", evidence: "documented" },
  { entity: "ticket", field: "templateType", target: "crm_tickets.template_type", transform: "I (initial) / R (recurring)", rule: "Separates initial-service revenue from recurring.", evidence: "deviation", deviation: "G4: regular invoices are templateType NA in the docs and would be quarantined." },
  { entity: "ticket", field: "total", target: "crm_tickets.total_cents", transform: "decimal string → integer cents, exact", rule: "Invoiced, not collected: never counted as revenue. Negative totals are quarantined.", evidence: "documented" },
  { entity: "ticket", field: "dateCreated", target: "crm_tickets.invoiced_at", transform: WALL_TIME, rule: "Invoice date.", evidence: "deviation", deviation: G1 },
  { entity: "ticket", field: "dateUpdated", target: "raw_events.external_id (version) + crm_tickets.source_updated_at", transform: WALL_TIME, rule: "Version clock. The same version with different content is a payload conflict, not an update.", evidence: "deviation", deviation: G1 },

  // ── payment ───────────────────────────────────────────────────────────────
  { entity: "payment", field: "paymentID", target: "crm_payments.crm_payment_id", transform: "numeric string → bigint", rule: "Source identity of one money movement.", evidence: "documented" },
  { entity: "payment", field: "customerID", target: "crm_payments.crm_customer_id", transform: "numeric string → bigint", rule: "Source customer.", evidence: "documented" },
  { entity: "payment", field: "officeID", target: "crm_payments.office_id → branches", transform: "numeric string → integer", rule: "Collected revenue lands in this office's branch.", evidence: "documented" },
  { entity: "payment", field: "ticketID", target: "crm_payments.crm_ticket_id", transform: "\"0\" → null", rule: "A payment for an invoice not yet delivered is an ordering exception, not an error.", evidence: "deviation", deviation: "G5: payments have no ticketID in the docs; the link is invoiceIDs / paymentApplications[].ticketID." },
  { entity: "payment", field: "amount", target: "crm_payments.amount_cents", transform: "decimal string → integer cents, exact; zero is quarantined", rule: "Negative amount = refund row; collected = Σ successful amounts, refunds included as negatives.", evidence: "documented" },
  { entity: "payment", field: "originalPaymentID", target: "crm_payments.original_payment_id", transform: "\"0\" → null", rule: "A refund MUST reference the payment it reverses (and only refunds may); the original row is never edited.", evidence: "documented" },
  { entity: "payment", field: "status", target: "crm_payments.status", transform: "1 successful · 0 failed · 2 voided", rule: "Only successful payments contribute to collected revenue (v_customer_revenue, scorecard); failed and voided rows are kept for the audit trail.", evidence: "deviation", deviation: "G6: docs list codes 0–7 (3–7 disputes / ACH return); those are quarantined until mapped." },
  { entity: "payment", field: "date", target: "crm_payments.paid_at + version order", transform: WALL_TIME, rule: "No version clock is relied on: a payment version is identified by its content and ordered by receipt; the connector re-sweeps a 35-day `date` window.", evidence: "deviation", deviation: `${G1} G7: current docs add payment dateUpdated (unconfirmed; legacy spec has none).` },
];

export function specFor(entity: CrmEntity): FieldSpec[] {
  return FIELDROUTES_FIELD_MAP.filter((s) => s.entity === entity);
}
