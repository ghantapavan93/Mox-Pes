import { dateRanges } from "@/lib/reconcile/gap-coverage";

/**
 * What one delivery run did, in the words its row on the Integrations pipeline shows
 * (docs/agent-work/DELIVERY-OUTCOMES.md). Built only from facts recorded at the time:
 *
 *   stored        ingestion_runs.inserted: record versions kept for the first time, accepted or not
 *   effect        ingestion_runs.rows_changed: writes and removals of accepted records, recorded in
 *                 the run's own transaction (migration 0030); null when that was not recorded
 *   verification  a coverage-gap verification stored on its incident that names the run
 *                 (lib/reconcile/gap-coverage.ts, verificationOf)
 *
 * Never from the run's status or its stored count, and never from whichever revision is accepted
 * today: a run whose effect was not recorded says so, never "no change".
 */

/** A run's own counts, as its row on ingestion_runs recorded them. */
export interface RunFacts {
  fetched: number;
  inserted: number;
  duplicates: number;
  projected: number;
  /** Writes and removals of accepted records; null: not recorded. */
  rowsChanged: number | null;
}

/** A coverage-gap verification that names the run, as stored on its incident. */
export interface RunVerification {
  exceptionId: number;
  verifiedAt: string;
  /** The dates of the run's accepted records that the verification used. */
  dates: string[];
  /** Every date the verification required. */
  requiredDates: number;
}

export interface RunOutcome {
  /** False when the run's effect was not recorded: then `effect` says so and nothing else is claimed. */
  recorded: boolean;
  effect: string;
  /** Why nothing changed, where the run's own counts say; null when they do not. */
  reason: string | null;
  /** Each verification that used the run: its incident, then what it used (the words after "Incident #N"). */
  verifications: Array<{ exceptionId: number; used: string }>;
}

export const EFFECT_NOT_RECORDED = "Effect not recorded";

const count = (n: number, one: string, many: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export function runOutcome(run: RunFacts, verifications: RunVerification[] = []): RunOutcome {
  const used = verifications.map((v) => ({
    exceptionId: v.exceptionId,
    used: `'s verification used ${dateRanges(v.dates)} (${v.dates.length} of ${v.requiredDates} dates) to clear its coverage hold`,
  }));
  if (run.rowsChanged === null) return { recorded: false, effect: EFFECT_NOT_RECORDED, reason: null, verifications: used };
  if (run.rowsChanged > 0) return { recorded: true, effect: count(run.rowsChanged, "change to accepted records", "changes to accepted records"), reason: null, verifications: used };
  return { recorded: true, effect: "No change to accepted records", reason: noChangeReason(run), verifications: used };
}

/** Why a run that changed nothing changed nothing, from its own counts. */
function noChangeReason(run: RunFacts): string | null {
  if (run.fetched === 0) return "Nothing delivered";
  if (run.inserted === 0) return run.duplicates === run.fetched ? "Duplicate: every delivery was a version already stored" : "Nothing new stored";
  // Every stored version went to the projection and none was written: the projection keeps the
  // newest version by the source's own clock, so each was older than the one already accepted.
  if (run.projected === run.inserted) return "Stored, but a newer revision was already accepted";
  return "Stored, none accepted";
}

/** One verification as a sentence: "Incident #2455's verification used … to clear its coverage hold." */
export const verificationSentence = (v: { exceptionId: number; used: string }) => `Incident #${v.exceptionId}${v.used}.`;
