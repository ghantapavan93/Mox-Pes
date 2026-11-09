import { BRANCH_BY_ID, BRANCH_BY_OFFICE } from "@/lib/reference";
import type { MapContext, SourceMapper, SourceName } from "./contract";
import { FieldRoutesMapper } from "./crm-fieldroutes";
import { AdSpendMapper, CallTrackingMapper, DoorToDoorMapper, WebLeadMapper } from "./marketing";

/** Every mapper version that has ever shipped. Old versions stay so history is explainable. */
const MAPPERS: Record<SourceName, Record<string, SourceMapper>> = {
  crm: { "1.0": new FieldRoutesMapper("1.0") },
  calls: { "1.0": new CallTrackingMapper("1.0"), "1.1": new CallTrackingMapper("1.1") },
  web: { "1.0": new WebLeadMapper() },
  d2d: { "1.0": new DoorToDoorMapper() },
  ads: { "1.0": new AdSpendMapper("1.0"), "1.1": new AdSpendMapper("1.1") },
};

/**
 * What is deployed now. calls@1.1 shipped after the call-feed incident; ads@1.1 shipped after
 * the Local Services → Performance Max reclassification (see SCENARIO). Records stored before a
 * fix keep the version that mapped them until they are replayed.
 */
export const ACTIVE_VERSION: Record<SourceName, string> = {
  crm: "1.0",
  calls: "1.1",
  web: "1.0",
  d2d: "1.0",
  ads: "1.1",
};

export function mapperFor(source: SourceName, version: string = ACTIVE_VERSION[source]): SourceMapper {
  const mapper = MAPPERS[source]?.[version];
  if (!mapper) throw new Error(`No mapper ${source}@${version}`);
  return mapper;
}

export function mapperVersions(source: SourceName): string[] {
  return Object.keys(MAPPERS[source] ?? {});
}

export const referenceContext: MapContext = {
  timezoneForOffice: (officeId) => BRANCH_BY_OFFICE.get(officeId)?.timezone,
  timezoneForBranch: (branchId) => BRANCH_BY_ID.get(branchId)?.timezone,
};
