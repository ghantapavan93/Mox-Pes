import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { RawRecord } from "@/lib/adapters/contract";
import { mapperFor, referenceContext } from "@/lib/adapters/registry";
import { withTransaction } from "@/lib/db";
import { dispatchEvents } from "@/lib/events/consumers";
import { ingestRecords } from "@/lib/ingest/ingest";
import { brandRows } from "@/lib/metrics/brands";
import { totals } from "@/lib/metrics/scorecard";
import { reconcile } from "@/lib/reconcile/reconcile";
import { BRANCHES, BRANDS, branchesOfBrands } from "@/lib/reference";
import { ForbiddenError, VIEWERS, resolveBrandScope, resolveScope } from "@/lib/viewer";
import { acquisition, freshDb, ingest, one, runReconcile, testPool } from "../helpers";

/**
 * The domain model's cross-context invariants (docs/domain-model.md):
 *   * Domain events: published in the writer's transaction; a consumer runs only for changes its
 *     last run provably did not see, and never loses an event that committed late.
 *   * Organization: every branch has one brand; brand lines add up to the company line; brand
 *     scope is branch scope.
 *   * Reporting contract: pinned columns, and facts that agree with the app's own metrics.
 */

const NOW = new Date("2026-10-31T13:00:00Z");
const OCT = { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-10-31T00:00:00Z") };

let pool: Pool;
beforeAll(() => {
  pool = testPool();
});
afterAll(async () => pool.end());
beforeEach(async () => {
  await freshDb(pool);
});

const count = async (sql: string, params: unknown[] = []) => Number((await one<{ n: string }>(pool, sql, params)).n);
const events = (type: string) => count("select count(*) n from domain_events where type = $1", [type]);
const statusOf = (results: Awaited<ReturnType<typeof dispatchEvents>>, consumer: string) => results.find((r) => r.consumer === consumer)?.status;

function spendDay(branch: string, d: number, dollars: number, campaign = `gs-${branch}`): RawRecord {
  const date = `2026-10-${String(d).padStart(2, "0")}`;
  return {
    entity: "spend_day",
    payload: {
      platform: "google_ads", accountId: "GA-TEST", campaignId: campaign, campaignName: `${branch} | Search`, campaignType: "SEARCH",
      date, costMicros: String(dollars * 1_000_000), clicks: 10, conversions: 2, fetchedAt: `${date}T23:00:00Z`,
    },
  };
}

async function mapCampaign(externalId: string, branch: string) {
  await pool.query(
    `insert into campaign_branch_map (campaign_id, branch_id, mapped_by, mapped_at)
     select id, $2, 'marketing-ops', $3 from ad_campaigns where external_campaign_id = $1`,
    [externalId, branch, NOW],
  );
}

// ── Domain events ───────────────────────────────────────────────────────────

describe("domain events", () => {
  it("a stored batch publishes intake.records_stored in its own transaction; a rolled-back batch publishes nothing", async () => {
    const sale = acquisition(1, "B01", "+12125550101", new Date("2026-10-05T15:00:00Z"));
    await ingest(pool, "crm", sale.crm);
    expect(await events("intake.records_stored")).toBe(1);
    const event = await one<{ payload: { source: string; inserted: number }; context: string }>(pool, "select payload, context from domain_events where type = 'intake.records_stored'");
    expect(event).toMatchObject({ context: "intake", payload: { source: "crm", inserted: sale.crm.length } });

    // Re-delivering the same versions stores nothing new and publishes nothing.
    await ingest(pool, "crm", sale.crm);
    expect(await events("intake.records_stored")).toBe(1);

    const other = acquisition(2, "B02", "+12125550102", new Date("2026-10-06T15:00:00Z"));
    await expect(
      withTransaction(pool, async (tx) => {
        await ingestRecords(tx, { source: "crm", records: other.crm, mapper: mapperFor("crm"), ctx: referenceContext, runId: null, now: NOW });
        throw new Error("abort");
      }),
    ).rejects.toThrow("abort");
    expect(await events("intake.records_stored")).toBe(1);
  });

  it("a consumer runs only for changes its last run did not see, and delivers every event once", async () => {
    await ingest(pool, "crm", acquisition(1, "B01", "+12125550101", new Date("2026-10-05T15:00:00Z")).crm);
    // Nothing reconciled yet: the event is uncovered and reconciliation runs.
    let results = await dispatchEvents(pool);
    expect(statusOf(results, "reconciliation")).toBe("ran");
    expect(statusOf(results, "identity")).toBe("ran");
    expect(await events("reconciliation.run_completed")).toBe(1);

    // Delivered: a second dispatch has nothing to do.
    results = await dispatchEvents(pool);
    expect(results.map((r) => r.status)).toEqual(["idle", "idle"]);

    // A writer that reconciles in its own transaction covers its own event: no extra run.
    await withTransaction(pool, async (tx) => {
      await ingestRecords(tx, { source: "crm", records: acquisition(2, "B02", "+12125550102", new Date("2026-10-06T15:00:00Z")).crm, mapper: mapperFor("crm"), ctx: referenceContext, runId: null, now: NOW });
      await reconcile(tx, NOW);
    });
    results = await dispatchEvents(pool, { only: ["reconciliation"] });
    expect(results).toEqual([{ consumer: "reconciliation", status: "caught_up", delivered: 1 }]);
    expect(await events("reconciliation.run_completed")).toBe(2);

    // A separate, later reconcile covers an earlier batch too.
    await ingest(pool, "crm", acquisition(3, "B03", "+12125550103", new Date("2026-10-07T15:00:00Z")).crm);
    await runReconcile(pool, NOW);
    results = await dispatchEvents(pool, { only: ["reconciliation"] });
    expect(results[0].status).toBe("caught_up");
    expect(await count("select count(*) n from event_deliveries where consumer = 'reconciliation'")).toBe(3);
  });

  it("an event whose transaction commits after a run started is not covered by that run", async () => {
    // The batch's transaction is open (event id assigned) while a reconcile runs and commits.
    const writer = await pool.connect();
    try {
      await writer.query("begin");
      await ingestRecords(writer, { source: "crm", records: acquisition(1, "B01", "+12125550101", new Date("2026-10-05T15:00:00Z")).crm, mapper: mapperFor("crm"), ctx: referenceContext, runId: null, now: NOW });
      await runReconcile(pool, NOW); // its snapshot sees the writer as in progress
      await writer.query("commit");
    } finally {
      writer.release();
    }
    const runEventId = Number((await one<{ id: string }>(pool, "select max(id) id from domain_events where type = 'reconciliation.run_completed'")).id);
    const storedEventId = Number((await one<{ id: string }>(pool, "select id from domain_events where type = 'intake.records_stored'")).id);
    expect(storedEventId).toBeLessThan(runEventId); // id order says "covered"; the snapshot says otherwise

    const results = await dispatchEvents(pool, { only: ["reconciliation"] });
    expect(results).toEqual([{ consumer: "reconciliation", status: "ran", delivered: 1 }]);
  });

  it("a failing consumer leaves its events pending and records the error", async () => {
    await ingest(pool, "crm", acquisition(1, "B01", "+12125550101", new Date("2026-10-05T15:00:00Z")).crm);
    await pool.query("alter table exceptions rename to exceptions_away");
    try {
      const [result] = await dispatchEvents(pool, { only: ["reconciliation"] });
      expect(result.status).toBe("failed");
    } finally {
      await pool.query("alter table exceptions_away rename to exceptions");
    }
    expect(await count("select count(*) n from event_deliveries where consumer = 'reconciliation'")).toBe(0);
    expect((await one<{ last_error: string | null }>(pool, "select last_error from event_consumers where consumer = 'reconciliation'")).last_error).toMatch(/exceptions/);
    const [retry] = await dispatchEvents(pool, { only: ["reconciliation"] });
    expect(retry).toEqual({ consumer: "reconciliation", status: "ran", delivered: 1 });
  });
});

// ── Organization: brands ────────────────────────────────────────────────────

describe("brands", () => {
  it("every branch belongs to exactly one known brand, in code and in the database", async () => {
    const ids = new Set(BRANDS.map((b) => b.id));
    expect(BRANCHES.every((b) => ids.has(b.brandId))).toBe(true);
    expect(BRANDS.flatMap((b) => branchesOfBrands([b.id])).sort()).toEqual(BRANCHES.map((b) => b.id).sort());
    const db = await pool.query<{ id: string; brand_id: string }>("select id, brand_id from branches order by id");
    expect(db.rows).toEqual(BRANCHES.map((b) => ({ id: b.id, brand_id: b.brandId })));
  });

  it("brand lines add up to the company line; unmapped spend belongs to no brand", async () => {
    const branches = { moxie: "B05", mission: "B28", joshuas: "B41" } as const;
    let n = 0;
    for (const branch of Object.values(branches)) {
      for (let k = 0; k < 2; k++) {
        const sale = acquisition(++n, branch, `+121255501${String(n).padStart(2, "0")}`, new Date(`2026-10-${String(3 + n).padStart(2, "0")}T15:00:00Z`));
        await ingest(pool, "calls", [sale.call]);
        await ingest(pool, "crm", sale.crm);
      }
    }
    await ingest(pool, "ads", [spendDay("B05", 3, 100), spendDay("B28", 3, 60), spendDay("B41", 3, 40), spendDay("B99", 3, 25, "orphan-campaign")]);
    for (const branch of Object.values(branches)) await mapCampaign(`gs-${branch}`, branch);
    await runReconcile(pool, NOW);

    const scope = { ...OCT, branchIds: null };
    const company = await totals(pool, scope);
    const brands = await brandRows(pool, scope);
    expect(brands.map((b) => b.brandId)).toEqual(["moxie", "mission", "joshuas"]);
    expect(brands.every((b) => b.complete)).toBe(true);
    const sum = (k: "paidSpendCents" | "acquired" | "collectedCents" | "newCustomerCollectedCents") => brands.reduce((a, b) => a + b.totals[k], 0);
    expect(company.acquired).toBe(6);
    expect(sum("acquired")).toBe(company.acquired);
    expect(sum("collectedCents")).toBe(company.collectedCents);
    expect(sum("newCustomerCollectedCents")).toBe(company.newCustomerCollectedCents);
    expect(sum("paidSpendCents")).toBe(company.paidSpendCents);
    expect(company.unallocatedSpendCents).toBe(2_500);
    expect(brands.every((b) => b.totals.unallocatedSpendCents === 0)).toBe(true);
  });

  it("brand scope is branch scope: a brand role sees its brand only; a partial view of a brand is refused", () => {
    const brand = VIEWERS.brand;
    expect(brand.branchIds).toEqual(branchesOfBrands(["joshuas"]));
    expect(resolveBrandScope(brand, "joshuas")).toEqual(branchesOfBrands(["joshuas"]));
    expect(() => resolveBrandScope(brand, "moxie")).toThrow(ForbiddenError);
    expect(() => resolveScope(brand, "B01")).toThrow(ForbiddenError);
    // The B20 partner sees one Moxie branch; showing it as "Moxie" would mislabel a branch as a brand.
    expect(() => resolveBrandScope(VIEWERS.partner, "moxie")).toThrow(ForbiddenError);
    expect(resolveBrandScope(VIEWERS.marketing, "mission")).toEqual(branchesOfBrands(["mission"]));
  });

  it("a partial scope over a brand is marked incomplete in the rollup", async () => {
    const rows = await brandRows(pool, { ...OCT, branchIds: ["B20"] });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ brandId: "moxie", branchIds: ["B20"], complete: false });
  });
});

