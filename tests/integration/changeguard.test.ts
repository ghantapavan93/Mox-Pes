import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { RawRecord } from "@/lib/adapters/contract";
import { mapperFor, referenceContext } from "@/lib/adapters/registry";
import { ActionError } from "@/lib/actions";
import { replay, type ReplayRequest } from "@/lib/ingest/replay";
import { planReplay } from "@/lib/ingest/replay-plan";
import { budgetSignal } from "@/lib/metrics/decision";
import { getException, type ExceptionRow } from "@/lib/queries";
import { acquisition, call, freshDb, ingest, one, runReconcile, testPool } from "../helpers";

/**
 * ChangeGuard: a HYPOTHETICAL Local Services → Performance Max migration at one branch.
 * Google's change is real (Google Ads Help 17213585; Ads API: migrated campaigns are
 * PERFORMANCE_MAX with local_services_enabled). The pipeline failure is engineered: ads@1.0
 * classifies channel by platform, so the migrated campaign's spend is filed as Google Search.
 */
const BRANCH = "B09";
const NOW = new Date("2026-10-31T13:00:00Z");
const OCT = { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-10-31T00:00:00Z") };
const MIGRATION_DAY = 13;

const day = (d: number) => `2026-10-${String(d).padStart(2, "0")}`;
const at = (d: number, hour = 15) => new Date(`${day(d)}T${String(hour).padStart(2, "0")}:00:00Z`);

function spend(campaign: "lsa" | "pmax" | "search", d: number, costDollars: number, extra: Record<string, unknown> = {}, fetchDelayH = 30): RawRecord {
  const base = {
    lsa: { platform: "google_lsa", accountId: `LSA-${BRANCH}`, campaignId: `lsa-${BRANCH}`, campaignName: `${BRANCH} | Local Services`, campaignType: "LOCAL_SERVICES" },
    pmax: { platform: "google_ads", accountId: `LSA-${BRANCH}`, campaignId: `pmax-lsa-${BRANCH}`, campaignName: `${BRANCH} | Local Services (PMax, pay-per-lead)`, campaignType: "PERFORMANCE_MAX", localServicesEnabled: true },
    search: { platform: "google_ads", accountId: "GA-SW", campaignId: `gs-${BRANCH}`, campaignName: `${BRANCH} | Search`, campaignType: "SEARCH" },
  }[campaign];
  const fetchedAt = new Date(new Date(`${day(d)}T00:00:00Z`).getTime() + fetchDelayH * 3_600_000);
  return {
    entity: "spend_day",
    payload: { ...base, date: day(d), costMicros: String(costDollars * 1_000_000), clicks: 10, conversions: 3, fetchedAt: fetchedAt.toISOString(), ...extra },
  };
}

/** Thirty days of three campaigns; Local Services migrates on day 13. */
function adsHistory(): RawRecord[] {
  const records: RawRecord[] = [];
  for (let d = 1; d <= 30; d++) {
    records.push(spend("search", d, 300));
    records.push(d < MIGRATION_DAY ? spend("lsa", d, 100) : spend("pmax", d, 100));
  }
  return records;
}

async function mapAllCampaigns(pool: Pool) {
  await pool.query(
    `insert into campaign_branch_map (campaign_id, branch_id, mapped_by, mapped_at)
     select id, $1, 'marketing-ops', $2 from ad_campaigns on conflict do nothing`,
    [BRANCH, NOW],
  );
}

/** Daily Local Services calls (some become customers) plus Google Search customers. */
async function seedLeadsAndCustomers(pool: Pool) {
  const calls: RawRecord[] = [];
  const crm: RawRecord[] = [];
  let n = 0;
  for (let d = 1; d <= 30; d++) {
    calls.push(call(`LSA-ONLY-${d}`, BRANCH, `+1602555${String(1000 + d)}`, at(d, 14), "Google LSA"));
    if (d % 3 === 0 && d <= 25) {
      const a = acquisition(++n, BRANCH, `+1602556${String(1000 + n)}`, at(d), { source: "Google LSA" });
      calls.push(a.call);
      crm.push(...a.crm);
    }
    if (d % 4 === 0 && d <= 25) {
      const a = acquisition(++n, BRANCH, `+1602556${String(1000 + n)}`, at(d), { source: "Google Ads" });
      calls.push(a.call);
      crm.push(...a.crm);
    }
  }
  await ingest(pool, "calls", calls);
  await ingest(pool, "crm", crm);
}

let pool: Pool;
let gap: ExceptionRow;

beforeAll(() => {
  pool = testPool();
});
afterAll(async () => pool.end());

beforeEach(async () => {
  await freshDb(pool);
  await ingest(pool, "ads", adsHistory(), { mapper: mapperFor("ads", "1.0"), now: NOW });
  await mapAllCampaigns(pool);
  await seedLeadsAndCustomers(pool);
  await runReconcile(pool, NOW);
  const row = await one<{ id: string }>(pool, "select id from exceptions where kind = 'channel_coverage_gap'");
  gap = (await getException(pool, Number(row.id)))!;
});

async function remap(key: string, overrides: Partial<ReplayRequest> = {}) {
  const plan = await planReplay(pool, gap, "1.1");
  return replay(pool, {
    ...plan, mapperVersion: "1.1", actor: "test", idempotencyKey: key, dryRun: false, now: NOW, exceptionId: gap.id,
    scope: { ...OCT, branchIds: [BRANCH] }, ...overrides,
  });
}

/** Everything a re-classification must never change. */
async function ledger() {
  return one(
    pool,
    `select (select count(*) from ad_spend_daily) as spend_rows, (select sum(cost_cents) from ad_spend_daily) as spend_cents,
            (select count(*) from raw_events) as raw_events, (select count(*) from leads) as leads,
            (select count(*) from crm_customers) as customers, (select sum(total_cents) from crm_tickets) as invoiced,
            (select sum(amount_cents) from crm_payments where status = 'successful') as collected,
            (select count(*) from v_acquisitions where initial_status = 'completed') as acquisitions`,
  );
}

const channelSpend = async (channel: string) =>
  Number((await one(pool, "select coalesce(sum(cost_cents), 0) as c from ad_spend_daily where channel_code = $1", [channel])).c);

describe("ads mapper versions", () => {
  it("ads@1.0 files a migrated Local Services campaign as Google Search; ads@1.1 as Local Services", () => {
    const record = spend("pmax", 20, 100);
    const v10 = mapperFor("ads", "1.0").map(record, referenceContext);
    const v11 = mapperFor("ads", "1.1").map(record, referenceContext);
    expect(v10.ok && v10.projection.row).toMatchObject({ channelCode: "google_search", campaignType: null });
    expect(v11.ok && v11.projection.row).toMatchObject({ channelCode: "google_lsa", campaignType: "PERFORMANCE_MAX", localServicesEnabled: true });
    // A plain Performance Max campaign stays where it was.
    const plain = mapperFor("ads", "1.1").map(spend("pmax", 20, 100, { localServicesEnabled: false }), referenceContext);
    expect(plain.ok && plain.projection.row).toMatchObject({ channelCode: "google_search" });
  });

  it("ads@1.1 refuses a local-services flag without a campaign type instead of guessing", () => {
    const result = mapperFor("ads", "1.1").map(spend("pmax", 20, 100, { campaignType: undefined }), referenceContext);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.code).toBe("AMBIGUOUS_CAMPAIGN_TYPE");
  });
});

