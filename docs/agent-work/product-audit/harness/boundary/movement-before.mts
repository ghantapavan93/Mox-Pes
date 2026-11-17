// The Overview's "what changed" takeaway for B03 alone, on the case-R copy, with and without the
// evidence holds. Without them the panel takes the code path it took before the boundary (no
// incident, no marker), so the first line is the before wording. It was not captured from the page
// before the change, because the capture of the branch-scoped panel was added afterwards.
// Usage (from the repo): npx tsx docs/agent-work/product-audit/harness/boundary/movement-before.mts
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = fileURLToPath(new URL("../../../../../", import.meta.url)).replace(/\\/g, "/").replace(/\/$/, "");
const imp = (p: string) => import(pathToFileURL(`${repo}/${p}`).href);
const { createPool } = await imp("lib/db.ts");
const pool = createPool("postgres://postgres@127.0.0.1:54333/revenue_signal_audit_boundary_r1");
const { movement } = await imp("lib/metrics/movement.ts");
const { takeaway } = await imp("lib/metrics/movement-copy.ts");
const { PERIODS } = await imp("lib/period.ts");
for (const evidenceHolds of [[], undefined]) {
  const m = await movement(pool, { branchId: "B03", branchIds: null, period: PERIODS.oct, evidenceHolds });
  const t = takeaway(m, "B03");
  console.log(`${evidenceHolds ? "without evidence holds (the before path)" : "with evidence holds (after)"}: ${t.trust.label}. ${t.trust.text}`);
}
await pool.end();
