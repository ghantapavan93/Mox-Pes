import { readFileSync } from "node:fs";
import path from "node:path";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Queryable } from "@/lib/db";
import { budgetSignal, decisionHolds, evidenceHolds } from "@/lib/metrics/decision";
import { channelEvidence } from "@/lib/metrics/eligibility";
import { branchRows, channelRows, conversionBridge, type Scope } from "@/lib/metrics/scorecard";
import { PERIODS } from "@/lib/period";
import { seed } from "@/lib/sim/seed";
import { testPool } from "../helpers";

/**
 * Migration 0038 decides v_acquisitions' first subscription and initial appointment in sets, and
 * WP-G rewrote four statements around it so each keeps its period, or its customers, first
 * (release design §5.10, WP-G step 3). None of it may change a result. Each read runs twice on one
 * connection: as it is now, on the new views, and as it was, on 0026's view (read from that
 * migration and kept here as a table) with the old text of every statement WP-G changed. On the
 * seeded world the two agree for every branch and period. On added customers whose subscriptions
 * tie on `sold_at`, whose initial appointments tie on `scheduled_for`, and whose subscriptions span
 * September and October, they agree once 0026's appointment order is total, as 0038's is.
 */

const pool = testPool();
let client: PoolClient;

const BRANCHES: string[] = [];
const MONTHS = [PERIODS.oct, PERIODS.sep, PERIODS.all];
/** Monday-to-Monday weeks over the seeded months, for the scorecard. */
const WEEKS = Array.from({ length: 10 }, (_, i) => {
  const from = new Date(Date.UTC(2026, 7, 31 + 7 * i));
  return { from, to: new Date(from.getTime() + 7 * 86_400_000) };
});
/** The scenario branches and the fixture branches, for reads whose all-branch result lists every branch. */
const SAMPLE = ["B01", "B02", "B03", "B04", "B05", "B09", "B10", "B11", "B20"];

// ── The old view, from its own migration ─────────────────────────────────────

const migration = readFileSync(path.join(process.cwd(), "database/migrations/0026_latest_identity_decision.sql"), "utf8");
const VIEW_0026 = migration
  .slice(migration.indexOf("create or replace view v_acquisitions as"))
  .replace("create or replace view v_acquisitions as", "")
  .replace(/;\s*$/, "");
// The initial appointment's order, which ends the line (a checkout may end lines with CRLF).
const UNTIED = /order by \(a\.status = 'rescheduled'\), a\.scheduled_for desc(?=\s)/;
const VIEW_0026_TOTAL = VIEW_0026.replace(UNTIED, "order by (a.status = 'rescheduled'), a.scheduled_for desc, a.crm_appointment_id");

async function keepOldView(select: string): Promise<void> {
  await client.query("drop table if exists pg_temp.acquisitions_old");
  await client.query(`create temp table acquisitions_old as ${select}`);
}

// ── The old text of each statement WP-G changed ──────────────────────────────

interface Swap {
  name: string;
  now: string;
  then: string;
  used: number;
}

/** SQL without comments, its whitespace collapsed, so fragments match however they are indented. */
const flat = (sql: string) => sql.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim();
const swap = (name: string, now: string, then: string): Swap => ({ name, now: flat(now), then: flat(then), used: 0 });