// ── Reporting contract ──────────────────────────────────────────────────────

const CONTRACT: Record<string, string[]> = {
  contract_v1: ["view_name:text", "grain:text"],
  dim_branch_v1: ["branch_id:text", "branch_name:text", "region:text", "timezone:text", "crm_office_id:integer", "brand_id:text", "brand_name:text"],
  dim_channel_v1: ["channel_code:text", "channel_label:text", "is_paid:boolean", "cost_basis:text", "measurement:text"],
  fact_acquisitions_v1: [
    "crm_customer_id:bigint", "branch_id:text", "brand_id:text", "channel_code:text", "attribution_basis:text", "channel_conflict:boolean",
    "sold_at:timestamp with time zone", "initial_status:text", "initial_completed_at:timestamp with time zone", "annual_value_cents:bigint", "collected_cents:bigint",
  ],
  fact_ad_spend_daily_v1: [
    "spend_date:date", "campaign_id:bigint", "branch_id:text", "brand_id:text", "channel_code:text", "cost_cents:bigint", "clicks:integer",
    "platform_conversions:integer", "classified_by:text", "source_record_id:bigint",
  ],
  fact_exceptions_v1: [
    "exception_id:bigint", "kind:text", "severity:text", "status:text", "branch_id:text", "brand_id:text", "amount_cents:bigint", "customers_referenced:integer",
    "first_detected_at:timestamp with time zone", "last_detected_at:timestamp with time zone", "resolved_at:timestamp with time zone", "decision_blocking:boolean",
  ],
  fact_leads_v1: [
    "lead_id:bigint", "source:text", "occurred_at:timestamp with time zone", "branch_id:text", "brand_id:text", "channel_code:text",
    "attribution_evidence:text", "branch_overridden:boolean", "prospect_key:text", "source_record_id:bigint",
  ],
};

