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

/**
 * One delivery: a campaign's own source records re-sent as a new version (the platform's numbers,
 * read from the payloads the seed stored), with what this delivery changes.
 *
 * - campaignId: whose records are re-sent (default pmax-lsa-B09, the successor);
 * - base: the stored record to start from, when the delivery is for a day that record's campaign
 *   never sent (a held day, an id the ledger has never seen);
 * - addCents / setCents: the amount, changed by or set to;
 * - override / omit: fields changed or removed (conversions, currency, campaign typing, the id).
 */
export interface DeliverySpec {
  campaignId?: string;
  base?: { campaignId?: string; date?: string };
  dates: readonly string[];
  fetchedAt: string;
  at: string;
  addCents?: number;
  setCents?: number;
  override?: Record<string, unknown>;
  omit?: readonly string[];
}

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
} as const satisfies Record<string, DeliverySpec>;

export type Step = keyof typeof STEPS;

/**
 * After B09 is verified: newer revisions the active mapper refuses, and what follows them
 * (HOLD-TO-DECISION.md §1.4). Each is a new source version, sent through the same polling path.
 *
 * - refused:        Oct 20, fetched 13:20 (after rest's 13:10), 2.5 conversions and $400.00: refused
 *                   (FRACTIONAL_CONVERSIONS); the ledger keeps rest's $120.91
 * - refusedOther:   Oct 22, fetched 13:20, billed in CAD: refused (CURRENCY_UNSUPPORTED)
 * - refusedAgain:   refused again, byte for byte (an exact duplicate)
 * - olderWhileHeld: Oct 20, fetched 13:08 (before rest's 13:10), $25.00 higher: older than the
 *                   accepted revision
 * - acceptedAgain:  rest's Oct 20 revision again (a re-send of the accepted one)
 * - corrected:      Oct 20, fetched 13:30, 2 conversions and $400.00: accepted, the newest revision
 * - sharedAccount:  B10's Search campaign (the ad account GA-SOUTHWEST, shared with B09), Oct 20,
 *                   fetched 13:20, 1.5 conversions: refused
 * - september:      B09's Search campaign, Sep 20, fetched 13:20, 1.5 conversions: refused
 * - unmapped:       an id the ledger has never seen, named like B09's campaign, in B09's ad
 *                   account, Oct 20, 2.5 conversions: refused, and no campaign to map
 * - unidentified:   Oct 20 with no campaign id: refused before it can be identified
 * - heldDay:        lsa-B09 (stopped after Oct 12) sends Oct 20 in CAD: refused, a day the ledger
 *                   never counted (N1)
 * - regression:     Oct 20, fetched 13:40, typed as Search: accepted, so a verified date is filed
 *                   as Google Search again
 */
export const REVISION_STEPS = {
  refused: { dates: ["2026-10-20"], fetchedAt: "2026-10-31T13:20:00Z", at: "2026-10-31T13:50:00Z", setCents: 40_000, override: { conversions: 2.5 } },
  refusedOther: { dates: ["2026-10-22"], fetchedAt: "2026-10-31T13:20:00Z", at: "2026-10-31T14:03:00Z", override: { currencyCode: "CAD" } },
  refusedAgain: { dates: ["2026-10-20"], fetchedAt: "2026-10-31T13:20:00Z", at: "2026-10-31T13:55:00Z", setCents: 40_000, override: { conversions: 2.5 } },
  olderWhileHeld: { dates: ["2026-10-20"], fetchedAt: "2026-10-31T13:08:00Z", at: "2026-10-31T14:00:00Z", addCents: 2_500 },
  acceptedAgain: { dates: ["2026-10-20"], fetchedAt: "2026-10-31T13:10:00Z", at: "2026-10-31T14:02:00Z" },
  corrected: { dates: ["2026-10-20"], fetchedAt: "2026-10-31T13:30:00Z", at: "2026-10-31T14:05:00Z", setCents: 40_000, override: { conversions: 2 } },
  sharedAccount: { campaignId: "gs-B10", dates: ["2026-10-20"], fetchedAt: "2026-10-31T13:20:00Z", at: "2026-10-31T14:06:00Z", override: { conversions: 1.5 } },
  september: { campaignId: "gs-B09", dates: ["2026-09-20"], fetchedAt: "2026-10-31T13:20:00Z", at: "2026-10-31T14:07:00Z", override: { conversions: 1.5 } },
  unmapped: { dates: ["2026-10-20"], fetchedAt: "2026-10-31T13:20:00Z", at: "2026-10-31T14:08:00Z", override: { campaignId: "pmax-lsa-B09-2", conversions: 2.5 } },
  unidentified: { dates: ["2026-10-20"], fetchedAt: "2026-10-31T13:20:00Z", at: "2026-10-31T14:09:00Z", omit: ["campaignId"] },
  heldDay: { campaignId: "lsa-B09", base: { date: "2026-10-12" }, dates: ["2026-10-20"], fetchedAt: "2026-10-31T13:20:00Z", at: "2026-10-31T14:10:00Z", override: { currencyCode: "CAD" } },
  regression: {
    dates: ["2026-10-20"],
    fetchedAt: "2026-10-31T13:40:00Z",
    at: "2026-10-31T14:12:00Z",
    override: { campaignName: "B09 Coral | Search", campaignType: "SEARCH", localServicesEnabled: false },
  },
} as const satisfies Record<string, DeliverySpec>;

