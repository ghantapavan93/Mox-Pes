import type { Pool, PoolClient } from "pg";
import { ActionError } from "@/lib/actions";
import { withRollback, withTransaction } from "@/lib/db";
import type { SourceName } from "@/lib/adapters/contract";
import { mapperFor, referenceContext } from "@/lib/adapters/registry";
import { recordEvent } from "@/lib/events/outbox";
import { lockReconcile, reconcile } from "@/lib/reconcile/reconcile";
import { branchRows, channelRows, paidCac, type Scope } from "@/lib/metrics/scorecard";
import { feedbackSummary } from "@/lib/feedback";
import { projectAll, type ProjectionItem } from "./project";

export interface ReplayRequest {
  source: SourceName;
  rawEventIds: number[];
  mapperVersion: string;
  actor: string;
  idempotencyKey: string;
  dryRun: boolean;
  now: Date;
  /** The quarantine exception this replay answers; its resolution records the replay. */
  exceptionId?: number;
  /** Branches whose metrics are snapshotted before/after; defaults to the events' branches. */
  scope: Scope;
  /**
   * "quarantined" (default) retries held records. "reproject" re-maps records that were
   * stored and counted under an older mapper version (`fromVersion`): a silent
   * misclassification, corrected without touching the money.
   */
  mode?: "quarantined" | "reproject";
  fromVersion?: string;
  /** A platform replaced one campaign with another; recorded with the replay, once. */
  lineage?: { predecessorCampaignId: number; successorCampaignId: number; effectiveDate: string; evidence: Record<string, unknown> };
}

export interface MetricSnapshot {
  branchIds: string[];
  paidSpendCents: number;
  acquired: number;
  paidAcquired: number;
  unknownAcquired: number;
  paidCacCents: number | null;
  openExceptions: number;
  atRiskCents: number;
  /** Serviced Google Search customers that would be reported back to Google Ads (dry-run ledger). */
  googleConversionsToUpload: number;
  /** Paid media channels in scope: spend, new customers serviced, cost per customer. */
  channels: Record<string, { spendCents: number; acquired: number; cacCents: number | null }>;
}

export interface ReplayResult {
  idempotencyKey: string;
  dryRun: boolean;
  /** true when this key was already processed: the stored result is returned, nothing re-runs. */
  alreadyProcessed: boolean;
  requested: number;
  claimed: number;
  projected: number;
  stillQuarantined: number;
  errors: Array<{ rawEventId: number; code: string; detail: string }>;
  before: MetricSnapshot | null;
  after: MetricSnapshot | null;
}

async function snapshot(tx: PoolClient, scope: Scope, now: Date): Promise<MetricSnapshot> {
  // Sequential: one transaction is one connection.
  const rows = await branchRows(tx, scope);
  const feedback = await feedbackSummary(tx, scope, now);
  const channels = await channelRows(tx, scope);
  const s = (k: "paidSpendCents" | "acquired" | "paidAcquired" | "unknownAcquired" | "openExceptions" | "atRiskCents") =>
    rows.reduce((acc, r) => acc + r[k], 0);
  return {
    branchIds: rows.map((r) => r.branchId),
    paidSpendCents: s("paidSpendCents"),
    acquired: s("acquired"),
    paidAcquired: s("paidAcquired"),
    unknownAcquired: s("unknownAcquired"),
    paidCacCents: paidCac(s("paidSpendCents"), s("paidAcquired")),
    openExceptions: s("openExceptions"),
    atRiskCents: s("atRiskCents"),
    googleConversionsToUpload: feedback.upload,
    channels: Object.fromEntries(
      channels
        .filter((c) => c.costBasis === "media")
        .map((c) => [c.channelCode, { spendCents: c.spendCents, acquired: c.acquired, cacCents: c.cacCents }]),
    ),
  };
}

/**
 * Re-runs stored raw events through a (newer) mapper: held records (mode "quarantined"), or
 * records already projected by an older mapper version (mode "reproject").
 *
 * Exactly-once guarantees:
 *   * the idempotency key is inserted first, inside the transaction — a second request
 *     with the same key blocks on it, then sees it and returns the stored result;
 *   * events are claimed with one conditional UPDATE (status = 'quarantined' → 'replaying'),
 *     so two concurrent replays with different keys can never claim the same event;
 *   * projection upserts are guarded by the source clock, so even a projected event
 *     re-projected would not change state.
 *
 * A dry run executes the same path inside a transaction that is rolled back.
 */
