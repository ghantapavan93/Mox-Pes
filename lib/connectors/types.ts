import type { RawRecord } from "@/lib/adapters/contract";
import type { BadRecordError, ConnectorErrorKind } from "./errors";

/**
 * The provider-neutral CRM connector contract. The job runner (lib/jobs) only ever talks to
 * this interface; FieldRoutesHttpClient is one implementation. A PestPac or ServiceTitan client
 * would implement the same five methods and reuse the jobs, checkpoints, trace and Studio.
 *
 * Shape it encodes (research/06 §4, research/17 §2): poll-first, search returns ids, get returns
 * records in bounded batches, credentials are scoped to one office, and every call is cheap to
 * repeat because ingestion absorbs duplicates.
 */

export const CRM_ENTITIES = ["customer", "subscription", "appointment", "ticket", "payment"] as const;
export type CrmEntity = (typeof CRM_ENTITIES)[number];

export function isCrmEntity(value: string): value is CrmEntity {
  return (CRM_ENTITIES as readonly string[]).includes(value);
}

/** How the connector finds changed records of one entity. */
export interface ChangeTracking {
  /** The source field the incremental filter runs on. */
  field: "dateUpdated" | "date";
  /**
   * How far behind the checkpoint each window re-reads. Payments are filtered by their
   * recording date, not an update stamp, so they need a wide trailing window.
   */
  overlapMs: number;
  /** Source-side filter needed to see EVERY state (e.g. cancelled appointments are hidden by default). */
  explicitFilters: Record<string, unknown>;
}

export interface ConnectorCapabilities {
  provider: "fieldroutes";
  entities: Record<CrmEntity, ChangeTracking>;
  /** Max ids one search returns before the client must page with `id > last`. */
  searchLimit: number;
  /** Max records one get returns. */
  getLimit: number;
  /** Credentials are issued per office; one office failing never blocks another. */
  credentialScope: "office";
  /** This build is read-only by construction: no create/update/delete method exists. */
  writes: false;
  /** No API-managed webhooks are documented; sync is polling only. */
  webhooks: false;
}

export interface ConnectionCheck {
  ok: true;
  officeId: number;
  keyType: "standard" | "global" | "unknown";
  /** Read budget as reported by the source, when it reports one. */
  usage: { readsToday: number | null; readsLastMinute: number | null; readLimitPerDay: number | null; readLimitPerMinute: number | null };
}

export interface CrmOffice {
  officeId: number;
  name: string;
  timeZone: string | null;
}

export interface SearchFilter {
  officeId: number;
  /** Inclusive lower bound on the entity's change field (business-clock instant). */
  updatedFrom: Date;
  /** Inclusive upper bound. */
  updatedTo: Date;
  /** Keyset position: only ids strictly greater than this. */
  idsAfter?: number | null;
}

export interface GetResult {
  /** Records ready for ingestRecords, in the source's own wire shape. */
  records: RawRecord[];
  /** Records refused before ingestion (e.g. returned for an office the key does not own). */
  rejected: BadRecordError[];
  /** Requested ids the source did not return (deleted or merged since the search; or truncated). */
  missingIds: number[];
}

/** One HTTP exchange, as recorded into sync_api_calls. Never carries credentials. */
export interface ApiCallRecord {
  method: string;
  path: string;
  officeId: number;
  entity: string;
  action: string;
  status: number | null;
  ms: number;
  ids: number[];
  idCount: number;
  errorKind: ConnectorErrorKind | null;
  error: string | null;
  at: Date;
}

export interface CrmConnector {
  capabilities(): ConnectorCapabilities;
  /** Proves the office's credentials work; throws AuthError when they do not. */
  validateConnection(officeId: number): Promise<ConnectionCheck>;
  /** Offices visible to the given office's credentials. */
  listOffices(officeId: number): Promise<CrmOffice[]>;
  /** Every id changed inside the window, ascending, paging past the search cap internally. */
  search(entity: CrmEntity, filter: SearchFilter): Promise<number[]>;
  /** Records for the ids, fetched in batches of at most `getLimit`. */
  get(entity: CrmEntity, request: { officeId: number; ids: number[] }): Promise<GetResult>;
}
