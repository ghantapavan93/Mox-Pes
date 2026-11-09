import type { Queryable } from "@/lib/db";
import { BRANCHES } from "@/lib/reference";
import type { SourceRecordVersion } from "@/lib/sim/world";
import { officeForDemoKey } from "./demo-keys";
import { CRM_ENTITIES, isCrmEntity, type CrmEntity } from "./types";

/**
 * A FieldRoutes-compatible mock server: a pure `(Request) => Promise<Response>` handler backed
 * by the synthetic world. It serves the LATEST version of each CRM record visible at the
 * business clock, in the wire shape FieldRoutesMapper reads (which deviates from the real API
 * in documented ways — lib/connectors/README.md, "Mapper deviations").
 *
 * Contract: research/17 "Mock server contract". Tags below: [DOC] documented FieldRoutes
 * behaviour; [INF] our choice where the docs are silent; [MOCK] demo-only behaviour that a real
 * tenant does not have (fault injection, demo keys, Retry-After).
 *
 *   transport  POST {base}/{entity}/{action}; other methods 405 [INF]; /v1/... 404 [DOC];
 *              JSON or form-urlencoded bodies with bracket syntax [DOC]; JSON responses [DOC]
 *   auth       authenticationKey/authenticationToken headers, else body [DOC]; missing → 401,
 *              unknown or expired → 403 [DOC]; keys are office-scoped demo keys [MOCK]
 *   scope      a standard key's officeIDs filter is FORCED to its own office [DOC]; get omits
 *              records outside it [INF]; rows with a negative officeID are never returned [DOC]
 *   search     ascending ids [DOC/INF], capped at searchLimit (50,000) [DOC]; operators
 *              = != > < >= <= IN, NOT IN, BETWEEN, LIKE, STARTSWITH, ENDSWITH, CONTAINS [DOC];
 *              default status filters on appointment/subscription/ticket [DOC]; unknown params
 *              ignored and listed in ignoredParams [DOC]; includeData=1 [DOC]
 *   get        at most getLimit (1,000) records; extra ids silently dropped [DOC cap, INF drop]
 *   limits     per key: 60 reads/min, 3,000/day [DOC]; 429 [DOC] with Retry-After [MOCK — the
 *              real API documents no rate-limit headers, so clients must not depend on it]
 *   writes     not served: every non-read action → 403 "read-only key" [INF]
 */

export const FAULT_KINDS = [
  "rate_limit", "expired_key", "timeout", "unavailable", "malformed_record", "missing_timestamp", "disappeared_record", "out_of_order",
] as const;
export type FaultKind = (typeof FAULT_KINDS)[number];

/** Faults that fail the whole request, vs. faults that alter the data in a response. */
export const REQUEST_FAULTS: readonly FaultKind[] = ["expired_key", "rate_limit", "unavailable", "timeout"];

/** Entities with a money field a malformed_record fault can corrupt. */
export const AMOUNT_FIELD: Partial<Record<CrmEntity, string>> = { subscription: "contractValue", ticket: "total", payment: "amount" };

export interface MockFault {
  id: number;
  kind: FaultKind;
  officeId: number | null;
  entity: CrmEntity | null;
  action: "search" | "get" | null;
  recordId: number | null;
  params: { retryAfterSeconds?: number; delayMs?: number };
}

export interface FaultStore {
  /** Faults that are active and not exhausted. */
  active(): Promise<MockFault[]>;
  /** Counts one match; true when the fault should fire on it (its skip count is used up). */
  fire(faultId: number): Promise<boolean>;
}

/** Faults from mock_fieldroutes_faults. Matching and counting are atomic per row. */
export function dbFaultStore(db: Queryable): FaultStore {
  return {
    async active() {
      const { rows } = await db.query<{ id: string; kind: FaultKind; office_id: number | null; entity: CrmEntity | null; action: "search" | "get" | null; record_id: string | null; params: MockFault["params"] }>(
        `select id, kind, office_id, entity, action, record_id, params from mock_fieldroutes_faults
         where active and (remaining is null or remaining > 0) order by id`,
      );
      return rows.map((r) => ({ id: Number(r.id), kind: r.kind, officeId: r.office_id, entity: r.entity, action: r.action, recordId: r.record_id === null ? null : Number(r.record_id), params: r.params ?? {} }));
    },
    async fire(faultId) {
      const { rows } = await db.query<{ fire: boolean }>(
        `with old as (select id, skip_remaining from mock_fieldroutes_faults where id = $1 for update)
         update mock_fieldroutes_faults f set
           skip_remaining = greatest(f.skip_remaining - 1, 0),
           remaining = case when f.skip_remaining > 0 or f.remaining is null then f.remaining else f.remaining - 1 end,
           fired = f.fired + case when f.skip_remaining > 0 then 0 else 1 end
         from old where f.id = old.id and f.active and (f.remaining is null or f.remaining > 0)
         returning old.skip_remaining = 0 as fire`,
        [faultId],
      );
      return rows[0]?.fire ?? false;
    },
  };
}