describe("reporting contract", () => {
  it("publishes exactly the pinned views, columns and types (a breaking change needs a _v2)", async () => {
    const { rows } = await pool.query<{ table_name: string; cols: string[] }>(
      `select table_name, array_agg(column_name || ':' || data_type order by ordinal_position) as cols
       from information_schema.columns where table_schema = 'reporting' group by table_name order by table_name`,
    );
    expect(Object.fromEntries(rows.map((r) => [r.table_name, r.cols]))).toEqual(CONTRACT);
    const listed = await pool.query<{ view_name: string }>("select view_name from reporting.contract_v1 order by view_name");
    expect(listed.rows.map((r) => r.view_name)).toEqual(Object.keys(CONTRACT).filter((v) => v !== "contract_v1"));
  });

  it("publishes no contact details", async () => {
    const { rows } = await pool.query<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'reporting'");
    expect(rows.map((r) => r.column_name).filter((c) => /phone|email|heard|zip|payload/.test(c))).toEqual([]);
  });

  it("facts agree with the app's own metrics for the same scope", async () => {
    let n = 0;
    for (const branch of ["B05", "B28", "B41"]) {
      const sale = acquisition(++n, branch, `+121255501${String(n).padStart(2, "0")}`, new Date(`2026-10-${String(4 + n).padStart(2, "0")}T15:00:00Z`));
      await ingest(pool, "calls", [sale.call]);
      await ingest(pool, "crm", sale.crm);
    }
    await ingest(pool, "ads", [spendDay("B05", 4, 100), spendDay("B41", 4, 40), spendDay("B99", 4, 25, "orphan-campaign")]);
    await mapCampaign("gs-B05", "B05");
    await mapCampaign("gs-B41", "B41");
    await runReconcile(pool, NOW);
    const company = await totals(pool, { ...OCT, branchIds: null });

    const facts = await one<{ acquired: string; collected: string; mapped_spend: string; unallocated: string; prospects: string; open_exc: string }>(
      pool,
      `select
         (select count(*) from reporting.fact_acquisitions_v1 where initial_status = 'completed' and initial_completed_at >= $1 and initial_completed_at < $2) as acquired,
         (select coalesce(sum(collected_cents), 0) from reporting.fact_acquisitions_v1) as collected,
         (select coalesce(sum(s.cost_cents), 0) from reporting.fact_ad_spend_daily_v1 s join reporting.dim_channel_v1 c using (channel_code)
            where s.branch_id is not null and c.cost_basis = 'media' and s.spend_date >= '2026-10-01' and s.spend_date < '2026-10-31') as mapped_spend,
         (select coalesce(sum(cost_cents), 0) from reporting.fact_ad_spend_daily_v1 where branch_id is null) as unallocated,
         (select count(distinct prospect_key) from reporting.fact_leads_v1 where occurred_at >= $1 and occurred_at < $2) as prospects,
         (select count(*) from reporting.fact_exceptions_v1 where status = 'open') as open_exc`,
      [OCT.from, OCT.to],
    );
    expect(Number(facts.acquired)).toBe(company.acquired);
    expect(Number(facts.collected)).toBe(company.newCustomerCollectedCents);
    expect(Number(facts.mapped_spend)).toBe(company.paidSpendCents);
    expect(Number(facts.unallocated)).toBe(company.unallocatedSpendCents);
    expect(Number(facts.prospects)).toBe(company.prospects);
    expect(Number(facts.open_exc)).toBe(company.openExceptions);
    // Brand cut of the same facts: joshuas spend is B41's only.
    const joshuas = await one<{ cost: string }>(pool, "select coalesce(sum(cost_cents), 0) cost from reporting.fact_ad_spend_daily_v1 where brand_id = 'joshuas'");
    expect(Number(joshuas.cost)).toBe(4_000);
  });
});
