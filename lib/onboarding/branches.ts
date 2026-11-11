import { BRANCHES, BRANCH_BY_ID, BRANCH_BY_OFFICE } from "@/lib/reference";

/**
 * Resolves how an export names a branch (a branch id "B09", a CRM office id "109", or the
 * branch's name) to a branch id. Only exact matches after case and space folding count; a
 * near miss ("Phoenix-E") is unresolved and must be mapped by a person.
 */
const fold = (s: string) => s.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
const BY_NAME = new Map(BRANCHES.map((b) => [fold(b.name), b.id]));

export type BranchMatch = { branchId: string; via: "branch_id" | "office_id" | "name" } | null;

export function resolveBranch(value: string): BranchMatch {
  const v = value.trim();
  const id = v.toUpperCase();
  if (BRANCH_BY_ID.has(id)) return { branchId: id, via: "branch_id" };
  if (/^[1-9]\d{0,5}$/.test(v)) {
    const b = BRANCH_BY_OFFICE.get(Number(v));
    return b ? { branchId: b.id, via: "office_id" } : null;
  }
  const byName = BY_NAME.get(fold(v));
  return byName ? { branchId: byName, via: "name" } : null;
}

/** Distinct values of a column and how each resolves (null = unresolved). */
export function branchValueReport(values: Array<string | null>): Array<{ value: string; rows: number; match: BranchMatch }> {
  const counts = new Map<string, number>();
  for (const v of values) if (v !== null && v.trim() !== "") counts.set(v.trim(), (counts.get(v.trim()) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([value, rows]) => ({ value, rows, match: resolveBranch(value) }));
}
