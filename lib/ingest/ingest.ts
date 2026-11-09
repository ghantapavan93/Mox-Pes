import type { Pool } from "pg";
import { withTransaction, type Queryable } from "@/lib/db";
import { payloadHash } from "@/lib/primitives";
import type { MapContext, MapResult, RawRecord, RecordIdentity, SourceClient, SourceMapper, SourceName } from "@/lib/adapters/contract";
import { redactValue } from "@/lib/adapters/redact";
import { isFailure } from "@/lib/adapters/validation";
import { recordEvent } from "@/lib/events/outbox";
import { projectAll, type ProjectionItem } from "./project";

export interface IngestStats {
  fetched: number;
  inserted: number;
  duplicates: number;
  conflicts: number;
  projected: number;
  quarantined: number;
}

interface Prepared {
  identity: RecordIdentity;
  payload: unknown;
  hash: string;
  result: MapResult;
  /** Our clock for this delivery; within a batch it preserves delivery order. */
  receivedAt: Date;
}

const MIN_INSTANT = Date.parse("1970-01-01T00:00:00Z");
const MAX_INSTANT = Date.parse("2100-01-01T00:00:00Z");

/** Redact first, then identify and map. Nothing downstream ever sees raw PII. */
export function prepare(record: RawRecord, mapper: SourceMapper, ctx: MapContext, now: Date): Prepared {
  const receivedAt = ctx.receivedAt ?? now;
  const payload = redactValue(record.payload);
  const hash = payloadHash(payload);
  const redacted: RawRecord = { entity: record.entity, payload };
  const identified = mapper.identify(redacted, ctx);
  // An identity must be storable: an instant Postgres and every report can represent.
  const identity =
    !isFailure(identified) && !(identified.occurredAt.getTime() >= MIN_INSTANT && identified.occurredAt.getTime() < MAX_INSTANT)
      ? { ok: false as const, code: "INVALID_TIMESTAMP", detail: `${record.entity}: source time outside 1970–2100` }
      : identified;
  if (isFailure(identity)) {
    // Unidentifiable records are still kept (quarantined), keyed by content.
    return {
      identity: { entity: record.entity, entityId: "unidentified", externalId: `${record.entity}:unidentified:${hash}`, occurredAt: now, versionClock: "received" },
      payload,
      hash,
      result: identity,
      receivedAt,
    };
  }
  return { identity, payload, hash, result: mapper.map(redacted, ctx), receivedAt };
}

/**
 * Database errors that belong to ONE record (bad data: SQLSTATE class 22, constraint: 23)
 * may quarantine that record. Anything else — lock timeouts, deadlocks, serialization
 * failures, lost connections — is transient: the run fails and the next run retries.
 */
export function isRecordLevelError(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" && (code.startsWith("22") || code.startsWith("23"));
}

/**
 * Writes one batch of deliveries exactly once. Must run inside a transaction.
 *
 *   new (source, external_id)            → raw event inserted, projected or quarantined
 *   seen, same payload hash              → duplicate delivery: delivery_count + 1; for
 *                                          clock-less records it is also the LATEST
 *                                          observation, so it is re-projected if another
 *                                          version is currently live (A -> B -> A)
 *   seen, different payload hash         → payload_conflict exception; stored version kept
 *                                          (in the same batch or across batches)
 *   a record whose projection fails      → quarantined as PROJECTION_FAILED; it never
 *                                          blocks the rest of its batch
 */
