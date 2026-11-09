import type { Queryable } from "@/lib/db";
import { BRAND_BY_ID, type BrandId } from "@/lib/reference";
import { totals, type Scope, type Totals } from "./scorecard";

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

/** Brands with at least one branch in scope, in brand order, from the database's assignment. */
export async function brandRows(db: Queryable, scope: Scope): Promise<BrandRow[]> {
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
    out.push({
      brandId: r.brand_id,
      name: r.name ?? BRAND_BY_ID.get(r.brand_id)?.name ?? r.brand_id,
      branchIds: inScope,
      complete: inScope.length === r.branch_ids.length,
      totals: await totals(db, { ...scope, branchIds: inScope }),
    });
  }
  return out;
}