export async function replay(pool: Pool, req: ReplayRequest): Promise<ReplayResult> {
  // A key identifies one REQUEST (what was asked), not its result. Reusing a key for a
  // different request is a client bug and is refused rather than silently answered.
  const mode = req.mode ?? "quarantined";
  if (mode === "reproject" && (!req.fromVersion || req.fromVersion === req.mapperVersion)) {
    throw new ActionError("A re-projection needs a fromVersion different from the target mapper version", 400);
  }
  const fingerprint =
    `${req.source}|${req.exceptionId ?? "-"}|${req.mapperVersion}` + (mode === "reproject" ? `|reproject:${req.fromVersion}` : "");
  if (!req.dryRun) {
    const stored = await loadStored(pool, req.idempotencyKey, fingerprint);
    if (stored) return stored;
  }
  const mapper = mapperFor(req.source, req.mapperVersion);

  const body = async (tx: PoolClient): Promise<ReplayResult> => {
    await lockReconcile(tx);
    if (!req.dryRun) {
      const key = await tx.query(
        `insert into replays (idempotency_key, request_fingerprint, exception_id, dry_run, actor, adapter_version, requested_ids,
           claimed, projected, still_quarantined, requested_at, finished_at, mode)
         values ($1, $7, $6, false, $2, $3, $4, 0, 0, 0, $5, $5, $8) on conflict (idempotency_key) do nothing returning id`,
        [req.idempotencyKey, req.actor, `${req.source}@${req.mapperVersion}`, req.rawEventIds, req.now, req.exceptionId ?? null, fingerprint, mode],
      );
      if (key.rowCount === 0) return { ...(await loadStored(tx, req.idempotencyKey, fingerprint))! };
    }

    const before = await snapshot(tx, req.scope, req.now);
    // The claim is the exactly-once point: a record moves to 'replaying' once. For a
    // re-projection it must still carry the old mapper version, so repeating the request
    // (or racing it) finds nothing left to claim.
    const claimed =
      mode === "quarantined"
        ? await tx.query<{ id: string; entity: string; payload: unknown; received_at: Date }>(
            `update raw_events set status = 'replaying', error_code = null, error_detail = null
             where id = any($1::bigint[]) and source = $2 and status = 'quarantined'
             returning id, entity, payload, received_at`,
            [req.rawEventIds, req.source],
          )
        : await tx.query<{ id: string; entity: string; payload: unknown; received_at: Date }>(
            `update raw_events set status = 'replaying'
             where id = any($1::bigint[]) and source = $2 and status = 'projected' and adapter_version = $3
             returning id, entity, payload, received_at`,
            [req.rawEventIds, req.source, `${req.source}@${req.fromVersion}`],
          );

    const items: ProjectionItem[] = [];
    const errors: ReplayResult["errors"] = [];
    const projectedIds: number[] = [];
    for (const row of claimed.rows) {
      // A replayed record keeps its ORIGINAL receipt time: it was received then and only
      // failed to map. It must not beat a version received after it.
      const result = mapper.map({ entity: row.entity, payload: row.payload }, { ...referenceContext, receivedAt: row.received_at });
      if (result.ok) {
        items.push({ projection: result.projection, rawEventId: Number(row.id) });
        projectedIds.push(Number(row.id));
      } else {
        errors.push({ rawEventId: Number(row.id), code: result.code, detail: result.detail });
      }
    }
    await projectAll(tx, items);
    if (projectedIds.length > 0) {
      await tx.query(
        `update raw_events set status = 'projected', projected_at = $2, adapter_version = $3 where id = any($1::bigint[])`,
        [projectedIds, req.now, `${req.source}@${req.mapperVersion}`],
      );
    }
    for (const e of errors) {
      if (mode === "quarantined") {
        await tx.query(
          "update raw_events set status = 'quarantined', error_code = $2, error_detail = $3 where id = $1",
          [e.rawEventId, e.code, e.detail],
        );
      } else {
        // Its earlier projection is still valid; a re-map that cannot read it leaves it as it was.
        await tx.query("update raw_events set status = 'projected' where id = $1", [e.rawEventId]);
      }
    }
    if (req.lineage) {
      await tx.query(
        `insert into campaign_lineage (predecessor_campaign_id, successor_campaign_id, effective_date, evidence, recorded_by, recorded_at)
         values ($1, $2, $3, $4, $5, $6) on conflict (predecessor_campaign_id) do nothing`,
        [req.lineage.predecessorCampaignId, req.lineage.successorCampaignId, req.lineage.effectiveDate, req.lineage.evidence, req.actor, req.now],
      );
    }
    if (req.exceptionId && projectedIds.length > 0) {
      // Kept only if reconciliation confirms the condition cleared; re-detection wipes it.
      await tx.query("update exceptions set resolution = $2 where id = $1 and status = 'open'", [
        req.exceptionId,
        `${mode === "reproject" ? "Re-mapped" : "Replayed"} ${projectedIds.length} records through ${req.source}@${req.mapperVersion} by ${req.actor}`,
      ]);
    }
    if (projectedIds.length > 0) {
      // Before reconcile: the run below then covers this event from inside the same transaction.
      await recordEvent(tx, {
        type: "intake.records_reprojected",
        subject: req.exceptionId ? `exception:${req.exceptionId}` : `source:${req.source}`,
        occurredAt: req.now,
        payload: { source: req.source, mode, mapperVersion: `${req.source}@${req.mapperVersion}`, fromVersion: req.fromVersion ?? null, projected: projectedIds.length, idempotencyKey: req.idempotencyKey },
      });
    }
    await reconcile(tx, req.now);
    const after = await snapshot(tx, req.scope, req.now);

    const result: ReplayResult = {
      idempotencyKey: req.idempotencyKey,
      dryRun: req.dryRun,
      alreadyProcessed: false,
      requested: req.rawEventIds.length,
      claimed: claimed.rowCount ?? 0,
      projected: projectedIds.length,
      stillQuarantined: mode === "quarantined" ? errors.length : 0,
      errors: errors.slice(0, 20),
      before,
      after,
    };
    if (!req.dryRun) {
      await tx.query(
        `update replays set claimed = $2, projected = $3, still_quarantined = $4, metric_before = $5, metric_after = $6,
           finished_at = $7 where idempotency_key = $1`,
        [req.idempotencyKey, result.claimed, result.projected, result.stillQuarantined, before, after, req.now],
      );
      await tx.query(
        "insert into audit_log (at, actor, action, subject, detail) values ($1, $2, 'replay', $3, $4)",
        [req.now, req.actor, `${req.source}@${req.mapperVersion}`, { idempotencyKey: req.idempotencyKey, mode, claimed: result.claimed, projected: result.projected, stillQuarantined: result.stillQuarantined, errors: errors.length }],
      );
    }
    return result;
  };

  return req.dryRun ? withRollback(pool, body) : withTransaction(pool, body);
}

