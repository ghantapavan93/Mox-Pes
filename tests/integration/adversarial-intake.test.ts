import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { POST as ingestPost } from "@/app/api/ingest/[source]/route";
import type { RawRecord, SourceMapper } from "@/lib/adapters/contract";
import { redactValue } from "@/lib/adapters/redact";
import { mapperFor } from "@/lib/adapters/registry";
import { parseMoneyToCents, wallTimeToInstant } from "@/lib/primitives";
import { T0, call, crm, freshDb, ingest, one, runReconcile, testPool } from "../helpers";

/**
 * Adversarial intake (docs/agent-work/ADVERSARIAL-MATRIX.md). The reviewer's challenge: "your demo
 * works because you invented the data". Every case feeds data the adapters were NOT designed
 * around through the real path (redact -> identify -> map -> raw ledger -> projection) and
 * asserts the SAFE outcome: the record is projected correctly, or it is kept and quarantined
 * with a reason. Never silently dropped, never silently reinterpreted.
 *
 * The case id (ADV-nn) is the row in the matrix. Cases marked "was FAIL" reproduced a defect
 * before the fix in the same change.
 */
const pool: Pool = testPool();
// The push route reads its pool from lib/server (which needs a Next request); point it at the test pool.
const route = vi.hoisted(() => ({ pool: null as unknown }));
vi.mock("@/lib/server", () => ({ getPool: () => route.pool, businessNow: async () => new Date("2026-10-31T13:00:00Z") }));
route.pool = pool;
beforeEach(async () => freshDb(pool));
afterAll(async () => pool.end());

async function rawOutcome(source: string) {
  return (
    await pool.query<{ entity_id: string; status: string; error_code: string | null }>(
      "select entity_id, status, error_code from raw_events where source = $1 order by id",
      [source],
    )
  ).rows;
}

/** Ingests one record and returns how the ledger accounted for it. */
async function intake(source: "crm" | "calls" | "web" | "d2d" | "ads", record: RawRecord) {
  const stats = await ingest(pool, source, [record]);
  const rows = await rawOutcome(source);
  return { stats, rows, accounted: stats.inserted + stats.duplicates + stats.conflicts };
}

const callRailExport = (overrides: Record<string, unknown> = {}): RawRecord => ({
  // Column names as a call-tracking CSV export would label them, not as our webhook mapper expects.
  entity: "call",
  payload: { "Call ID": "CR-1", "Start Time": "10/05/2026 3:04 PM", "Customer Phone Number": "(480) 555-0101", Source: "Google Ads", ...overrides },
});

describe("adversarial intake · schema challenges", () => {
  it("ADV-01 renamed columns (a CSV-export shape) are kept and quarantined, not dropped or guessed", async () => {
    const { rows, accounted } = await intake("calls", callRailExport());
    expect(accounted).toBe(1);
    expect(rows).toEqual([expect.objectContaining({ status: "quarantined", error_code: "MISSING_IDENTITY" })]);
  });

  it("ADV-02 a missing required column quarantines with SCHEMA_VIOLATION", async () => {
    const r = call("CAL-1", "B01", "+12125550101", T0);
    delete (r.payload as Record<string, unknown>).branch_tag;
    const { rows } = await intake("calls", r);
    expect(rows[0]).toMatchObject({ status: "quarantined", error_code: "SCHEMA_VIOLATION" });
  });

  it("ADV-03 unknown extra fields are ignored by the projection but preserved in the raw ledger", async () => {
    const r = call("CAL-2", "B01", "+12125550102", T0, "Google Ads", { lead_score: 97, nested: { a: [1, 2] } });
    await intake("calls", r);
    const raw = await one<{ payload: Record<string, unknown>; status: string }>(pool, "select payload, status from raw_events where source = 'calls'");
    expect(raw.status).toBe("projected");
    expect(raw.payload).toMatchObject({ lead_score: 97, nested: { a: [1, 2] } });
  });

  it("ADV-04 a conflicting field type (number where a string is required) quarantines", async () => {
    const r = call("CAL-3", "B01", "+12125550103", T0, "Google Ads", { campaign: 12345 });
    const { rows } = await intake("calls", r);
    expect(rows[0]).toMatchObject({ status: "quarantined", error_code: "SCHEMA_VIOLATION" });
  });

  it("ADV-05 an unknown status code (a call source the mapper has never seen) quarantines", async () => {
    const r = call("CAL-4", "B01", "+12125550104", T0, "TikTok");
    const { rows } = await intake("calls", r);
    expect(rows[0]).toMatchObject({ status: "quarantined", error_code: "SCHEMA_VIOLATION" });
  });

  it("ADV-06 an unknown CRM appointment status code quarantines", async () => {
    const r = crm.appointment(3001, 2001, 1001, "B01", "1", T0, T0);
    (r.payload as Record<string, unknown>).status = "7";
    const { rows } = await intake("crm", r);
    expect(rows[0]).toMatchObject({ status: "quarantined", error_code: "SCHEMA_VIOLATION" });
  });

  it("ADV-07 an unknown CRM entity is kept and quarantined as UNKNOWN_ENTITY", async () => {
    const { rows } = await intake("crm", { entity: "invoice_line", payload: { lineID: "1", officeID: "101" } });
    expect(rows[0]).toMatchObject({ status: "quarantined", error_code: "UNKNOWN_ENTITY" });
  });
});

