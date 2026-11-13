import { date, money } from "@/lib/format";
import type { ChangedLead, DriftCaseView } from "./review";

/**
 * The words of a drift case's decision brief, built only from the stored case (./review.ts):
 * nothing here knows the demo's branches, campaigns or leads.
 *
 * Three things stay apart, in the page and in these words:
 *   * the SYSTEM FINDING: what the post-release check confirmed (and that it changed nothing);
 *   * the HUMAN DISPOSITION: what a person decided, or that no one has yet;
 *   * the BUSINESS OUTCOME: no revenue impact was measured; spend at stake is not a loss; a
 *     revision is not proof the mapping is wrong.
 * IDs, raw rows, exact times and lineage stay out of the headline.
 */

export type BriefState = "open" | "reviewed" | "investigating" | "reopened";

export interface Brief {
  state: BriefState;
  status: { label: string; tone: "warn" | "good" | "bad" };
  headline: string;
  detail: string;
  /** Reopened only: what is new since the last review, said first. */
  whatsNew: string | null;
  finding: string;
  disposition: string;
  outcome: string;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const spell = (n: number) => (["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"][n] ?? String(n));

/** The latest human decision wins: a reopened case someone has since put under investigation is "investigating". */
export function briefState(view: Pick<DriftCaseView, "state" | "reopened" | "decision">): BriefState {
  if (view.state === "closed_acknowledged") return "reviewed";
  if (view.state === "investigating" && view.decision) return "investigating";
  if (view.reopened) return "reopened";
  if (view.state === "investigating") return "investigating";
  return "open";
}

/** "One lead changed branches", "Two leads arrived outside the approved branches", … */
function leadsSentence(leads: ChangedLead[], hidden: number): string {
  const n = leads.length + hidden;
  if (n === 0) return "The leads the release relied on changed";
  const revised = leads.filter((l) => l.branchAtRelease !== null && l.branchAtRelease !== l.branchNow).length;
  if (hidden === 0 && revised === n) return `${spell(n)} ${plural(n, "lead", "leads")} changed branches`;
  if (hidden === 0 && revised === 0) return `${spell(n)} ${plural(n, "lead", "leads")} arrived outside the approved branches`;
  return `${spell(n)} ${plural(n, "lead", "leads")} now ${plural(n, "points", "point")} outside the approved branches`;
}

/** A newer ChangeGuard release set the live mapping (this change was replaced, e.g. by a compensating change). */
const replacedBy = (view: DriftCaseView): number | null =>
  view.change.liveChangeId !== null && view.change.liveChangeId !== view.change.id ? view.change.liveChangeId : null;

function mappingSentence(view: DriftCaseView): string {
  const c = view.change;
  if (c.unchanged) return `The mapping stayed at ${c.releasedBranch}.`;
  const where = c.liveBranch ?? "a branch outside your scope";
  const newer = replacedBy(view);
  if (newer !== null) return `The mapping is now ${where}, set by change #${newer} after this one.`;
  if (c.liveBranch) return `The mapping is now ${c.liveBranch}, not the ${c.releasedBranch} this change released.`;
  return "The mapping moved to a branch outside your scope.";
}

export function briefCopy(view: DriftCaseView): Brief {
  const state = briefState(view);
  const c = view.change;
  const n = view.leads.length + view.hiddenLeads;
  const latest = view.latest;
  // No lead outside the approved branches: the contradiction is the share of leads at the released branch.
  const shareSentence =
    latest && n === 0 && !view.mappingMoved
      ? `Fewer of the campaign's leads arrive at ${c.releasedBranch}: ${latest.atTarget} of ${latest.total} now, ${view.release.atTarget} of ${view.release.total} at release`
      : null;
  const headline =
    view.mappingMoved && !c.unchanged
      ? mappingSentence(view)
      : `${shareSentence ?? leadsSentence(view.leads, view.hiddenLeads)}. ${mappingSentence(view)}`;

  const revisedVisible = view.leads.filter((l) => l.branchAtRelease !== null && l.branchAtRelease !== l.branchNow);
  const detailParts: string[] = [];
  if (revisedVisible.length === 1 && n === 1) {
    const l = revisedVisible[0];
    detailParts.push(`A ${l.noun.toLowerCase()} that arrived at ${l.branchAtRelease} was revised at the source to point to ${l.branchNow}.`);
  } else if (view.leads.length > 0) {
    detailParts.push(
      revisedVisible.length === view.leads.length
        ? "Each lead below was revised at the source after the release."
        : "Each lead below was revised at the source, or first arrived, after the release.",
    );
  }
  if (view.hiddenLeads > 0) detailParts.push(`${spell(view.hiddenLeads)} ${plural(view.hiddenLeads, "lead points", "leads point")} to a branch outside your scope.`);
  const newer = replacedBy(view);
  detailParts.push(
    c.unchanged
      ? `The live mapping of ${c.campaign}, read now, is still ${c.releasedBranch}${c.liveVersion !== null ? ` (version ${c.liveVersion})` : ""}, as released; no check changed it.`
      : newer !== null
        ? `Change #${newer} replaced this change's mapping; no check changed it.`
        : "No ChangeGuard release made this move; no check changed it.",
  );

  let whatsNew: string | null = null;
  if (view.reopened) {
    const k = view.reopened.newLeads;
    const others = view.reopened.otherNewFacts.length;
    whatsNew =
      k > 0
        ? `New since the last review: ${k === 1 ? "one more lead" : `${spell(k).toLowerCase()} more leads`} ${plural(k, "points", "point")} outside the approved branches.`
        : others > 0
          ? "New since the last review: the evidence changed in a way that review did not see."
          : "New since the last review.";
  }

  const finding = latest
    ? `Check #${latest.runId} on ${date(latest.ranAt)} confirmed a change in the evidence the release was approved on. The check changed nothing.`
    : "No check has confirmed a drift on this case.";

  const decided = view.decision;
  const disposition =
    state === "reviewed" && decided
      ? `Reviewed — no mapping change, by ${decided.actorLabel} on ${date(decided.reviewedAt)}.`
      : state === "investigating" && decided
        ? `Needs investigation — owned by ${decided.ownerLabel ?? "an unassigned role"} since ${date(decided.reviewedAt)}.`
        : state === "reopened" && view.reopened
          ? `Reopened by new evidence on ${date(view.reopened.at)}. The review of ${date(view.reopened.previous.reviewedAt)} is kept below.`
          : "Open — no one has reviewed it yet.";

  // "Revision" only when every visible lead was revised at the source; a lead that first arrived
  // elsewhere, or one the viewer cannot see, is just "a lead outside the approved branches".
  const allRevised = view.hiddenLeads === 0 && view.leads.length > 0 && view.leads.every((l) => l.branchAtRelease !== null && l.branchAtRelease !== l.branchNow);
  const notProof =
    n === 0
      ? "A change in the evidence does not show the mapping is wrong."
      : allRevised
        ? `${n === 1 ? "One source revision does" : `${spell(n)} source revisions do`} not show the mapping is wrong.`
        : `${n === 1 ? "One lead" : `${spell(n)} leads`} outside the approved branches ${n === 1 ? "does" : "do"} not show the mapping is wrong.`;
  const outcome = `No revenue impact was measured from this finding. ${money(view.spendAtStakeCents)} of the campaign's spend is at stake, not lost. ${notProof}`;

  const status =
    state === "reviewed"
      ? { label: "Reviewed — no mapping change", tone: "good" as const }
      : state === "reopened"
        ? { label: "Reopened — new evidence", tone: "bad" as const }
        : state === "investigating"
          ? { label: "Needs investigation", tone: "warn" as const }
          : { label: "Needs review", tone: "warn" as const };

  return { state, status, headline, detail: detailParts.join(" "), whatsNew, finding, disposition, outcome };
}