const SWAPS: Swap[] = [
  swap(
    "branchRows: sold",
    `select b.id as branch_id, count(*) as sold
       from v_first_subscriptions fs
       join crm_customers c on c.crm_customer_id = fs.crm_customer_id
       join branches b on b.crm_office_id = fs.office_id
       where fs.sold_at >= $1::timestamptz and fs.sold_at < $2::timestamptz group by 1`,
    `select a.branch_id, count(*) as sold from v_acquisitions a, p
       where a.sold_at >= p.t0 and a.sold_at < p.t1 group by 1`,
  ),
  swap(
    "branchRows: period_acq",
    `left join v_customer_revenue r on r.crm_customer_id = a.crm_customer_id
       where a.initial_status = 'completed' and a.initial_completed_at >= $1::timestamptz and a.initial_completed_at < $2::timestamptz`,
    `left join v_customer_revenue r on r.crm_customer_id = a.crm_customer_id, p
       where a.initial_status = 'completed' and a.initial_completed_at >= p.t0 and a.initial_completed_at < p.t1`,
  ),
  swap(
    "conversionBridge: acq",
    `candidates as materialized (
       select cu.crm_customer_id from v_leads l join crm_customers cu on cu.phone_hash = l.phone_hash
       where l.prospect_key in (select prospect_key from prospects)
       union
       select cu.crm_customer_id from v_leads l join crm_customers cu on cu.email_hash = l.email_hash
       where l.prospect_key in (select prospect_key from prospects)),
     acq as materialized (
       select a.lead_id, a.channel_code, a.initial_status, a.sold_at from v_acquisitions a
       where a.lead_id is not null and a.crm_customer_id = any(array(select crm_customer_id from candidates))),`,
    `acq as materialized (
       select a.lead_id, a.channel_code, a.initial_status, a.sold_at from v_acquisitions a where a.lead_id is not null),`,
  ),
  swap(
    "UNMAPPED_AT_BRANCH",
    `with unmapped as materialized (
    select e.id, e.kind, e.summary, e.severity, e.amount_cents, lc.lead_id
    from exceptions e
    join v_lead_campaigns lc on lc.campaign_id = (e.evidence ->> 'campaignId')::bigint
    where e.status = 'open' and e.kind = 'unmapped_spend' and e.branch_id is null),
  candidates as materialized (
    select cu.crm_customer_id from unmapped u join leads l on l.id = u.lead_id join crm_customers cu on cu.phone_hash = l.phone_hash
    union
    select cu.crm_customer_id from unmapped u join leads l on l.id = u.lead_id join crm_customers cu on cu.email_hash = l.email_hash)
  select distinct u.id, a.branch_id, a.channel_code, a.initial_completed_at, u.kind, u.summary, u.severity, u.amount_cents
  from unmapped u
  join v_acquisitions a on a.lead_id = u.lead_id and a.initial_status = 'completed'
    and a.crm_customer_id = any(array(select crm_customer_id from candidates))`,
    `select distinct e.id, a.branch_id, a.channel_code, a.initial_completed_at, e.kind, e.summary, e.severity, e.amount_cents
  from exceptions e
  join v_lead_campaigns lc on lc.campaign_id = (e.evidence ->> 'campaignId')::bigint
  join v_acquisitions a on a.lead_id = lc.lead_id and a.initial_status = 'completed'
  where e.status = 'open' and e.kind = 'unmapped_spend' and e.branch_id is null`,
  ),
];

/**
 * The connection as it was: each changed statement back in its old text, and v_acquisitions read
 * from the kept 0026 table. A fragment that appears twice is an error: the swap would be ambiguous.
 */
const before: Queryable = {
  query: (text, params) => {
    let sql = flat(text);
    for (const s of SWAPS) {
      const times = sql.split(s.now).length - 1;
      if (times > 1) throw new Error(`"${s.name}" appears ${times} times in one statement`);
      if (times === 1) {
        sql = sql.replace(s.now, () => s.then);
        s.used += 1;
      }
    }
    return client.query(sql.replace(/\bv_acquisitions\b/g, "pg_temp.acquisitions_old"), params);
  },
};
const now: Queryable = { query: (text, params) => client.query(text, params) };

async function same<T>(label: string, read: (db: Queryable) => Promise<T>): Promise<T> {
  const result = await read(now);
  expect(result, label).toEqual(await read(before));
  return result;
}

const scope = (period: { from: Date; to: Date }, branchIds: string[] | null): Scope => ({ from: period.from, to: period.to, branchIds });
const day = (iso: string) => new Date(iso);

beforeAll(async () => {
  await seed(pool);
  client = await pool.connect();
  BRANCHES.push(...(await client.query<{ id: string }>("select id from branches order by id")).rows.map((r) => r.id));
}, 300_000);

afterAll(async () => {
  client?.release();
  await pool.end();
});

describe("the seeded world reads the same before and after WP-G step 3", () => {
  beforeAll(async () => {
    await keepOldView(VIEW_0026);
  });

  it("v_acquisitions: every customer's row is 0026's", async () => {
    const order = "order by crm_customer_id";
    const after = (await client.query(`select * from v_acquisitions ${order}`)).rows;
    const old = (await client.query(`select * from pg_temp.acquisitions_old ${order}`)).rows;
    expect(after.length).toBeGreaterThan(10_000);
    expect(after).toEqual(old);
  }, 60_000);

  it("the scorecard, for every branch, in every month and week", async () => {
    for (const period of [...MONTHS, ...WEEKS]) await same(`branchRows ${period.from.toISOString()}`, (db) => branchRows(db, scope(period, null)));
    await same("branchRows, two branches", (db) => branchRows(db, scope(PERIODS.oct, ["B09", "B20"])));
  }, 120_000);

  it("the conversion bridge, for the company and for each branch, in every month", async () => {
    for (const period of MONTHS) {
      for (const branchIds of [null, ...BRANCHES.map((b) => [b])]) {
        await same(`conversionBridge ${period.from.toISOString()} ${branchIds ?? "all"}`, (db) => conversionBridge(db, scope(period, branchIds)));
      }
    }
  }, 180_000);

  it("eligibility and the holds, for the company and the scenario branches, in every month", async () => {
    for (const period of MONTHS) {
      for (const branchIds of [null, ...SAMPLE.map((b) => [b])]) {
        const at = `${period.from.toISOString()} ${branchIds ?? "all"}`;
        await same(`channelEvidence ${at}`, (db) => channelEvidence(db, scope(period, branchIds)));
        await same(`evidenceHolds ${at}`, (db) => evidenceHolds(db, branchIds, period));
        await same(`decisionHolds ${at}`, (db) => decisionHolds(db, branchIds, 50, period));
      }
    }
    await same("decisionHolds, no period", (db) => decisionHolds(db, null, 50, null));
  }, 180_000);

  it("the Decision Lab's signal, for every branch, in October and September", async () => {
    for (const period of [PERIODS.oct, PERIODS.sep]) {
      for (const b of BRANCHES) await same(`budgetSignal ${period.key} ${b}`, (db) => budgetSignal(db, b, { from: period.from, to: period.to }));
    }
  }, 180_000);

  it("ran every old statement it holds: a query WP-G changed has not changed again", () => {
    expect(SWAPS.filter((s) => s.used === 0).map((s) => s.name)).toEqual([]);
  });
});

