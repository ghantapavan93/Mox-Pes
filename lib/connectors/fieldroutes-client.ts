import { z } from "zod";
import type { RawRecord } from "@/lib/adapters/contract";
import { instantToWallTime } from "@/lib/primitives";
import type { Credentials } from "./config";
import { isRealFieldRoutesHost } from "./demo-keys";
import { AuthError, BadRecordError, ConnectorError, ProtocolError, RateLimitError, TimeoutError, UnavailableError } from "./errors";
import type { ApiCallRecord, ChangeTracking, ConnectionCheck, ConnectorCapabilities, CrmConnector, CrmEntity, CrmOffice, GetResult, SearchFilter } from "./types";

/**
 * A read-only FieldRoutes API client over an injectable `fetch`.
 *
 * Contract source: research/17-fieldroutes-api-contract.md (official docs, Oct 2026). Labels in
 * comments: DOC = documented there; INFERRED = our choice where the docs are silent.
 *
 *   * Every call is POST {base}/{entity}/{action} with a JSON body (DOC: "Always POST, including
 *     reads"; base URL already ends in /api).
 *   * Credentials travel in the `authenticationKey` / `authenticationToken` headers (DOC,
 *     recommended), never in the body — the server echoes the body back as `params`, so body
 *     credentials would end up in logs.
 *   * search returns ascending integer ids, at most `searchLimit` (DOC 50,000); the client pages
 *     with `{entity}IDs: {operator: ">", value: lastId}` until a page is short (DOC).
 *   * get returns at most `getLimit` records (DOC 1,000); the client never asks for more.
 *   * Non-2xx AND HTTP 200 with success:false are both failures (DOC: business-rule errors are
 *     200 + success:false; before release 10.6 auth failures could be too).
 *   * The error text field varies between pages; read errorMessage ?? error ?? message (INFERRED).
 *   * A non-empty `ignoredParams` means a filter we rely on was silently dropped (DOC: unknown
 *     params are ignored, not rejected). The client fails loudly instead of syncing less.
 *
 * There is deliberately no create/update/delete method: production writes are not implemented.
 */

const DEFAULT_SEARCH_LIMIT = 50_000;
const DEFAULT_GET_LIMIT = 1_000;
const MINUTE = 60_000;

/**
 * Change tracking per entity. Overlaps match the in-memory pipeline's 30 minutes for entities
 * with a dateUpdated filter. Payments are swept by recording `date` over a 35-day trailing
 * window (research/06 §2.4): the legacy spec has no payment dateUpdated and the current docs'
 * one is unconfirmed (research/17 §3, CONFLICT) — INFERRED, revisit on an authorized tenant.
 */
export const FIELDROUTES_CHANGE_TRACKING: Record<CrmEntity, ChangeTracking> = {
  customer: { field: "dateUpdated", overlapMs: 30 * MINUTE, explicitFilters: {} },
  // DOC: subscription search defaults to active IN (0,1); leads (-3) are hidden. Explicit, so the
  // intent survives a default change; leads are out of scope for the mapper.
  subscription: { field: "dateUpdated", overlapMs: 30 * MINUTE, explicitFilters: { active: { operator: "IN", value: [0, 1] } } },
  // DOC: appointment search defaults to status IN (0,1) — cancelled (-1), rescheduled (-2) and
  // no-show (2) would silently never sync without this filter.
  appointment: { field: "dateUpdated", overlapMs: 30 * MINUTE, explicitFilters: { status: { operator: "IN", value: [-2, -1, 0, 1, 2] } } },
  // DOC: ticket search defaults to status IN (0,1); templates (-1) are not invoices.
  ticket: { field: "dateUpdated", overlapMs: 30 * MINUTE, explicitFilters: { status: { operator: "IN", value: [0, 1] } } },
  payment: { field: "date", overlapMs: 35 * 24 * 60 * MINUTE, explicitFilters: {} },
};

const ID_FIELD: Record<CrmEntity, string> = {
  customer: "customerID",
  subscription: "subscriptionID",
  appointment: "appointmentID",
  ticket: "ticketID",
  payment: "paymentID",
};

