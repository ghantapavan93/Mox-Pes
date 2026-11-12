import type { Pool, PoolClient } from "pg";
import type { SourceName } from "@/lib/adapters/contract";
import { compareVersions, mapperVersions } from "@/lib/adapters/registry";
import { ActionError } from "@/lib/actions";
import type { ExceptionRow } from "@/lib/queries";
import { coverageGapRecordIds, quarantineGroupIds, type ReplayRequest } from "./replay";

export type ReplayPlan = Pick<ReplayRequest, "source" | "rawEventIds" | "mode" | "fromVersion" | "lineage">;

interface CampaignRef {
  campaignId: number;
  externalCampaignId: string;
}

/**
 * Which stored records a replay for this exception touches, and how. One place, so the API,
 * the scripts and the tests replay exactly the same thing.
 *
 *   * quarantined_source_records → the held records of that group, retried;
 *   * channel_coverage_gap → the successor campaigns' spend records still mapped by an older
 *     ads mapper, re-mapped by `mapperVersion`, with the campaign lineage the evidence names.
 */
export async function planReplay(db: Pool | PoolClient, exception: ExceptionRow, mapperVersion: string): Promise<ReplayPlan> {
  const ev = exception.evidence as Record<string, unknown>;

  if (exception.kind === "quarantined_source_records") {
    const source = ev.source as SourceName;
    const rawEventIds = await quarantineGroupIds(db, { source, errorCode: String(ev.errorCode), branchId: exception.branchId });
    return { source, rawEventIds, mode: "quarantined" };
  }

  if (exception.kind === "channel_coverage_gap") {
    const successors = (ev.successors as CampaignRef[] | null) ?? [];
    const predecessors = (ev.predecessors as CampaignRef[] | null) ?? [];
    if (successors.length === 0) {
      throw new ActionError("No successor campaign in the evidence: there is nothing to re-map. Investigate the source.", 409);
    }
    // Re-map from the version the successor's spend is actually STORED under, not "the version
    // just before the target": with ads@1.2 the misfiled B09 spend is still ads@1.0, and the
    // old rule looked for ads@1.1 records and found none. The oldest stored older version is the
    // one that misread the most; records already under a newer version were typed correctly.
    const older = mapperVersions("ads").filter((v) => compareVersions(v, mapperVersion) < 0);
    if (older.length === 0) throw new ActionError(`ads@${mapperVersion} has no older version to re-map from`, 400);
    const stored = await db.query<{ v: string }>(
      `select distinct substring(adapter_version from 5) as v from raw_events
        where source = 'ads' and status = 'projected' and payload ->> 'campaignId' = any($1::text[])`,
      [successors.map((s) => s.externalCampaignId)],
    );
    const candidates = older.filter((v) => stored.rows.some((r) => r.v === v));
    const fromVersion = candidates[0] ?? older[older.length - 1];
    const rawEventIds = await coverageGapRecordIds(db, {
      externalCampaignIds: successors.map((s) => s.externalCampaignId),
      fromVersion,
    });
    const lineage =
      predecessors.length === 1 && successors.length === 1
        ? {
            predecessorCampaignId: predecessors[0].campaignId,
            successorCampaignId: successors[0].campaignId,
            effectiveDate: String(ev.gapStart),
            evidence: { exceptionId: exception.id, predecessor: predecessors[0], successor: successors[0] },
          }
        : undefined;
    return { source: "ads", rawEventIds, mode: "reproject", fromVersion, lineage };
  }

  throw new ActionError(`A ${exception.kind} exception is not fixed by a replay`, 409);
}