describe("adversarial intake · format challenges", () => {
  it("ADV-10 a US-format date is not reinterpreted; it quarantines", async () => {
    const r = call("CAL-10", "B01", "+12125550110", T0, "Google Ads", { start_time: "10/05/2026 15:04:00" });
    const { rows } = await intake("calls", r);
    expect(rows[0]).toMatchObject({ status: "quarantined" });
  });

  it("ADV-11 a zone-less timestamp on an ISO feed is not assumed to be UTC; it quarantines", async () => {
    const r = call("CAL-11", "B01", "+12125550111", T0, "Google Ads", { start_time: "2026-10-05T15:04:00" });
    const { rows } = await intake("calls", r);
    expect(rows[0]).toMatchObject({ status: "quarantined" });
  });

  it("ADV-12 (was FAIL) an impossible CRM calendar date is refused, not rolled into the next month", async () => {
    expect(() => wallTimeToInstant("2026-02-30 10:00:00", "America/Chicago")).toThrow();
    expect(() => wallTimeToInstant("2026-10-05 24:00:00", "America/Chicago")).toThrow();
    expect(() => wallTimeToInstant("2026-10-05 10:61:00", "America/Chicago")).toThrow();
    const r = crm.customer(1012, "B01", "+12125550112", T0);
    (r.payload as Record<string, unknown>).dateUpdated = "2026-02-30 10:00:00";
    const { rows } = await intake("crm", r);
    expect(rows[0]).toMatchObject({ status: "quarantined", error_code: "INVALID_TIMESTAMP" });
  });

  it("ADV-13 (was FAIL) an impossible date in a non-clock field quarantines instead of projecting a different day", async () => {
    const r = crm.customer(1013, "B01", "+12125550113", T0);
    (r.payload as Record<string, unknown>).dateAdded = "2026-09-31 08:00:00";
    const { rows } = await intake("crm", r);
    expect(rows[0]).toMatchObject({ status: "quarantined" });
    expect(await one(pool, "select count(*)::int as n from crm_customers")).toEqual({ n: 0 });
  });

  it("ADV-14 text money such as \"$1,234.00\" is not parsed by guesswork; it quarantines", async () => {
    const r = crm.ticket(4014, 1014, 3014, "B01", "$1,234.00", T0);
    const { rows } = await intake("crm", r);
    expect(rows[0]).toMatchObject({ status: "quarantined", error_code: "SCHEMA_VIOLATION" });
  });

  it("ADV-15 (was FAIL) money beyond exact integer range is refused rather than silently rounded", async () => {
    expect(() => parseMoneyToCents("99999999999999999.99")).toThrow();
    expect(parseMoneyToCents("90071992547409.91")).toBe(9_007_199_254_740_991);
    const r = crm.ticket(4015, 1015, 3015, "B01", "99999999999999999.99", T0);
    const { rows } = await intake("crm", r);
    expect(rows[0]).toMatchObject({ status: "quarantined" });
  });

  it("ADV-16 a negative ticket total is refused by the mapper (the ledger check stands behind it)", async () => {
    const r = crm.ticket(4016, 1016, 3016, "B01", "-149.00", T0);
    const { rows } = await intake("crm", r);
    expect(rows[0]).toMatchObject({ status: "quarantined", error_code: "SCHEMA_VIOLATION" });
  });

  it("ADV-17 a negative payment with no original payment (an orphan refund) quarantines", async () => {
    const r = crm.payment(5017, 1017, 4017, "B01", "-50.00", T0);
    const { rows } = await intake("crm", r);
    expect(rows[0]).toMatchObject({ status: "quarantined" });
  });

  it("ADV-18 scientific notation in an identifier quarantines", async () => {
    const r = crm.customer(1018, "B01", "+12125550118", T0);
    (r.payload as Record<string, unknown>).customerID = "1.018e3";
    const { rows } = await intake("crm", r);
    expect(rows[0]).toMatchObject({ status: "quarantined" });
  });

  it("ADV-19 (was FAIL) a leading-zero identifier is refused, so \"0042\" and \"42\" cannot become one customer", async () => {
    const a = crm.customer(42, "B01", "+12125550119", T0);
    const b = crm.customer(42, "B01", "+12125550129", new Date(T0.getTime() + 3_600_000));
    (b.payload as Record<string, unknown>).customerID = "0042";
    await ingest(pool, "crm", [a, b]);
    const rows = await rawOutcome("crm");
    expect(rows.map((r) => r.status).sort()).toEqual(["projected", "quarantined"]);
    expect(rows.find((r) => r.status === "quarantined")?.error_code).toBe("INVALID_IDENTITY");
    const c = await one<{ n: number }>(pool, "select count(*)::int as n from crm_customers");
    expect(c.n).toBe(1);
  });

  it("ADV-20 an identifier longer than 15 digits quarantines (bigint and JS-number exactness)", async () => {
    const r = crm.customer(1020, "B01", "+12125550120", T0);
    (r.payload as Record<string, unknown>).customerID = "1234567890123456";
    const { rows } = await intake("crm", r);
    expect(rows[0]).toMatchObject({ status: "quarantined" });
  });

  it("ADV-21 Unicode is stored exactly as received; a NUL byte (which Postgres cannot store) is removed by redaction", async () => {
    await ingest(pool, "calls", [
      call("CAL-21a", "B01", "+12125550121", T0, "Google Ads", { agent_note: "Señora Ñúñez — 害虫 😀" }),
      call("CAL-21b", "B01", "+12125550131", T0, "Google Ads", { agent_note: "bad\u0000byte" }),
    ]);
    const notes = (await pool.query<{ note: string }>("select payload->>'agent_note' as note from raw_events where source = 'calls' order by id")).rows.map((r) => r.note);
    expect(notes).toEqual(["Señora Ñúñez — 害虫 😀", "badbyte"]);
  });

  it("ADV-24 (was FAIL) an impossible ISO instant on a push feed is refused, not moved to another day", async () => {
    for (const [i, start] of ["2026-02-30T10:00:00Z", "2026-04-31T10:00:00-05:00", "2026-10-05T24:00:00Z", "2026-10-05T10:00:00+25:00"].entries()) {
      await ingest(pool, "calls", [call(`CAL-24${i}`, "B01", `+1212555014${i}`, T0, "Google Ads", { start_time: start })]);
    }
    const rows = await rawOutcome("calls");
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.status === "quarantined" && r.error_code === "INVALID_TIMESTAMP")).toBe(true);
    expect(await one(pool, "select count(*)::int as n from leads")).toEqual({ n: 0 });
  });

  it("ADV-25 (was FAIL) an impossible appointment date or start time quarantines", async () => {
    const a = crm.appointment(3025, 2025, 1025, "B01", "0", T0, T0);
    (a.payload as Record<string, unknown>).date = "2026-11-31";
    const b = crm.appointment(3026, 2026, 1026, "B01", "0", T0, T0);
    (b.payload as Record<string, unknown>).start = "25:10:00";
    await ingest(pool, "crm", [a, b]);
    expect((await rawOutcome("crm")).map((r) => r.error_code)).toEqual(["SCHEMA_VIOLATION", "SCHEMA_VIOLATION"]);
  });

  it("ADV-22 placeholders (\"N/A\", \"\", \"null\") in a phone are not hashed into a fake identity", async () => {
    for (const [i, phone] of ["N/A", "", "null"].entries()) {
      await ingest(pool, "calls", [call(`CAL-22${i}`, "B01", phone, T0)]);
    }
    const leads = await one<{ n: number }>(pool, "select count(*)::int as n from leads where phone_hash is not null");
    expect(leads.n).toBe(0);
    expect((await rawOutcome("calls")).every((r) => r.status === "quarantined")).toBe(true);
  });

  it("ADV-23 an ad-spend date that does not exist quarantines", async () => {
    const { rows } = await intake("ads", {
      entity: "spend_day",
      payload: { platform: "google_ads", accountId: "111", campaignId: "9", campaignName: "x", date: "2026-02-30", costMicros: "1000000", clicks: 1, conversions: 0, fetchedAt: "2026-10-01T00:00:00Z" },
    });
    expect(rows[0]).toMatchObject({ status: "quarantined" });
  });
});