const numberish = z.union([z.number(), z.string().regex(/^-?\d+$/)]).transform(Number);
const lenientNumber = z.union([z.number(), z.string()]).transform((v) => (Number.isFinite(Number(v)) ? Number(v) : null)).nullable().optional();

const envelopeSchema = z.looseObject({
  success: z.boolean(),
  ignoredParams: z.array(z.string()).optional(),
  requestAPIKeyType: z.string().optional(),
  tokenUsage: z.looseObject({ requestsReadToday: lenientNumber, requestsReadInLastMinute: lenientNumber }).optional(),
  tokenLimits: z.looseObject({ limitReadRequestsPerDay: lenientNumber, limitReadRequestsPerMinute: lenientNumber }).optional(),
  errorMessage: z.string().optional(),
  error: z.string().optional(),
  message: z.string().optional(),
});
type Envelope = z.infer<typeof envelopeSchema> & Record<string, unknown>;

export interface FieldRoutesClientOptions {
  /** API root, e.g. https://tenant.fieldroutes.com/api or this app's /api/mock/fieldroutes. */
  baseUrl: string;
  /** Office-scoped credentials. Throws (AuthError) or returns them; never logged. */
  credentials: (officeId: number) => Credentials;
  fetch?: typeof fetch;
  timeoutMs: number;
  /** "office" = each office's zone; otherwise the IANA zone the source writes datetimes in. */
  wireTimeZone: "office" | string;
  officeTimeZone: (officeId: number) => string | undefined;
  searchLimit?: number;
  getLimit?: number;
  onCall?: (call: ApiCallRecord) => void;
  /** Hosts a person has authorized for real calls. Empty in this build. */
  authorizedHosts?: string[];
  now?: () => Date;
}

export class FieldRoutesHttpClient implements CrmConnector {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly searchLimit: number;
  private readonly getLimit: number;
  private readonly now: () => Date;

  constructor(private readonly options: FieldRoutesClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    const host = (() => {
      try {
        return new URL(this.baseUrl).hostname.toLowerCase();
      } catch {
        throw new ProtocolError(`Connector base URL is not a URL: "${options.baseUrl}"`);
      }
    })();
    // The authorization boundary: this build may only talk to mocks and explicitly authorized
    // hosts. Pointing a connector row at a real tenant does nothing without that authorization.
    if (isRealFieldRoutesHost(this.baseUrl) && !(options.authorizedHosts ?? []).includes(host)) {
      throw new AuthError(`Calls to ${host} are not authorized in this build (no FieldRoutes agreement or credentials). Use the mock.`);
    }
    this.fetchImpl = options.fetch ?? fetch;
    this.searchLimit = options.searchLimit ?? DEFAULT_SEARCH_LIMIT;
    this.getLimit = options.getLimit ?? DEFAULT_GET_LIMIT;
    this.now = options.now ?? (() => new Date());
  }

  capabilities(): ConnectorCapabilities {
    return {
      provider: "fieldroutes",
      entities: FIELDROUTES_CHANGE_TRACKING,
      searchLimit: this.searchLimit,
      getLimit: this.getLimit,
      credentialScope: "office",
      writes: false,
      webhooks: false,
    };
  }

  async validateConnection(officeId: number): Promise<ConnectionCheck> {
    const env = await this.post(officeId, "office", "search", {}, []);
    const keyType = env.requestAPIKeyType === "standard" || env.requestAPIKeyType === "global" ? env.requestAPIKeyType : "unknown";
    return {
      ok: true,
      officeId,
      keyType,
      usage: {
        readsToday: env.tokenUsage?.requestsReadToday ?? null,
        readsLastMinute: env.tokenUsage?.requestsReadInLastMinute ?? null,
        readLimitPerDay: env.tokenLimits?.limitReadRequestsPerDay ?? null,
        readLimitPerMinute: env.tokenLimits?.limitReadRequestsPerMinute ?? null,
      },
    };
  }