export async function ingestRecords(
  tx: Queryable,
  args: { source: SourceName; records: RawRecord[]; mapper: SourceMapper; ctx: MapContext; runId: number | null; now: Date },
): Promise<IngestStats> {
  const { source, records, mapper, runId, now } = args;
  const stats: IngestStats = { fetched: records.length, inserted: 0, duplicates: 0, conflicts: 0, projected: 0, quarantined: 0 };

  const prepared = new Map<string, Prepared>();
  const repeatsInBatch = new Map<string, number>();
  const inBatchConflicts: Prepared[] = [];
  for (const [index, record] of records.entries()) {
    // Delivery order inside a batch is receipt order: record i is received i ms after record 0.
    const p = prepare(record, mapper, { ...args.ctx, receivedAt: new Date(now.getTime() + index) }, now);
    const existing = prepared.get(p.identity.externalId);
    if (!existing) prepared.set(p.identity.externalId, p);
    else if (existing.hash === p.hash) repeatsInBatch.set(p.identity.externalId, (repeatsInBatch.get(p.identity.externalId) ?? 0) + 1);
    else inBatchConflicts.push(p); // same version, different content in one batch: keep the first, record the second
  }
  if (prepared.size === 0) return stats;

  const rows = [...prepared.values()].map((p) => ({
    entity: p.identity.entity,
    entityId: p.identity.entityId,
    externalId: p.identity.externalId,
    payload: p.payload,
    payloadHash: p.hash,
    occurredAt: p.identity.occurredAt.toISOString(),
    status: p.result.ok ? "projected" : "quarantined",
    errorCode: p.result.ok ? null : p.result.code,
    errorDetail: p.result.ok ? null : p.result.detail,
    deliveryCount: 1 + (repeatsInBatch.get(p.identity.externalId) ?? 0),
    receivedAt: p.receivedAt.toISOString(),
  }));

  const inserted = await insertRaw(tx, { source, now, runId, adapterVersion: `${source}@${mapper.version}`, rows });
  for (const externalId of inserted.unstorable) {
    const p = prepared.get(externalId)!;
    p.result = { ok: false, code: "UNSTORABLE_PAYLOAD", detail: "payload could not be stored as received" };
  }
  const insertedIds = new Map(inserted.rows.map((r) => [r.external_id, Number(r.id)]));
  stats.inserted = insertedIds.size;
  stats.duplicates = [...repeatsInBatch.values()].reduce((a, b) => a + b, 0);

  // Already-seen versions: duplicate delivery or conflicting content.
  const seen = [...prepared.keys()].filter((id) => !insertedIds.has(id));
  const reobserved: ProjectionItem[] = [];
  if (seen.length > 0) {
    const existing = await tx.query<{ id: string; external_id: string; payload_hash: string; status: string }>(
      "select id, external_id, payload_hash, status from raw_events where source = $1 and external_id = any($2::text[])",
      [source, seen],
    );
    const duplicateIds: number[] = [];
    for (const row of existing.rows) {
      const incoming = prepared.get(row.external_id)!;
      if (incoming.hash === row.payload_hash) {
        duplicateIds.push(Number(row.id));
        stats.duplicates += 1 + (repeatsInBatch.get(row.external_id) ?? 0);
        if (incoming.identity.versionClock === "received" && incoming.result.ok && row.status === "projected") {
          // Upserts skip rows already pointing at this raw event, so an unchanged re-read
          // costs nothing; an A -> B -> A flip restores A.
          reobserved.push({ projection: incoming.result.projection, rawEventId: Number(row.id) });
        }
      } else {
        stats.conflicts += 1;
        await recordPayloadConflict(tx, { source, rawEventId: Number(row.id), externalId: row.external_id, incoming, now });
      }
    }
    if (duplicateIds.length > 0) {
      await tx.query(
        "update raw_events set delivery_count = delivery_count + 1, last_delivered_at = $2 where id = any($1::bigint[])",
        [duplicateIds, now],
      );
    }
  }

  for (const p of inBatchConflicts) {
    const storedId = insertedIds.get(p.identity.externalId) ?? (await rawEventId(tx, source, p.identity.externalId));
    stats.conflicts += 1;
    if (storedId !== null) await recordPayloadConflict(tx, { source, rawEventId: storedId, externalId: p.identity.externalId, incoming: p, now });
  }

  const items: ProjectionItem[] = [];
  for (const [externalId, rawEventId] of insertedIds) {
    const p = prepared.get(externalId)!;
    if (p.result.ok) items.push({ projection: p.result.projection, rawEventId });
    else stats.quarantined += 1;
  }
  const failed = await projectIsolated(tx, [...items, ...reobserved]);
  for (const f of failed) {
    await tx.query(
      "update raw_events set status = 'quarantined', error_code = 'PROJECTION_FAILED', error_detail = $2, projected_at = null where id = $1",
      [f.rawEventId, f.message.slice(0, 500)],
    );
  }
  const failedIds = new Set(failed.map((f) => f.rawEventId));
  const projected = items.filter((i) => !failedIds.has(i.rawEventId)).length;
  stats.quarantined += items.length - projected;
  stats.projected = projected;
  // Published with the batch, in its transaction. An unchanged re-read publishes nothing, so
  // a quiet poll never wakes the consumers.
  if (stats.inserted > 0 || stats.conflicts > 0) {
    await recordEvent(tx, {
      type: "intake.records_stored",
      subject: `source:${source}`,
      occurredAt: now,
      payload: { source, mapperVersion: `${source}@${mapper.version}`, runId, inserted: stats.inserted, projected: stats.projected, quarantined: stats.quarantined, conflicts: stats.conflicts },
    });
  }
  return stats;
}

