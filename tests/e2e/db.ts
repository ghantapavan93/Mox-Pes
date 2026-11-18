import type { Pool } from "pg";
import { createPool, DEFAULT_DATABASE_URL, getNow } from "../../lib/db";
import { resolveIdentities } from "../../lib/identity/resolve";
import { instantToWallTime } from "../../lib/primitives";
import { deleteWorkspaceUploads } from "../../lib/workspace";
import { seed } from "../../lib/sim/seed";
import type { LedgerCall } from "../fixtures/onboarding/unseen";
import { call, crm, ingest } from "../helpers";

/**
 * Database helpers for the Playwright specs. They talk to the same demo database the dev
 * server uses (DATABASE_URL, default the demo DB) and go through the product's own write paths:
 * `seed()` for a clean demo, `ingestRecords` + `resolveIdentities` for fixtures.
 */

async function withDemoPool<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
  const pool = createPool(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

/**
 * Rebuilds the demo database from the synthetic world (about two minutes).
 *
 * The app may still be processing events from the previous spec's last action (after-response
 * consumers: reconciliation, identity). Dropping the schema under them can deadlock, and
 * Postgres then cancels one side. When the reseed is the victim it waits and tries again: the
 * background work finishes in seconds.
 */
export async function reseedDemo(): Promise<void> {
  if (process.env.SKIP_SEED) return;
  for (let attempt = 1; ; attempt++) {
    try {
      await withDemoPool((pool) => seed(pool, { log: (line) => console.log(`[seed] ${line}`) }));
      return;
    } catch (error) {
      const deadlock = (error as { code?: string }).code === "40P01";
      if (!deadlock || attempt >= 4) throw error;
      console.log(`[seed] deadlocked with background work (attempt ${attempt}); retrying in 3 s`);
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  }
}

/** The CRM records of one serviced synthetic customer, shaped like FieldRoutes sends them. */
function crmCustomer(id: number, branchId: string, phone: string, soldAt: Date) {
  const done = new Date(soldAt.getTime() + 48 * 3_600_000);
  return [
    crm.customer(id, branchId, phone, soldAt),
    crm.subscription(id + 10_000, id, branchId, soldAt),
    crm.appointment(id + 20_000, id + 10_000, id, branchId, "1", done, done),
    crm.ticket(id + 30_000, id, id + 20_000, branchId, "149.00", new Date(done.getTime() + 3_600_000)),
    crm.payment(id + 40_000, id, id + 30_000, branchId, "149.00", new Date(done.getTime() + 7_200_000)),
  ];
}

export interface ConflictFixture {
  /** Two CRM customers that share one phone, and a call lead from that phone: two pending conflicts. */
  accept: { customerIds: [number, number]; leadId: string };
  reject: { customerIds: [number, number]; leadId: string };
}

/**
 * Ambiguous identities for the review-permission spec. The synthetic world gives every person
 * a unique phone, so the demo has no conflicts; these fixtures add two groups at B20 whose
 * phones (…5559xxx) cannot collide with the world's (…5550xxx). Each group is two CRM
 * customers sharing a phone plus one call from it, so resolution must NOT merge and opens two
 * pending conflicts per group instead. Idempotent: re-running ingests duplicates (absorbed)
 * and an unchanged resolution changes nothing.
 */
export async function seedIdentityConflicts(): Promise<ConflictFixture> {
  const fixture: ConflictFixture = {
    accept: { customerIds: [990101, 990102], leadId: "CAL-E2E-0101" },
    reject: { customerIds: [990201, 990202], leadId: "CAL-E2E-0201" },
  };
  await withDemoPool(async (pool) => {
    const now = await getNow(pool);
    const day = (d: number) => new Date(Date.UTC(2026, 9, d, 15, 0));
    const groups: Array<[ConflictFixture["accept"], string]> = [
      [fixture.accept, "+12125559101"],
      [fixture.reject, "+12125559201"],
    ];
    for (const [group, phone] of groups) {
      await ingest(pool, "crm", [...crmCustomer(group.customerIds[0], "B20", phone, day(10)), ...crmCustomer(group.customerIds[1], "B20", phone, day(12))], { now });
      await ingest(pool, "calls", [call(group.leadId, "B20", phone, day(9))], { now });
    }
    await resolveIdentities(pool, now);
  });
  return fixture;
}

/**
 * Calls the demo ledger holds, as a call-tracking export would state them, for the unseen export
 * of J2: their rows are compared with the ledger and link to their journeys. Only calls with a
 * live identity (so the link exists), no campaign and a whole-minute start (so every compared fact
 * can agree with a file that has no campaign column and minute times).
 */
export async function ledgerCalls(n: number): Promise<LedgerCall[]> {
  return withDemoPool(async (pool) => {
    const rows = (
      await pool.query<{ id: string; branch: string; timezone: string; occurred_at: Date; source: string }>(
        `select l.source_lead_id as id, b.name as branch, b.timezone, l.occurred_at, r.payload->>'source' as source
         from leads l
         join branches b on b.id = l.branch_id
         join raw_events r on r.id = l.raw_event_id
         where l.source = 'calls' and l.campaign_external_id is null and extract(second from l.occurred_at) = 0
           and exists (
             select 1 from identity_links k join identities i on i.id = k.identity_id
             where k.record_table = 'leads' and k.record_id = l.id and i.retired_at is null
           )
         order by l.occurred_at desc, l.id
         limit $1`,
        [n],
      )
    ).rows;
    // The world stores callers' numbers hashed; the export states a fictional 555 number instead.
    // The comparison never reads the phone (branch, channel, time and campaign are the facts).
    return rows.map((r, i) => {
      const [date, time] = instantToWallTime(r.occurred_at, r.timezone).split(" ");
      const [y, m, d] = date.split("-");
      return { id: r.id, branch: r.branch, startedLocal: `${m}/${d}/${y} ${time.slice(0, 5)}`, source: r.source, phone: `(206) 555-01${String(40 + i).padStart(2, "0")}` };
    });
  });
}

/** Moves a workspace upload past its 24 hours, as the wall clock would (release design §5.2). */
export async function expireWorkspaceItem(uploadId: number): Promise<void> {
  await withDemoPool(async (pool) => {
    const { rowCount } = await pool.query(
      "update onboarding_uploads set workspace_started_at = now() - interval '25 hours' where id = $1 and workspace_owner is not null",
      [uploadId],
    );
    if (rowCount !== 1) throw new Error(`upload ${uploadId} is not a workspace upload`);
  });
}

/** Removes every visitor-workspace item and quota counter, so a journey starts from an empty workspace. */
export async function clearWorkspace(): Promise<void> {
  await withDemoPool(async (pool) => {
    const ids = (await pool.query<{ id: string }>("select id from onboarding_uploads where workspace_owner is not null")).rows.map((r) => Number(r.id));
    await deleteWorkspaceUploads(pool, ids);
    await pool.query("delete from workspace_quota");
  });
}
