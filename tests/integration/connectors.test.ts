import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { RawRecord } from "@/lib/adapters/contract";
import { mapperFor, referenceContext } from "@/lib/adapters/registry";
import { getNow } from "@/lib/db";
import { BRANCH_BY_ID, BRANCH_BY_OFFICE } from "@/lib/reference";
import { instantToWallTime } from "@/lib/primitives";
import type { SourceRecordVersion } from "@/lib/sim/world";
import { getConnector, resolveCredentials } from "@/lib/connectors/config";
import { demoCredentials } from "@/lib/connectors/demo-keys";
import { AuthError, ProtocolError, RateLimitError, TimeoutError } from "@/lib/connectors/errors";
import { clearFaults, createFault, type FaultInput } from "@/lib/connectors/faults";
import { FieldRoutesHttpClient, parseRetryAfter } from "@/lib/connectors/fieldroutes-client";
import { FIELDROUTES_FIELD_MAP, specFor } from "@/lib/connectors/fieldroutes-mapping";
import { createMockFieldRoutes, dbFaultStore } from "@/lib/connectors/mock-fieldroutes";
import { CRM_ENTITIES, type ApiCallRecord, type CrmConnector, type CrmEntity } from "@/lib/connectors/types";
import { drainJobs } from "@/lib/jobs/kick";
import { cancelJob, enqueueSync, retryJob, runPendingJobs, type SyncRuntime } from "@/lib/jobs/sync";
import { VIEWERS } from "@/lib/viewer";
import { approveProposal, createProposal, dryRunProposal, executeProposal } from "@/lib/workflow/proposals";
import { acquisition, crm, freshDb, ingest, one, runReconcile, testPool } from "../helpers";

/**
 * The connector end to end, in-process: FieldRoutesHttpClient → (fetch = the mock handler) →
 * jobs → ingestRecords → projections. No network. Mock limits are shrunk (search 5, get 3) so
 * paging boundaries are cheap to hit; production defaults are 50,000 / 1,000.
 */

const pool: Pool = testPool();
const mapper = mapperFor("crm");
afterAll(async () => pool.end());

const SEARCH_LIMIT = 5;
const GET_LIMIT = 3;
const OFFICE_A = BRANCH_BY_ID.get("B01")!.crmOfficeId; // 101
const OFFICE_B = BRANCH_BY_ID.get("B02")!.crmOfficeId; // 102
const OFFICE_C = BRANCH_BY_ID.get("B03")!.crmOfficeId; // 103
const BRANCH_OF: Record<number, string> = { [OFFICE_A]: "B01", [OFFICE_B]: "B02", [OFFICE_C]: "B03" };
/** Inside the demo connector's first window (168 h before the 2026-10-31T13:00Z business clock). */
const RECENT = new Date("2026-10-30T15:00:00Z");
const minutes = (m: number) => m * 60_000;

// ── Fixture world ───────────────────────────────────────────────────────────

let world: SourceRecordVersion[] = [];
const version = (record: RawRecord, visibleAt: Date): SourceRecordVersion => ({
  stream: `crm.${record.entity}`,
  entity: record.entity,
  visibleAt: visibleAt.getTime(),
  payload: record.payload as Record<string, unknown>,
});
function addCustomers(officeId: number, n: number, firstId: number, at = RECENT): number[] {
  const ids: number[] = [];
  for (let k = 0; k < n; k++) {
    const id = firstId + k;
    const when = new Date(at.getTime() + minutes(k));
    world.push(version(crm.customer(id, BRANCH_OF[officeId], `+1212555${String(1000 + (id % 9000)).padStart(4, "0")}`, when), when));
    ids.push(id);
  }
  return ids;
}

// ── Harness ────────────────────────────────────────────────────────────────

let wall = new Date("2026-11-01T09:00:00Z");
let mock: (request: Request) => Promise<Response>;
const inProcessFetch: typeof fetch = async (input, init) => mock(new Request(input as string, init));

function makeMock(overrides: { rateLimit?: { perMinute: number; perDay: number } } = {}) {
  mock = createMockFieldRoutes({
    records: () => world,
    clock: () => getNow(pool),
    faults: dbFaultStore(pool),
    searchLimit: SEARCH_LIMIT,
    getLimit: GET_LIMIT,
    rateLimit: overrides.rateLimit ?? { perMinute: 10_000, perDay: 100_000 },
    wallNow: () => wall.getTime(),
  });
}

function client(opts: { onCall?: (c: ApiCallRecord) => void; timeoutMs?: number; credentials?: (officeId: number) => { key: string; token: string } } = {}) {
  return new FieldRoutesHttpClient({
    baseUrl: "http://localhost:3000/api/mock/fieldroutes",
    credentials: opts.credentials ?? demoCredentials,
    fetch: inProcessFetch,
    timeoutMs: opts.timeoutMs ?? 2_000,
    wireTimeZone: "office",
    officeTimeZone: (officeId) => BRANCH_BY_OFFICE.get(officeId)?.timezone,
    searchLimit: SEARCH_LIMIT,
    getLimit: GET_LIMIT,
    onCall: opts.onCall,
    now: () => wall,
  });
}