describe("adversarial intake · business and operational challenges", () => {
  it("ADV-30 the same delivery three times counts once", async () => {
    const r = call("CAL-30", "B01", "+12125550130", T0);
    await ingest(pool, "calls", [r, r]);
    const stats = await ingest(pool, "calls", [r]);
    expect(stats.duplicates).toBe(1);
    expect(await one(pool, "select count(*)::int as n, max(delivery_count) as d from leads, raw_events where raw_events.source = 'calls'")).toMatchObject({ n: 1 });
    expect(await one(pool, "select delivery_count::int as d from raw_events")).toEqual({ d: 3 });
  });

  it("ADV-31 a CRM version arriving after a newer one never overwrites it", async () => {
    const newer = crm.customer(1031, "B01", "+12125550132", new Date(T0.getTime() + 7_200_000));
    const older = crm.customer(1031, "B01", "+12125550133", T0);
    await ingest(pool, "crm", [newer]);
    await ingest(pool, "crm", [older]);
    const c = await one<{ source_updated_at: Date }>(pool, "select source_updated_at from crm_customers where crm_customer_id = 1031");
    expect(c.source_updated_at.toISOString()).toBe(new Date(T0.getTime() + 7_200_000).toISOString().replace(/\.\d+Z$/, ".000Z"));
  });

  it("ADV-32 same version, different content is a payload conflict, not a silent overwrite", async () => {
    const a = crm.customer(1032, "B01", "+12125550134", T0);
    const b = crm.customer(1032, "B01", "+12125550135", T0);
    await ingest(pool, "crm", [a]);
    const stats = await ingest(pool, "crm", [b]);
    expect(stats.conflicts).toBe(1);
    expect(await one(pool, "select count(*)::int as n from exceptions where kind = 'payload_conflict'")).toEqual({ n: 1 });
  });

  it("ADV-33 a record naming an unknown branch quarantines and reconciliation still runs", async () => {
    await ingest(pool, "calls", [call("CAL-33", "B77", "+12125550136", T0)]);
    await expect(runReconcile(pool)).resolves.toBeDefined();
    expect((await rawOutcome("calls"))[0]).toMatchObject({ status: "quarantined", error_code: "UNKNOWN_BRANCH" });
  });

  it("ADV-35 (was FAIL) a mapper that throws on one record quarantines it as MAPPER_ERROR; the batch still lands", async () => {
    const base = mapperFor("calls");
    const throwing: SourceMapper = {
      source: base.source,
      version: base.version,
      identify: (r, c) => base.identify(r, c),
      map: (r, c) => {
        if ((r.payload as { id?: string }).id === "CAL-35b") throw new Error("mapper bug");
        return base.map(r, c);
      },
    };
    const stats = await ingest(pool, "calls", [call("CAL-35a", "B01", "+12125550151", T0), call("CAL-35b", "B01", "+12125550152", T0)], { mapper: throwing });
    expect(stats).toMatchObject({ inserted: 2, projected: 1, quarantined: 1 });
    expect((await rawOutcome("calls")).map((r) => r.error_code)).toEqual([null, "MAPPER_ERROR"]);
  });

  it("ADV-34 one bad record never blocks the rest of its batch", async () => {
    const stats = await ingest(pool, "calls", [
      call("CAL-34a", "B01", "+12125550137", T0),
      call("CAL-34b", "B01", "not a phone", T0),
      call("CAL-34c", "B01", "+12125550138", T0),
    ]);
    expect(stats).toMatchObject({ inserted: 3, projected: 2, quarantined: 1 });
  });
});

