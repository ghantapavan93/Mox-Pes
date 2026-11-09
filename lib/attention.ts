import type { BranchRow } from "@/lib/metrics/scorecard";

/**
 * Which branches deserve a look first. Deliberately simple and explainable: each flag is
 * a comparison against the median branch in the same scope and period, and the reason is
 * shown next to it. No model, no score nobody can explain.
 */
export interface Flag {
  code: "cac" | "unknown" | "exceptions";
  label: string;
}

function median(values: number[]): number {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return 0;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

export function attentionFlags(rows: BranchRow[]): Map<string, Flag[]> {
  const cac = (r: BranchRow) => (r.paidAcquired > 0 ? r.paidSpendCents / r.paidAcquired : NaN);
  const unknown = (r: BranchRow) => (r.acquired > 0 ? r.unknownAcquired / r.acquired : NaN);
  const medCac = median(rows.map(cac));
  const medUnknown = median(rows.map(unknown));
  const flags = new Map<string, Flag[]>();
  for (const r of rows) {
    const f: Flag[] = [];
    if (rows.length > 1 && cac(r) > medCac * 1.4) f.push({ code: "cac", label: `CAC ${(cac(r) / medCac).toFixed(1)}× median` });
    if (rows.length > 1 && unknown(r) > medUnknown * 1.6) f.push({ code: "unknown", label: `Unattributed ${(unknown(r) / medUnknown).toFixed(1)}× median` });
    if (r.atRiskCents >= 100_000 || r.openExceptions >= 10) f.push({ code: "exceptions", label: `${r.openExceptions} open exceptions` });
    flags.set(r.branchId, f);
  }
  return flags;
}
