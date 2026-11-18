import { getNow, type Queryable } from "@/lib/db";
import { budgetSignal } from "@/lib/metrics/decision";
import { branchRows, channelRows, paidCac } from "@/lib/metrics/scorecard";
import { PERIODS, type Period, type PeriodKey } from "@/lib/period";

/**
 * Before/after state of one proposal's dry run or execution, and the checks that decide
 * whether the result is verified.
 *
 * Two kinds of number:
 *   * the LEDGER — money and records that no Action Center fix may create or destroy: total
 *     ad spend, raw events, CRM customers, invoiced and collected. A fix re-classifies,
 *     re-attributes or records a decision; if one of these moves, something is wrong and
 *     the execution rolls back;
 *   * the DECISION numbers for the affected branch — paid CAC, unattributed customers,
 *     media channel cost per customer, and whether the budget signal is trustworthy. These
 *     are expected to move; they are what the approver is approving.
 */

export const LEDGER_KEYS = ["adSpendCents", "rawEvents", "crmCustomers", "invoicedCents", "collectedCents"] as const;
export type LedgerKey = (typeof LEDGER_KEYS)[number];

export const LEDGER_LABEL: Record<LedgerKey, string> = {
  adSpendCents: "Total ad spend",
  rawEvents: "Raw events stored",
  crmCustomers: "CRM customers",
  invoicedCents: "Invoiced",
  collectedCents: "Collected",
};

export interface BranchSnapshot {
  branchId: string;
  /** The snapshot's period: the whole demo window (PERIODS.all) for `branch`, a calendar month for `month`. */
  paidSpendCents: number;
  acquired: number;
  paidAcquired: number;
  unknownAcquired: number;
  paidCacCents: number | null;
  openExceptions: number;
  /**
   * The open exceptions counted in openExceptions, so a receipt can say which ones the run closed
   * and which it opened, not only that the count moved. Absent from snapshots stored before it.
   */
  openExceptionList?: OpenExceptionRef[];
  channels: Record<string, { spendCents: number; acquired: number; cacCents: number | null }>;
  /**
   * New customers per channel, every channel (door-to-door and unknown included), so a receipt can
   * say where newly credited customers came from. Absent from snapshots stored before 2026-11-18.
   */
  acquiredByChannel?: Record<string, number>;
  /**
   * October budget signal, as the branch page shows it. `recommendation` and `heldBy` (absent from
   * snapshots stored before 2026-11-17) say whether anything still holds the recommendation once no
   * incident gates it: a fix that clears its own incident is not a clearance of the decision.
   */
  budgetSignal: { signal: "shift" | "none"; trustworthy: boolean; blockers: number; ratio: number | null; recommendation?: "shift" | "none" | "held"; heldBy?: string[] };
}

export interface OpenExceptionRef {
  id: number;
  kind: string;
  amountCents: number;
}

export interface StateSnapshot {
  exception: { id: number; status: string; lastDetectedAt: string | null };
  ledger: Record<LedgerKey, number>;
  openExceptionsCompanyWide: number;
  /** The whole demo window (PERIODS.all). */
  branch: BranchSnapshot | null;
  /**
   * The same branch in the latest calendar month the business clock has reached (October on the
   * seeded data), by the same branchRows: what a receipt leads with (release design §5.8). Absent
   * on executions stored before 2026-11-18, whose receipt shows the window only.
   */
  month?: { key: PeriodKey; branch: BranchSnapshot } | null;
}

/** The latest calendar month (September or October) whose start the business clock has passed. */
function latestMonth(now: Date): Period | null {
  return [PERIODS.oct, PERIODS.sep].find((p) => p.from.getTime() <= now.getTime()) ?? null;
}