type RawRow = Record<string, unknown> & { externalId: string };

const INSERT_RAW = `
  insert into raw_events (source, entity, entity_id, external_id, payload, payload_hash, occurred_at, received_at,
    ingestion_run_id, adapter_version, status, error_code, error_detail, delivery_count, last_delivered_at, projected_at)
  select $1, r."entity", r."entityId", r."externalId", r."payload", r."payloadHash", r."occurredAt", r."receivedAt",
    $3, $4, r."status", r."errorCode", r."errorDetail", r."deliveryCount", $2,
    case when r."status" = 'projected' then $2::timestamptz end
  from jsonb_to_recordset($5::jsonb) as r("entity" text, "entityId" text, "externalId" text, "payload" jsonb,
    "payloadHash" text, "occurredAt" timestamptz, "receivedAt" timestamptz, "status" text, "errorCode" text,
    "errorDetail" text, "deliveryCount" int)
  on conflict (source, external_id) do nothing
  returning id, external_id`;

/**
 * Inserts the batch into the raw log set-based. If the database refuses the batch (a value
 * Postgres cannot store), retries row by row; a row that still cannot be stored is kept as a
 * quarantined placeholder, so one record never blocks its batch or its stream's cursor.
 */
async function insertRaw(
  tx: Queryable,
  args: { source: string; now: Date; runId: number | null; adapterVersion: string; rows: RawRow[] },
): Promise<{ rows: Array<{ id: string; external_id: string }>; unstorable: string[] }> {
  const params = (rows: RawRow[]) => [args.source, args.now, args.runId, args.adapterVersion, JSON.stringify(rows)];
  await tx.query("savepoint raw_batch");
  try {
    const all = await tx.query<{ id: string; external_id: string }>(INSERT_RAW, params(args.rows));
    await tx.query("release savepoint raw_batch");
    return { rows: all.rows, unstorable: [] };
  } catch (error) {
    await tx.query("rollback to savepoint raw_batch");
    if (!isRecordLevelError(error)) throw error;
  }
  const out: Array<{ id: string; external_id: string }> = [];
  const unstorable: string[] = [];
  for (const row of args.rows) {
    await tx.query("savepoint raw_one");
    try {
      out.push(...(await tx.query<{ id: string; external_id: string }>(INSERT_RAW, params([row]))).rows);
      await tx.query("release savepoint raw_one");
    } catch (error) {
      await tx.query("rollback to savepoint raw_one");
      if (!isRecordLevelError(error)) throw error;
      const placeholder = {
        ...row,
        payload: { unstorable: true },
        status: "quarantined",
        errorCode: "UNSTORABLE_PAYLOAD",
        errorDetail: (error as Error).message.slice(0, 300),
        occurredAt: args.now.toISOString(),
      };
      out.push(...(await tx.query<{ id: string; external_id: string }>(INSERT_RAW, params([placeholder]))).rows);
      unstorable.push(row.externalId);
      console.warn(JSON.stringify({ level: "warn", msg: "unstorable payload quarantined", source: args.source, externalId: row.externalId }));
    }
  }
  return { rows: out, unstorable };
}

async function rawEventId(tx: Queryable, source: string, externalId: string): Promise<number | null> {
  const { rows } = await tx.query<{ id: string }>("select id from raw_events where source = $1 and external_id = $2", [source, externalId]);
  return rows[0] ? Number(rows[0].id) : null;
}

/**
 * Projects a batch set-based; if the database rejects it, retries record by record inside
 * savepoints so one bad record is isolated instead of aborting the whole batch (and, for
 * polling, stalling the stream's cursor forever).
 */
