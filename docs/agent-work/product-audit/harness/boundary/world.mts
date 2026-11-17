// Builds a committed case world on an isolated copy of the pristine seed, for page captures.
// The rolled-back cases (cases.mts) prove the boundary; this only puts one of them where a running
// app can show it. Every change goes through the product's own functions.
//
// Usage (from the repo): npx tsx docs/agent-work/product-audit/harness/boundary/world.mts <db> <case>
//   <db>    must start with revenue_signal_audit_boundary (a `createdb -T revenue_signal_deploy` copy)
//   <case>  r   one person revokes B03's Local Services currency rule (exp-n1 case R)
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = fileURLToPath(new URL("../../../../../", import.meta.url)).replace(/\\/g, "/").replace(/\/$/, "");
const imp = (p: string) => import(pathToFileURL(`${repo}/${p}`).href);

const [db, which] = process.argv.slice(2);
if (!db?.startsWith("revenue_signal_audit_boundary")) throw new Error("name an isolated revenue_signal_audit_boundary* database");
const { createPool } = await imp("lib/db.ts");
const pool = createPool(`postgres://postgres@127.0.0.1:54333/${db}`);
const { rows } = await pool.query("select current_database() as d");
if (rows[0].d !== db) throw new Error(`connected to ${rows[0].d}, not ${db}`);

// Reconciliation as the worker runs it: one transaction (its working tables drop on commit).
const settle = async (at: Date) => {
  const { reconcile } = await imp("lib/reconcile/reconcile.ts");
  const { withTransaction } = await imp("lib/db.ts");
  console.log("reconcile:", JSON.stringify(await withTransaction(pool, (tx: unknown) => reconcile(tx, at))));
};

if (which === "r") {
  const { revokeCurrencyRule } = await imp("lib/currency/rules.ts");
  const { VIEWERS } = await imp("lib/viewer.ts");
  const rule = (await pool.query("select id from currency_rules where platform = 'google_lsa' and ad_account_id = 'LSA-B03' and revoked_at is null")).rows[0];
  if (!rule) throw new Error("no live LSA-B03 currency rule (already applied?)");
  const now = new Date("2026-10-31T13:40:00Z");
  console.log("revoke:", JSON.stringify(await revokeCurrencyRule(pool, VIEWERS.engineer, { ruleId: Number(rule.id), reason: "audit: account currency not confirmed", now })));
  await settle(now);
} else {
  throw new Error(`unknown case ${which}`);
}
const held = await pool.query(
  "select count(*)::int as n from raw_events where source = 'ads' and status in ('excluded', 'quarantined')",
);
console.log(`${db}: held ads records now ${held.rows[0].n}`);
await pool.end();