export async function captureState(db: Queryable, exceptionId: number, branchId: string | null): Promise<StateSnapshot> {
  // Sequential on purpose: inside a transaction this is one connection.
  const ledger = await db.query<Record<string, string>>(
    `select (select coalesce(sum(cost_cents), 0) from ad_spend_daily) as spend,
            (select count(*) from raw_events) as raw_events,
            (select count(*) from crm_customers) as customers,
            (select coalesce(sum(total_cents), 0) from crm_tickets) as invoiced,
            (select coalesce(sum(amount_cents), 0) from crm_payments where status = 'successful') as collected,
            (select count(*) from exceptions where status = 'open') as open_exceptions`,
  );
  const exception = await db.query<{ status: string; last_detected_at: Date | null }>(
    "select status, last_detected_at from exceptions where id = $1",
    [exceptionId],
  );
  const l = ledger.rows[0];
  return {
    exception: {
      id: exceptionId,
      status: exception.rows[0]?.status ?? "missing",
      lastDetectedAt: exception.rows[0]?.last_detected_at ? new Date(exception.rows[0].last_detected_at).toISOString() : null,
    },
    ledger: {
      adSpendCents: Number(l.spend),
      rawEvents: Number(l.raw_events),
      crmCustomers: Number(l.customers),
      invoicedCents: Number(l.invoiced),
      collectedCents: Number(l.collected),
    },
    openExceptionsCompanyWide: Number(l.open_exceptions),
    branch: branchId ? await branchSnapshot(db, branchId, PERIODS.all) : null,
    month: branchId ? await monthSnapshot(db, branchId) : null,
  };
}

async function monthSnapshot(db: Queryable, branchId: string): Promise<StateSnapshot["month"]> {
  const month = latestMonth(await getNow(db));
  if (!month) return null;
  const branch = await branchSnapshot(db, branchId, month);
  return branch ? { key: month.key, branch } : null;
}

async function branchSnapshot(db: Queryable, branchId: string, period: Period): Promise<BranchSnapshot | null> {
  const scope = { from: period.from, to: period.to, branchIds: [branchId] };
  const [row] = await branchRows(db, scope);
  if (!row) return null;
  const channels = await channelRows(db, scope);
  const signal = await budgetSignal(db, branchId, { from: PERIODS.oct.from, to: PERIODS.oct.to });
  // The same rows branchRows counts as open_exceptions (lib/metrics/scorecard.ts).
  const open = await db.query<{ id: number; kind: string; amount_cents: string | number | null }>(
    "select id, kind, amount_cents from exceptions where status = 'open' and branch_id = $1 order by id",
    [branchId],
  );
  return {
    branchId,
    paidSpendCents: row.paidSpendCents,
    acquired: row.acquired,
    paidAcquired: row.paidAcquired,
    unknownAcquired: row.unknownAcquired,
    paidCacCents: paidCac(row.paidSpendCents, row.paidAcquired),
    openExceptions: row.openExceptions,
    openExceptionList: open.rows.map((e) => ({ id: Number(e.id), kind: e.kind, amountCents: Number(e.amount_cents ?? 0) })),
    channels: Object.fromEntries(
      channels
        .filter((c) => c.costBasis === "media")
        .map((c) => [c.channelCode, { spendCents: c.spendCents, acquired: c.acquired, cacCents: c.cacCents }]),
    ),
    acquiredByChannel: Object.fromEntries(channels.map((c) => [c.channelCode, c.acquired])),
    budgetSignal: {
      signal: signal.signal,
      trustworthy: signal.trustworthy,
      blockers: signal.blockers.length,
      ratio: signal.ratio,
      recommendation: signal.recommendation.status,
      heldBy: signal.recommendation.heldBy.map((h) => h.text),
    },
  };
}

export interface Verification {
  ok: boolean;
  /** What the exception had to become for this kind of fix, or null when the effect is deferred. */
  expectedExceptionStatus: string[] | null;
  exceptionStatus: string;
  conservation: Array<{ key: LedgerKey; label: string; before: number; after: number; ok: boolean }>;
  problems: string[];
}

/**
 * The fix is verified when (1) after re-running reconciliation the exception is in one of
 * the statuses this kind of fix must produce, and (2) every ledger figure the kind does not
 * declare as changeable is unchanged.
 */
export function verify(
  before: StateSnapshot,
  after: StateSnapshot,
  expectedExceptionStatus: string[] | null,
  mayChange: readonly LedgerKey[],
): Verification {
  const problems: string[] = [];
  const conservation = LEDGER_KEYS.map((key) => {
    const ok = mayChange.includes(key) || before.ledger[key] === after.ledger[key];
    if (!ok) problems.push(`${LEDGER_LABEL[key]} changed from ${before.ledger[key]} to ${after.ledger[key]}`);
    return { key, label: LEDGER_LABEL[key], before: before.ledger[key], after: after.ledger[key], ok };
  });
  if (expectedExceptionStatus && !expectedExceptionStatus.includes(after.exception.status)) {
    problems.push(`Exception is ${after.exception.status} after reconciliation; expected ${expectedExceptionStatus.join(" or ")}`);
  }
  return { ok: problems.length === 0, expectedExceptionStatus, exceptionStatus: after.exception.status, conservation, problems };
}