let connectorId = 0;
function runtime(opts: { workerId?: string; timeoutMs?: number; wrap?: (c: CrmConnector) => CrmConnector; credentials?: (officeId: number) => { key: string; token: string } } = {}): SyncRuntime {
  return {
    pool,
    clientFor: (connector, onCall) => {
      const credentials = opts.credentials ?? ((officeId: number) => {
        const r = resolveCredentials(connector, officeId, {});
        if (!r.credentials) throw new AuthError(`No credentials for office ${officeId}`);
        return r.credentials;
      });
      const c = client({ onCall, timeoutMs: opts.timeoutMs, credentials });
      return opts.wrap ? opts.wrap(c) : c;
    },
    now: () => wall,
    businessNow: () => getNow(pool),
    workerId: opts.workerId ?? "test-worker",
    random: () => 0.5,
    backoffBaseMs: 1_000,
  };
}

let keySeq = 0;
const sync = (officeIds: number[], entities: CrmEntity[] = ["customer"]) =>
  enqueueSync(pool, { connectorId, officeIds, entities, idempotencyKey: `test-request-${++keySeq}`, actor: "engineer", scope: null, now: wall, auditAt: wall });

const fault = (input: FaultInput) => createFault(pool, { input, actor: "engineer", now: wall, auditAt: wall });

const count = async (sql: string, params: unknown[] = []) => Number((await one<{ n: string }>(pool, sql, params)).n);
const job = (id: number) => one<{ state: string; attempts: number; last_error: string | null; last_error_kind: string | null; resume_after_id: string | null; stats: Record<string, number>; next_attempt_at: Date; window_end: Date }>(pool, "select * from sync_jobs where id = $1", [id]);
const calls = (jobId: number) => pool.query<{ action: string; status: number | null; id_count: number; ids: string[]; attempt: number; error_kind: string | null }>("select * from sync_api_calls where job_id = $1 order by id", [jobId]).then((r) => r.rows);
const checkpoint = (officeId: number, entity: CrmEntity = "customer") =>
  pool.query<{ cursor_at: Date; last_job_id: string }>("select * from sync_checkpoints where connector_id = $1 and office_id = $2 and entity = $3", [connectorId, officeId, entity]).then((r) => r.rows[0] ?? null);

beforeEach(async () => {
  await freshDb(pool);
  world = [];
  wall = new Date("2026-11-01T09:00:00Z");
  makeMock();
  connectorId = Number((await one<{ id: string }>(pool, "select id from connectors where slug = 'fieldroutes-demo'")).id);
});

// ── Contract: client ↔ mock ─────────────────────────────────────────────────

