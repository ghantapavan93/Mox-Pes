import type { ReactNode } from "react";
import { ChevronRight, MapPin, Megaphone, Search, Users, type LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui";
import type { ChannelVerdicts, DecisionVerdicts, EffectivenessVerdict, IntegrityVerdict, ReadinessVerdict } from "@/lib/decision/verdicts";
import { ReasonList } from "./ReasonList";
import { customers, usd } from "./fmt";

type Tone = "good" | "warn" | "bad" | "neutral" | "accent";

const INTEGRITY: Record<IntegrityVerdict["status"], { tone: Tone; label: string }> = {
  pass: { tone: "good", label: "Pass" },
  warn: { tone: "warn", label: "Pass with caveats" },
  fail: { tone: "bad", label: "Fail" },
};
const READINESS: Record<ReadinessVerdict["status"], { tone: Tone; label: string }> = {
  ready: { tone: "good", label: "Ready" },
  not_ready: { tone: "bad", label: "Not ready" },
};
const EFFECTIVENESS: Record<EffectivenessVerdict["status"], { tone: Tone; label: string; short: string }> = {
  unknown: { tone: "neutral", label: "Unknown — no randomized experiment", short: "Unknown · no experiment" },
  measured: { tone: "accent", label: "Measured (randomized)", short: "Measured" },
};

/** A paid channel's kind, drawn as a generic mark: no platform's logo. */
const CHANNEL_ICON: Record<string, LucideIcon> = { google_search: Search, microsoft: Search, google_lsa: MapPin, meta: Users };
const TINT: Record<Tone, string> = { bad: "bg-bad-soft text-bad", warn: "bg-warn-soft text-warn", good: "bg-good-soft text-good", accent: "bg-accent-soft text-accent", neutral: "bg-surface-2 text-muted" };

/** The three verdict columns: wide enough for their longest chip, the same in the header and every row. */
const COLUMNS = "md:grid-cols-[minmax(0,1fr)_9rem_10.5rem_12.5rem_1rem]";

/** One verdict's chip in the collapsed row. Its column's name is visible on phones and read out at every width. */
function Chip({ name, tone, label }: { name: string; tone: Tone; label: string }) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className="text-[11px] text-faint md:sr-only">{name}:</span>{" "}
      <Badge tone={tone}>{label}</Badge>
    </span>
  );
}

/** One verdict's reasons in the open row: its question, its answer in words, then each check. */
function Reasons({ testId, question, answer, children }: { testId: string; question: string; answer: string; children: ReactNode }) {
  return (
    <section data-testid={testId} className="min-w-0">
      <h4 className="text-[11px] font-medium uppercase tracking-wider text-faint">{question}</h4>
      <p className="mb-1.5 mt-0.5 text-xs font-medium text-text">{answer}</p>
      {children}
    </section>
  );
}

function Row({ c }: { c: ChannelVerdicts }) {
  const blockers = c.readiness.blockers.length;
  const integrity = INTEGRITY[c.integrity.status];
  const readiness = READINESS[c.readiness.status];
  const effectiveness = EFFECTIVENESS[c.effectiveness.status];
  // The mark's tint is the row's worst verdict on the records and the evidence; the chips say which.
  const worst: Tone = integrity.tone === "bad" || readiness.tone === "bad" ? "bad" : integrity.tone === "warn" ? "warn" : "good";
  const Icon = CHANNEL_ICON[c.channelCode] ?? Megaphone;
  return (
    <li data-testid={`verdict-row-${c.channelCode}`}>
      <details className="group">
        <summary className={`grid grid-cols-[minmax(0,1fr)_1rem] items-center gap-x-3 gap-y-1.5 rounded-lg px-2 py-1.5 transition-colors duration-100 hover:bg-surface-2 ${COLUMNS}`}>
          <span className="flex min-w-0 items-center gap-2.5">
            <span aria-hidden className={`grid size-7 shrink-0 place-items-center rounded-md ${TINT[worst]}`}>
              <Icon className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-text">{c.label}</span>
              <span className="block truncate text-[11px] text-faint">
                {usd(c.spendCents)} · {customers(c.acquired, 0)} customers · {c.cacCents === null ? "no CAC" : `${usd(c.cacCents)} attributed CAC`}
              </span>
            </span>
          </span>
          <ChevronRight aria-hidden className="col-start-2 row-start-1 size-4 text-faint transition-transform duration-150 group-open:rotate-90 md:col-start-5" />
          <span className="col-span-2 flex flex-wrap items-center gap-x-3 gap-y-1 pl-[2.375rem] md:contents">
            <Chip name="Integrity" tone={integrity.tone} label={integrity.label} />{" "}
            <Chip name="Readiness" tone={readiness.tone} label={readiness.label} />{" "}
            <Chip name="Effectiveness" tone={effectiveness.tone} label={effectiveness.short} />
          </span>
        </summary>
        <div className="grid gap-4 px-2 pb-3 pt-2 md:grid-cols-3 md:pl-[2.875rem]">
          <Reasons testId="verdict-integrity" question="1 · Data integrity" answer={`${integrity.label} · ${c.integrity.reasons.length} checks`}>
            <ReasonList reasons={c.integrity.reasons} />
          </Reasons>
          <Reasons
            testId="verdict-readiness"
            question="2 · Decision readiness"
            answer={`${readiness.label} · ${blockers > 0 ? `${blockers} blocker${blockers === 1 ? "" : "s"}` : `${c.readiness.reasons.length} checks`}`}
          >
            <ReasonList reasons={c.readiness.reasons} />
          </Reasons>
          <Reasons testId="verdict-effectiveness" question="3 · Business effectiveness" answer={effectiveness.label}>
            <ReasonList reasons={c.effectiveness.reasons} />
          </Reasons>
        </div>
      </details>
    </li>
  );
}

/**
 * The three verdicts per paid-media channel, as factor rows (docs/design-system.md,
 * `VerdictMatrix`): one row per channel with its three answers as chips, each a word in its state's tint;
 * the row opens in place to the three verdicts' reasons, side by side. The verdicts stay
 * independent: a row's tint is the worst of the first two, and the chips say which.
 */
export function VerdictMatrix({ verdicts }: { verdicts: DecisionVerdicts }) {
  if (verdicts.channels.length === 0) return <p className="text-sm text-muted">No paid-media channels are defined.</p>;
  return (
    <div className="-mx-2">
      <div aria-hidden className={`hidden gap-x-3 whitespace-nowrap border-b border-border px-2 pb-2 text-[11px] font-medium uppercase tracking-wider text-faint md:grid ${COLUMNS}`}>
        <span>Paid channel</span>
        <span>1 · Data integrity</span>
        <span>2 · Decision readiness</span>
        <span>3 · Business effectiveness</span>
      </div>
      <ul className="mt-1 space-y-0.5" aria-label="Verdicts by paid channel">
        {verdicts.channels.map((c) => (
          <Row key={c.channelCode} c={c} />
        ))}
      </ul>
    </div>
  );
}
