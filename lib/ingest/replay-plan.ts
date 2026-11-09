import type { Pool, PoolClient } from "pg";
import type { SourceName } from "@/lib/adapters/contract";
import { mapperVersions } from "@/lib/adapters/registry";
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
    // Every shipped version older than the target is a candidate; today that is ads@1.0.
    const older = mapperVersions("ads").filter((v) => v < mapperVersion);
    if (older.length === 0) throw new ActionError(`ads@${mapperVersion} has no older version to re-map from`, 400);
    const fromVersion = older[older.length - 1];
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