export type RevisionStep = keyof typeof REVISION_STEPS;
export type AnyStep = Step | RevisionStep;

export const specOf = (step: AnyStep): DeliverySpec => (step in STEPS ? STEPS[step as Step] : REVISION_STEPS[step as RevisionStep]);

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
  step: AnyStep;
  runId: number;
  status: string;
  sent: Sent[];
}

/** The records a step sends, built from the source's own stored records (nothing is delivered). */
export async function recordsFor(pool: Pool, step: AnyStep): Promise<Array<Record<string, unknown>>> {
  const s = specOf(step);
  const campaignId = s.base?.campaignId ?? s.campaignId ?? "pmax-lsa-B09";
  const baseDates = s.base?.date ? [s.base.date] : s.dates;
  // The source's own version of each date from before any correction (the platform's numbers).
  const { rows } = await pool.query<{ payload: Record<string, unknown> }>(
    `select distinct on (payload ->> 'date') payload from raw_events
     where source = 'ads' and entity = 'spend_day' and payload ->> 'campaignId' = $2
       and payload ->> 'date' = any($1::text[]) and payload ->> 'fetchedAt' < '2026-10-31T13:00:00Z'
     order by payload ->> 'date', payload ->> 'fetchedAt' desc`,
    [baseDates, campaignId],
  );
  if (rows.length !== baseDates.length) throw new Error(`${step}: expected ${baseDates.length} source records for ${campaignId}, found ${rows.length}`);
  return rows.flatMap(({ payload }) =>
    (s.base?.date ? s.dates : [String(payload.date)]).map((date) => {
      const record: Record<string, unknown> = {
        ...payload,
        date,
        fetchedAt: s.fetchedAt,
        ...(s.addCents ? { costMicros: String(BigInt(String(payload.costMicros)) + BigInt(s.addCents) * 10_000n) } : {}),
        ...(s.setCents !== undefined ? { costMicros: String(BigInt(s.setCents) * 10_000n) } : {}),
        ...(s.override ?? {}),
      };
      for (const field of s.omit ?? []) delete record[field];
      return record;
    }),
  );
}

export async function deliver(pool: Pool, step: AnyStep): Promise<Delivery> {
  const s = specOf(step);
  const records = await recordsFor(pool, step);
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
  // A delivery the feed's cursor has already passed fetches nothing and changes nothing, silently:
  // the step's business time must come after every step before it. Say so instead.
  if ((run.stats?.fetched ?? 0) !== records.length) {
    throw new Error(`${step}: the run fetched ${run.stats?.fetched ?? 0} of ${records.length} records; its time (${s.at}) is not after the feed's cursor. Deliver the steps in the documented order.`);
  }
  await dispatchEvents(pool);
  return { step, runId: Number(run.runId), status: String(run.status), sent };
}