describe("FieldRoutes client and mock contract", () => {
  it("pages searches at the cap and batches gets at the limit (boundaries 4, 5, 6, 11)", async () => {
    const window = { updatedFrom: new Date("2026-10-30T00:00:00Z"), updatedTo: new Date("2026-10-31T13:00:00Z") };
    const trace: ApiCallRecord[] = [];
    const c = client({ onCall: (call) => trace.push(call) });
    const searchesFor = async (n: number) => {
      world = [];
      makeMock();
      trace.length = 0;
      const ids = addCustomers(OFFICE_A, n, 400_000);
      const found = await c.search("customer", { officeId: OFFICE_A, ...window });
      expect(found).toEqual(ids);
      return trace.filter((t) => t.action === "search").map((t) => t.idCount);
    };
    expect(await searchesFor(4)).toEqual([4]);
    expect(await searchesFor(5)).toEqual([5, 0]); // a full page means "maybe more"
    expect(await searchesFor(6)).toEqual([5, 1]);
    expect(await searchesFor(11)).toEqual([5, 5, 1]);

    trace.length = 0;
    const got = await c.get("customer", { officeId: OFFICE_A, ids: world.map((w) => Number(w.payload.customerID)) });
    expect(got.records).toHaveLength(11);
    expect(trace.map((t) => t.idCount)).toEqual([3, 3, 3, 2]);
    expect(got.missingIds).toEqual([]);
  });

  it("an office's key never reads another office", async () => {
    addCustomers(OFFICE_A, 2, 400_000);
    const bIds = addCustomers(OFFICE_B, 2, 500_000);
    const keyA = demoCredentials(OFFICE_A);
    const post = (path: string, body: unknown, creds: { key: string; token: string } | null = keyA) =>
      mock(new Request(`http://localhost:3000/api/mock/fieldroutes${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(creds ? { authenticationKey: creds.key, authenticationToken: creds.token } : {}) },
        body: JSON.stringify(body),
      }));

    // DOC: a standard key's officeIDs filter is forced to its own office.
    const search = await (await post("/customer/search", { officeIDs: [OFFICE_B] })).json();
    expect(search.customerIDs.every((id: number) => id < 500_000)).toBe(true);
    const get = await (await post("/customer/get", { customerIDs: bIds, officeIDs: [OFFICE_B] })).json();
    expect(get.customers).toEqual([]);

    expect((await post("/customer/search", {}, null)).status).toBe(401);
    expect((await post("/customer/search", {}, { key: keyA.key, token: "wrong" })).status).toBe(403);
    expect((await post("/customer/create", {})).status).toBe(403); // read-only
    expect((await mock(new Request("http://localhost:3000/api/mock/fieldroutes/customer/search"))).status).toBe(405);

    // A misconfigured credential (office A's key used for office B) syncs nothing into B.
    const c = client({ credentials: () => keyA });
    const ids = await c.search("customer", { officeId: OFFICE_B, updatedFrom: new Date("2026-10-30T00:00:00Z"), updatedTo: new Date("2026-10-31T13:00:00Z") });
    const got = await c.get("customer", { officeId: OFFICE_B, ids });
    expect(got.records).toEqual([]);
    expect(got.rejected.length).toBe(2); // office A's records, refused under office B's sync
  });

  it("asks for every appointment status explicitly; the source hides cancelled ones by default", async () => {
    const base = new Date("2026-10-30T15:00:00Z");
    world.push(version(crm.appointment(9001, 7001, 4001, "B01", "-1", base, base), base));
    world.push(version(crm.appointment(9002, 7002, 4002, "B01", "0", base, base), base));
    const ids = await client().search("appointment", { officeId: OFFICE_A, updatedFrom: new Date("2026-10-30T00:00:00Z"), updatedTo: new Date("2026-10-31T13:00:00Z") });
    expect(ids).toEqual([9001, 9002]);
    const k = demoCredentials(OFFICE_A);
    const raw = await (await mock(new Request("http://localhost:3000/api/mock/fieldroutes/appointment/search", {
      method: "POST", headers: { authenticationKey: k.key, authenticationToken: k.token, "content-type": "application/json" }, body: "{}",
    }))).json();
    expect(raw.appointmentIDs).toEqual([9002]);
  });

  it("classifies responses: ignored filters, 200 + success:false auth, Retry-After, unauthorised hosts", async () => {
    const stub = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      new FieldRoutesHttpClient({
        baseUrl: "http://localhost:9/api", credentials: demoCredentials, timeoutMs: 1_000, wireTimeZone: "office",
        officeTimeZone: () => "America/Chicago", now: () => wall,
        fetch: async () => new Response(JSON.stringify(body), { status, headers }),
      });
    await expect(stub(200, { success: true, officeIDs: [], ignoredParams: ["dateUpdated"] }).validateConnection(1)).rejects.toBeInstanceOf(ProtocolError);
    await expect(stub(200, { success: false, errorMessage: "Invalid authentication token" }).validateConnection(1)).rejects.toBeInstanceOf(AuthError);
    const limited = await stub(429, { success: false }, { "retry-after": "7" }).validateConnection(1).catch((e) => e);
    expect(limited).toBeInstanceOf(RateLimitError);
    expect((limited as RateLimitError).retryAfterMs).toBe(7_000);
    expect(parseRetryAfter(new Date(wall.getTime() + 5_000).toUTCString(), wall)).toBe(5_000);
    expect(() => new FieldRoutesHttpClient({ baseUrl: "https://acme.fieldroutes.com/api", credentials: demoCredentials, timeoutMs: 1, wireTimeZone: "office", officeTimeZone: () => undefined })).toThrow(AuthError);
  });
});

// ── Jobs ────────────────────────────────────────────────────────────────────

describe("sync jobs", () => {
  it("syncs through HTTP into the projections, then a repeat sync is absorbed as duplicates", async () => {
    addCustomers(OFFICE_A, 11, 400_000);
    const first = await sync([OFFICE_A]);
    const [outcome] = await runPendingJobs(runtime());
    expect(outcome).toMatchObject({ state: "succeeded", attempt: 1 });
    expect(await count("select count(*) n from crm_customers")).toBe(11);
    const j1 = await job(first.created[0]);
    expect(j1.stats).toMatchObject({ searched: 11, fetched: 11, inserted: 11, projected: 11, quarantined: 0, batches: 4 });
    expect((await calls(first.created[0])).map((c) => `${c.action}:${c.id_count}`)).toEqual(["search:5", "search:5", "search:1", "get:3", "get:3", "get:3", "get:2"]);
    expect((await checkpoint(OFFICE_A))!.cursor_at.getTime()).toBe(j1.window_end.getTime());

    const rawBefore = await count("select count(*) n from raw_events");
    const second = await sync([OFFICE_A]);
    await runPendingJobs(runtime());
    const j2 = await job(second.created[0]);
    // The 30-minute overlap re-reads only what changed near the checkpoint; nothing is new.
    expect(j2.state).toBe("succeeded");
    expect(j2.stats.inserted).toBe(0);
    expect(await count("select count(*) n from raw_events")).toBe(rawBefore);
    expect(await count("select count(*) n from crm_customers")).toBe(11);
    expect(await count("select count(*) n from audit_log where action = 'sync_job.succeeded'")).toBe(2);
  });

  it("re-reading an overlapping window absorbs duplicates: no new raw events, delivery counts rise", async () => {
    // Records inside the overlap of the second window (checkpoint − 30 min).
    addCustomers(OFFICE_A, 4, 400_000, new Date("2026-10-31T12:40:00Z"));
    await sync([OFFICE_A]);
    await runPendingJobs(runtime());
    const second = await sync([OFFICE_A]);
    await runPendingJobs(runtime());
    expect((await job(second.created[0])).stats).toMatchObject({ fetched: 4, inserted: 0, duplicates: 4 });
    expect(await count("select count(*) n from raw_events")).toBe(4);
    expect(await count("select count(*) n from raw_events where delivery_count = 2")).toBe(4);
  });

  it("enqueue is idempotent by key and refuses a reused key for a different request", async () => {
    const a = await enqueueSync(pool, { connectorId, officeIds: [OFFICE_A], entities: ["customer"], idempotencyKey: "same-key-001", actor: "engineer", scope: null, now: wall, auditAt: wall });
    const again = await enqueueSync(pool, { connectorId, officeIds: [OFFICE_A], entities: ["customer"], idempotencyKey: "same-key-001", actor: "engineer", scope: null, now: wall, auditAt: wall });
    expect(again.alreadyRequested).toBe(true);
    expect(again.jobs.map((j) => j.id)).toEqual(a.created);
    await expect(enqueueSync(pool, { connectorId, officeIds: [OFFICE_B], entities: ["customer"], idempotencyKey: "same-key-001", actor: "engineer", scope: null, now: wall, auditAt: wall }))
      .rejects.toMatchObject({ status: 409 });
    // A stream that already has a queued job is not queued twice.
    const other = await sync([OFFICE_A]);
    expect(other.created).toEqual([]);
    expect(other.reusedQueued).toEqual(a.created);
    // Branch scope is enforced server-side.
    await expect(enqueueSync(pool, { connectorId, officeIds: [OFFICE_B], entities: ["customer"], idempotencyKey: "scoped-key-01", actor: "partner", scope: ["B01"], now: wall, auditAt: wall }))
      .rejects.toMatchObject({ status: 403 });
  });

  it("rate limit → retry after Retry-After → resumes after the last committed batch", async () => {
    addCustomers(OFFICE_A, 7, 400_000);
    await fault({ kind: "rate_limit", officeId: OFFICE_A, entity: "customer", action: "get", skip: 1, remaining: 1, retryAfterSeconds: 30 });
    const { created: [id] } = await sync([OFFICE_A]);

    const [first] = await runPendingJobs(runtime());
    expect(first).toMatchObject({ state: "queued", errorKind: "rate_limit" });
    let j = await job(id);
    expect(j.next_attempt_at.getTime()).toBe(wall.getTime() + 30_000); // honoured Retry-After
    expect(Number(j.resume_after_id)).toBe(400_002); // batch 1 (3 records) committed
    expect(await count("select count(*) n from crm_customers")).toBe(3);
    expect(await checkpoint(OFFICE_A)).toBeNull(); // window not complete → no checkpoint

    wall = new Date(wall.getTime() + 10_000);
    expect(await runPendingJobs(runtime())).toEqual([]); // not due yet

    wall = new Date(wall.getTime() + 21_000);
    const [second] = await runPendingJobs(runtime());
    expect(second).toMatchObject({ state: "succeeded", attempt: 2 });
    j = await job(id);
    const attempt2 = (await calls(id)).filter((c) => c.attempt === 2);
    // Same window, only ids after the committed batch: nothing re-fetched.
    expect(attempt2.map((c) => `${c.action}:${c.id_count}`)).toEqual(["search:4", "get:3", "get:1"]);
    expect(await count("select count(*) n from crm_customers")).toBe(7);
    expect(await count("select count(*) n from raw_events")).toBe(7);
    expect(await count("select coalesce(sum(delivery_count), 0) n from raw_events")).toBe(7);
    expect((await checkpoint(OFFICE_A))!.cursor_at.getTime()).toBe(j.window_end.getTime());
  });

  it("an expired key fails the job at once with an actionable message and leaves the checkpoint alone", async () => {
    addCustomers(OFFICE_A, 2, 400_000);
    await sync([OFFICE_A]);
    await runPendingJobs(runtime());
    const before = await checkpoint(OFFICE_A);

    await fault({ kind: "expired_key", officeId: OFFICE_A, remaining: null });
    const { created: [id] } = await sync([OFFICE_A]);
    const outcomes = await runPendingJobs(runtime());
    expect(outcomes).toHaveLength(1); // not re-queued
    const j = await job(id);
    expect(j).toMatchObject({ state: "failed", attempts: 1, last_error_kind: "auth" });
    expect(j.last_error).toContain("FIELDROUTES_KEY_101");
    expect(j.last_error).toContain("Not retried");
    const after = await checkpoint(OFFICE_A);
    expect(after!.cursor_at.getTime()).toBe(before!.cursor_at.getTime());
    expect(after!.last_job_id).toBe(before!.last_job_id);
    expect((await calls(id)).map((c) => c.status)).toEqual([403]);

    // Fix the key, retry: a NEW job, linked to the failed one, which succeeds.
    await clearFaults(pool, { faultId: null, actor: "engineer", now: wall, auditAt: wall });
    const retry = await retryJob(pool, { jobId: id, actor: "engineer", idempotencyKey: "retry-key-001", scope: null, now: wall, auditAt: wall });
    expect(retry.retryOf).toBe(id);
    expect((await retryJob(pool, { jobId: id, actor: "engineer", idempotencyKey: "retry-key-001", scope: null, now: wall, auditAt: wall })).id).toBe(retry.id);
    await runPendingJobs(runtime());
    expect((await job(retry.id)).state).toBe("succeeded");
  });

  it("a timeout is retried and the next attempt succeeds", async () => {
    addCustomers(OFFICE_A, 2, 400_000);
    await fault({ kind: "timeout", officeId: OFFICE_A, action: "search", remaining: 1, delayMs: 400 });
    const { created: [id] } = await sync([OFFICE_A]);
    const [first] = await runPendingJobs(runtime({ timeoutMs: 50 }));
    expect(first).toMatchObject({ state: "queued", errorKind: "timeout" });
    expect((await job(id)).next_attempt_at.getTime()).toBe(wall.getTime() + 750); // 1 s base, jitter fixed at 0.5
    wall = new Date(wall.getTime() + 1_000);
    const [second] = await runPendingJobs(runtime({ timeoutMs: 50 }));
    expect(second).toMatchObject({ state: "succeeded", attempt: 2 });
    expect((await calls(id)).map((c) => c.error_kind)).toEqual(["timeout", null, null]);
  });

  it("503s back off exponentially and the job gives up after max attempts", async () => {
    addCustomers(OFFICE_A, 1, 400_000);
    await pool.query("update connectors set config = jsonb_set(config, '{maxAttempts}', '3') where id = $1", [connectorId]);
    await fault({ kind: "unavailable", officeId: OFFICE_A, remaining: null });
    const { created: [id] } = await sync([OFFICE_A]);
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      const [o] = await runPendingJobs(runtime());
      const j = await job(id);
      if (o.state === "queued") delays.push(j.next_attempt_at.getTime() - wall.getTime());
      wall = new Date(j.next_attempt_at.getTime() + 1);
    }
    expect(delays).toEqual([750, 1_500]); // base·2^(n−1) with jitter fixed at 0.5
    const j = await job(id);
    expect(j).toMatchObject({ state: "failed", attempts: 3, last_error_kind: "unavailable" });
    expect(j.last_error).toContain("gave up after 3 attempts");
    expect((await calls(id)).map((c) => c.status)).toEqual([503, 503, 503]);
  });

  it("a malformed amount quarantines that record only; the rest of the batch is ingested", async () => {
    const at = RECENT;
    for (let k = 0; k < 3; k++) {
      world.push(version(crm.ticket(3_000_000 + k, 400_000 + k, 2_000_000 + k, "B01", "149.00", at), at));
    }
    await fault({ kind: "malformed_record", officeId: OFFICE_A, entity: "ticket", recordId: 3_000_001, remaining: 1 });
    const { created: [id] } = await sync([OFFICE_A], ["ticket"]);
    await runPendingJobs(runtime());
    const j = await job(id);
    expect(j.state).toBe("succeeded");
    expect(j.stats).toMatchObject({ fetched: 3, projected: 2, quarantined: 1 });
    const q = await one<{ entity_id: string; error_code: string; error_detail: string }>(pool, "select entity_id, error_code, error_detail from raw_events where status = 'quarantined'");
    expect(q).toMatchObject({ entity_id: "3000001", error_code: "SCHEMA_VIOLATION" });
    expect(q.error_detail).toContain("ticket.total");
    expect(await count("select count(*) n from crm_tickets")).toBe(2);
  });

  it("a record without its timestamp is quarantined as INVALID_TIMESTAMP, not dropped", async () => {
    addCustomers(OFFICE_A, 3, 400_000);
    await fault({ kind: "missing_timestamp", officeId: OFFICE_A, entity: "customer", recordId: 400_001, remaining: 1 });
    const { created: [id] } = await sync([OFFICE_A]);
    await runPendingJobs(runtime());
    expect((await job(id)).stats).toMatchObject({ fetched: 3, projected: 2, quarantined: 1 });
    expect(await one(pool, "select error_code from raw_events where status = 'quarantined'")).toEqual({ error_code: "INVALID_TIMESTAMP" });
  });

  it("an older version delivered after a newer one never overwrites the projection", async () => {
    const created = new Date("2026-10-31T12:40:00Z");
    const done = new Date("2026-10-31T12:45:00Z");
    world.push(version(crm.appointment(9001, 7001, 4001, "B01", "0", done, created), created));
    world.push(version(crm.appointment(9001, 7001, 4001, "B01", "1", done, done), done));
    await sync([OFFICE_A], ["appointment"]);
    await runPendingJobs(runtime());
    const latest = await one<{ status: string; raw_event_id: string }>(pool, "select status, raw_event_id from crm_appointments where crm_appointment_id = 9001");
    expect(latest.status).toBe("completed");

    await fault({ kind: "out_of_order", officeId: OFFICE_A, entity: "appointment", remaining: 1 });
    const { created: [id] } = await sync([OFFICE_A], ["appointment"]);
    await runPendingJobs(runtime());
    expect((await job(id)).stats).toMatchObject({ fetched: 1, inserted: 1 }); // the stale version is logged…
    expect(await one(pool, "select status, raw_event_id from crm_appointments where crm_appointment_id = 9001")).toEqual(latest); // …but loses
    expect(await count("select count(*) n from raw_events where entity_id = '9001'")).toBe(2);
  });

  it("a record that disappears from search results is not deleted downstream", async () => {
    addCustomers(OFFICE_A, 3, 400_000, new Date("2026-10-31T12:40:00Z"));
    await sync([OFFICE_A]);
    await runPendingJobs(runtime());
    await fault({ kind: "disappeared_record", officeId: OFFICE_A, entity: "customer", recordId: 400_001, remaining: null });
    const { created: [id] } = await sync([OFFICE_A]);
    await runPendingJobs(runtime());
    const j = await job(id);
    expect(j.state).toBe("succeeded");
    expect(j.stats.searched).toBe(2);
    expect(await count("select count(*) n from crm_customers")).toBe(3);
    expect(await count("select count(*) n from crm_customers where crm_customer_id = 400001")).toBe(1);
  });

  it("concurrent runners claim every job exactly once", async () => {
    addCustomers(OFFICE_A, 4, 400_000);
    addCustomers(OFFICE_B, 4, 500_000);
    const { created } = await sync([OFFICE_A, OFFICE_B], [...CRM_ENTITIES]);
    expect(created).toHaveLength(10);
    const [a, b, c] = await Promise.all([
      runPendingJobs(runtime({ workerId: "worker-a" }), { concurrency: 2 }),
      runPendingJobs(runtime({ workerId: "worker-b" }), { concurrency: 2 }),
      runPendingJobs(runtime({ workerId: "worker-c" })),
    ]);
    const ran = [...a, ...b, ...c].map((o) => o.jobId).sort((x, y) => x - y);
    expect(ran).toEqual([...created].sort((x, y) => x - y));
    expect(await count("select count(*) n from sync_jobs where state = 'succeeded' and attempts = 1")).toBe(10);
    expect(await count("select count(*) n from audit_log where action = 'sync_job.started'")).toBe(10);
    expect(await count("select count(*) n from crm_customers")).toBe(8);
  });

  it("one office failing never blocks the others", async () => {
    addCustomers(OFFICE_A, 2, 400_000);
    addCustomers(OFFICE_B, 2, 500_000);
    addCustomers(OFFICE_C, 2, 600_000);
    await fault({ kind: "expired_key", officeId: OFFICE_B, remaining: null });
    await sync([OFFICE_A, OFFICE_B, OFFICE_C]);
    await runPendingJobs(runtime());
    const states = (await pool.query<{ office_id: number; state: string }>("select office_id, state from sync_jobs order by office_id")).rows;
    expect(states).toEqual([
      { office_id: OFFICE_A, state: "succeeded" },
      { office_id: OFFICE_B, state: "failed" },
      { office_id: OFFICE_C, state: "succeeded" },
    ]);
    expect((await pool.query("select office_id from crm_customers group by office_id order by office_id")).rows.map((r) => r.office_id)).toEqual([OFFICE_A, OFFICE_C]);
    expect(await checkpoint(OFFICE_B)).toBeNull();
  });

  it("cancellation: a queued job never runs; a running job stops between batches, checkpoint unchanged", async () => {
    addCustomers(OFFICE_A, 7, 400_000);
    const queued = await sync([OFFICE_A]);
    expect((await cancelJob(pool, { jobId: queued.created[0], actor: "engineer", scope: null, now: wall, auditAt: wall })).state).toBe("cancelled");
    expect(await runPendingJobs(runtime())).toEqual([]);
    await expect(cancelJob(pool, { jobId: queued.created[0], actor: "engineer", scope: null, now: wall, auditAt: wall })).rejects.toMatchObject({ status: 409 });

    const running = await sync([OFFICE_A]);
    const id = running.created[0];
    // Cancel arrives while the first batch is in flight.
    const wrap = (c: CrmConnector): CrmConnector => ({
      capabilities: () => c.capabilities(),
      validateConnection: (o) => c.validateConnection(o),
      listOffices: (o) => c.listOffices(o),
      search: (e, f) => c.search(e, f),
      get: async (e, r) => {
        const result = await c.get(e, r);
        await cancelJob(pool, { jobId: id, actor: "engineer", scope: null, now: wall, auditAt: wall });
        return result;
      },
    });
    const [outcome] = await runPendingJobs(runtime({ wrap }));
    expect(outcome.state).toBe("cancelled");
    expect(await count("select count(*) n from crm_customers")).toBe(3); // the committed batch stays
    expect(await checkpoint(OFFICE_A)).toBeNull();
    expect(await count("select count(*) n from audit_log where action in ('sync_job.cancel_requested', 'sync_job.cancelled')")).toBe(3);
    // Partner scope: a job outside the viewer's branches is "not found".
    await expect(cancelJob(pool, { jobId: id, actor: "partner", scope: ["B20"], now: wall, auditAt: wall })).rejects.toMatchObject({ status: 404 });
  });

  it("the demo connector's credentials come from env names; demo keys only for a local mock", async () => {
    const connector = (await getConnector(pool, connectorId, {}))!;
    expect(resolveCredentials(connector, OFFICE_A, {})).toMatchObject({ source: "demo" });
    expect(resolveCredentials(connector, OFFICE_A, { FIELDROUTES_KEY_101: "k", FIELDROUTES_TOKEN_101: "t" })).toMatchObject({ source: "env", credentials: { key: "k", token: "t" } });
    const remote = (await getConnector(pool, connectorId, { FIELDROUTES_MOCK_BASE_URL: "https://mock.example.test/api/mock/fieldroutes" }))!;
    expect(remote.baseUrlSource).toBe("env");
    expect(resolveCredentials(remote, OFFICE_A, {})).toMatchObject({ credentials: null, keyEnv: "FIELDROUTES_KEY_101", tokenEnv: "FIELDROUTES_TOKEN_101" });
    // Nothing secret is stored in the database.
    expect(JSON.stringify((await one(pool, "select config from connectors where id = $1", [connectorId])))).not.toMatch(/demo-office|token":"[a-f0-9]{8}/);
  });
});

// ── Worker takeover ─────────────────────────────────────────────────────────

/** A promise the test opens by hand, to hold a worker at a chosen point. */
function gate(): { open: () => void; opened: Promise<void> } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

/**
 * Wraps a client so its `nth` get call signals `reached`, then waits for `release` before it
 * goes to the source (or throws `lateError` instead): a worker stalled mid-window.
 */
function stallAtGet(nth: number, reached: () => void, release: Promise<void>, lateError: Error | null = null) {
  let gets = 0;
  return (c: CrmConnector): CrmConnector => ({
    capabilities: () => c.capabilities(),
    validateConnection: (o) => c.validateConnection(o),
    listOffices: (o) => c.listOffices(o),
    search: (e, f) => c.search(e, f),
    get: async (e, r) => {
      gets += 1;
      if (gets === nth) {
        reached();
        await release;
        if (lateError) throw lateError;
      }
      return c.get(e, r);
    },
  });
}

describe("worker takeover", () => {
  it.each([
    ["finishes its window", null],
    ["fails with a retryable error", new TimeoutError("FieldRoutes did not answer within 2000 ms")],
  ])("a worker presumed dead that later %s cannot write to the job another worker re-claimed", async (_, lateError) => {
    addCustomers(OFFICE_A, 7, 400_000); // gets of 3, 3, 1
    const { created: [id] } = await sync([OFFICE_A]);

    const aStalled = gate();
    const aRelease = gate();
    const runA = runPendingJobs(runtime({ workerId: "worker-a", wrap: stallAtGet(2, aStalled.open, aRelease.opened, lateError) }));
    await aStalled.opened; // A committed its first batch and hangs on the second get
    expect(await job(id)).toMatchObject({ state: "running", attempts: 1, claimed_by: "worker-a", resume_after_id: "400002" });

    wall = new Date(wall.getTime() + minutes(10)); // A's heartbeat is now stale
    const bStalled = gate();
    const bRelease = gate();
    const runB = runPendingJobs(runtime({ workerId: "worker-b", wrap: stallAtGet(1, bStalled.open, bRelease.opened) }));
    await bStalled.opened; // B re-queued the job, re-claimed it and hangs on its first get
    expect(await job(id)).toMatchObject({ state: "running", attempts: 2, claimed_by: "worker-b", resume_after_id: "400002" });

    // A wakes up while B holds the job: every write it attempts is fenced off.
    aRelease.open();
    const [a] = await runA;
    expect(a).toMatchObject({ jobId: id, attempt: 1, claimLost: true, state: "running" });
    expect(await job(id)).toMatchObject({ state: "running", attempts: 2, claimed_by: "worker-b", resume_after_id: "400002" });
    expect((await job(id)).stats).toMatchObject({ fetched: 3, batches: 1 });
    expect(await checkpoint(OFFICE_A)).toBeNull();

    bRelease.open();
    const [b] = await runB;
    expect(b).toMatchObject({ jobId: id, state: "succeeded", attempt: 2 });
    const done = await job(id);
    expect(done).toMatchObject({ state: "succeeded", attempts: 2, claimed_by: "worker-b" });
    expect(done.stats).toMatchObject({ fetched: 7, inserted: 7, duplicates: 0, batches: 3 });
    expect(await count("select count(*) n from crm_customers")).toBe(7);
    expect((await checkpoint(OFFICE_A))?.last_job_id).toBe(String(id));
    // Only the owner's outcome is recorded: one re-queue, one success, nothing from A.
    expect((await pool.query("select action from audit_log where action like 'sync_job.%' and action <> 'sync_job.started' order by id")).rows.map((r) => r.action)).toEqual([
      "sync_job.requeued",
      "sync_job.succeeded",
    ]);
  });

  it("a stale job is re-queued while attempts remain and fails at max_attempts instead of looping", async () => {
    addCustomers(OFFICE_A, 1, 400_000);
    addCustomers(OFFICE_B, 1, 500_000);
    // A worker claimed the job and died without a trace (no heartbeat since).
    const die = (id: number, attempt: number) =>
      pool.query("update sync_jobs set state = 'running', attempts = $2, started_at = $3, heartbeat_at = $3, claimed_by = 'dead-worker' where id = $1", [id, attempt, wall]);

    const { created: [retried] } = await sync([OFFICE_A]);
    await die(retried, 1);
    wall = new Date(wall.getTime() + minutes(10));
    expect(await runPendingJobs(runtime())).toMatchObject([{ jobId: retried, state: "succeeded", attempt: 2 }]);

    const { created: [exhausted] } = await sync([OFFICE_B]);
    await pool.query("update sync_jobs set max_attempts = 2 where id = $1", [exhausted]);
    await die(exhausted, 2);
    wall = new Date(wall.getTime() + minutes(10));
    expect(await runPendingJobs(runtime())).toEqual([]); // not re-queued, so nothing to run
    const failed = await job(exhausted);
    expect(failed).toMatchObject({ state: "failed", attempts: 2, last_error_kind: "worker_lost" });
    expect(failed.last_error).toMatch(/attempt 2 of 2/);
    expect(await count("select count(*) n from audit_log where action = 'sync_job.failed' and subject = $1", [`sync_job:${exhausted}`])).toBe(1);
    expect(await checkpoint(OFFICE_B)).toBeNull();
    // A person can still retry it once the cause is found.
    const again = await retryJob(pool, { jobId: exhausted, actor: "engineer", idempotencyKey: "retry-after-worker-loss", scope: null, now: wall, auditAt: wall });
    expect(again.state).toBe("queued");
  });
});

// ── Sync → reconciliation ───────────────────────────────────────────────────

describe("sync follow-up", () => {
  it("trigger_sync end to end: the drained job delivers the missing ticket and the case resolves with no manual reconcile", async () => {
    // A sale whose payment arrived before its ticket: the CRM has the ticket, we do not.
    const soldAt = new Date("2026-10-28T10:00:00Z");
    const sale = acquisition(1, "B01", "+12125550101", soldAt);
    const ticket = sale.crm.find((r) => r.entity === "ticket")!;
    await ingest(pool, "crm", sale.crm.filter((r) => r !== ticket));
    const businessNow = await getNow(pool);
    await runReconcile(pool, businessNow);
    const exception = await one<{ id: string }>(pool, "select id from exceptions where kind = 'payment_without_ticket' and status = 'open'");
    const exceptionId = Number(exception.id);
    world.push(version(ticket, new Date(soldAt.getTime() + 49 * 3_600_000))); // invoiced an hour after the visit

    const { engineer, approver } = VIEWERS;
    const params = { connectorId, officeId: OFFICE_A, entity: "ticket" };
    const proposal = await createProposal(pool, { exceptionId, kind: "trigger_sync", params, rationale: "Ask the CRM for the missing invoice", source: "human", actor: engineer, now: businessNow });
    expect((await dryRunProposal(pool, { proposalId: proposal.id, actor: engineer, now: businessNow })).status).toBe("dry_run_ok");
    await approveProposal(pool, { proposalId: proposal.id, actor: approver, reason: "Read-only sync of one office", now: businessNow });
    const { execution } = await executeProposal(pool, { proposalId: proposal.id, actor: approver, now: businessNow });
    expect(execution.status, execution.error ?? "").toBe("succeeded");
    expect((await one(pool, "select state from cases where exception_id = $1", [exceptionId])).state).toBe("verified");

    // What the API's after() kick does — no reconcile call anywhere in this test.
    await drainJobs(pool, runtime());

    expect(await one(pool, "select state from sync_jobs where id = $1", [Number(execution.result?.jobId)])).toEqual({ state: "succeeded" });
    expect(await count("select count(*) n from crm_tickets where crm_ticket_id = $1", [sale.ticketId])).toBe(1);
    expect((await one(pool, "select status from exceptions where id = $1", [exceptionId])).status).toBe("resolved");
    expect((await one(pool, "select state from cases where exception_id = $1", [exceptionId])).state).toBe("resolved");
  });
});

// ── Mapping spec ────────────────────────────────────────────────────────────

describe("FieldRoutes mapping spec", () => {
  const SAMPLES: Record<CrmEntity, RawRecord> = {
    customer: crm.customer(400_001, "B01", "+12125551234", RECENT, { email: "a@example.com" }),
    subscription: crm.subscription(700_001, 400_001, "B01", RECENT, { soldBy: "1234" }),
    appointment: crm.appointment(2_000_001, 700_001, 400_001, "B01", "1", RECENT, RECENT),
    ticket: crm.ticket(3_000_001, 400_001, 2_000_001, "B01", "149.00", RECENT),
    payment: crm.payment(5_000_001, 400_001, 3_000_001, "B01", "149.00", RECENT),
  };
  const outcome = (record: RawRecord) => JSON.stringify([mapper.identify(record, referenceContext), mapper.map(record, referenceContext)]);

  /** Every property the mapper reads from the payload, observed through a Proxy. */
  function fieldsRead(record: RawRecord): Set<string> {
    const read = new Set<string>();
    const payload = new Proxy(record.payload as Record<string, unknown>, {
      get(target, prop, receiver) {
        if (typeof prop === "string") read.add(prop);
        return Reflect.get(target, prop, receiver);
      },
    });
    mapper.identify({ entity: record.entity, payload }, referenceContext);
    mapper.map({ entity: record.entity, payload }, referenceContext);
    const NOT_FIELDS = new Set(["then", "constructor", "toJSON", "valueOf", "toString", "length", "__proto__"]);
    return new Set([...read].filter((p) => !NOT_FIELDS.has(p) && !p.startsWith("~") && !p.startsWith("_")));
  }

  it.each(CRM_ENTITIES)("%s: the spec lists exactly the fields the mapper reads", (entity) => {
    expect(SAMPLES[entity].payload).toBeTruthy();
    expect(mapper.map(SAMPLES[entity], referenceContext).ok).toBe(true);
    const spec = new Set(specFor(entity).map((s) => s.field));
    expect([...fieldsRead(SAMPLES[entity])].sort()).toEqual([...spec].sort());
  });

  it.each(CRM_ENTITIES)("%s: every spec'd field changes the mapper's outcome when it is removed", (entity) => {
    const baseline = outcome(SAMPLES[entity]);
    for (const spec of specFor(entity)) {
      const payload = { ...(SAMPLES[entity].payload as Record<string, unknown>) };
      delete payload[spec.field];
      expect(outcome({ entity, payload }), `${entity}.${spec.field} is not actually used`).not.toBe(baseline);
    }
  });

  it("every spec entry is complete and every deviation is explained", () => {
    for (const s of FIELDROUTES_FIELD_MAP) {
      expect(s.target && s.transform && s.rule, `${s.entity}.${s.field}`).toBeTruthy();
      if (s.evidence === "deviation") expect(s.deviation, `${s.entity}.${s.field}`).toBeTruthy();
    }
  });
});

// ── The real synthetic world ────────────────────────────────────────────────

describe("mock backed by the synthetic world", () => {
  it("serves the latest visible version of each record in the shape the mapper accepts", async () => {
    const { generateWorld } = await import("@/lib/sim/world");
    const all = generateWorld().records;
    world = all;
    makeMock();
    const now = await getNow(pool);
    const officeId = OFFICE_A;
    const c = client();
    const ids = await c.search("appointment", { officeId, updatedFrom: new Date(now.getTime() - 48 * 3_600_000), updatedTo: now });
    expect(ids.length).toBeGreaterThan(0);
    const got = await c.get("appointment", { officeId, ids: ids.slice(0, 50) });
    for (const r of got.records) {
      const p = r.payload as Record<string, string>;
      const latest = all
        .filter((v) => v.entity === "appointment" && v.payload.appointmentID === p.appointmentID && v.visibleAt <= now.getTime())
        .sort((x, y) => x.visibleAt - y.visibleAt)
        .at(-1)!;
      expect(p).toEqual(latest.payload);
      expect(mapper.map(r, referenceContext).ok).toBe(true);
      expect(p.dateUpdated <= instantToWallTime(now, BRANCH_BY_OFFICE.get(officeId)!.timezone)).toBe(true);
    }
  }, 120_000);
});
