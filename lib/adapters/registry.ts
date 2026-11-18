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

/**
 * The first version of a source's mapper that applies each refusal (its error code). A held record
 * replayed through an older version skips the check that refused it and is counted wrongly: ads@1.0
 * files a Performance Max campaign by platform alone (the B09 misfiling), and ads@1.0 and ads@1.1 read
 * no currency, so they would sum Canadian dollars as US dollars (EGM review 2026-11-18, K6).
 */
export const REFUSAL_CHECKED_FROM: Partial<Record<SourceName, Readonly<Record<string, string>>>> = {
  ads: { AMBIGUOUS_CAMPAIGN_TYPE: "1.1", CURRENCY_UNSUPPORTED: "1.2", FRACTIONAL_CONVERSIONS: "1.2" },
};

/** The mapper versions that may replay records refused with these codes: those that still apply every check. */
export function replayableVersions(source: SourceName, errorCodes: Iterable<string>): string[] {
  const floors = [...errorCodes].map((code) => REFUSAL_CHECKED_FROM[source]?.[code]).filter((v): v is string => v !== undefined);
  const floor = floors.sort(compareVersions).at(-1);
  return mapperVersions(source).filter((v) => floor === undefined || compareVersions(v, floor) >= 0);
}

export const referenceContext: MapContext = {
  timezoneForOffice: (officeId) => BRANCH_BY_OFFICE.get(officeId)?.timezone,
  timezoneForBranch: (branchId) => BRANCH_BY_ID.get(branchId)?.timezone,
};
