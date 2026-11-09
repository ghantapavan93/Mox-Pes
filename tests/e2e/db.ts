import type { Pool } from "pg";
import { createPool, DEFAULT_DATABASE_URL, getNow } from "../../lib/db";
import { resolveIdentities } from "../../lib/identity/resolve";
import { seed } from "../../lib/sim/seed";
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

/** Rebuilds the demo database from the synthetic world (about two minutes). */
export async function reseedDemo(): Promise<void> {
  if (process.env.SKIP_SEED) return;
  await withDemoPool((pool) => seed(pool, { log: (line) => console.log(`[seed] ${line}`) }));
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
