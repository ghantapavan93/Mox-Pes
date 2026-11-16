import type { Pool } from "pg";
import { mapperFor, referenceContext } from "@/lib/adapters/registry";
import { dispatchEvents } from "@/lib/events/consumers";
import { runStream } from "@/lib/ingest/ingest";
import { InMemorySourceClient } from "@/lib/sim/clients";

/**
 * The B09 delivery fixture: the source correcting itself, through the ads feed's polling path.
 *
 * The demo seed files B09's Local Services campaign (pmax-lsa-B09, a Performance Max successor)
 * as Google Search from Oct 13. Each step re-delivers that campaign's own records, the platform's
 * numbers read from the source payloads the seed stored, as new versions: runStream with the
 * active mapper, then the intake's consumers (reconciliation), as the worker does. Nothing is
 * written to the product's tables directly.
 *
 * What a step sent is returned as the source's own ledger, captured before the product maps it.
 *
 * - partial:   Oct 26–30, fetched 13:00 (the first correction; 5 of the 18 dates)
 * - rest:      Oct 13–25, fetched 13:10 (the other 13)
 * - duplicate: rest again, the same versions
 * - older:     Oct 20, fetched 13:05 (before rest's 13:10) and $50 higher
 * - stale:     Oct 20, fetched 13:07 and $50 higher, carrying a Search campaign's name and inputs
 */

const days = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `2026-10-${String(from + i).padStart(2, "0")}`);

export const STEPS = {
  partial: { dates: days(26, 30), fetchedAt: "2026-10-31T13:00:00Z", at: "2026-10-31T13:05:00Z" },
  rest: { dates: days(13, 25), fetchedAt: "2026-10-31T13:10:00Z", at: "2026-10-31T13:15:00Z" },
  duplicate: { dates: days(13, 25), fetchedAt: "2026-10-31T13:10:00Z", at: "2026-10-31T13:25:00Z" },
  older: { dates: ["2026-10-20"], fetchedAt: "2026-10-31T13:05:00Z", at: "2026-10-31T13:30:00Z", addCents: 5_000 },
  stale: {
    dates: ["2026-10-20"],
    fetchedAt: "2026-10-31T13:07:00Z",
    at: "2026-10-31T13:40:00Z",
    addCents: 5_000,
    override: { campaignName: "B09 Coral | Search", campaignType: "SEARCH", localServicesEnabled: false },
  },
} as const satisfies Record<string, { dates: readonly string[]; fetchedAt: string; at: string; addCents?: number; override?: Record<string, unknown> }>;

export type Step = keyof typeof STEPS;

/** One record as the source sent it. */
export interface Sent {
  date: string;
  cents: number;
  fetchedAt: string;
  campaignName: string;
  campaignType: string | null;
  localServicesEnabled: boolean | null;
}

export interface Delivery {
  step: Step;
  runId: number;
  status: string;
  sent: Sent[];
}

export async function deliver(pool: Pool, step: Step): Promise<Delivery> {
  const s: { dates: readonly string[]; fetchedAt: string; at: string; addCents?: number; override?: Record<string, unknown> } = STEPS[step];
  // The source's own accepted version of each date, from before any correction (the platform's numbers).
  const { rows } = await pool.query<{ payload: Record<string, unknown> }>(
    `select distinct on (payload ->> 'date') payload from raw_events
     where source = 'ads' and entity = 'spend_day' and payload ->> 'campaignId' = 'pmax-lsa-B09'
       and payload ->> 'date' = any($1::text[]) and payload ->> 'fetchedAt' < '2026-10-31T13:00:00Z'
     order by payload ->> 'date', payload ->> 'fetchedAt' desc`,
    [s.dates],
  );
  if (rows.length !== s.dates.length) throw new Error(`${step}: expected ${s.dates.length} source records for pmax-lsa-B09, found ${rows.length}`);
  const records: Array<Record<string, unknown>> = rows.map(({ payload }) => ({
    ...payload,
    fetchedAt: s.fetchedAt,
    ...(s.addCents ? { costMicros: String(BigInt(String(payload.costMicros)) + BigInt(s.addCents) * 10_000n) } : {}),
    ...(s.override ?? {}),
  }));
  const sent: Sent[] = records.map((r) => ({
    date: String(r.date),
    cents: Number(BigInt(String(r.costMicros)) / 10_000n),
    fetchedAt: String(r.fetchedAt),
    campaignName: String(r.campaignName),
    campaignType: (r.campaignType as string | undefined) ?? null,
    localServicesEnabled: (r.localServicesEnabled as boolean | undefined) ?? null,
  }));

  const at = new Date(s.at);
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
  await dispatchEvents(pool);
  return { step, runId: Number(run.runId), status: String(run.status), sent };
}
