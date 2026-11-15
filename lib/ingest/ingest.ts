import type { Pool } from "pg";
import { withTransaction, type Queryable } from "@/lib/db";
import { formatCents, payloadHash } from "@/lib/primitives";
import { isExclusion, type MapContext, type MapExclusion, type MapFailure, type MapResult, type RawRecord, type RecordIdentity, type SourceClient, type SourceMapper, type SourceName } from "@/lib/adapters/contract";
import { redactValue } from "@/lib/adapters/redact";
import { isFailure } from "@/lib/adapters/validation";
import { recordEvent } from "@/lib/events/outbox";
import { lockCurrencyShared } from "@/lib/currency/coverage";
import { projectAll, type ProjectionItem } from "./project";

export interface IngestStats {
  fetched: number;
  /** Record versions stored for the first time, whether or not they became the accepted version. */
  inserted: number;
  duplicates: number;
  conflicts: number;
  /** Stored versions handed to the projection; one older than the accepted version changes nothing. */
  projected: number;
  quarantined: number;
  /** Records the source itself marks as not counted (e.g. outbound or spam calls); kept as evidence. */
  excluded?: number;
  /**
   * Writes and removals of accepted records (the rows every metric reads): versions that became the
   * accepted one, earlier versions accepted again, exclusions applied, spend the currency gate
   * removed. 0 when the delivery changed nothing, whatever it stored.
   */
  rowsChanged: number;
}

interface Prepared {
  identity: RecordIdentity;
  payload: unknown;
  hash: string;
  result: MapResult;
  /** Our clock for this delivery; within a batch it preserves delivery order. */
  receivedAt: Date;
  /**
   * When this exact version was LAST observed (a repeat later in the same batch moves it).
   * Stored as raw_events.last_delivered_at, so the ledger alone orders every observation and a
   * rebuild from it reproduces the projection exactly (tests/integration/ledger-model.test.ts).
   */
  lastSeenAt?: Date;
  /** No observation of this version in the batch took effect: it was held (see `heldPaymentObservations`). */
  held?: boolean;
}

/** A payment version as the fold below sees it: which version, when first received, what it counts. */
interface PaymentState {
  externalId: string;
  firstReceivedAt: number;
  status: string;
  amountCents: number;
  /** Everything but the status: amount, payment date, ticket, customer, office, original payment. */
  content: string;
}

const paymentContent = (r: { amountCents: unknown; paidAt: unknown; crmTicketId: unknown; crmCustomerId: unknown; officeId: unknown; originalPaymentId: unknown }) =>
  JSON.stringify([Number(r.amountCents), r.paidAt instanceof Date ? r.paidAt.toISOString() : String(r.paidAt), String(r.crmTicketId ?? null), String(r.crmCustomerId), String(r.officeId), String(r.originalPaymentId ?? null)]);

/** Cash a payment version counts: its amount when successful (a refund is negative), else nothing. */
const countedCents = (s: Pick<PaymentState, "status" | "amountCents">) => (s.status === "successful" ? s.amountCents : 0);

/** Why one delivery of an earlier payment version did not take effect. */
interface HeldObservation {
  live: PaymentState;
  incoming: PaymentState;
}

/**
 * R-37 · an earlier payment version observed again never adds cash back silently.
 *
 * Payments are ordered by observation (FieldRoutes sends no `dateUpdated`): a NEW version a poll
 * returns is the vendor's current state and applies, a correction after a void included. What
 * the ledger cannot tell apart is a stale replica re-serving an earlier version (the mock's
 * `out_of_order` fault) from a real reversal. So a version that would raise the payment's counted
 * cash is held when it is
 *   (a) a version first received BEFORE the live one, seen again (successful again after a void,
 *       a larger amount after a correction, a smaller refund), or
 *   (b) the live VOIDED version with only its status put back: a void reverted with nothing else
 *       changed, which is what a replica serving the pre-void version (never seen here) sends.
 * Held: the delivery is counted, the live state stays, and a person sees the conflict. A new
 * version that also changes what was paid (amount, date) is a correction and applies. One that
 * lowers cash (a void seen again) applies: overstating cash is the error that must not pass unseen.
 *
 * Returns the held observations by their index in the batch. The live payments are locked first,
 * in id order and before any raw event is written, so two batches folding the same payment run
 * one after the other.
 */
