import { z } from "zod";
import { parseMoneyToCents, payloadHash, wallTimeToInstant } from "@/lib/primitives";
import { fail, type MapContext, type MapResult, type RawRecord, type RecordIdentity, type SourceMapper } from "./contract";
import { emailHashOf, phoneHashOf } from "./redact";
import { schemaFailure } from "./validation";

/**
 * CRM mapper modelled on the public FieldRoutes API shape (fieldroutes.dev):
 *   * ids and money arrive as strings; "0" means "no reference"
 *   * timestamps are zone-less wall time at the office ("YYYY-MM-DD HH:MM:SS"),
 *     and "0000-00-00 00:00:00" means null
 *   * every record carries officeID — the CRM's branch
 *   * appointment status codes: 0 pending, 1 completed, 2 no-show, -1 cancelled, -2 rescheduled
 *   * payments have no dateUpdated; their version is their status
 *
 * Unknown status codes are rejected, not guessed: a silently mis-mapped status would
 * change completed-service counts without anyone noticing.
 */

// ≤ 15 digits: fits bigint AND stays exact as a JS number (2^53 ≈ 9.0e15).
const id = z.string().regex(/^\d{1,15}$/, "expected a numeric id string of at most 15 digits");
const wallTime = z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, "expected 'YYYY-MM-DD HH:MM:SS'");
const money = z.string().regex(/^-?\d+(\.\d{1,2})?$/, "expected a decimal amount");
const ZERO_DATE = "0000-00-00 00:00:00";

const customerSchema = z.object({
  customerID: id,
  officeID: id,
  phone1: z.string().nullable(),
  email: z.string().nullable(),
  zip: z.string().regex(/^\d{5}$/).nullable(),
  source: z.string().nullable(),
  dateAdded: wallTime,
  dateUpdated: wallTime,
});

const subscriptionSchema = z.object({
  subscriptionID: id,
  customerID: id,
  officeID: id,
  serviceType: z.string().min(1),
  soldBy: id,
  source: z.string().nullable(),
  contractValue: money,
  active: z.enum(["0", "1"]),
  dateAdded: wallTime,
  dateCancelled: wallTime,
  dateUpdated: wallTime,
});

const APPOINTMENT_STATUS = { "0": "pending", "1": "completed", "2": "no_show", "-1": "cancelled", "-2": "rescheduled" } as const;

const appointmentSchema = z.object({
  appointmentID: id,
  subscriptionID: id,
  customerID: id,
  officeID: id,
  salesAnchor: z.enum(["0", "1"]),
  status: z.enum(["0", "1", "2", "-1", "-2"]),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  start: z.string().regex(/^\d{2}:\d{2}:\d{2}$/),
  dateCompleted: wallTime,
  dateUpdated: wallTime,
});

const ticketSchema = z.object({
  ticketID: id,
  customerID: id,
  appointmentID: id,
  officeID: id,
  templateType: z.enum(["I", "R"]),
  total: money,
  dateCreated: wallTime,
  dateUpdated: wallTime,
});

const PAYMENT_STATUS = { "1": "successful", "0": "failed", "2": "voided" } as const;

const paymentSchema = z.object({
  paymentID: id,
  customerID: id,
  officeID: id,
  ticketID: id,
  amount: money,
  originalPaymentID: id,
  status: z.enum(["0", "1", "2"]),
  date: wallTime,
});

const SCHEMAS = {
  customer: customerSchema,
  subscription: subscriptionSchema,
  appointment: appointmentSchema,
  ticket: ticketSchema,
  payment: paymentSchema,
} as const;

type CrmEntity = keyof typeof SCHEMAS;

const ID_FIELD: Record<CrmEntity, string> = {
  customer: "customerID",
  subscription: "subscriptionID",
  appointment: "appointmentID",
  ticket: "ticketID",
  payment: "paymentID",
};

function isCrmEntity(entity: string): entity is CrmEntity {
  return entity in SCHEMAS;
}

const ref = (value: string): number | null => (value === "0" ? null : Number(value));

export class FieldRoutesMapper implements SourceMapper {
  readonly source = "crm" as const;
  constructor(readonly version: string) {}

  identify(record: RawRecord, ctx: MapContext): RecordIdentity | ReturnType<typeof fail> {
    if (!isCrmEntity(record.entity)) return fail("UNKNOWN_ENTITY", `crm entity "${record.entity}" is not handled`);
    const p = (record.payload ?? {}) as Record<string, unknown>;
    const entityId = p[ID_FIELD[record.entity]];
    const office = Number(p.officeID);
    const tz = ctx.timezoneForOffice(office);
    if (typeof entityId !== "string" || !tz) return fail("MISSING_IDENTITY", `${record.entity}: no id or unknown officeID`);
    // Payments carry no dateUpdated: a version is identified by its content and ordered
    // by receipt (versionClock "received"), so void → successful → void is never lost.
    const isPayment = record.entity === "payment";
    const version = isPayment ? payloadHash(p).slice(0, 16) : String(p.dateUpdated ?? "");
    const clock = isPayment ? p.date : p.dateUpdated;
    let occurredAt: Date;
    try {
      occurredAt = wallTimeToInstant(String(clock), tz);
    } catch {
      return fail("INVALID_TIMESTAMP", `${record.entity}.${record.entity === "payment" ? "date" : "dateUpdated"}: "${String(clock)}"`);
    }
    return {
      entity: record.entity,
      entityId,
      externalId: `${record.entity}:${entityId}:${version}`,
      occurredAt,
      versionClock: isPayment ? "received" : "source",
    };
  }