  async listOffices(officeId: number): Promise<CrmOffice[]> {
    const search = await this.post(officeId, "office", "search", {}, []);
    const ids = this.idsOf(search, "officeIDs");
    if (ids.length === 0) return [];
    const got = await this.post(officeId, "office", "get", { officeIDs: ids }, ids);
    const offices = z
      .array(z.looseObject({ officeID: numberish, officeName: z.string(), timeZone: z.string().nullable().optional() }))
      .safeParse(got.offices);
    if (!offices.success) throw new ProtocolError("office/get: response has no usable `offices` list");
    return offices.data.map((o) => ({ officeId: o.officeID, name: o.officeName, timeZone: o.timeZone ?? null }));
  }

  async search(entity: CrmEntity, filter: SearchFilter): Promise<number[]> {
    const tracking = FIELDROUTES_CHANGE_TRACKING[entity];
    const zone = this.zoneFor(filter.officeId);
    const window = [instantToWallTime(filter.updatedFrom, zone), instantToWallTime(filter.updatedTo, zone)];
    const idParam = `${entity}IDs`;
    const all: number[] = [];
    let after = filter.idsAfter ?? null;
    for (;;) {
      const body: Record<string, unknown> = {
        officeIDs: [filter.officeId],
        [tracking.field]: { operator: "BETWEEN", value: window },
        ...tracking.explicitFilters,
        ...(after !== null ? { [idParam]: { operator: ">", value: after } } : {}),
      };
      const page = this.idsOf(await this.post(filter.officeId, entity, "search", body, null), idParam);
      all.push(...page);
      // DOC: a full page means "there may be more" — re-query with id > the last id. Max, not
      // last element: ascending order is documented for some entities and only INFERRED for others.
      if (page.length < this.searchLimit) break;
      after = Math.max(...page);
    }
    return [...new Set(all)].sort((a, b) => a - b);
  }

  async get(entity: CrmEntity, request: { officeId: number; ids: number[] }): Promise<GetResult> {
    const result: GetResult = { records: [], rejected: [], missingIds: [] };
    const idField = ID_FIELD[entity];
    for (let i = 0; i < request.ids.length; i += this.getLimit) {
      const chunk = request.ids.slice(i, i + this.getLimit);
      const env = await this.post(request.officeId, entity, "get", { [`${entity}IDs`]: chunk, officeIDs: [request.officeId] }, chunk);
      const list = env[`${entity}s`];
      if (!Array.isArray(list)) throw new ProtocolError(`${entity}/get: response has no \`${entity}s\` list`);
      const returned = new Set<number>();
      for (const item of list) {
        if (item === null || typeof item !== "object" || Array.isArray(item)) {
          result.rejected.push(new BadRecordError(`${entity}/get returned a non-object entry`, null));
          continue;
        }
        const payload = item as Record<string, unknown>;
        const id = payload[idField];
        if (id !== undefined && id !== null) returned.add(Number(id));
        // Scope check: a record for another office must never be stored under this office's
        // sync. (Negative officeID = soft-deleted customer, DOC — also not ours to ingest here.)
        if (String(payload.officeID) !== String(request.officeId)) {
          result.rejected.push(new BadRecordError(`${entity} ${String(id)} belongs to office ${String(payload.officeID)}, not ${request.officeId}`, id == null ? null : String(id)));
          continue;
        }
        // Records with a missing id or bad fields still go to ingestion: the raw log keeps them
        // and the mapper quarantines them with a reason, which is what makes them replayable.
        result.records.push({ entity, payload } satisfies RawRecord);
      }
      result.missingIds.push(...chunk.filter((id) => !returned.has(id)));
    }
    return result;
  }

  private zoneFor(officeId: number): string {
    if (this.options.wireTimeZone !== "office") return this.options.wireTimeZone;
    const zone = this.options.officeTimeZone(officeId);
    if (!zone) throw new ProtocolError(`No time zone known for office ${officeId}`);
    return zone;
  }

  private idsOf(env: Envelope, key: string): number[] {
    const parsed = z.array(numberish).safeParse(env[key]);
    if (!parsed.success) throw new ProtocolError(`search response has no \`${key}\` id list`);
    return parsed.data;
  }