describe("channel coverage gap", () => {
  it("is detected with record-level evidence: what stopped, what started, how it was filed", () => {
    const ev = gap.evidence as Record<string, unknown> & { successors: Array<Record<string, unknown>>; predecessors: Array<Record<string, unknown>> };
    expect(gap.branchId).toBe(BRANCH);
    expect(ev.channel).toBe("google_lsa");
    expect(ev.lastSpendDate).toBe(day(MIGRATION_DAY - 1));
    expect(Number(ev.leadsSinceGap)).toBeGreaterThanOrEqual(18);
    expect(ev.predecessors.map((p) => p.externalCampaignId)).toEqual([`lsa-${BRANCH}`]);
    expect(ev.successors).toHaveLength(1);
    expect(ev.successors[0]).toMatchObject({ externalCampaignId: `pmax-lsa-${BRANCH}`, classifiedAs: ["google_search"] });
    expect(gap.amountCents).toBe((30 - MIGRATION_DAY + 1) * 100 * 100);
  });

  it("blocks the budget signal while open, and stops blocking once the records are re-mapped", async () => {
    const before = await budgetSignal(pool, BRANCH, OCT);
    expect(before.signal).toBe("shift");
    expect(before.from?.channelCode).toBe("google_search");
    expect(before.trustworthy).toBe(false);
    expect(before.blockers.map((b) => b.exceptionId)).toContain(gap.id);

    await remap("gate-1");
    const after = await budgetSignal(pool, BRANCH, OCT);
    expect(after.trustworthy).toBe(true);
    expect(after.ratio!).toBeLessThan(before.ratio!);
  });

  it("re-mapping moves spend between channels and duplicates nothing", async () => {
    const lsaBefore = await channelSpend("google_lsa");
    const searchBefore = await channelSpend("google_search");
    const invariants = await ledger();

    const result = await remap("move-1");
    const misfiled = (30 - MIGRATION_DAY + 1) * 100 * 100;
    expect(result.claimed).toBe(30 - MIGRATION_DAY + 1);
    expect(result.projected).toBe(result.claimed);
    expect(await channelSpend("google_lsa")).toBe(lsaBefore + misfiled);
    expect(await channelSpend("google_search")).toBe(searchBefore - misfiled);
    expect(await ledger()).toEqual(invariants);

    expect((await getException(pool, gap.id))!.status).toBe("resolved");
    const lineage = await one(pool, "select effective_date::text as d from campaign_lineage");
    expect(lineage.d).toBe(day(MIGRATION_DAY));
    expect((await one(pool, "select count(*) n from raw_events where source = 'ads' and payload ->> 'campaignId' = $1 and adapter_version <> 'ads@1.1'", [`pmax-lsa-${BRANCH}`])).n).toBe("0");
  });

  it("is idempotent: the same key returns the stored result, a new key finds nothing left, a reused key for another request is refused", async () => {
    const first = await remap("idem-1");
    const lsa = await channelSpend("google_lsa");
    const again = await remap("idem-1");
    expect(again.alreadyProcessed).toBe(true);
    expect(again.claimed).toBe(first.claimed);
    const fresh = await remap("idem-2");
    expect(fresh.claimed).toBe(0);
    expect(await channelSpend("google_lsa")).toBe(lsa);
    await expect(remap("idem-1", { fromVersion: "0.9" })).rejects.toBeInstanceOf(ActionError);
  });

  it("concurrent re-maps claim every record exactly once", async () => {
    const lsaBefore = await channelSpend("google_lsa");
    const results = await Promise.all([1, 2, 3, 4].map((k) => remap(`race-${k}`)));
    expect(results.reduce((n, r) => n + r.claimed, 0)).toBe(30 - MIGRATION_DAY + 1);
    expect(await channelSpend("google_lsa")).toBe(lsaBefore + (30 - MIGRATION_DAY + 1) * 100 * 100);
  });

  it("a dry run changes nothing", async () => {
    const invariants = await ledger();
    const lsa = await channelSpend("google_lsa");
    const dry = await remap("dry-1", { dryRun: true });
    expect(dry.after!.channels.google_lsa.spendCents).toBeGreaterThan(dry.before!.channels.google_lsa.spendCents);
    expect(await channelSpend("google_lsa")).toBe(lsa);
    expect(await ledger()).toEqual(invariants);
    expect((await one(pool, "select count(*) n from replays")).n).toBe("0");
  });

  it("a failure mid-replay rolls everything back, and the same request then succeeds", async () => {
    const invariants = await ledger();
    const lsa = await channelSpend("google_lsa");
    await pool.query(`create function fail_spend_update() returns trigger language plpgsql as $$
      begin raise exception 'injected failure'; end $$`);
    await pool.query("create trigger fail_spend before update on ad_spend_daily for each row execute function fail_spend_update()");
    await expect(remap("fail-1")).rejects.toThrow(/injected failure/);
    expect(await channelSpend("google_lsa")).toBe(lsa);
    expect(await ledger()).toEqual(invariants);
    expect((await one(pool, "select count(*) n from raw_events where status = 'replaying'")).n).toBe("0");
    expect((await one(pool, "select count(*) n from replays")).n).toBe("0");
    expect((await getException(pool, gap.id))!.status).toBe("open");

    await pool.query("drop trigger fail_spend on ad_spend_daily");
    const retry = await remap("fail-1");
    expect(retry.projected).toBe(30 - MIGRATION_DAY + 1);
  });

  it("a record the new mapper cannot read keeps its earlier projection", async () => {
    // Stored by ads@1.0 (which ignores campaign typing), unreadable for ads@1.1.
    await ingest(pool, "ads", [spend("pmax", 30, 100, { campaignType: undefined }, 40)], { mapper: mapperFor("ads", "1.0"), now: NOW });
    const result = await remap("ambiguous-1");
    expect(result.errors.map((e) => e.code)).toEqual(["AMBIGUOUS_CAMPAIGN_TYPE"]);
    const row = await one(pool, `select re.status, re.adapter_version, s.channel_code from ad_spend_daily s join raw_events re on re.id = s.raw_event_id
      join ad_campaigns c on c.id = s.campaign_id where c.external_campaign_id = $1 and s.spend_date = $2`, [`pmax-lsa-${BRANCH}`, day(30)]);
    expect(row).toEqual({ status: "projected", adapter_version: "ads@1.0", channel_code: "google_search" });
  });
});