  map(record: RawRecord, ctx: MapContext): MapResult {
    if (!isCrmEntity(record.entity)) return fail("UNKNOWN_ENTITY", `crm entity "${record.entity}" is not handled`);
    const parsed = SCHEMAS[record.entity].safeParse(record.payload);
    if (!parsed.success) return schemaFailure(record.entity, parsed.error);
    const p = parsed.data as Record<string, string | null>;
    const officeId = Number(p.officeID);
    const tz = ctx.timezoneForOffice(officeId);
    if (!tz) return fail("UNKNOWN_OFFICE", `${record.entity}.officeID ${p.officeID} is not a known branch`);
    const at = (wall: string | null) => (wall && wall !== ZERO_DATE ? wallTimeToInstant(wall, tz) : null);

    switch (record.entity) {
      case "customer":
        return {
          ok: true,
          projection: {
            table: "crm_customers",
            row: {
              crmCustomerId: Number(p.customerID),
              officeId,
              sourceLabel: p.source,
              phoneHash: phoneHashOf(p.phone1),
              emailHash: emailHashOf(p.email),
              zip: p.zip,
              createdAtSource: at(p.dateAdded)!,
              sourceUpdatedAt: at(p.dateUpdated)!,
            },
          },
        };
      case "subscription": {
        const cancelledAt = at(p.dateCancelled);
        if (p.active === "0" && !cancelledAt) return fail("SCHEMA_VIOLATION", "subscription.dateCancelled: inactive subscription without a cancel date");
        return {
          ok: true,
          projection: {
            table: "crm_subscriptions",
            row: {
              crmSubscriptionId: Number(p.subscriptionID),
              crmCustomerId: Number(p.customerID),
              officeId,
              serviceType: p.serviceType!,
              soldByRep: p.soldBy === "0" ? null : p.soldBy,
              sourceLabel: p.source,
              annualValueCents: parseMoneyToCents(p.contractValue!),
              status: p.active === "1" ? "active" : "cancelled",
              soldAt: at(p.dateAdded)!,
              cancelledAt,
              sourceUpdatedAt: at(p.dateUpdated)!,
            },
          },
        };
      }
      case "appointment": {
        const status = APPOINTMENT_STATUS[p.status as keyof typeof APPOINTMENT_STATUS];
        const completedAt = at(p.dateCompleted);
        if ((status === "completed") !== (completedAt !== null)) {
          return fail("SCHEMA_VIOLATION", "appointment.dateCompleted: must be set exactly when status is completed");
        }
        return {
          ok: true,
          projection: {
            table: "crm_appointments",
            row: {
              crmAppointmentId: Number(p.appointmentID),
              crmSubscriptionId: Number(p.subscriptionID),
              crmCustomerId: Number(p.customerID),
              officeId,
              kind: p.salesAnchor === "1" ? "initial" : "recurring",
              status,
              scheduledFor: wallTimeToInstant(`${p.date} ${p.start}`, tz),
              completedAt,
              sourceUpdatedAt: at(p.dateUpdated)!,
            },
          },
        };
      }
      case "ticket": {
        const totalCents = parseMoneyToCents(p.total!);
        if (totalCents < 0) return fail("SCHEMA_VIOLATION", "ticket.total: negative invoice total");
        return {
          ok: true,
          projection: {
            table: "crm_tickets",
            row: {
              crmTicketId: Number(p.ticketID),
              crmAppointmentId: ref(p.appointmentID!),
              crmCustomerId: Number(p.customerID),
              officeId,
              templateType: p.templateType as "I" | "R",
              totalCents,
              invoicedAt: at(p.dateCreated)!,
              sourceUpdatedAt: at(p.dateUpdated)!,
            },
          },
        };
      }
      case "payment": {
        const amountCents = parseMoneyToCents(p.amount!);
        const originalPaymentId = ref(p.originalPaymentID!);
        if (amountCents === 0) return fail("SCHEMA_VIOLATION", "payment.amount: zero");
        if ((amountCents < 0) !== (originalPaymentId !== null)) {
          return fail("SCHEMA_VIOLATION", "payment.originalPaymentID: refunds (negative amounts) must reference the original payment");
        }
        const paidAt = at(p.date)!;
        return {
          ok: true,
          projection: {
            table: "crm_payments",
            row: {
              crmPaymentId: Number(p.paymentID),
              crmTicketId: ref(p.ticketID!),
              crmCustomerId: Number(p.customerID),
              officeId,
              amountCents,
              originalPaymentId,
              status: PAYMENT_STATUS[p.status as keyof typeof PAYMENT_STATUS],
              paidAt,
              sourceUpdatedAt: ctx.receivedAt ?? paidAt,
            },
          },
        };
      }
    }
  }
}