describe("adversarial intake · push API boundary", () => {
  // The key the route accepts here: INGEST_API_KEY when the environment sets one (CI does),
  // otherwise the development default (app/api/ingest/[source]/route.ts).
  const KEY = process.env.INGEST_API_KEY ?? "dev-ingest-key";
  const post = (source: string, body: string, key = KEY, headers: Record<string, string> = {}) =>
    ingestPost(new Request(`http://localhost/api/ingest/${source}`, { method: "POST", body, headers: { "content-type": "application/json", "x-ingest-key": key, ...headers } }), {
      params: Promise.resolve({ source }),
    });

  it("ADV-40 a wrong key is refused before the body is read", async () => {
    expect((await post("calls", "{}", "nope")).status).toBe(401);
  });

  it("ADV-41 a pull-only source cannot be pushed", async () => {
    expect((await post("crm", JSON.stringify({ records: [{ entity: "customer", payload: {} }] }))).status).toBe(404);
  });

  it("ADV-42 (was FAIL) an oversized body is refused with 413 and nothing is stored", async () => {
    const huge = JSON.stringify({ records: [{ entity: "call", payload: { agent_note: "x".repeat(3 * 1024 * 1024) } }] });
    const res = await post("calls", huge);
    expect(res.status).toBe(413);
    expect(await one(pool, "select count(*)::int as n from raw_events")).toEqual({ n: 0 });
  });

  it("ADV-43 a declared Content-Length over the limit is refused without reading", async () => {
    const res = await post("calls", JSON.stringify({ records: [] }), KEY, { "content-length": String(50 * 1024 * 1024) });
    expect(res.status).toBe(413);
  });

  it("ADV-44 malformed JSON and an empty batch are 400s", async () => {
    expect((await post("calls", "{not json")).status).toBe(400);
    expect((await post("calls", JSON.stringify({ records: [] }))).status).toBe(400);
  });

  it("ADV-46 (was FAIL) redacting a multi-megabyte free-text note is linear, not quadratic", () => {
    const t = Date.now();
    redactValue({ agent_note: "x".repeat(1_000_000) });
    redactValue({ agent_note: "1".repeat(1_000_000) });
    // The old unbounded e-mail pattern took 36 s on 200 KB and hours on 3 MB.
    expect(Date.now() - t).toBeLessThan(5_000);
    expect(redactValue({ agent_note: "reach me on (480) 555-0101 or jo@example.com" })).toEqual({ agent_note: "reach me on [phone] or [email]" });
  });

  it("ADV-45 a prototype-pollution key in a payload is stored as data and pollutes nothing", async () => {
    const body = `{"records":[{"entity":"call","payload":{"__proto__":{"polluted":true},"id":"CAL-45"}}]}`;
    const res = await post("calls", body);
    expect(res.status).toBe(200);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
