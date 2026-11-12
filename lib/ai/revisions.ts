import type { Queryable } from "@/lib/db";
import { numericEvidenceId } from "./evidence";

/**
 * Stale revisions: a source record (raw event) that a NEWER revision of the same source entity
 * replaced. A CRM customer re-sent with a corrected amount arrives as a new raw event with the
 * same (source, entity, entity_id); the old one stays stored for audit. A claim about the
 * business that rests on the old revision, without citing the new one, is stale (lib/ai/analyst.ts).
 *
 * "Newer" means occurred later, or the same time and received later; only revisions that took
 * effect count (projected, or excluded at intake by a rule) — a quarantined newer copy did not
 * replace anything yet.
 */
export async function staleRevisions(db: Queryable, evidenceIds: Iterable<string>): Promise<Map<string, string>> {
  const ids = [...new Set([...evidenceIds].map((id) => numericEvidenceId(id, "raw_event")).filter((n): n is number => n !== null))];
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const { rows } = await db.query<{ old_id: string; newer_id: string }>(
    `select r.id::text as old_id,
            (select n.id::text from raw_events n
              where n.source = r.source and n.entity = r.entity and n.entity_id = r.entity_id and n.id <> r.id
                and n.status in ('projected', 'excluded')
                and (n.occurred_at > r.occurred_at or (n.occurred_at = r.occurred_at and n.received_at > r.received_at))
              order by n.occurred_at desc, n.received_at desc, n.id desc limit 1) as newer_id
       from raw_events r where r.id = any($1::bigint[])`,
    [ids],
  );
  for (const r of rows) if (r.newer_id) out.set(`raw_event:${r.old_id}`, `raw_event:${r.newer_id}`);
  return out;
}
