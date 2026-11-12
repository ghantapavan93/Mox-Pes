import { BRANCH_BY_ID, BRANCH_BY_OFFICE } from "@/lib/reference";
import type { MapContext, SourceMapper, SourceName } from "./contract";
import { FieldRoutesMapper } from "./crm-fieldroutes";
import { AdSpendMapper, CallTrackingMapper, DoorToDoorMapper, WebLeadMapper } from "./marketing";

/** Every mapper version that has ever shipped. Old versions stay so history is explainable. */
const MAPPERS: Record<SourceName, Record<string, SourceMapper>> = {
  crm: { "1.0": new FieldRoutesMapper("1.0") },
  // calls@1.2 and ads@1.2 are ACTIVE since migration 0018 (an "excluded" state for calls the
  // source says are not leads; currency recorded on spend). Earlier versions stay for history
  // and replays (docs/agent-work/VENDOR-CONTRACTS.md).
  calls: { "1.0": new CallTrackingMapper("1.0"), "1.1": new CallTrackingMapper("1.1"), "1.2": new CallTrackingMapper("1.2") },
  web: { "1.0": new WebLeadMapper() },
  d2d: { "1.0": new DoorToDoorMapper() },
  ads: { "1.0": new AdSpendMapper("1.0"), "1.1": new AdSpendMapper("1.1"), "1.2": new AdSpendMapper("1.2") },
};

/**
 * What is deployed now. calls@1.1 shipped after the call-feed incident; ads@1.1 shipped after
 * the Local Services → Performance Max reclassification (see SCENARIO); calls@1.2 and ads@1.2
 * add source semantics (excluded calls, stated currency) and map every earlier shape the same
 * way. Records stored before a fix keep the version that mapped them until they are replayed.
 */
export const ACTIVE_VERSION: Record<SourceName, string> = {
  crm: "1.0",
  calls: "1.2",
  web: "1.0",
  d2d: "1.0",
  ads: "1.2",
};

export function mapperFor(source: SourceName, version: string = ACTIVE_VERSION[source]): SourceMapper {
  const mapper = MAPPERS[source]?.[version];
  if (!mapper) throw new Error(`No mapper ${source}@${version}`);
  return mapper;
}

export function mapperVersions(source: SourceName): string[] {
  return Object.keys(MAPPERS[source] ?? {}).sort(compareVersions);
}

/** Numeric version order ("1.10" after "1.9"); negative when a is older than b. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export const referenceContext: MapContext = {
  timezoneForOffice: (officeId) => BRANCH_BY_OFFICE.get(officeId)?.timezone,
  timezoneForBranch: (branchId) => BRANCH_BY_ID.get(branchId)?.timezone,
};