describe("historical continuity", () => {
  it("a post-migration re-pull that no longer returns the old Local Services rows deletes nothing", async () => {
    const lsaRows = await one(pool, "select count(*) n, sum(cost_cents) c from ad_spend_daily s join ad_campaigns c on c.id = s.campaign_id where c.external_campaign_id = $1", [`lsa-${BRANCH}`]);
    const raw = await one(pool, "select count(*) n from raw_events where payload ->> 'campaignId' = $1", [`lsa-${BRANCH}`]);
    // Google: LSA performance reports do not transition to Google Ads. A re-pull of the
    // pre-migration window now returns only the campaigns that still report.
    const repull = Array.from({ length: MIGRATION_DAY - 1 }, (_, i) => spend("search", i + 1, 300, {}, 24 * 25));
    await ingest(pool, "ads", repull, { mapper: mapperFor("ads", "1.1"), now: NOW });
    expect(await one(pool, "select count(*) n, sum(cost_cents) c from ad_spend_daily s join ad_campaigns c on c.id = s.campaign_id where c.external_campaign_id = $1", [`lsa-${BRANCH}`])).toEqual(lsaRows);
    expect(await one(pool, "select count(*) n from raw_events where payload ->> 'campaignId' = $1", [`lsa-${BRANCH}`])).toEqual(raw);
  });

  it("after the re-map, Local Services spend is continuous across the migration", async () => {
    await remap("continuity-1");
    const days = await pool.query(
      "select spend_date::text as d, sum(cost_cents) as c from ad_spend_daily where channel_code = 'google_lsa' group by 1 order by 1",
    );
    expect(days.rows.map((r) => r.d)).toEqual(Array.from({ length: 30 }, (_, i) => day(i + 1)));
    expect(new Set(days.rows.map((r) => r.c))).toEqual(new Set(["10000"]));
  });
});
