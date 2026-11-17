// Shared helpers for the decision-boundary cases, adapted from the decisions-and-money audit
// (scratchpad audit-dm/common.ts, the exp-n1 runs recorded in ../n1-rerun/). Read-only on the repo:
// imports only. Every case runs inside ONE transaction on revenue_signal_audit_dm (a copy of the
// pristine seed) that is always rolled back, so the seeded world stays as it was between cases.
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO = fileURLToPath(new URL("../../../../../", import.meta.url)).replace(/\\/g, "/").replace(/\/$/, "");
export const AUDIT_DB = "postgres://postgres@127.0.0.1:54333/revenue_signal_audit_dm";

export async function mod<T = any>(rel: string): Promise<T> {
  return (await import(pathToFileURL(`${REPO}/${rel}`).href)) as T;
}

async function auditPool() {
  const name = new URL(AUDIT_DB).pathname.slice(1);
  if (name !== "revenue_signal_audit_dm") throw new Error(`refusing database ${name}`);
  const { createPool } = await mod("lib/db.ts");
  return createPool(AUDIT_DB);
}

/**
 * Runs fn inside a transaction that is always rolled back. `pool` is the product's own nestedPool
 * on that one connection, so product code that opens its own transactions nests as savepoints.
 */
export async function inRollback<T>(fn: (tx: any, pool: any) => Promise<T>): Promise<T> {
  const p = await auditPool();
  const { nestedPool } = await mod("lib/workflow/nested.ts");
  const client = await p.connect();
  try {
    await client.query("begin");
    return await fn(client, nestedPool(client));
  } finally {
    await client.query("rollback").catch(() => undefined);
    client.release();
    await p.end();
  }
}

export const money = (c: number | null | undefined) =>
  c === null || c === undefined ? "—" : `${c < 0 ? "-" : ""}$${(Math.abs(c) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Inside the single audit transaction, run reconciliation explicitly: the event consumers decide
 * "already covered" from the transaction snapshot, and inside one transaction every later event looks
 * covered, so dispatch would skip the run. In the product each delivery commits and the consumer runs.
 */
export async function settle(pool: any, at: Date) {
  const { reconcile } = await mod("lib/reconcile/reconcile.ts");
  await pool.query("drop table if exists _ir_leads, _ir_cand, _ir_eval");
  await reconcile(pool, at);
}

/** One ads delivery through the product's polling path (runStream with the active mapper), then reconciliation. */
export async function deliverAds(pool: any, records: Array<Record<string, unknown>>, atIso: string) {
  const { mapperFor, referenceContext } = await mod("lib/adapters/registry.ts");
  const { runStream } = await mod("lib/ingest/ingest.ts");
  const { InMemorySourceClient } = await mod("lib/sim/clients.ts");
  const at = new Date(atIso);
  await pool.query("update app_clock set now = $1", [at]);
  const versions = records.map((payload) => ({ stream: "ads", entity: "spend_day", visibleAt: at.getTime() - 60_000, payload }));
  const run = await runStream(pool, {
    client: new InMemorySourceClient("ads", "ads", versions),
    mapper: mapperFor("ads"),
    ctx: referenceContext,
    now: at,
    windowEnd: at,
    overlapMs: 0,
    initialCursor: new Date(at.getTime() - 24 * 3_600_000),
  });
  if ((run.stats?.fetched ?? 0) !== records.length) throw new Error(`fetched ${run.stats?.fetched} of ${records.length}`);
  await settle(pool, at);
  return run;
}

/** The newest stored source payload of a campaign-day (the platform's own numbers). */
export async function storedPayload(db: any, campaignId: string, date: string): Promise<Record<string, unknown>> {
  const { rows } = await db.query(
    `select payload from raw_events where source = 'ads' and entity = 'spend_day' and payload ->> 'campaignId' = $1 and payload ->> 'date' = $2
     order by (payload ->> 'fetchedAt')::timestamptz desc, id desc limit 1`,
    [campaignId, date],
  );
  if (!rows[0]) throw new Error(`no stored payload for ${campaignId} ${date}`);
  return rows[0].payload;
}

export const octDays = () => Array.from({ length: 30 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`);