export interface MockOffice {
  officeId: number;
  name: string;
  timeZone: string;
}

export interface MockOptions {
  /** Source record versions (the synthetic world); non-CRM streams are ignored. */
  records: () => SourceRecordVersion[];
  /** The business clock: what "now" is in the synthetic world. */
  clock: () => Promise<Date>;
  faults: FaultStore;
  /** Path prefix in front of /{entity}/{action}. */
  basePath?: string;
  searchLimit?: number;
  getLimit?: number;
  rateLimit?: { perMinute: number; perDay: number };
  offices?: MockOffice[];
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Wall clock for rate-limit windows. */
  wallNow?: () => number;
}

const ID_FIELD: Record<CrmEntity, string> = {
  customer: "customerID",
  subscription: "subscriptionID",
  appointment: "appointmentID",
  ticket: "ticketID",
  payment: "paymentID",
};

/** Search params each entity understands besides officeIDs/includeData/{entity}IDs [DOC subset]. */
const SEARCH_PARAMS: Record<CrmEntity, Record<string, string>> = {
  // filter name → response field it filters on
  customer: { dateUpdated: "dateUpdated", dateAdded: "dateAdded", active: "status", status: "status" },
  subscription: { dateUpdated: "dateUpdated", dateAdded: "dateAdded", active: "active", customerIDs: "customerID" },
  appointment: { dateUpdated: "dateUpdated", date: "date", status: "status", salesAnchor: "salesAnchor", customerIDs: "customerID" },
  ticket: { dateUpdated: "dateUpdated", dateCreated: "dateCreated", status: "active", customerIDs: "customerID" },
  payment: { date: "date", status: "status", customerIDs: "customerID" },
};
/** Range helpers documented on customer and subscription only [DOC]. */
const RANGE_PARAMS: Partial<Record<CrmEntity, Record<string, { field: string; op: ">=" | "<=" }>>> = {
  customer: { dateUpdatedStart: { field: "dateUpdated", op: ">=" }, dateUpdatedEnd: { field: "dateUpdated", op: "<=" } },
  subscription: { dateUpdatedStart: { field: "dateUpdated", op: ">=" }, dateUpdatedEnd: { field: "dateUpdated", op: "<=" } },
};
/** Default status filters that hide rows unless the caller asks [DOC]. */
const DEFAULT_FILTERS: Partial<Record<CrmEntity, { param: string; value: number[] }>> = {
  appointment: { param: "status", value: [0, 1] },
  subscription: { param: "active", value: [0, 1] },
  ticket: { param: "status", value: [0, 1] },
};
/** A record without the field counts as this value (the synthetic world omits ticket.active). */
const FIELD_DEFAULTS: Record<string, string> = { active: "1", status: "1" };

interface Served {
  id: number;
  officeId: number;
  current: Record<string, unknown>;
  previous: Record<string, unknown> | null;
}

interface Snapshot {
  at: number;
  byEntity: Map<CrmEntity, Served[]>;
  byId: Map<CrmEntity, Map<number, Served>>;
}

type Filter = { operator: string; value: unknown };

class HttpFailure extends Error {
  constructor(readonly status: number, message: string, readonly headers: Record<string, string> = {}) {
    super(message);
  }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const defaultSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });

export function createMockFieldRoutes(options: MockOptions): (request: Request) => Promise<Response> {
  const basePath = (options.basePath ?? "/api/mock/fieldroutes").replace(/\/+$/, "");
  const searchLimit = options.searchLimit ?? 50_000;
  const getLimit = options.getLimit ?? 1_000;
  const limits = options.rateLimit ?? { perMinute: 60, perDay: 3_000 };
  const offices = options.offices ?? BRANCHES.map((b) => ({ officeId: b.crmOfficeId, name: `${b.name} (synthetic office ${b.id})`, timeZone: b.timezone }));
  const sleep = options.sleep ?? defaultSleep;
  const wallNow = options.wallNow ?? (() => Date.now());

  let index: Map<CrmEntity, Map<number, SourceRecordVersion[]>> | null = null;
  let snapshot: Snapshot | null = null;
  const usage = new Map<string, { minute: number[]; day: string; dayCount: number }>();

  /** Versions per entity id, sorted by when they became visible. Built once per handler. */
  function versions(): Map<CrmEntity, Map<number, SourceRecordVersion[]>> {
    if (index) return index;
    const built = new Map<CrmEntity, Map<number, SourceRecordVersion[]>>(CRM_ENTITIES.map((e) => [e, new Map()]));
    for (const record of options.records()) {
      if (!record.stream.startsWith("crm.") || !isCrmEntity(record.entity)) continue;
      const id = Number(record.payload[ID_FIELD[record.entity]]);
      if (!Number.isSafeInteger(id)) continue;
      const byId = built.get(record.entity)!;
      const list = byId.get(id) ?? [];
      list.push(record);
      byId.set(id, list);
    }
    for (const byId of built.values()) for (const list of byId.values()) list.sort((a, b) => a.visibleAt - b.visibleAt);
    index = built;
    return built;
  }

  /** Latest version of every record visible at `at`, plus the version before it. Cached per clock. */
  function snapshotAt(at: number): Snapshot {
    if (snapshot?.at === at) return snapshot;
    const byEntity = new Map<CrmEntity, Served[]>();
    const byId = new Map<CrmEntity, Map<number, Served>>();
    for (const [entity, ids] of versions()) {
      const served: Served[] = [];
      for (const [id, list] of ids) {
        let k = -1;
        while (k + 1 < list.length && list[k + 1].visibleAt <= at) k++;
        if (k < 0) continue;
        const current = list[k].payload;
        served.push({ id, officeId: Number(current.officeID), current, previous: k > 0 ? list[k - 1].payload : null });
      }
      served.sort((a, b) => a.id - b.id);
      byEntity.set(entity, served);
      byId.set(entity, new Map(served.map((s) => [s.id, s])));
    }
    snapshot = { at, byEntity, byId };
    return snapshot;
  }

  async function matchingFaults(kinds: readonly FaultKind[], officeId: number, entity: string, action: string): Promise<MockFault[]> {
    return (await options.faults.active()).filter(
      (f) =>
        kinds.includes(f.kind) &&
        (f.officeId === null || f.officeId === officeId) &&
        (f.entity === null || f.entity === entity) &&
        (f.action === null || f.action === action),
    );
  }

  /** Per-key rolling-minute and calendar-day read counters [DOC limits; INF window shapes]. */
  function countRead(key: string): { readsToday: number; readsLastMinute: number } {
    const now = wallNow();
    const day = new Date(now).toISOString().slice(0, 10);
    const u = usage.get(key) ?? { minute: [], day, dayCount: 0 };
    if (u.day !== day) Object.assign(u, { day, dayCount: 0 });
    u.minute = u.minute.filter((t) => now - t < 60_000);
    if (u.minute.length >= limits.perMinute) {
      const retryAfter = Math.max(1, Math.ceil((u.minute[0] + 60_000 - now) / 1000));
      throw new HttpFailure(429, "Rate limit exceeded: limitReadRequestsPerMinute", { "retry-after": String(retryAfter) });
    }
    if (u.dayCount >= limits.perDay) throw new HttpFailure(429, "Rate limit exceeded: limitReadRequestsPerDay", { "retry-after": "3600" });
    u.minute.push(now);
    u.dayCount += 1;
    usage.set(key, u);
    return { readsToday: u.dayCount, readsLastMinute: u.minute.length };
  }

  return async function handle(request: Request): Promise<Response> {
    const started = Date.now();
    const url = new URL(request.url);
    const rest = url.pathname.startsWith(basePath) ? url.pathname.slice(basePath.length) : url.pathname;
    const [entity = "", action = ""] = rest.split("/").filter(Boolean);
    const fail = (status: number, message: string, headers: Record<string, string> = {}) =>
      json(status, { success: false, errorMessage: message, endpoint: entity, requestAction: action }, headers);

    if (request.method !== "POST") return fail(405, "Every FieldRoutes call is POST, including reads");
    if (/^v\d+$/.test(entity)) return fail(404, "No version segment: use /{entity}/{action}");
    if (entity !== "office" && !isCrmEntity(entity)) return fail(404, `Unknown endpoint "${entity}"`);

    let body: Record<string, unknown>;
    try {
      body = await readBody(request);
    } catch (error) {
      return fail(400, (error as Error).message);
    }

    // Auth [DOC]: headers first, then body. Credentials never appear in the echoed params.
    const key = request.headers.get("authenticationkey") ?? (typeof body.authenticationKey === "string" ? body.authenticationKey : null);
    const token = request.headers.get("authenticationtoken") ?? (typeof body.authenticationToken === "string" ? body.authenticationToken : null);
    delete body.authenticationKey;
    delete body.authenticationToken;
    if (!key || !token) return fail(401, "Authentication failed: authenticationKey or authenticationToken missing");
    const keyOffice = officeForDemoKey(key, token);
    if (keyOffice === null) return fail(403, "Authentication failed: invalid or expired credentials");

    const isRead = action === "search" || action === "get" || /^\d+$/.test(action);
    if (!isRead) return fail(403, `This key is read-only: ${entity}/${action} is not permitted`);
    const faultAction = action === "search" ? "search" : "get";

    try {
      for (const fault of await matchingFaults(REQUEST_FAULTS, keyOffice, entity, faultAction)) {
        if (!(await options.faults.fire(fault.id))) continue;
        if (fault.kind === "expired_key") return fail(403, "Authentication failed: invalid or expired credentials");
        if (fault.kind === "rate_limit") {
          return fail(429, "Rate limit exceeded: limitReadRequestsPerMinute", { "retry-after": String(fault.params.retryAfterSeconds ?? 2) });
        }
        if (fault.kind === "unavailable") return fail(503, "Service temporarily unavailable");
        if (fault.kind === "timeout") {
          await sleep(fault.params.delayMs ?? 17_000, request.signal);
          if (request.signal.aborted) return fail(503, "client went away");
        }
      }
      const usageNow = countRead(key);
      const clock = (await options.clock()).getTime();
      const envelope = (extra: Record<string, unknown>, ignoredParams: string[] = []) =>
        json(200, {
          params: { ...body, endpoint: entity, action },
          tokenUsage: { requestsReadToday: usageNow.readsToday, requestsWriteToday: 0, requestsReadInLastMinute: usageNow.readsLastMinute, requestsWriteInLastMinute: 0 },
          tokenLimits: { limitReadRequestsPerMinute: limits.perMinute, limitReadRequestsPerDay: limits.perDay, limitWriteRequestsPerMinute: limits.perMinute, limitWriteRequestsPerDay: limits.perDay },
          requestAction: action,
          endpoint: entity,
          success: true,
          processingTime: `${Date.now() - started} milliseconds`,
          ...extra,
          requestAPIKeyType: "standard",
          ignoredParams,
        });

      if (entity === "office") {
        const own = offices.filter((o) => o.officeId === keyOffice);
        if (action === "search") return envelope({ count: own.length, idName: "officeIDs", officeIDs: own.map((o) => o.officeId), propertyName: "officeIDs" });
        const list = own.map((o) => ({ officeID: String(o.officeId), officeName: o.name, companyID: "1", timeZone: o.timeZone }));
        return envelope({ count: list.length, offices: list, propertyName: "offices" });
      }

      const crmEntity = entity as CrmEntity;
      const snap = snapshotAt(clock);

      if (action === "search") {
        const { rows, ignored } = searchRows(snap.byEntity.get(crmEntity)!, crmEntity, body, keyOffice);
        let ids = rows.slice(0, searchLimit).map((r) => r.id);
        for (const fault of await matchingFaults(["disappeared_record"], keyOffice, entity, "search")) {
          const target = fault.recordId !== null ? (ids.includes(fault.recordId) ? fault.recordId : null) : (ids[0] ?? null);
          if (target !== null && (await options.faults.fire(fault.id))) ids = ids.filter((id) => id !== target);
        }
        const idName = `${entity}IDs`;
        if (Number(body.includeData) === 1) {
          const data = ids.slice(0, getLimit).map((id) => serialize(snap.byId.get(crmEntity)!.get(id)!.current));
          return envelope({ count: ids.length, idName, [idName]: ids, propertyName: idName, [`${entity}s`]: data, [`${entity}IDsNoDataExported`]: ids.slice(getLimit), propertyNameData: `${entity}s` }, ignored);
        }
        return envelope({ count: ids.length, idName, [idName]: ids, propertyName: idName }, ignored);
      }

      const single = /^\d+$/.test(action) ? Number(action) : null;
      const requested = single !== null ? [single] : idList(body[`${entity}IDs`]);
      if (requested === null) return fail(400, `${entity}IDs is required`);
      const byId = snap.byId.get(crmEntity)!;
      // [DOC] cap; [INF] extra ids are dropped silently, as "may be truncated" suggests.
      const found = [...new Set(requested)].slice(0, getLimit).sort((a, b) => a - b)
        .map((id) => byId.get(id))
        .filter((s): s is Served => s !== undefined && s.officeId === keyOffice && s.officeId > 0);
      const records = found.map((s) => ({ served: s, payload: structuredClone(s.current) }));
      await applyDataFaults(records, crmEntity, keyOffice);
      const list = records.map((r) => serialize(r.payload));
      if (single !== null) {
        if (list.length === 0) return fail(404, `${entity} ${single} not found`);
        return envelope({ [entity]: list[0], propertyName: entity });
      }
      return envelope({ count: list.length, [`${entity}s`]: list, propertyName: `${entity}s` });
    } catch (error) {
      if (error instanceof HttpFailure) return fail(error.status, error.message, error.headers);
      console.error(JSON.stringify({ level: "error", msg: "mock fieldroutes error", error: (error as Error).message }));
      return fail(500, "Internal error");
    }
  };

  /** Data faults on a get response: each fires at most once per response, on one record. */
  async function applyDataFaults(records: Array<{ served: Served; payload: Record<string, unknown> }>, entity: CrmEntity, officeId: number) {
    const faults = await matchingFaults(["malformed_record", "missing_timestamp", "out_of_order"], officeId, entity, "get");
    for (const fault of faults) {
      const eligible = records.filter((r) =>
        (fault.recordId === null || r.served.id === fault.recordId) &&
        (fault.kind !== "out_of_order" || r.served.previous !== null) &&
        (fault.kind !== "malformed_record" || AMOUNT_FIELD[entity] !== undefined),
      );
      const target = eligible[0];
      if (!target || !(await options.faults.fire(fault.id))) continue;
      if (fault.kind === "malformed_record") target.payload[AMOUNT_FIELD[entity]!] = "12.34.56";
      if (fault.kind === "missing_timestamp") delete target.payload[entity === "payment" ? "date" : "dateUpdated"];
      if (fault.kind === "out_of_order") {
        // A stale replica answers: the version before the latest, delivered after it.
        for (const k of Object.keys(target.payload)) delete target.payload[k];
        Object.assign(target.payload, structuredClone(target.served.previous!));
      }
    }
  }

  function searchRows(rows: Served[], entity: CrmEntity, body: Record<string, unknown>, keyOffice: number): { rows: Served[]; ignored: string[] } {
    const known = SEARCH_PARAMS[entity];
    const ranges = RANGE_PARAMS[entity] ?? {};
    const idParam = `${entity}IDs`;
    const ignored: string[] = [];
    const predicates: Array<(r: Served) => boolean> = [];
    for (const [param, raw] of Object.entries(body)) {
      if (param === "officeIDs" || param === "officeID" || param === "includeData") continue; // scope is forced below [DOC]
      if (param === idParam) {
        const f = asFilter(raw);
        predicates.push((r) => compare(r.id, f));
      } else if (param in known) {
        const field = known[param];
        const f = asFilter(raw);
        predicates.push((r) => compare(fieldValue(r.current, field), f));
      } else if (param in ranges) {
        const { field, op } = ranges[param];
        predicates.push((r) => compare(fieldValue(r.current, field), { operator: op, value: raw }));
      } else {
        ignored.push(param);
      }
    }
    const fallback = DEFAULT_FILTERS[entity];
    if (fallback && !(fallback.param in body)) {
      const field = known[fallback.param];
      predicates.push((r) => compare(fieldValue(r.current, field), { operator: "IN", value: fallback.value }));
    }
    return { rows: rows.filter((r) => r.officeId === keyOffice && r.officeId > 0 && predicates.every((p) => p(r))), ignored };
  }
}

