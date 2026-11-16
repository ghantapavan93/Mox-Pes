"use client";

import Link from "next/link";
import { useRef, useState, type KeyboardEvent } from "react";
import { ArrowRight, Check, CheckCircle2, X, XCircle } from "lucide-react";
import type { DayEvidence, DayMark, WindowFacts } from "@/lib/reconcile/gap-days";

/** A date of the window as the strip draws it: its evidence, whether it is in the selected week, and where its records open. */
export interface StripDay extends DayEvidence {
  inWeek: boolean;
  records: { href: string; week: string } | null;
}

// A mark's outline is a border, so the ring stays free for the selection alone.
const MARK_STYLE: Record<DayMark, string> = {
  verified: "border border-good bg-good text-white",
  missing: "border border-bad/45 text-bad",
  zero: "border border-border-strong bg-sunken text-muted",
};
// Missing is hatched as well as outlined: a day with no record never looks like a filled one.
const HATCH = { backgroundImage: "repeating-linear-gradient(135deg, var(--bad-soft) 0 3px, var(--surface) 3px 6px)" };
const CHIP: Record<DayMark, string> = { verified: "bg-good-soft text-good", missing: "bg-bad-soft text-bad", zero: "bg-surface-2 text-muted" };

function Glyph({ mark }: { mark: DayMark }) {
  if (mark === "verified") return <Check aria-hidden className="size-3.5" strokeWidth={3} />;
  if (mark === "missing") return <X aria-hidden className="size-3.5" strokeWidth={2.5} />;
  return (
    <span aria-hidden className="text-[11px] font-semibold tabular-nums">
      0
    </span>
  );
}

/**
 * The decision window as a strip of dates (docs/agent-work/HOLD-TO-DECISION.md §9). Each date is a
 * radio in one group: arrow keys move between dates, the selection follows focus, and the date's
 * evidence is read out below: what arrived, why it did or did not count, what clears it. The two
 * facts a reader must not confuse sit side by side under the strip: the week they picked, and the
 * window the decision needs. Everything shown here comes from the server; this only selects.
 */