async function heldPaymentObservations(tx: Queryable, source: SourceName, observations: readonly Prepared[]): Promise<Map<number, HeldObservation>> {
  const held = new Map<number, HeldObservation>();
  if (source !== "crm") return held;
  type Row = { status: string; amountCents: number; paidAt: Date; crmTicketId: number | null; crmCustomerId: number; officeId: number; originalPaymentId: number | null };
  const payments = observations.flatMap((p, index) =>
    p.identity.entity === "payment" && p.identity.versionClock === "received" && p.result.ok && p.result.projection.table === "crm_payments"
      ? [{ p, index, row: p.result.projection.row as Row }]
      : [],
  );
  if (payments.length === 0) return held;
  const ids = [...new Set(payments.map(({ p }) => p.identity.entityId))].map(Number).sort((a, b) => a - b);
  const live = await tx.query<{ id: string; status: string; amount_cents: string; paid_at: Date; crm_ticket_id: string | null; crm_customer_id: string; office_id: number; original_payment_id: string | null; external_id: string; received_at: Date }>(
    `select cp.crm_payment_id as id, cp.status, cp.amount_cents, cp.paid_at, cp.crm_ticket_id, cp.crm_customer_id, cp.office_id,
            cp.original_payment_id, re.external_id, re.received_at
     from crm_payments cp join raw_events re on re.id = cp.raw_event_id
     where cp.crm_payment_id = any($1::bigint[]) order by cp.crm_payment_id for update of cp`,
    [ids],
  );
  const stored = await tx.query<{ external_id: string; received_at: Date }>(
    "select external_id, received_at from raw_events where source = 'crm' and external_id = any($1::text[])",
    [[...new Set(payments.map(({ p }) => p.identity.externalId))]],
  );
  const firstReceived = new Map(stored.rows.map((r) => [r.external_id, r.received_at.getTime()]));
  const current = new Map<string, PaymentState>(
    live.rows.map((r) => [
      r.id,
      {
        externalId: r.external_id,
        firstReceivedAt: r.received_at.getTime(),
        status: r.status,
        amountCents: Number(r.amount_cents),
        content: paymentContent({ amountCents: r.amount_cents, paidAt: r.paid_at, crmTicketId: r.crm_ticket_id, crmCustomerId: r.crm_customer_id, officeId: r.office_id, originalPaymentId: r.original_payment_id }),
      },
    ]),
  );
  for (const { p, index, row } of payments) {
    if (!firstReceived.has(p.identity.externalId)) firstReceived.set(p.identity.externalId, p.receivedAt.getTime());
    const incoming: PaymentState = { externalId: p.identity.externalId, firstReceivedAt: firstReceived.get(p.identity.externalId)!, status: row.status, amountCents: Number(row.amountCents), content: paymentContent(row) };
    const now = current.get(p.identity.entityId);
    const addsCash = now !== undefined && now.externalId !== incoming.externalId && countedCents(incoming) > countedCents(now);
    const earlier = addsCash && incoming.firstReceivedAt < now.firstReceivedAt;
    const voidReverted = addsCash && now.status === "voided" && incoming.content === now.content;
    if (now && (earlier || voidReverted)) {
      held.set(index, { live: now, incoming });
      continue;
    }
    current.set(p.identity.entityId, incoming);
  }
  return held;
}

/**
 * A held payment version first stored in the batch that held it is kept as evidence, not counted:
 * status 'excluded' with this code, so a rebuild of the projection from the ledger (which reads
 * projected versions in observation order) never puts it after the version it did not replace.
 * Observed again when nothing holds it, it is projected after all.
 */
export const EARLIER_VERSION_HELD = "EARLIER_VERSION_HELD";

/** Advisory lock key serialising file publication against live lead intake (see ingestRecords). */
export const LEAD_WRITE_LOCK = 742_002;
const LEAD_SOURCES = new Set<SourceName>(["calls", "web", "d2d"]);

/**
 * Every path that writes `leads` from a lead source takes this shared lock first in its
 * transaction (live intake and replay); a publication takes it exclusive. Shared holders run
 * together; a publication waits for them and they wait for it, so a publication's compare and
 * its write see the same leads.
 */