  /**
   * One HTTP exchange with timeout, classification and a trace record. `ids` are the ids
   * requested (get); for a search, the returned ids are traced instead (null here).
   */
  private async post(officeId: number, entity: string, action: string, body: Record<string, unknown>, ids: number[] | null): Promise<Envelope> {
    const path = `/${entity}/${action}`;
    const started = Date.now();
    const at = this.now();
    let status: number | null = null;
    let traced: number[] = ids ?? [];
    let tracedCount = ids?.length ?? 0;
    try {
      const credentials = this.options.credentials(officeId);
      const env = await this.exchange(path, body, credentials, (s) => (status = s));
      if (ids === null) {
        const returned = Array.isArray(env[`${entity}IDs`]) ? (env[`${entity}IDs`] as unknown[]).map(Number) : [];
        tracedCount = returned.length;
        traced = returned.slice(0, 1000);
      }
      this.trace({ path, officeId, entity, action, status, started, at, ids: traced, idCount: tracedCount, error: null });
      return env;
    } catch (error) {
      const err = error instanceof ConnectorError ? error : new UnavailableError(`${path}: ${(error as Error).message}`);
      this.trace({ path, officeId, entity, action, status, started, at, ids: traced, idCount: tracedCount, error: err });
      throw err;
    }
  }

  private async exchange(path: string, body: Record<string, unknown>, credentials: Credentials, onStatus: (status: number) => void): Promise<Envelope> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Race as well as abort: an in-process fetch (tests, the mock) may not honour the signal.
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new TimeoutError(`${path}: no response within ${this.options.timeoutMs} ms`));
      }, this.options.timeoutMs);
    });
    try {
      const response = await Promise.race([
        this.fetchImpl(`${this.baseUrl}${path}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            authenticationKey: credentials.key,
            authenticationToken: credentials.token,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        }),
        timeout,
      ]);
      onStatus(response.status);
      const text = await Promise.race([response.text(), timeout]);
      return this.interpret(path, response, text);
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      if ((error as Error).name === "AbortError") throw new TimeoutError(`${path}: no response within ${this.options.timeoutMs} ms`);
      // fetch rejects with a TypeError on DNS/connection failures: the source is unreachable.
      throw new UnavailableError(`${path}: ${(error as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private interpret(path: string, response: Response, text: string): Envelope {
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    const parsed = envelopeSchema.safeParse(json);
    const message = parsed.success ? (parsed.data.errorMessage ?? parsed.data.error ?? parsed.data.message ?? null) : null;
    const detail = `${path}: HTTP ${response.status}${message ? ` — ${message}` : ""}`;

    if (response.status === 401 || response.status === 403) throw new AuthError(detail, response.status);
    if (response.status === 429) throw new RateLimitError(detail, 429, parseRetryAfter(response.headers.get("retry-after"), this.now()));
    if (response.status >= 500) throw new UnavailableError(detail, response.status);
    if (!response.ok) throw new ProtocolError(detail, response.status);
    if (!parsed.success) throw new ProtocolError(`${path}: HTTP ${response.status} with a body that is not a FieldRoutes envelope`, response.status);
    if (!parsed.data.success) {
      // DOC: pre-10.6 auth failures could arrive as HTTP 200 + success:false. INFERRED wording match.
      if (message && /auth|credential|token|key/i.test(message)) throw new AuthError(detail, response.status);
      throw new ProtocolError(detail, response.status);
    }
    if (parsed.data.ignoredParams && parsed.data.ignoredParams.length > 0) {
      throw new ProtocolError(`${path}: the source ignored filter(s) ${parsed.data.ignoredParams.join(", ")} — refusing a sync that would silently read the wrong set`);
    }
    return parsed.data as Envelope;
  }

  private trace(args: { path: string; officeId: number; entity: string; action: string; status: number | null; started: number; at: Date; ids: number[]; idCount: number; error: ConnectorError | null }) {
    this.options.onCall?.({
      method: "POST",
      path: args.path,
      officeId: args.officeId,
      entity: args.entity,
      action: args.action,
      status: args.status,
      ms: Math.max(0, Date.now() - args.started),
      ids: args.ids,
      idCount: args.idCount,
      errorKind: args.error?.kind ?? null,
      error: args.error?.message ?? null,
      at: args.at,
    });
  }
}

/** Retry-After as delta-seconds or an HTTP date (RFC 9110 §10.2.3). Null when absent or unusable. */
export function parseRetryAfter(value: string | null, now: Date): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value.trim())) return Number(value.trim()) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - now.getTime());
}
