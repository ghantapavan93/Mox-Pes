import type { Queryable } from "@/lib/db";
import { decisionHolds } from "@/lib/metrics/decision";
import { branchRows, conversionBridge, paidCac, totals, type Bridge, type BranchRow } from "@/lib/metrics/scorecard";
import { PERIODS } from "@/lib/period";

/**
 * The dashboard's October figures as one value: the company tiles, the conversion bridge, every
 * branch's row, the held budget decisions and the open exceptions. Read with the same functions
 * the Overview and branch pages use (lib/metrics/scorecard.ts, decision.ts), so a figure here is
 * the figure those pages show. Reads run one after another: inside a transaction there is one
 * connection (lib/onboarding/service.ts previews a visitor's file in one that is rolled back).
 */

export interface Figures {
  paidSpendCents: number;
  collectedCents: number;
  prospects: number;
  paidProspects: number;
  acquired: number;
  paidAcquired: number;
  unknownAcquired: number;
  /** Null where the scorecard defines no CAC (no spend or no paid customer counted). */
  paidCacCents: number | null;
  /** Unattributed share of new customers, 0–1; null with none acquired. */
  unknownShare: number | null;
  openExceptions: number;
  atRiskCents: number;
}

export interface BranchFigures extends Figures {
  branchId: string;
  name: string;
}

export interface DashboardSnapshot {
  periodKey: "oct";
  company: Figures & { platformClaimed: number };
  bridge: Bridge;
  branches: BranchFigures[];
  /** Branches whose budget decision an open incident holds. */
  heldBranches: string[];
  exceptions: Array<{ id: number; kind: string; branchId: string | null; amountCents: number }>;
}

const branchFigures = (r: BranchRow): BranchFigures => ({
  branchId: r.branchId,
  name: r.name,
  paidSpendCents: r.paidSpendCents,
  collectedCents: r.collectedCents,
  prospects: r.prospects,
  paidProspects: r.paidProspects,
  acquired: r.acquired,
  paidAcquired: r.paidAcquired,
  unknownAcquired: r.unknownAcquired,
  paidCacCents: paidCac(r.paidSpendCents, r.paidAcquired),
  unknownShare: r.acquired > 0 ? r.unknownAcquired / r.acquired : null,
  openExceptions: r.openExceptions,
  atRiskCents: r.atRiskCents,
});

export async function dashboardSnapshot(db: Queryable): Promise<DashboardSnapshot> {
  const period = PERIODS.oct;
  const scope = { from: period.from, to: period.to, branchIds: null };
  const rows = await branchRows(db, scope);
  const t = await totals(db, scope, rows);
  const bridge = await conversionBridge(db, scope);
  const holds = await decisionHolds(db, null, 100, period);
  const exceptions = await db.query<{ id: string; kind: string; branch_id: string | null; amount_cents: string }>(
    "select id, kind, branch_id, amount_cents from exceptions where status = 'open' order by id",
  );
  return {
    periodKey: "oct",
    company: {
      paidSpendCents: t.paidSpendCents,
      collectedCents: t.collectedCents,
      prospects: t.prospects,
      paidProspects: t.paidProspects,
      acquired: t.acquired,
      paidAcquired: t.paidAcquired,
      unknownAcquired: t.unknownAcquired,
      paidCacCents: t.paidCacCents,
      unknownShare: t.unknownShare,
      openExceptions: t.openExceptions,
      atRiskCents: t.atRiskCents,
      platformClaimed: t.platformClaimed,
    },
    bridge,
    branches: rows.map(branchFigures),
    heldBranches: [...new Set(holds.map((h) => h.branchId))].sort(),
    exceptions: exceptions.rows.map((e) => ({ id: Number(e.id), kind: e.kind, branchId: e.branch_id, amountCents: Number(e.amount_cents) })),
  };
}

/** The figures a branch row compares on: a branch "changed" when any of them did. */
const COMPARED: Array<keyof Figures> = ["paidSpendCents", "collectedCents", "prospects", "paidProspects", "acquired", "paidAcquired", "unknownAcquired", "openExceptions", "atRiskCents"];

export interface SnapshotChange {
  company: { before: DashboardSnapshot["company"]; after: DashboardSnapshot["company"] };
  bridge: { before: Bridge; after: Bridge };
  /** Branches whose figures moved, the largest CAC move first; at most `limit`. */
  branches: Array<{ before: BranchFigures; after: BranchFigures }>;
  /** How many branches moved in all (the list above may be cut). */
  branchesChanged: number;
  held: { before: string[]; after: string[] };
  /** Open exceptions the change would open, and how many it would close. */
  opened: DashboardSnapshot["exceptions"];
  closed: number;
}

/**
 * What moved between two snapshots. Exceptions are matched by kind, branch and amount, not by id:
 * ids a rolled-back transaction assigned never exist, so a new id says nothing on its own.
 */
export function compareSnapshots(before: DashboardSnapshot, after: DashboardSnapshot, limit = 8): SnapshotChange {
  const byId = new Map(before.branches.map((b) => [b.branchId, b]));
  const moved = after.branches
    .map((a) => ({ before: byId.get(a.branchId)!, after: a }))
    .filter(({ before: b, after: a }) => b && COMPARED.some((k) => b[k] !== a[k]));
  const cacMove = (x: { before: BranchFigures; after: BranchFigures }) => Math.abs((x.after.paidCacCents ?? 0) - (x.before.paidCacCents ?? 0));
  moved.sort((x, y) => cacMove(y) - cacMove(x) || x.after.branchId.localeCompare(y.after.branchId));
  const key = (e: DashboardSnapshot["exceptions"][number]) => `${e.kind}|${e.branchId ?? "-"}|${e.amountCents}`;
  const count = (list: DashboardSnapshot["exceptions"]) => list.reduce((m, e) => m.set(key(e), (m.get(key(e)) ?? 0) + 1), new Map<string, number>());
  const was = count(before.exceptions);
  const now = count(after.exceptions);
  const opened: DashboardSnapshot["exceptions"] = [];
  const seen = new Map<string, number>();
  for (const e of after.exceptions) {
    const k = key(e);
    seen.set(k, (seen.get(k) ?? 0) + 1);
    if (seen.get(k)! > (was.get(k) ?? 0)) opened.push(e);
  }
  let closed = 0;
  for (const [k, n] of was) closed += Math.max(0, n - (now.get(k) ?? 0));
  return {
    company: { before: before.company, after: after.company },
    bridge: { before: before.bridge, after: after.bridge },
    branches: moved.slice(0, limit),
    branchesChanged: moved.length,
    held: { before: before.heldBranches, after: after.heldBranches },
    opened,
    closed,
  };
}