async function projectIsolated(tx: Queryable, items: ProjectionItem[]): Promise<Array<{ rawEventId: number; message: string }>> {
  if (items.length === 0) return [];
  await tx.query("savepoint project_batch");
  try {
    await projectAll(tx, items);
    await tx.query("release savepoint project_batch");
    return [];
  } catch (error) {
    await tx.query("rollback to savepoint project_batch");
    if (!isRecordLevelError(error)) throw error;
  }
  const failed: Array<{ rawEventId: number; message: string }> = [];
  for (const item of items) {
    await tx.query("savepoint project_one");
    try {
      await projectAll(tx, [item]);
      await tx.query("release savepoint project_one");
    } catch (error) {
      await tx.query("rollback to savepoint project_one");
      if (!isRecordLevelError(error)) throw error; // transient: fail the run, retry next run
      failed.push({ rawEventId: item.rawEventId, message: (error as Error).message });
      console.warn(JSON.stringify({ level: "warn", msg: "projection failed; record quarantined", rawEventId: item.rawEventId }));
    }
  }
  return failed;
}

async function recordPayloadConflict(
  tx: Queryable,
  args: { source: string; rawEventId: number; externalId: string; incoming: Prepared; now: Date },
): Promise<void> {
  const { source, rawEventId, externalId, incoming, now } = args;
  await tx.query(
    `insert into exceptions (kind, severity, fingerprint, branch_id, subject_type, subject_id, summary, evidence,
       first_detected_at, last_detected_at)
     values ('payload_conflict', 'medium', $1, null, 'raw_event', $2, $3, $4, $5, $5)
     on conflict (fingerprint) do update set last_detected_at = excluded.last_detected_at,
       evidence = exceptions.evidence || jsonb_build_object('deliveries', coalesce((exceptions.evidence->>'deliveries')::int, 1) + 1)`,
    [
      `payload_conflict:${source}:${externalId}`,
      String(rawEventId),
      `${source} sent two different payloads for the same record version ${externalId}`,
      JSON.stringify({ externalId, storedRawEventId: rawEventId, incomingPayload: incoming.payload, incomingHash: incoming.hash, deliveries: 1 }),
      now,
    ],
  );
}

/**
 * One polling run for one stream. The run row is written outside the data transaction
 * so a failed run is still recorded. The cursor only advances when the run commits.
 */
export async function runStream(
  pool: Pool,
  args: { client: SourceClient; mapper: SourceMapper; ctx: MapContext; now: Date; windowEnd: Date; overlapMs: number; initialCursor: Date },
): Promise<{ runId: number; status: "succeeded" | "failed"; stats?: IngestStats; error?: string }> {
  const { client, mapper, ctx, now, windowEnd, overlapMs, initialCursor } = args;
  const cursorRow = await pool.query<{ cursor_at: Date }>("select cursor_at from source_cursors where stream = $1", [client.stream]);
  const cursor = cursorRow.rows[0]?.cursor_at ?? initialCursor;
  const from = new Date(cursor.getTime() - overlapMs);

  const run = await pool.query<{ id: string }>(
    `insert into ingestion_runs (source, stream, adapter_version, window_start, window_end, started_at)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [client.source, client.stream, `${client.source}@${mapper.version}`, from, windowEnd, now],
  );
  const runId = Number(run.rows[0].id);

  try {
    const records = await client.fetchChanges({ from, to: windowEnd });
    const stats = await withTransaction(pool, async (tx) => {
      const s = await ingestRecords(tx, { source: client.source, records, mapper, ctx, runId, now });
      await tx.query(
        `insert into source_cursors (stream, cursor_at, updated_at) values ($1, $2, $3)
         on conflict (stream) do update set cursor_at = greatest(source_cursors.cursor_at, excluded.cursor_at),
           updated_at = excluded.updated_at`,
        [client.stream, windowEnd, now],
      );
      return s;
    });
    await pool.query(
      `update ingestion_runs set status = 'succeeded', finished_at = $2, fetched = $3, inserted = $4, duplicates = $5,
         conflicts = $6, projected = $7, quarantined = $8 where id = $1`,
      [runId, now, stats.fetched, stats.inserted, stats.duplicates, stats.conflicts, stats.projected, stats.quarantined],
    );
    return { runId, status: "succeeded", stats };
  } catch (error) {
    const message = (error as Error).message;
    await pool.query("update ingestion_runs set status = 'failed', finished_at = $2, error = $3 where id = $1", [runId, now, message]);
    return { runId, status: "failed", error: message };
  }
}