export async function lockLeadWritesShared(tx: Queryable, source: SourceName): Promise<void> {
  if (LEAD_SOURCES.has(source)) await tx.query("select pg_advisory_xact_lock_shared($1)", [LEAD_WRITE_LOCK]);
}

const MIN_INSTANT = Date.parse("1970-01-01T00:00:00Z");
const MAX_INSTANT = Date.parse("2100-01-01T00:00:00Z");

/** Redact first, then identify and map. Nothing downstream ever sees raw PII. */
export function prepare(record: RawRecord, mapper: SourceMapper, ctx: MapContext, now: Date): Prepared {
  const receivedAt = ctx.receivedAt ?? now;
  const payload = redactValue(record.payload);
  const hash = payloadHash(payload);
  const redacted: RawRecord = { entity: record.entity, payload };
  const identified = guarded(() => mapper.identify(redacted, ctx));
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
  return { identity, payload, hash, result: guarded(() => mapper.map(redacted, ctx)), receivedAt };
}

/**
 * A mapper that throws on one record (a bug, or an input its schema let through) quarantines
 * that record as MAPPER_ERROR; it never fails the batch the record arrived in (ADV-35).
 */
function guarded<T>(step: () => T | MapFailure): T | MapFailure {
  try {
    return step();
  } catch (error) {
    return { ok: false, code: "MAPPER_ERROR", detail: String((error as Error)?.message ?? error).slice(0, 300) };
  }
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
  const stats: IngestStats = { fetched: records.length, inserted: 0, duplicates: 0, conflicts: 0, projected: 0, quarantined: 0, excluded: 0, rowsChanged: 0 };
  // Lead writers take the lead-write lock FIRST, before any row lock: shared here (deliveries run
  // side by side), exclusive for a file publication (lib/onboarding/service.ts). One lock in one
  // order cannot deadlock; the table lock it replaced was taken in the opposite order to these
  // inserts and deadlocked on an identical payload (tests/integration/concurrency.test.ts).
  await lockLeadWritesShared(tx, source);
  // Spend is gated by the currency rules: shared here, before any row lock, exclusive while a
  // rule is authorized or revoked (lib/currency/rules.ts). Taken late, inside the gate, it could
  // deadlock against an authorization waiting on a raw event this batch already touched.
  if (source === "ads") await lockCurrencyShared(tx);

  // Delivery order inside a batch is receipt order: record i is received i ms after record 0.
  const observations = records.map((record, index) => prepare(record, mapper, { ...args.ctx, receivedAt: new Date(now.getTime() + index) }, now));
  const held = await heldPaymentObservations(tx, source, observations);
  const prepared = new Map<string, Prepared>();
  const repeatsInBatch = new Map<string, number>();
  const inBatchConflicts: Prepared[] = [];
  for (const [index, p] of observations.entries()) {
    const isHeld = held.has(index);
    const existing = prepared.get(p.identity.externalId);
    if (!existing) prepared.set(p.identity.externalId, isHeld ? { ...p, held: true } : { ...p, lastSeenAt: p.receivedAt });
    else if (existing.hash === p.hash) {
      repeatsInBatch.set(p.identity.externalId, (repeatsInBatch.get(p.identity.externalId) ?? 0) + 1);
      // A held observation is counted as a delivery and moves nothing.
      if (isHeld) continue;
      existing.lastSeenAt = p.receivedAt;
      existing.held = false;
      // A receipt-ordered version seen again later in the batch is the latest observation:
      // an in-batch A, B, A must end on A, as it does across batches (unless R-37 holds it).
      if (p.identity.versionClock === "received") existing.result = p.result;
    } else inBatchConflicts.push(p); // same version, different content in one batch: keep the first, record the second
  }
  if (prepared.size === 0) return stats;

  const rows = [...prepared.values()].map((p) => ({
    entity: p.identity.entity,
    entityId: p.identity.entityId,
    externalId: p.identity.externalId,
    payload: p.payload,
    payloadHash: p.hash,
    occurredAt: p.identity.occurredAt.toISOString(),
    status: p.held ? "excluded" : p.result.ok ? "projected" : isExclusion(p.result) ? "excluded" : "quarantined",
    errorCode: p.result.ok || isExclusion(p.result) ? null : p.result.code,
    errorDetail: p.result.ok || isExclusion(p.result) ? null : p.result.detail,
    exclusionCode: p.held ? EARLIER_VERSION_HELD : isExclusion(p.result) ? p.result.code : null,
    exclusionDetail: p.held ? "an earlier payment version received after a later one, that would add cash back; held for a person (R-37)" : isExclusion(p.result) ? p.result.detail : null,
    deliveryCount: 1 + (repeatsInBatch.get(p.identity.externalId) ?? 0),
    receivedAt: p.receivedAt.toISOString(),
    lastSeenAt: (p.lastSeenAt ?? p.receivedAt).toISOString(),
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
  const exclusions: Array<{ exclusion: MapExclusion; rawEventId: number }> = [];
  if (seen.length > 0) {
    const existing = await tx.query<{ id: string; external_id: string; payload_hash: string; status: string; exclusion_code: string | null }>(
      "select id, external_id, payload_hash, status, exclusion_code from raw_events where source = $1 and external_id = any($2::text[])",
      [source, seen],
    );
    const duplicates: Array<{ id: number; at: string | null; n: number }> = [];
    const released: number[] = [];
    for (const row of existing.rows) {
      const incoming = prepared.get(row.external_id)!;
      if (incoming.hash === row.payload_hash) {
        // A held re-observation is counted but does not move the version's observation clock,
        // so a rebuild of the projection from the ledger keeps the later version too.
        duplicates.push({ id: Number(row.id), at: incoming.held ? null : (incoming.lastSeenAt ?? incoming.receivedAt).toISOString(), n: 1 + (repeatsInBatch.get(row.external_id) ?? 0) });
        stats.duplicates += 1 + (repeatsInBatch.get(row.external_id) ?? 0);
        if (incoming.held) continue;
        // A version held earlier and now observed with nothing holding it is projected after all.
        const wasHeld = row.status === "excluded" && row.exclusion_code === EARLIER_VERSION_HELD;
        if (wasHeld && incoming.result.ok) released.push(Number(row.id));
        if (incoming.identity.versionClock === "received" && incoming.result.ok && (row.status === "projected" || wasHeld)) {
          // Upserts skip rows already pointing at this raw event, so an unchanged re-read
          // costs nothing; an A -> B -> A flip restores A.
          reobserved.push({ projection: incoming.result.projection, rawEventId: Number(row.id) });
        } else if (incoming.identity.versionClock === "received" && isExclusion(incoming.result)) {
          // An excluded version observed again (A -> B -> A over B), or a version stored as
          // projected by an older mapper that the active one excludes (a spam call stored under
          // calls@1.1, re-delivered): the latest observation wins, so the exclusion applies.
          exclusions.push({ exclusion: { ...incoming.result, supersedes: { ...incoming.result.supersedes, receivedAt: incoming.lastSeenAt ?? incoming.receivedAt } }, rawEventId: Number(row.id) });
        }
      } else {
        stats.conflicts += 1;
        await recordPayloadConflict(tx, { source, rawEventId: Number(row.id), externalId: row.external_id, incoming, now });
      }
    }
    if (duplicates.length > 0) {
      // Each version's own latest observation (never moved backwards), and every delivery counted.
      await tx.query(
        `update raw_events r set delivery_count = r.delivery_count + d."n", last_delivered_at = greatest(r.last_delivered_at, d."at")
         from jsonb_to_recordset($1::jsonb) as d("id" bigint, "at" timestamptz, "n" int) where r.id = d."id"`,
        [JSON.stringify(duplicates)],
      );
    }
    if (released.length > 0) {
      await tx.query("update raw_events set status = 'projected', exclusion_code = null, exclusion_detail = null where id = any($1::bigint[])", [released]);
    }
  }

  for (const p of inBatchConflicts) {
    const storedId = insertedIds.get(p.identity.externalId) ?? (await rawEventId(tx, source, p.identity.externalId));
    stats.conflicts += 1;
    if (storedId !== null) await recordPayloadConflict(tx, { source, rawEventId: storedId, externalId: p.identity.externalId, incoming: p, now });
  }

  // Every held observation, recorded for a person against the stored version it re-delivered.
  stats.conflicts += held.size;
  for (const [index, h] of held) {
    const p = observations[index];
    const storedId = insertedIds.get(p.identity.externalId) ?? (await rawEventId(tx, source, p.identity.externalId));
    if (storedId !== null) await recordStaleVersion(tx, { source, rawEventId: storedId, entityId: p.identity.entityId, held: h, now });
  }

  const items: ProjectionItem[] = [];
  for (const [externalId, rawEventId] of insertedIds) {
    const p = prepared.get(externalId)!;
    if (p.held) continue; // stored as evidence; it does not take effect
    if (p.result.ok) items.push({ projection: p.result.projection, rawEventId });
    else if (isExclusion(p.result)) {
      stats.excluded = (stats.excluded ?? 0) + 1;
      exclusions.push({ exclusion: p.result, rawEventId });
    } else stats.quarantined += 1;
  }
  const projection = await projectIsolated(tx, [...items, ...reobserved]);
  const { failed } = projection;
  // After projection, so an exclusion and a qualifying version in one batch resolve by the
  // source clock either way round.
  const changed =
    projection.changed +
    (await applyExclusions(tx, exclusions, now)) +
    (await reapplyNewerExclusions(tx, leadKeysOf([...items, ...reobserved]), now));
  for (const f of failed) {
    await tx.query(
      "update raw_events set status = 'quarantined', error_code = 'PROJECTION_FAILED', error_detail = $2, projected_at = null where id = $1",
      [f.rawEventId, f.message.slice(0, 500)],
    );
  }
  const failedIds = new Set(failed.map((f) => f.rawEventId));
  // The currency gate excludes a record without failing it: counted as excluded, never as
  // projected, so the run summary matches what the metrics count (review 2026-11-12, A-14).
  const heldIds = new Set(projection.held);
  const stored = items.filter((i) => !failedIds.has(i.rawEventId));
  const projected = stored.filter((i) => !heldIds.has(i.rawEventId)).length;
  stats.quarantined += items.length - stored.length;
  stats.excluded = (stats.excluded ?? 0) + (stored.length - projected);
  stats.projected = projected;
  stats.rowsChanged = changed;
  // Published with the batch, in its transaction. An unchanged re-read publishes nothing, so
  // a quiet poll never wakes the consumers; a re-observed version that changed live rows (an
  // A -> B -> A flip of a received-clock record) does, or reconciliation never sees the flip
  // back (audit 2026-11-09, A-1).
  if (stats.inserted > 0 || stats.conflicts > 0 || changed > 0) {
    await recordEvent(tx, {
      type: "intake.records_stored",
      subject: `source:${source}`,
      occurredAt: now,
      payload: { source, mapperVersion: `${source}@${mapper.version}`, runId, inserted: stats.inserted, projected: stats.projected, quarantined: stats.quarantined, excluded: stats.excluded ?? 0, conflicts: stats.conflicts, rowsChanged: changed },
    });
  }
  return stats;
}

/**
 * A record the source marks as not counted leaves the projection: if an earlier version
 * projected the entity (a lead), that row is marked excluded and points at the excluding
 * version, so v_leads and every metric built on it drop it, and a newer qualifying version
 * restores it through the ordinary upsert. Guarded by the source clock like every projection:
 * an exclusion older than the stored version is a no-op. Returns the rows changed.
 */
export async function applyExclusions(tx: Queryable, exclusions: Array<{ exclusion: MapExclusion; rawEventId: number }>, now: Date): Promise<number> {
  if (exclusions.length === 0) return 0;
  const rows = exclusions.map(({ exclusion, rawEventId }) => ({
    source: exclusion.supersedes.source,
    sourceLeadId: exclusion.supersedes.sourceLeadId,
    code: exclusion.code,
    receivedAt: exclusion.supersedes.receivedAt.toISOString(),
    rawEventId,
  }));
  const result = await tx.query(
    `update leads t set excluded_code = r."code", excluded_at = $2, raw_event_id = r."rawEventId", source_updated_at = r."receivedAt"
     from (select distinct on ("source", "sourceLeadId") * from jsonb_to_recordset($1::jsonb)
             as x("source" text, "sourceLeadId" text, "code" text, "receivedAt" timestamptz, "rawEventId" bigint)
           order by "source", "sourceLeadId", "receivedAt" desc) r
     where t.source = r."source" and t.source_lead_id = r."sourceLeadId" and t.source_updated_at <= r."receivedAt"
       -- the excluding version delivered again moves the lead's clock too (see project.ts)
       and (t.excluded_code is distinct from r."code" or t.raw_event_id <> r."rawEventId" or t.source_updated_at < r."receivedAt")`,
    [JSON.stringify(rows), now],
  );
  return result.rowCount ?? 0;
}

/** The (source, source lead id) of every lead projection in a batch. */
export function leadKeysOf(items: ProjectionItem[]): Array<{ source: string; sourceLeadId: string }> {
  return items
    .filter((i) => i.projection.table === "leads")
    .map((i) => {
      const row = i.projection.row as { source: string; sourceLeadId: string };
      return { source: row.source, sourceLeadId: row.sourceLeadId };
    });
}

/**
 * A lead just projected from a version OLDER than an excluded version of the same call (a held
 * record replayed with its original receipt time, after the source had marked the call spam)
 * must not count: the newest stored version decides. Applies that newer exclusion. Returns the
 * rows changed.
 */
export async function reapplyNewerExclusions(tx: Queryable, keys: Array<{ source: string; sourceLeadId: string }>, now: Date): Promise<number> {
  const calls = keys.filter((k) => k.source === "calls").map((k) => k.sourceLeadId);
  if (calls.length === 0) return 0;
  const result = await tx.query(
    // By each version's LATEST observation, the clock a lead's source_updated_at is on (a version
    // delivered again after a newer one is the newest observation; replay.ts maps on it too).
    `update leads l set excluded_code = x.exclusion_code, excluded_at = $2, raw_event_id = x.id, source_updated_at = x.last_delivered_at
     from (select distinct on (entity_id) entity_id, id, exclusion_code, last_delivered_at from raw_events
           where source = 'calls' and status = 'excluded' and entity_id = any($1::text[])
           order by entity_id, last_delivered_at desc, id desc) x
     where l.source = 'calls' and l.source_lead_id = x.entity_id and x.last_delivered_at > l.source_updated_at`,
    [calls, now],
  );
  return result.rowCount ?? 0;
}

type RawRow = Record<string, unknown> & { externalId: string };

const INSERT_RAW = `
  insert into raw_events (source, entity, entity_id, external_id, payload, payload_hash, occurred_at, received_at,
    ingestion_run_id, adapter_version, status, error_code, error_detail, exclusion_code, exclusion_detail,
    delivery_count, last_delivered_at, projected_at)
  select $1, r."entity", r."entityId", r."externalId", r."payload", r."payloadHash", r."occurredAt", r."receivedAt",
    $3, $4, r."status", r."errorCode", r."errorDetail", r."exclusionCode", r."exclusionDetail",
    r."deliveryCount", coalesce(r."lastSeenAt", $2::timestamptz),
    case when r."status" = 'projected' then $2::timestamptz end
  from jsonb_to_recordset($5::jsonb) as r("entity" text, "entityId" text, "externalId" text, "payload" jsonb,
    "payloadHash" text, "occurredAt" timestamptz, "receivedAt" timestamptz, "status" text, "errorCode" text,
    "errorDetail" text, "exclusionCode" text, "exclusionDetail" text, "deliveryCount" int, "lastSeenAt" timestamptz)
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
        exclusionCode: null,
        exclusionDetail: null,
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
async function projectIsolated(tx: Queryable, items: ProjectionItem[]): Promise<{ failed: Array<{ rawEventId: number; message: string }>; changed: number; held: number[] }> {
  if (items.length === 0) return { failed: [], changed: 0, held: [] };
  // Records the currency gate held: excluded, not projected (lib/ingest/project.ts).
  const report = { held: [] as number[] };
  await tx.query("savepoint project_batch");
  try {
    const changed = await projectAll(tx, items, report);
    await tx.query("release savepoint project_batch");
    return { failed: [], changed, held: report.held };
  } catch (error) {
    await tx.query("rollback to savepoint project_batch");
    if (!isRecordLevelError(error)) throw error;
    report.held.length = 0;
  }
  const failed: Array<{ rawEventId: number; message: string }> = [];
  let changed = 0;
  for (const item of items) {
    await tx.query("savepoint project_one");
    try {
      changed += await projectAll(tx, [item], report);
      await tx.query("release savepoint project_one");
    } catch (error) {
      await tx.query("rollback to savepoint project_one");
      if (!isRecordLevelError(error)) throw error; // transient: fail the run, retry next run
      failed.push({ rawEventId: item.rawEventId, message: (error as Error).message });
      console.warn(JSON.stringify({ level: "warn", msg: "projection failed; record quarantined", rawEventId: item.rawEventId }));
    }
  }
  return { failed, changed, held: report.held };
}

/**
 * A held earlier payment version (R-37), as a payload conflict a person closes once the source is
 * checked: "is this a stale copy, or did the source really reverse the later state?". One per
 * (version, later version); a repeat counts a delivery.
 */
async function recordStaleVersion(
  tx: Queryable,
  args: { source: string; rawEventId: number; entityId: string; held: HeldObservation; now: Date },
): Promise<void> {
  const { source, rawEventId, entityId, held, now } = args;
  const cash = countedCents(held.incoming) - countedCents(held.live);
  await tx.query(
    `insert into exceptions (kind, severity, fingerprint, branch_id, subject_type, subject_id, summary, evidence,
       first_detected_at, last_detected_at, customer_ids)
     select 'payload_conflict', 'high', $1, payload_branch(re.payload), 'raw_event', $2, $3, $4, $5, $5,
       case when re.payload ->> 'customerID' ~ '^[0-9]{1,18}$' then array[(re.payload ->> 'customerID')::bigint] else '{}'::bigint[] end
     from raw_events re where re.id = $6
     on conflict (fingerprint) do update set last_detected_at = excluded.last_detected_at,
       evidence = exceptions.evidence || jsonb_build_object('deliveries', coalesce((exceptions.evidence->>'deliveries')::int, 1) + 1)`,
    [
      `payload_conflict:${source}:${held.incoming.externalId}:after:${held.live.externalId}`,
      String(rawEventId),
      `${source} re-sent an earlier version of payment ${entityId} (${held.incoming.status}) after a later one (${held.live.status}): it would add ${formatCents(cash)} of cash back, so the later version was kept`,
      JSON.stringify({
        conflict: "earlier_version_after_later",
        externalId: held.incoming.externalId,
        heldRawEventId: rawEventId,
        liveExternalId: held.live.externalId,
        liveStatus: held.live.status,
        liveAmountCents: held.live.amountCents,
        incomingStatus: held.incoming.status,
        incomingAmountCents: held.incoming.amountCents,
        cashCentsHeld: cash,
        deliveries: 1,
      }),
      now,
      rawEventId,
    ],
  );
}

async function recordPayloadConflict(
  tx: Queryable,
  args: { source: string; rawEventId: number; externalId: string; incoming: Prepared; now: Date },
): Promise<void> {
  const { source, rawEventId, externalId, incoming, now } = args;
  await tx.query(
    // The branch and the customer come from the stored payload, as for every other exception, so
    // the conflict is visible to that branch's viewers and its revenue counts as untied (audit
    // 2026-11-09, D-4). Unknown branch or no customer id: null / empty, as before.
    `insert into exceptions (kind, severity, fingerprint, branch_id, subject_type, subject_id, summary, evidence,
       first_detected_at, last_detected_at, customer_ids)
     select 'payload_conflict', 'medium', $1, payload_branch(re.payload), 'raw_event', $2, $3, $4, $5, $5,
       case when re.payload ->> 'customerID' ~ '^[0-9]{1,18}$' then array[(re.payload ->> 'customerID')::bigint] else '{}'::bigint[] end
     from raw_events re where re.id = $6
     on conflict (fingerprint) do update set last_detected_at = excluded.last_detected_at,
       evidence = exceptions.evidence || jsonb_build_object('deliveries', coalesce((exceptions.evidence->>'deliveries')::int, 1) + 1)`,
    [
      `payload_conflict:${source}:${externalId}`,
      String(rawEventId),
      `${source} sent two different payloads for the same record version ${externalId}`,
      JSON.stringify({ externalId, storedRawEventId: rawEventId, incomingPayload: incoming.payload, incomingHash: incoming.hash, deliveries: 1 }),
      now,
      rawEventId,
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
      // What the delivery changed in the accepted records, recorded with the change itself: it
      // commits with it or not at all (then it stays null: not recorded), and it is set, not
      // added to, so writing it again cannot double it (migration 0030).
      await tx.query("update ingestion_runs set rows_changed = $2 where id = $1", [runId, s.rowsChanged]);
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
