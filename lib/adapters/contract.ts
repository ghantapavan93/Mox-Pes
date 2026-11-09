import type { ChannelCode } from "@/lib/reference";

/**
 * The integration seam, split in two:
 *
 *   SourceClient  — transport. Fetches raw records changed inside a window. The demo uses
 *                   in-memory mocks; a real FieldRoutes or CallRail client implements the
 *                   same interface over HTTP (auth, pagination, rate limits live here).
 *   SourceMapper  — meaning. Versioned. Identifies a record version, validates it, redacts
 *                   PII and maps it to a projection row. Pure: no I/O, so every rule is
 *                   unit-testable and a replay can re-run a newer mapper over stored payloads.
 */

export type SourceName = "crm" | "calls" | "web" | "d2d" | "ads";

export interface RawRecord {
  /** e.g. "appointment", "call", "lead", "sale", "spend_day" */
  entity: string;
  payload: unknown;
}

export interface FetchWindow {
  from: Date;
  to: Date;
}

export interface SourceClient {
  readonly stream: string;
  readonly source: SourceName;
  /** Records whose source-side update time falls inside the window. May repeat records. */
  fetchChanges(window: FetchWindow): Promise<RawRecord[]>;
}

/** Stable identity of one VERSION of a source record. */
export interface RecordIdentity {
  entity: string;
  entityId: string;
  /** entity:id:version — re-delivery of the same version is a duplicate. */
  externalId: string;
  occurredAt: Date;
  /**
   * "source": the source stamps versions (dateUpdated); the newest source time wins.
   * "received": the source has no version clock (FieldRoutes payments, call-tracking
   *   records whose attribution is updated after the fact). Versions are identified by
   *   content and ordered by when we received them; the latest observation wins.
   */
  versionClock: "source" | "received";
}

export type MapFailure = { ok: false; code: string; detail: string };
export type MapSuccess = { ok: true; projection: Projection };
export type MapResult = MapSuccess | MapFailure;

export interface MapContext {
  timezoneForOffice(officeId: number): string | undefined;
  timezoneForBranch(branchId: string): string | undefined;
  /** When this delivery was received; orders versions of clock-less records. */
  receivedAt?: Date;
}

export interface SourceMapper {
  readonly source: SourceName;
  readonly version: string;
  identify(record: RawRecord, ctx: MapContext): RecordIdentity | MapFailure;
  map(record: RawRecord, ctx: MapContext): MapResult;
}

// ── Projection rows (one per target table) ───────────────────────────────────

export interface LeadRow {
  source: "web" | "calls" | "d2d";
  sourceLeadId: string;
  branchId: string | null;
  channelCode: ChannelCode;
  attributionEvidence: "click_id" | "utm" | "tracking_number" | "lsa_lead" | "rep_signature" | "none";
  campaignExternalId: string | null;
  clickId: string | null;
  phoneHash: string | null;
  emailHash: string | null;
  zip: string | null;
  heardAboutText: string | null;
  occurredAt: Date;
  sourceUpdatedAt: Date;
}

export interface CustomerRow {
  crmCustomerId: number;
  officeId: number;
  sourceLabel: string | null;
  phoneHash: string | null;
  emailHash: string | null;
  zip: string | null;
  createdAtSource: Date;
  sourceUpdatedAt: Date;
}

export interface SubscriptionRow {
  crmSubscriptionId: number;
  crmCustomerId: number;
  officeId: number;
  serviceType: string;
  soldByRep: string | null;
  sourceLabel: string | null;
  annualValueCents: number;
  status: "active" | "cancelled";
  soldAt: Date;
  cancelledAt: Date | null;
  sourceUpdatedAt: Date;
}

export interface AppointmentRow {
  crmAppointmentId: number;
  crmSubscriptionId: number;
  crmCustomerId: number;
  officeId: number;
  kind: "initial" | "recurring";
  status: "pending" | "completed" | "no_show" | "cancelled" | "rescheduled";
  scheduledFor: Date;
  completedAt: Date | null;
  sourceUpdatedAt: Date;
}

export interface TicketRow {
  crmTicketId: number;
  crmAppointmentId: number | null;
  crmCustomerId: number;
  officeId: number;
  templateType: "I" | "R";
  totalCents: number;
  invoicedAt: Date;
  sourceUpdatedAt: Date;
}

export interface PaymentRow {
  crmPaymentId: number;
  crmTicketId: number | null;
  crmCustomerId: number;
  officeId: number;
  amountCents: number;
  originalPaymentId: number | null;
  status: "successful" | "failed" | "voided";
  paidAt: Date;
  sourceUpdatedAt: Date;
}

export interface SpendDayRow {
  platform: "google_ads" | "google_lsa" | "microsoft_ads" | "meta";
  adAccountId: string;
  externalCampaignId: string;
  campaignName: string;
  /** How the platform types the campaign (e.g. PERFORMANCE_MAX); null if the mapper did not read it. */
  campaignType: string | null;
  localServicesEnabled: boolean;
  channelCode: ChannelCode;
  spendDate: string; // YYYY-MM-DD in the ad account's zone
  costCents: number;
  clicks: number;
  platformConversions: number;
  sourceUpdatedAt: Date;
}

export type Projection =
  | { table: "leads"; row: LeadRow }
  | { table: "crm_customers"; row: CustomerRow }
  | { table: "crm_subscriptions"; row: SubscriptionRow }
  | { table: "crm_appointments"; row: AppointmentRow }
  | { table: "crm_tickets"; row: TicketRow }
  | { table: "crm_payments"; row: PaymentRow }
  | { table: "ad_spend_daily"; row: SpendDayRow };

export function fail(code: string, detail: string): MapFailure {
  return { ok: false, code, detail };
}
