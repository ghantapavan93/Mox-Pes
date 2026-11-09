import type { Pool } from "pg";
import { createPool, withTransaction } from "@/lib/db";
import { migrate, resetSchema } from "@/lib/migrate";
import { BRANCHES, BRANCH_BY_ID, CHANNELS } from "@/lib/reference";
import { instantToWallTime } from "@/lib/primitives";
import type { RawRecord, SourceMapper, SourceName } from "@/lib/adapters/contract";
import { mapperFor, referenceContext } from "@/lib/adapters/registry";
import { ingestRecords, type IngestStats } from "@/lib/ingest/ingest";
import { reconcile } from "@/lib/reconcile/reconcile";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres@127.0.0.1:54333/revenue_signal_test";
export const T0 = new Date("2026-10-01T15:00:00Z");

export function testPool(): Pool {
  return createPool(TEST_DATABASE_URL);
}

/** Empty schema + reference data. Fast enough to run before every test. */
export async function freshDb(pool: Pool): Promise<void> {
  await resetSchema(pool);
  await migrate(pool);
  await pool.query(
    `insert into branches (id, name, region, timezone, crm_office_id, brand_id)
     select r."id", r."name", r."region", r."timezone", r."crmOfficeId", r."brandId"
     from jsonb_to_recordset($1::jsonb) as r("id" text, "name" text, "region" text, "timezone" text, "crmOfficeId" int, "brandId" text)`,
    [JSON.stringify(BRANCHES)],
  );
  await pool.query(
    `insert into channels (code, label, is_paid, cost_basis, measurement)
     select r."code", r."label", r."isPaid", r."costBasis", r."measurement"
     from jsonb_to_recordset($1::jsonb) as r("code" text, "label" text, "isPaid" boolean, "costBasis" text, "measurement" text)`,
    [JSON.stringify(CHANNELS)],
  );
  await pool.query("insert into app_clock (now) values ($1)", [new Date("2026-10-31T13:00:00Z")]);
}

export async function ingest(pool: Pool, source: SourceName, records: RawRecord[], opts: { mapper?: SourceMapper; now?: Date } = {}): Promise<IngestStats> {
  return withTransaction(pool, (tx) =>
    ingestRecords(tx, { source, records, mapper: opts.mapper ?? mapperFor(source), ctx: referenceContext, runId: null, now: opts.now ?? T0 }),
  );
}

export async function runReconcile(pool: Pool, now = T0) {
  return withTransaction(pool, (tx) => reconcile(tx, now));
}

export const one = async <T = Record<string, unknown>>(pool: Pool, sql: string, params: unknown[] = []): Promise<T> =>
  (await pool.query(sql, params)).rows[0] as T;

// ── Record factories, shaped like the sources ────────────────────────────────

const wall = (branchId: string, at: Date) => instantToWallTime(at, BRANCH_BY_ID.get(branchId)!.timezone);
const office = (branchId: string) => String(BRANCH_BY_ID.get(branchId)!.crmOfficeId);
const hours = (h: number) => h * 3_600_000;

export const crm = {
  customer: (id: number, branchId: string, phone: string, at: Date, extra: Record<string, unknown> = {}): RawRecord => ({
    entity: "customer",
    payload: { customerID: String(id), officeID: office(branchId), phone1: phone, email: null, zip: "10001", source: "Google Ads", dateAdded: wall(branchId, at), dateUpdated: wall(branchId, at), ...extra },
  }),
  subscription: (id: number, customerId: number, branchId: string, at: Date, extra: Record<string, unknown> = {}): RawRecord => ({
    entity: "subscription",
    payload: {
      subscriptionID: String(id), customerID: String(customerId), officeID: office(branchId), serviceType: "General Pest", soldBy: "0", source: "Google Ads",
      contractValue: "540.00", active: "1", dateAdded: wall(branchId, at), dateCancelled: "0000-00-00 00:00:00", dateUpdated: wall(branchId, at), ...extra,
    },
  }),
  appointment: (id: number, subId: number, customerId: number, branchId: string, status: "0" | "1" | "-1", scheduled: Date, updated: Date): RawRecord => {
    const [date, start] = wall(branchId, scheduled).split(" ");
    return {
      entity: "appointment",
      payload: {
        appointmentID: String(id), subscriptionID: String(subId), customerID: String(customerId), officeID: office(branchId), salesAnchor: "1", status, date, start,
        dateCompleted: status === "1" ? wall(branchId, updated) : "0000-00-00 00:00:00", dateUpdated: wall(branchId, updated),
      },
    };
  },
  ticket: (id: number, customerId: number, apptId: number, branchId: string, total: string, at: Date): RawRecord => ({
    entity: "ticket",
    payload: { ticketID: String(id), customerID: String(customerId), appointmentID: String(apptId), officeID: office(branchId), templateType: "I", total, dateCreated: wall(branchId, at), dateUpdated: wall(branchId, at) },
  }),
  payment: (id: number, customerId: number, ticketId: number, branchId: string, amount: string, at: Date, status: "0" | "1" = "1", originalPaymentID = "0"): RawRecord => ({
    entity: "payment",
    payload: { paymentID: String(id), customerID: String(customerId), officeID: office(branchId), ticketID: String(ticketId), amount, originalPaymentID, status, date: wall(branchId, at) },
  }),
};

export function call(id: string, branchId: string, phone: string, at: Date, source = "Google Ads", extra: Record<string, unknown> = {}): RawRecord {
  return {
    entity: "call",
    payload: {
      id, branch_tag: branchId, start_time: at.toISOString(), tracking_phone_number: "+12025550199", source, gclid: null, campaign: null, agent_note: null,
      customer_phone_number: phone, ...extra,
    },
  };
}

/** One complete paid acquisition: call → customer → subscription → completed initial → ticket → payment. */
export function acquisition(n: number, branchId: string, phone: string, soldAt: Date, opts: { source?: string; amount?: string } = {}) {
  const customerId = 1000 + n;
  const subId = 2000 + n;
  const apptId = 3000 + n;
  const ticketId = 4000 + n;
  const done = new Date(soldAt.getTime() + hours(48));
  return {
    call: call(`CAL-${n}`, branchId, phone, new Date(soldAt.getTime() - hours(1)), opts.source ?? "Google Ads"),
    crm: [
      crm.customer(customerId, branchId, phone, soldAt),
      crm.subscription(subId, customerId, branchId, soldAt),
      crm.appointment(apptId, subId, customerId, branchId, "0", done, soldAt),
      crm.appointment(apptId, subId, customerId, branchId, "1", done, done),
      crm.ticket(ticketId, customerId, apptId, branchId, opts.amount ?? "149.00", new Date(done.getTime() + hours(1))),
      crm.payment(5000 + n, customerId, ticketId, branchId, opts.amount ?? "149.00", new Date(done.getTime() + hours(2))),
    ],
    customerId,
    ticketId,
  };
}