async function loadStored(db: Pool | PoolClient, key: string, fingerprint: string): Promise<ReplayResult | null> {
  const { rows } = await db.query("select * from replays where idempotency_key = $1", [key]);
  const r = rows[0];
  if (!r) return null;
  if (r.request_fingerprint !== fingerprint) {
    throw new ActionError("This idempotency key was already used for a different replay request", 409);
  }
  return {
    idempotencyKey: key,
    dryRun: false,
    alreadyProcessed: true,
    requested: r.requested_ids.length,
    claimed: r.claimed,
    projected: r.projected,
    stillQuarantined: r.still_quarantined,
    errors: [],
    before: r.metric_before,
    after: r.metric_after,
  };
}

/** The quarantined raw event ids of one exception group (source + error + branch). */
export async function quarantineGroupIds(
  db: Pool | PoolClient,
  group: { source: string; errorCode: string; branchId: string | null },
): Promise<number[]> {
  const { rows } = await db.query<{ id: string }>(
    `select re.id from raw_events re
     where re.status = 'quarantined' and re.source = $1 and re.error_code = $2
       and payload_branch(re.payload) is not distinct from $3
     order by re.id`,
    [group.source, group.errorCode, group.branchId],
  );
  return rows.map((r) => Number(r.id));
}

/**
 * The raw spend records behind a channel coverage gap: every stored version for the
 * successor campaigns named in the exception's evidence that an older mapper projected.
 * Versions superseded by a restatement are included, so the raw log carries one mapper
 * version per campaign after the re-map.
 */
export async function coverageGapRecordIds(
  db: Pool | PoolClient,
  args: { externalCampaignIds: string[]; fromVersion: string },
): Promise<number[]> {
  const { rows } = await db.query<{ id: string }>(
    `select re.id from raw_events re
     where re.source = 'ads' and re.status = 'projected' and re.adapter_version = $2
       and re.payload ->> 'campaignId' = any($1::text[])
     order by re.id`,
    [args.externalCampaignIds, `ads@${args.fromVersion}`],
  );
  return rows.map((r) => Number(r.id));
}
