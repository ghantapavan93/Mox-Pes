import type { Queryable } from "@/lib/db";
import { BRAND_BY_ID, type BrandId } from "@/lib/reference";
import { totals, type BranchRow, type Scope, type Totals } from "./scorecard";

/**
 * Brand rollups. A brand's numbers are its branches' numbers, computed by the same totals()
 * the company line uses — never by adding up branch rows, because distinct counts (prospects)
 * are not additive across branches.
 *
 * Invariants (tests/integration/domain-model.test.ts):
 *   * every branch belongs to exactly one brand, so brand spend, customers and collected
 *     revenue add up to the company's;
 *   * spend on a campaign mapped to NO branch belongs to no brand: it stays company-level
 *     "unallocated", and brand lines never absorb it.
 */

export interface BrandRow {
  brandId: BrandId;
  name: string;
  branchIds: string[];
  /** False when the viewer's scope covers only part of the brand: the row is a partial view. */
  complete: boolean;
  totals: Totals;
}

/**
 * Brands with at least one branch in scope, in brand order, from the database's assignment.
 *
 * `branchRows`, when the caller already has them for the same period: a branch's row does not
 * depend on which other branches are in scope (every aggregate in branchRows is computed for all
 * branches; the scope only selects rows), so a brand's totals from these rows are exactly
 * totals() for the brand. Without them, each brand recomputes the whole scorecard, one brand
 * after another: about 2 s of the Overview's 3.4 s on the demo world (R-34).
 */
export async function brandRows(db: Queryable, scope: Scope, branchRows?: BranchRow[]): Promise<BrandRow[]> {
  const byId = new Map((branchRows ?? []).map((r) => [r.branchId, r]));
  const { rows } = await db.query<{ brand_id: BrandId; name: string; branch_ids: string[] }>(
    `select br.id as brand_id, br.name, array_agg(b.id order by b.id) as branch_ids
     from brands br join branches b on b.brand_id = br.id
     group by br.id, br.name
     order by min(b.id)`,
  );
  const out: BrandRow[] = [];
  for (const r of rows) {
    const inScope = scope.branchIds === null ? r.branch_ids : r.branch_ids.filter((id) => scope.branchIds!.includes(id));
    if (inScope.length === 0) continue;
    // Reuse only a complete set: a missing branch would silently drop out of the brand's sums.
    const given = inScope.map((id) => byId.get(id));
    const rows = given.every((row) => row !== undefined) ? (given as BranchRow[]) : undefined;
    out.push({
      brandId: r.brand_id,
      name: r.name ?? BRAND_BY_ID.get(r.brand_id)?.name ?? r.brand_id,
      branchIds: inScope,
      complete: inScope.length === r.branch_ids.length,
      totals: await totals(db, { ...scope, branchIds: inScope }, rows),
    });
  }
  return out;
}
