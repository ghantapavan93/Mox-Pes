import type { GapStatus } from "@/lib/reconcile/gap-status";
import type { Cell, Marker, Movement, Series, WeekInfo } from "./movement";

/**
 * The words around the "What changed" chart, built only from the scoped Movement (./movement.ts):
 * the takeaway before the chart, whether the figures support an action or call for review, and
 * the explanation of one selected point. Pure, so the same values the chart draws are the values
 * the sentences use. Nothing here names a demo branch, campaign or date. A coverage gap's decision
 * status is the incident's own (lib/reconcile/gap-status.ts), quoted, never recomputed here.
 */

export interface Takeaway {
  headline: string;
  detail: string | null;
  /** The decision status: a label that reads without colour, why, and the incident it rests on (its evidence link). */
  trust: { tone: "review" | "clear" | "unknown"; label: string; text: string; exceptionId?: number };
  /** A held branch to look at next (company or brand scope only). */
  suggestion: { branchId: string; label: string } | null;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A coverage gap's status as the Overview's one-line decision status. */
function gapTrust(s: GapStatus): Takeaway["trust"] {
  return {
    tone: s.state === "verified" ? "clear" : "review",
    label: s.label,
    text: s.state === "verified" && s.change ? `${s.statusText} ${s.change}` : s.statusText,
    exceptionId: s.exceptionId,
  };
}

/** "$4,539.34": exact cents in words a reader checks against records. */
export const dollars = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const day = (isoDate: string) => new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
/** The day before an ISO date: a coverage gap's stored start is its first day WITHOUT spend. */
const dayBefore = (isoDate: string) => day(new Date(Date.parse(`${isoDate}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10));
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export const shortDay = day;

export function weekLabel(w: Pick<WeekInfo, "start" | "end">): string {
  return `${day(w.start)}–${day(w.end)}`;
}

function changeWord(now: number, before: number): string {
  if (before === 0) return now === 0 ? "no change" : "up from nothing";
  const pct = Math.round(((now - before) / before) * 100);
  return pct === 0 ? "about the same as September" : `${pct > 0 ? "+" : "−"}${Math.abs(pct)}% vs September`;
}

/** The coverage gap a marker records, read against the chart's own cells. */
function gapStory(m: Movement, marker: Marker, scopeLabel: string): Takeaway | null {
  const s = m.series.find((x) => x.channel === marker.channel);
  if (!s) return null;
  const after = s.cells.filter((c) => c.week > marker.week);
  const stopped = after.length > 0 && after.every((c) => c.status === "missing" || c.status === "not_delivered");
  const leadsAfter = s.cells.filter((c) => c.week >= marker.week).reduce((t, c) => t + c.leads, 0);
  // The incident's own status, when the movement read it: its decision window as the records cover
  // it now. Without it (a fixture, or evidence without a window) the marker's stored finding stands.
  const recovery = m.recoveries?.find((r) => r.exceptionId === marker.exceptionId && r.held) ?? null;
  const partlyBack = recovery !== null && recovery.covered.length > 0 && recovery.openLabel !== "";
  const headline = partlyBack
    ? `${marker.channelLabel} spend at ${scopeLabel} stopped after ${dayBefore(marker.date)}; since then only ${recovery.coveredLabel} ${recovery.covered.length === 1 ? "has" : "have"} any.`
    : stopped
      ? `${marker.channelLabel} spend at ${scopeLabel} stopped after ${dayBefore(marker.date)}${leadsAfter > 0 ? " while its leads kept arriving" : ""}.`
      : `${marker.channelLabel} spend at ${scopeLabel} changed from ${day(marker.date)}.`;
  const succ = marker.successors.filter((x) => x.spendSinceCents > 0);
  const detail = recovery?.change
    ? `${recovery.change}${recovery.misfiledCents > 0 ? ` Cost per customer is wrong for both channels until it is all filed as ${marker.channelLabel}.` : ""}`
    : succ.length > 0
      ? `${succ.map((x) => `${dollars(x.spendSinceCents)} has since been spent under ${x.externalCampaignId}${x.classifiedAs.length ? `, which is filed as ${x.classifiedAs.join(" and ")}` : ""}`).join("; ")}. Until it is re-mapped, cost per customer is wrong for both channels.`
      : null;
  return {
    headline,
    detail,
    trust: recovery
      ? gapTrust(recovery)
      : {
          tone: marker.status === "open" ? "review" : "clear",
          label: marker.status === "open" ? "Investigate before acting" : "Incident closed",
          text:
            marker.status === "open"
              ? `An open incident records a coverage gap here from ${day(marker.date)}. This is a number to investigate, not a budget movement to act on.`
              : `A ${marker.status} incident recorded a coverage gap here from ${day(marker.date)}.`,
        },
    suggestion: null,
  };
}

export function takeaway(m: Movement, scopeLabel: string): Takeaway {
  const stale = m.feedStale
    ? { tone: "unknown" as const, label: "Spend may be incomplete", text: `${m.feedStale} The latest weeks may be missing records.` }
    : null;
  const open = m.markers.filter((x) => x.status === "open").sort((a, b) => b.date.localeCompare(a.date));
  if (open[0]) {
    const story = gapStory(m, open[0], scopeLabel);
    if (story) return stale && story.trust.tone !== "review" ? { ...story, trust: stale } : story;
  }

  const total = m.totals.periodCents;
  const headline =
    m.totals.compareCents !== null
      ? `Paid media spend at ${scopeLabel}: ${dollars(total)} in ${m.period.label.split(",")[0]}, ${changeWord(total, m.totals.compareCents)}.`
      : `Paid media spend at ${scopeLabel}: ${dollars(total)} in ${m.period.label}.`;
  // The largest channel movement, when there is a comparison period.
  let detail: string | null = null;
  if (m.totals.compareCents !== null && m.series.length > 0) {
    const moved = [...m.series].sort((a, b) => Math.abs(b.periodCents - (b.compareCents ?? 0)) - Math.abs(a.periodCents - (a.compareCents ?? 0)))[0];
    const delta = moved.periodCents - (moved.compareCents ?? 0);
    if (delta !== 0) detail = `The largest change by channel: ${moved.label}, ${delta > 0 ? "+" : "−"}${dollars(Math.abs(delta))}.`;
  }
  const heldBranches = [...new Set(m.holds.map((h) => h.branchId))];
  // Recommendations the records hold with no incident (held spend, none recorded, cost at another
  // branch): said beside the incidents, so "no open incident" is never read as "nothing holds it".
  const evidence = m.evidenceHolds ?? [];
  const evidenceOnly = [...new Set(evidence.map((h) => h.branchId))].filter((b) => !heldBranches.includes(b));
  const alsoHeld =
    m.scope.branchId !== null
      ? evidence[0]
        ? ` ${evidence[0].label}'s cost here cannot be counted yet either (${evidence[0].short}).`
        : ""
      : evidenceOnly.length > 0
        ? ` ${evidenceOnly.slice(0, 4).join(", ")}${evidenceOnly.length > 4 ? "…" : ""} also ${evidenceOnly.length === 1 ? "has" : "have"} a channel whose cost the records cannot count yet.`
        : "";
  // A coverage gap the chart marks that was verified (or whose verification is now historical):
  // its status is the decision status, so the reader sees what cleared and that spend moved.
  const cleared = m.recoveries?.find((r) => r.state === "verified" || r.state === "historical") ?? null;
  // At one branch, the decision first: what holds it, in the holding incident's own words; then
  // any coverage hold that cleared, which is not the same thing as the decision being free.
  const first = m.holds[0];
  const trust: Takeaway["trust"] =
    m.holds.length > 0
      ? m.scope.branchId !== null
        ? {
            tone: "review" as const,
            label: "Hold the budget decision",
            text: `${m.holds.length === 1 ? `Incident #${first.exceptionId} holds it` : `${plural(m.holds.length, "open incident")} hold it, first #${first.exceptionId}`}: ${first.summary.replace(/\.$/, "")}.${cleared ? ` ${capital(cleared.conclusion)}` : ""}${alsoHeld}`,
            exceptionId: first.exceptionId,
          }
        : {
            tone: "review" as const,
            label: "Investigate before acting",
            text: `${plural(heldBranches.length, "branch", "branches")} in this scope ${heldBranches.length === 1 ? "has" : "have"} an open incident that holds its budget decision: ${heldBranches.slice(0, 4).join(", ")}${heldBranches.length > 4 ? "…" : ""}. Channel totals here include ${heldBranches.length === 1 ? "it" : "them"}.${alsoHeld}`,
          }
      : evidence.length > 0
        ? m.scope.branchId !== null
          ? {
              tone: "review" as const,
              label: "Hold the budget decision",
              text: `No incident is open, but the records hold it: ${evidence[0].summary}${evidence.length > 1 ? ` ${plural(evidence.length - 1, "other channel")} too.` : ""}`,
            }
          : {
              tone: "review" as const,
              label: "Investigate before acting",
              text: `${plural(evidenceOnly.length, "branch", "branches")} in this scope ${evidenceOnly.length === 1 ? "has" : "have"} a channel whose cost the records cannot count yet, which holds its budget decision: ${evidenceOnly.slice(0, 4).join(", ")}${evidenceOnly.length > 4 ? "…" : ""}. Channel totals here leave that cost out.`,
            }
        : (stale ?? (cleared ? gapTrust(cleared) : { tone: "clear" as const, label: "No open incident affects these figures", text: "Nothing open changes what these channels cost. The figures are the stored spend records, not a forecast." }));
  const firstHeld = heldBranches[0] ?? evidenceOnly[0];
  const suggestion = m.scope.branchId === null && firstHeld ? { branchId: firstHeld, label: `See what changed at ${firstHeld}` } : null;
  return { headline, detail, trust, suggestion };
}

/** The selected point's heading: channel, scope and week. */
export function pointTitle(series: Pick<Series, "label">, week: WeekInfo, scopeLabel: string): string {
  return `${series.label} at ${scopeLabel} · ${weekLabel(week)}`;
}

/**
 * One point of the chart in one sentence: channel, scope, the week's dates, then its value in US
 * dollars and its state, in `explainCell`'s words. The point's tooltip and the selection panel
 * both show exactly this, so a reader gets the same words whether they hover, tap or use the
 * keyboard (release design §5.7).
 */
export function cellSentence(series: Pick<Series, "label" | "channel">, cell: Cell, week: WeekInfo, markers: Marker[], scopeLabel: string): string {
  const [fact] = explainCell(series, cell, week, markers);
  return `${pointTitle(series, week, scopeLabel)}: ${fact}`;
}

/**
 * One point of the chart, in words, with the same values the chart and the table show. The
 * heading (`pointTitle`) names the channel, scope and week; these lines start with the fact.
 */
export function explainCell(series: Pick<Series, "channel">, cell: Cell, week: WeekInfo, markers: Marker[]): string[] {
  const lines: string[] = [];
  switch (cell.status) {
    case "recorded":
      lines.push(`${dollars(cell.cents!)}, from spend records on all ${plural(cell.daysDelivered, "day")} the feed has delivered.`);
      break;
    case "partial":
      lines.push(
        cell.cents === 0
          ? `$0.00, recorded on ${cell.daysWithRecord} of ${plural(cell.daysDelivered, "day")}: the platform reported zero. The other ${plural(cell.daysDelivered - cell.daysWithRecord, "day")} have no spend record, which is not the same as zero.`
          : `${dollars(cell.cents!)}, from records on ${cell.daysWithRecord} of ${plural(cell.daysDelivered, "day")}. The other ${plural(cell.daysDelivered - cell.daysWithRecord, "day")} have no spend record.`,
      );
      break;
    case "zero":
      lines.push(`$0.00, recorded: the platform reported spend on ${cell.daysWithRecord} of ${plural(cell.daysDelivered, "day")}, and it was zero.`);
      break;
    case "missing":
      // Not "nothing was delivered": the feed can deliver a day's spend filed under another channel
      // (B09-RECOVERY.md). The records say only that this channel has none here.
      lines.push(`No spend record on any of its ${plural(cell.daysDelivered, "day")}. This is not $0: no record here says what this channel spent.`);
      break;
    case "not_delivered":
      lines.push("The ads feed has not delivered this week yet. Unknown, not zero.");
      break;
  }
  // "On the chart", not "in the window": a coverage gap's decision window is another scope.
  if (week.days < 7) lines.push(`Only ${plural(week.days, "day")} of this week are on the chart, so it is a partial week.`);
  if (cell.leads > 0) lines.push(`${plural(cell.leads, "lead record")} from this channel arrived here that week (a count, not dollars).`);
  for (const m of markers.filter((x) => x.week === cell.week && x.channel === series.channel)) {
    lines.push(`Incident #${m.exceptionId} (${m.status}) records a coverage gap from ${day(m.date)}, in this week.`);
  }
  return lines;
}
