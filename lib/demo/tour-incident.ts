import type { Queryable } from "@/lib/db";
import { TOUR_BRANCH } from "@/lib/demo/b20-tour";

/**
 * The incident the visitor tour walks (lib/demo/b20-tour.ts): B20's held calls, resolved by a
 * replay whose execution succeeded, the newest if there were several. Ids differ between seeds and
 * the hosted copy, so it is looked up, never written down. Null until the repair has been made:
 * the hosted copy makes it once after loading (lib/demo/hosted-correction.ts); a fresh local seed
 * has not made it yet.
 */
export async function repairedTourIncident(db: Queryable): Promise<{ id: number } | null> {
  const { rows } = await db.query<{ id: string }>(
    `select p.exception_id as id
       from action_proposals p
       join action_executions x on x.proposal_id = p.id
       join exceptions e on e.id = p.exception_id
      where e.branch_id = $1 and e.kind = 'quarantined_source_records' and e.status = 'resolved'
        and p.kind = 'replay_quarantine' and x.status = 'succeeded'
      order by x.finished_at desc, p.id desc
      limit 1`,
    [TOUR_BRANCH],
  );
  return rows[0] ? { id: Number(rows[0].id) } : null;
}