function fieldValue(payload: Record<string, unknown>, field: string): string | number | null {
  const value = payload[field];
  if (value === undefined) return FIELD_DEFAULTS[field] ?? null;
  return typeof value === "number" || typeof value === "string" ? value : null;
}

function asFilter(raw: unknown): Filter {
  if (raw && typeof raw === "object" && !Array.isArray(raw) && "operator" in raw) {
    const f = raw as { operator: unknown; value: unknown };
    return { operator: String(f.operator).toUpperCase(), value: f.value };
  }
  return Array.isArray(raw) ? { operator: "IN", value: raw } : { operator: "=", value: raw };
}

const OPERATORS = new Set(["=", "!=", ">", "<", ">=", "<=", "IN", "NOT IN", "BETWEEN", "LIKE", "STARTSWITH", "ENDSWITH", "CONTAINS"]);

/** Numbers compare numerically, everything else as strings — "YYYY-MM-DD HH:MM:SS" sorts as time [INF]. */
function compare(actual: string | number | null, filter: Filter): boolean {
  if (!OPERATORS.has(filter.operator)) throw new HttpFailure(400, `Unknown operator "${filter.operator}"`);
  if (actual === null) return false;
  const cmp = (expected: unknown): number => {
    const a = Number(actual);
    const b = Number(expected);
    if (String(actual).trim() !== "" && String(expected).trim() !== "" && Number.isFinite(a) && Number.isFinite(b)) return a - b;
    const sa = String(actual);
    const sb = String(expected);
    // A date-only bound against a datetime compares on the date part [INF].
    const left = /^\d{4}-\d{2}-\d{2}$/.test(sb) ? sa.slice(0, 10) : sa;
    return left < sb ? -1 : left > sb ? 1 : 0;
  };
  const list = (): unknown[] => {
    if (!Array.isArray(filter.value)) throw new HttpFailure(400, `${filter.operator} needs an array value`);
    return filter.value;
  };
  const text = String(actual).toLowerCase();
  const needle = String(filter.value).toLowerCase();
  switch (filter.operator) {
    case "=": return cmp(filter.value) === 0;
    case "!=": return cmp(filter.value) !== 0;
    case ">": return cmp(filter.value) > 0;
    case "<": return cmp(filter.value) < 0;
    case ">=": return cmp(filter.value) >= 0;
    case "<=": return cmp(filter.value) <= 0;
    case "IN": return list().some((v) => cmp(v) === 0);
    case "NOT IN": return !list().some((v) => cmp(v) === 0);
    case "BETWEEN": {
      const [lo, hi] = list();
      return cmp(lo) >= 0 && cmp(hi) <= 0;
    }
    case "LIKE": return new RegExp(`^${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`).test(text);
    case "STARTSWITH": return text.startsWith(needle);
    case "ENDSWITH": return text.endsWith(needle);
    default: return text.includes(needle);
  }
}