export function DecisionWindow({
  days,
  facts,
  defaultDate,
  verifiedNote,
}: {
  days: StripDay[];
  facts: WindowFacts;
  defaultDate: string | null;
  /** "Verified Oct 31, 1:15 PM UTC" once the incident verified the window; null before. */
  verifiedNote: string | null;
}) {
  // No date is open until one needs attention (`defaultDate`) or the reader picks one.
  const [selected, setSelected] = useState<string | null>(defaultDate);
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = days.findIndex((d) => d.date === selected);
  const day = selectedIndex >= 0 ? days[selectedIndex] : null;
  // The group's one tab stop: the selected date, or the first while none is selected.
  const tabStop = selectedIndex >= 0 ? selectedIndex : 0;

  const moveTo = (i: number) => {
    const next = days[Math.min(days.length - 1, Math.max(0, i))];
    if (!next) return;
    setSelected(next.date);
    buttons.current[days.indexOf(next)]?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const at = buttons.current.indexOf(e.target as HTMLButtonElement);
    const from = at >= 0 ? at : tabStop;
    const keys: Record<string, number> = { ArrowRight: from + 1, ArrowDown: from + 1, ArrowLeft: from - 1, ArrowUp: from - 1, Home: 0, End: days.length - 1 };
    if (!(e.key in keys)) return;
    e.preventDefault();
    moveTo(keys[e.key]);
  };

  const { counts, window: w, week } = facts;
  const legend: Array<[DayMark, string, number]> = [
    ["verified", "Verified", counts.verified],
    ["missing", "No record", counts.missing],
    ["zero", "Recorded $0.00", counts.zero],
  ];

  return (
    <section aria-labelledby="window-title" className="rounded-xl bg-surface p-4 ring-1 ring-text/10 sm:p-5" data-testid="decision-window">
      <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h3 id="window-title" className="text-[15px] font-semibold leading-6 tracking-tight text-text">
          Decision window <span className="font-normal text-muted">· {w.label}</span>
        </h3>
        {/* The legend carries the counts: it is the strip's summary, not decoration. */}
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted" data-testid="window-legend">
          {legend.map(([mark, label, value]) => (
            <li key={mark} className="inline-flex items-center gap-1.5">
              <span aria-hidden className={`grid size-3.5 place-items-center rounded-[4px] ${MARK_STYLE[mark]}`} style={mark === "missing" ? HATCH : undefined} />
              {label} <span className="font-semibold tabular-nums text-text">{value}</span>
            </li>
          ))}
        </ul>
      </header>

      <p id="window-keys" className="sr-only">
        Use the arrow keys to move between dates; the date&apos;s evidence follows below.
      </p>
      <div
        role="radiogroup"
        aria-labelledby="window-title"
        aria-describedby="window-keys"
        onKeyDown={onKeyDown}
        className="mt-4 grid grid-cols-9 gap-1 sm:gap-1.5 md:grid-cols-18"
        data-testid="window-strip"
      >
        {days.map((d, i) => {
          const isSelected = i === selectedIndex;
          return (
            <button
              key={d.date}
              ref={(el) => {
                buttons.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={isSelected}
              aria-label={`${d.ariaLabel}${d.inWeek ? "; in the selected week" : ""}`}
              tabIndex={i === tabStop ? 0 : -1}
              onClick={() => setSelected(d.date)}
              data-date={d.date}
              data-mark={d.mark}
              className="group flex min-w-0 flex-col items-center gap-1 rounded-lg pb-1 pt-0.5 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              <span
                className={`grid h-9 w-full place-items-center rounded-md transition-shadow duration-150 motion-reduce:transition-none ${MARK_STYLE[d.mark]} ${
                  // Keyboard focus draws its own outline around the date, so the ring steps aside then.
                  isSelected ? "ring-2 ring-accent ring-offset-2 ring-offset-surface group-focus-visible:ring-transparent" : "group-hover:ring-2 group-hover:ring-accent/35"
                }`}
                style={d.mark === "missing" ? HATCH : undefined}
              >
                <Glyph mark={d.mark} />
              </span>
              <span className={`text-[11px] tabular-nums leading-4 ${isSelected ? "font-semibold text-text" : "text-muted"}`}>{d.dayOfMonth}</span>
              <span aria-hidden className={`h-1 w-full rounded-full ${d.inWeek ? "bg-accent" : "bg-transparent"}`} />
            </button>
          );
        })}
      </div>

      {/* The two scopes, side by side: what the reader picked, and what the decision needs. */}
      <div className="mt-4 grid gap-2 sm:grid-cols-2" data-testid="window-compare">
        {week && (
          <Fact
            ok={week.complete}
            title={week.complete ? "Selected week covered" : "Selected week not covered"}
            detail={`${week.label} · ${week.verified} of ${week.total} date${week.total === 1 ? "" : "s"} verified`}
            marker
            testId="fact-week"
          />
        )}
        <Fact
          ok={w.complete}
          title={w.complete ? "Decision window complete" : "Decision window incomplete"}
          detail={w.complete ? `${w.label} · all ${w.total} dates verified${verifiedNote ? ` · ${verifiedNote}` : ""}` : `${w.label} · ${w.verified} of ${w.total} verified · ${w.openLabel} open`}
          testId="fact-window"
        />
      </div>

      {/* The selected date's evidence, in a live region so a date picked by key is read out. With
          nothing unresolved no date opens by itself, and what moved keeps the first screen. */}
      <div aria-live="polite" data-testid="day-panel">
      {!day ? (
        <p className="mt-3 text-xs leading-5 text-muted" data-testid="day-hint">
          {days.every((d) => !d.unresolved) ? "Every date is verified. Select one to see the record behind it." : "Select a date to see its evidence."}
        </p>
      ) : (
        <div role="region" aria-labelledby="day-title" className="mt-4 rounded-lg bg-surface-2 p-4" data-testid="day-evidence" data-date={day.date}>
          <div className="flex flex-wrap items-center gap-2">
            <h4 id="day-title" className="text-sm font-semibold text-text">
              {day.long}
            </h4>
            <span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${CHIP[day.mark]}`}>{day.stateLabel}</span>
          </div>
          <dl className="mt-3 grid gap-x-6 gap-y-2.5 text-sm leading-6 sm:grid-cols-[9.5rem_minmax(0,1fr)]">
            <dt className="text-[11px] font-medium uppercase tracking-wider text-muted sm:pt-1">Received</dt>
            <dd className="min-w-0 text-text" data-testid="day-received">
              <ul className="space-y-1">
                {day.received.map((r, i) => (
                  <li key={i} className="[overflow-wrap:anywhere]">
                    {r.text}
                    {r.rawEventId !== null && <span className="ml-1.5 font-mono text-xs text-muted">raw #{r.rawEventId}</span>}
                  </li>
                ))}
              </ul>
            </dd>
            <dt className="text-[11px] font-medium uppercase tracking-wider text-muted sm:pt-1">{day.unresolved ? "Why it does not count" : "Why it counts"}</dt>
            <dd className="text-text" data-testid="day-why">
              {day.why}
            </dd>
            <dt className="text-[11px] font-medium uppercase tracking-wider text-muted sm:pt-1">What clears it</dt>
            <dd className="text-text" data-testid="day-clears">
              {day.clears}
            </dd>
          </dl>
          {day.records && (
            <Link href={day.records.href} className="mt-3 inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline" data-testid="day-records">
              Open the records for {day.records.week}
              <ArrowRight aria-hidden className="size-3.5" />
            </Link>
          )}
        </div>
      )}
      </div>
    </section>
  );
}

function Fact({ ok, title, detail, marker, testId }: { ok: boolean; title: string; detail: string; marker?: boolean; testId: string }) {
  const Icon = ok ? CheckCircle2 : XCircle;
  return (
    <div className={`flex items-start gap-2.5 rounded-lg px-3 py-2.5 ${ok ? "bg-good-soft" : "bg-bad-soft"}`} data-testid={testId} data-ok={ok}>
      <Icon aria-hidden className={`mt-0.5 size-4 shrink-0 ${ok ? "text-good" : "text-bad"}`} />
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-sm font-semibold text-text">
          {marker && <span aria-hidden className="h-1 w-3 rounded-full bg-accent" />}
          {title}
        </p>
        <p className="text-xs leading-5 text-muted">{detail}</p>
      </div>
    </div>
  );
}