describe("ties and subscriptions that span two months read the same once both orders are total", () => {
  beforeAll(async () => {
    expect(VIEW_0026_TOTAL).not.toBe(VIEW_0026);
    await client.query("begin");
    const ev = (await client.query<{ id: string }>("select min(id) as id from raw_events")).rows[0].id;
    const customer = (id: number, branch: string, phone: string | null, at: string) =>
      client.query(
        `insert into crm_customers (crm_customer_id, office_id, phone_hash, created_at_source, source_updated_at, raw_event_id)
         values ($1, (select crm_office_id from branches where id = $2), $3, $4, $4, $5)`,
        [id, branch, phone, at, ev],
      );
    const subscription = (id: number, customerId: number, branch: string, soldAt: string) =>
      client.query(
        `insert into crm_subscriptions (crm_subscription_id, crm_customer_id, office_id, service_type, annual_value_cents, status, sold_at, source_updated_at, raw_event_id)
         values ($1, $2, (select crm_office_id from branches where id = $3), 'General Pest', 54000, 'active', $4, $4, $5)`,
        [id, customerId, branch, soldAt, ev],
      );
    const appointment = (id: number, subId: number, customerId: number, branch: string, status: string, scheduledFor: string, completedAt: string | null = null) =>
      client.query(
        `insert into crm_appointments (crm_appointment_id, crm_subscription_id, crm_customer_id, office_id, kind, status, scheduled_for, completed_at, source_updated_at, raw_event_id)
         values ($1, $2, $3, (select crm_office_id from branches where id = $4), 'initial', $5, $6, $7, $6, $8)`,
        [id, subId, customerId, branch, status, scheduledFor, completedAt, ev],
      );

    // C1: two subscriptions sold at the same instant, at B01 and B02. The lower id is first: B01,
    // sold in September, serviced in October (the other would be B02, serviced in September).
    await customer(9_900_001, "B01", null, "2026-09-30T22:00:00Z");
    await subscription(9_910_011, 9_900_001, "B01", "2026-09-30T23:00:00Z");
    await subscription(9_910_012, 9_900_001, "B02", "2026-09-30T23:00:00Z");
    await appointment(9_920_111, 9_910_011, 9_900_001, "B01", "completed", "2026-10-02T15:00:00Z", "2026-10-02T16:00:00Z");
    await appointment(9_920_121, 9_910_012, 9_900_001, "B02", "completed", "2026-09-30T23:30:00Z", "2026-09-30T23:45:00Z");
    // C2: two initial appointments scheduled at the same time; the lower id, completed, decides. A
    // paid call two days before the sale credits the customer to Search.
    await customer(9_900_002, "B03", "fx-phone-2", "2026-10-03T14:00:00Z");
    await subscription(9_910_021, 9_900_002, "B03", "2026-10-03T15:00:00Z");
    await appointment(9_920_211, 9_910_021, 9_900_002, "B03", "completed", "2026-10-05T15:00:00Z", "2026-10-05T16:00:00Z");
    await appointment(9_920_212, 9_910_021, 9_900_002, "B03", "no_show", "2026-10-05T15:00:00Z");
    await client.query(
      `insert into leads (source, source_lead_id, branch_id, channel_code, attribution_evidence, phone_hash, occurred_at, source_updated_at, raw_event_id)
       values ('calls', 'FX-LEAD-2', 'B03', 'google_search', 'tracking_number', 'fx-phone-2', '2026-10-01T15:00:00Z', '2026-10-01T15:00:00Z', $1)`,
      [ev],
    );
    // C3: the same tie, the other way round: the lower id was cancelled, so the customer is not serviced.
    await customer(9_900_003, "B03", null, "2026-10-03T14:00:00Z");
    await subscription(9_910_031, 9_900_003, "B03", "2026-10-03T15:00:00Z");
    await appointment(9_920_311, 9_910_031, 9_900_003, "B03", "cancelled", "2026-10-06T15:00:00Z");
    await appointment(9_920_312, 9_910_031, 9_900_003, "B03", "completed", "2026-10-06T15:00:00Z", "2026-10-06T16:00:00Z");
    // C4: a rescheduled appointment scheduled later still loses to one that is not.
    await customer(9_900_004, "B04", null, "2026-10-04T14:00:00Z");
    await subscription(9_910_041, 9_900_004, "B04", "2026-10-04T15:00:00Z");
    await appointment(9_920_411, 9_910_041, 9_900_004, "B04", "rescheduled", "2026-10-20T15:00:00Z");
    await appointment(9_920_412, 9_910_041, 9_900_004, "B04", "completed", "2026-10-08T15:00:00Z", "2026-10-08T16:00:00Z");
    // C5: sold in September at B04 and serviced in October; a second subscription in October at B05
    // is not the first and counts nowhere.
    await customer(9_900_005, "B04", null, "2026-09-28T14:00:00Z");
    await subscription(9_910_051, 9_900_005, "B04", "2026-09-28T15:00:00Z");
    await appointment(9_920_511, 9_910_051, 9_900_005, "B04", "completed", "2026-10-02T15:00:00Z", "2026-10-02T16:00:00Z");
    await subscription(9_910_052, 9_900_005, "B05", "2026-10-05T15:00:00Z");
    await appointment(9_920_521, 9_910_052, 9_900_005, "B05", "completed", "2026-10-08T15:00:00Z", "2026-10-08T16:00:00Z");

    await keepOldView(VIEW_0026_TOTAL);
  });

  afterAll(async () => {
    await client.query("rollback");
  });

  it("v_acquisitions applies the rules to the fixtures", async () => {
    const { rows } = await client.query(
      `select crm_customer_id::int as id, crm_subscription_id::int as sub, branch_id, sold_at, initial_status, initial_completed_at, channel_code
       from v_acquisitions where crm_customer_id between 9900001 and 9900005 order by 1`,
    );
    expect(rows).toEqual([
      { id: 9_900_001, sub: 9_910_011, branch_id: "B01", sold_at: day("2026-09-30T23:00:00Z"), initial_status: "completed", initial_completed_at: day("2026-10-02T16:00:00Z"), channel_code: "unknown" },
      { id: 9_900_002, sub: 9_910_021, branch_id: "B03", sold_at: day("2026-10-03T15:00:00Z"), initial_status: "completed", initial_completed_at: day("2026-10-05T16:00:00Z"), channel_code: "google_search" },
      { id: 9_900_003, sub: 9_910_031, branch_id: "B03", sold_at: day("2026-10-03T15:00:00Z"), initial_status: "cancelled", initial_completed_at: null, channel_code: "unknown" },
      { id: 9_900_004, sub: 9_910_041, branch_id: "B04", sold_at: day("2026-10-04T15:00:00Z"), initial_status: "completed", initial_completed_at: day("2026-10-08T16:00:00Z"), channel_code: "unknown" },
      { id: 9_900_005, sub: 9_910_051, branch_id: "B04", sold_at: day("2026-09-28T15:00:00Z"), initial_status: "completed", initial_completed_at: day("2026-10-02T16:00:00Z"), channel_code: "unknown" },
    ]);
  });

  it("v_acquisitions equals 0026's with its appointment order made total", async () => {
    const order = "order by crm_customer_id";
    expect((await client.query(`select * from v_acquisitions ${order}`)).rows).toEqual((await client.query(`select * from pg_temp.acquisitions_old ${order}`)).rows);
  }, 60_000);

  it("the reads agree for the fixtures' branches in September, October and both", async () => {
    for (const period of MONTHS) {
      await same(`branchRows ${period.key}`, (db) => branchRows(db, scope(period, null)));
      for (const b of ["B01", "B02", "B03", "B04", "B05"]) {
        await same(`conversionBridge ${period.key} ${b}`, (db) => conversionBridge(db, scope(period, [b])));
        await same(`channelRows ${period.key} ${b}`, (db) => channelRows(db, scope(period, [b])));
        await same(`channelEvidence ${period.key} ${b}`, (db) => channelEvidence(db, scope(period, [b])));
      }
    }
  }, 120_000);
});