function idList(raw: unknown): number[] | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const values = Array.isArray(raw) ? raw : String(raw).split(",");
  const ids = values.map((v) => Number(v)).filter((n) => Number.isSafeInteger(n));
  return ids;
}

/** [DOC] get returns scalars as JSON strings; null stays null. */
function serialize(payload: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, typeof v === "number" ? String(v) : v]));
}

/** JSON, or form-urlencoded with bracket syntax: a[operator]=>&a[value][]=x [DOC]. */
async function readBody(request: Request): Promise<Record<string, unknown>> {
  const type = request.headers.get("content-type") ?? "";
  const text = await request.text();
  if (!text.trim()) return {};
  if (type.includes("application/x-www-form-urlencoded")) {
    const out: Record<string, unknown> = {};
    for (const [rawKey, value] of new URLSearchParams(text)) {
      const match = /^([^[\]]+)((?:\[[^\]]*\])*)$/.exec(rawKey);
      if (!match) continue;
      const keys = [match[1], ...[...match[2].matchAll(/\[([^\]]*)\]/g)].map((m) => m[1])];
      let node = out;
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        if (keys[i + 1] === "" && i + 2 === keys.length) {
          node[k] = [...((node[k] as unknown[] | undefined) ?? []), value]; // a[]=1&a[]=2
          break;
        }
        if (i === keys.length - 1) {
          node[k] = value;
          break;
        }
        node[k] = (node[k] as Record<string, unknown> | undefined) ?? {};
        node = node[k] as Record<string, unknown>;
      }
    }
    return out;
  }
  if (type.includes("xml")) throw new Error("XML bodies are not supported by this mock");
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Body must be a JSON object");
  return parsed as Record<string, unknown>;
}
