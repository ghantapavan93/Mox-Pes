"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { buttonClass } from "@/components/ui";
import { rememberFocus, restoreRememberedFocus } from "@/components/useRestoreFocus";
import { cellSentence, dollars, explainCell, weekLabel } from "@/lib/metrics/movement-copy";
import type { Cell, Marker, Series, WeekInfo } from "@/lib/metrics/movement";

/**
 * The "What changed" chart: paid media spend per week, one line per channel, one unit (US
 * dollars). A week without a spend record is a gap in its line, never a point at $0; a recorded
 * $0 is a point on the axis.
 *
 * Select, then open (release design §5.7). Hovering a point shows its sentence; clicking or tapping
 * it, or choosing a channel and a week with the buttons below the chart, selects it, and the panel
 * shows the same sentence and offers its stored records ("Open evidence"). The buttons are the
 * keyboard path: each row is one tab stop, arrows move within it. The selection lives in the URL
 * (`channel`, `week`) without a server round trip and is read back from it, so Back shows what its
 * URL names even when the page comes from the browser's cache, with focus on "Open evidence".
 */

export interface Selection {
  channel: string;
  week: string;
}

/**
 * One colour for the channel in focus (the selected one, or the one an incident names); the others
 * are grey, told apart by dash pattern and label. Amber and green mean states on this page (unknown
 * source, good), so a channel never borrows them.
 */
const FOCUS = "var(--chart-paid)";
const OTHER = "var(--muted)";
const DASHES = ["", "6 3", "2 3", "8 3 2 3"];
const OPEN_EVIDENCE_ID = "movement-open-evidence";

function niceMax(cents: number): number {
  const dollarsMax = Math.max(1, cents / 100);
  const step = 10 ** Math.floor(Math.log10(dollarsMax));
  const top = Math.ceil(dollarsMax / step) * step;
  return top * 100;
}

/** Arrows, Home and End move focus within one row of buttons; Tab leaves the row. Enter or Space activates. */
function rovingIndex(e: KeyboardEvent<HTMLElement>, count: number, index: number): number | null {
  const next =
    e.key === "ArrowRight" || e.key === "ArrowDown" ? index + 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? index - 1 : e.key === "Home" ? 0 : e.key === "End" ? count - 1 : null;
  if (next === null) return null;
  e.preventDefault();
  return (next + count) % count;
}

export function MovementChart({
  weeks,
  series,
  markers,
  scopeLabel,
  initial,
  defaultChannel,
  evidenceBase,
  periodLabel,
  windowNotes = {},
}: {
  weeks: WeekInfo[];
  series: Series[];
  markers: Marker[];
  scopeLabel: string;
  initial: Selection | null;
  /** The channel the week buttons act on before anything is selected (the one an incident names, else the largest). */
  defaultChannel: string;
  /** The branch trace for this scope and period ("…/trace?period=oct&metric=paid_spend"), or null when no single branch is selected. */
  evidenceBase: string | null;
  periodLabel: string;
  /**
   * "channel|week" → how that week stands against the channel's decision window (an incident's
   * required dates), written on the server from the incident's status. The selected week is a
   * viewing filter; the note keeps it apart from the window the decision rests on.
   */
  windowNotes?: Record<string, string>;
}) {
  // The URL names the selection; the server's props name it for the first render. A Back served
  // from the browser's cache can carry older props, so the URL is read as well and wins.
  const params = useSearchParams();
  const urlSel = useMemo<Selection | null>(() => {
    const c = params.get("channel");
    const w = params.get("week");
    return c && w && series.some((s) => s.channel === c) && weeks.some((x) => x.start === w) ? { channel: c, week: w } : null;
  }, [params, series, weeks]);
  const [sel, setSel] = useState<Selection | null>(urlSel ?? initial);
  const [channel, setChannel] = useState<string>((urlSel ?? initial)?.channel ?? defaultChannel);
  // When the URL changes under the chart (Back, Forward), its selection is adopted during render.
  const urlKey = urlSel ? `${urlSel.channel}|${urlSel.week}` : "";
  const [seenUrlKey, setSeenUrlKey] = useState(urlKey);
  if (urlKey !== seenUrlKey) {
    setSeenUrlKey(urlKey);
    if (urlSel) {
      setSel(urlSel);
      setChannel(urlSel.channel);
    }
  }

  const liveRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const channelRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const weekRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const titleId = useId();
  const [hover, setHover] = useState<{ channel: string; week: string; left: number; top: number } | null>(null);

  const select = useCallback((next: Selection | null) => {
    setSel(next);
    if (next) setChannel(next.channel);
    // The selection lives in the URL (native history API: no server round trip, no new entry).
    try {
      const url = new URL(window.location.href);
      if (next) {
        url.searchParams.set("channel", next.channel);
        url.searchParams.set("week", next.week);
      } else {
        url.searchParams.delete("channel");
        url.searchParams.delete("week");
      }
      url.hash = "movement";
      window.history.replaceState(null, "", url.toString());
    } catch {
      // A URL the browser will not rewrite: the selection still works on the page.
    }
  }, []);

  // Back to a selection: focus returns to the control that left ("Open evidence"); arriving from
  // the evidence page's own link (#movement), it goes to the explained point instead.
  useEffect(() => {
    if (restoreRememberedFocus()) return;
    if (initial && window.location.hash === "#movement") liveRef.current?.focus();
  }, [initial]);

  // Geometry.
  const W = 640;
  const H = 240;
  const pad = { l: 52, r: 16, t: 18, b: 28 };
  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.cells.map((c) => c.cents ?? 0))));
  const x = (i: number) => pad.l + (weeks.length === 1 ? 0 : (i * (W - pad.l - pad.r)) / (weeks.length - 1));
  const y = (cents: number) => pad.t + (1 - cents / max) * (H - pad.t - pad.b);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(max * f));
  const periodIdx = weeks.map((w, i) => (w.inPeriod ? i : -1)).filter((i) => i >= 0);
  const xOfDate = (isoDate: string) => {
    const i = weeks.findIndex((w) => w.start <= isoDate && isoDate <= w.end);
    if (i < 0) return null;
    const offset = (Date.parse(`${isoDate}T00:00:00Z`) - Date.parse(`${weeks[i].start}T00:00:00Z`)) / (7 * 86_400_000);
    return x(i) + offset * (weeks.length > 1 ? x(1) - x(0) : 0);
  };

  const cellAt = useCallback(
    (s: Selection) => {
      const se = series.find((x) => x.channel === s.channel);
      const wi = weeks.findIndex((w) => w.start === s.week);
      return se && wi >= 0 ? { series: se, cell: se.cells[wi], week: weeks[wi], index: wi } : null;
    },
    [series, weeks],
  );
  const selected = useMemo(() => (sel ? cellAt(sel) : null), [sel, cellAt]);
  const sentenceOf = (c: NonNullable<ReturnType<typeof cellAt>>) => cellSentence(c.series, c.cell, c.week, markers, scopeLabel);
  // The panel's lines after its sentence: the rest of the explanation.
  const lines = selected ? explainCell(selected.series, selected.cell, selected.week, markers).slice(1) : [];
  const windowNote = selected ? (windowNotes[`${selected.series.channel}|${selected.week.start}`] ?? null) : null;
  const focus = sel?.channel ?? channel;
  const colorOf = (c: string) => (c === focus ? FOCUS : OTHER);
  const evidenceHref = selected && evidenceBase ? `${evidenceBase}&channel=${encodeURIComponent(selected.series.channel)}&week=${selected.week.start}` : null;
  const hovered = hover ? cellAt(hover) : null;

  // One tab stop per row: the current channel, and the selected week (else the period's first).
  const channelStop = Math.max(0, series.findIndex((s) => s.channel === channel));
  const weekStop = Math.max(0, sel ? weeks.findIndex((w) => w.start === sel.week) : weeks.findIndex((w) => w.inPeriod));
  const [channelFocus, setChannelFocus] = useState<number | null>(null);
  const [weekFocus, setWeekFocus] = useState<number | null>(null);

  /** A point's dot and its larger touch target answer the same way. */
  const pointHandlers = (s: Selection) => ({
    onClick: () => select(s),
    onPointerEnter: (e: PointerEvent<SVGCircleElement>) => showTip(e, s),
    onPointerLeave: () => setHover(null),
  });

  const showTip = (e: PointerEvent<SVGCircleElement>, s: Selection) => {
    // A tap selects and the panel says it; the tooltip is for a pointer that can hover.
    if (e.pointerType !== "mouse" || !plotRef.current) return;
    const box = plotRef.current.getBoundingClientRect();
    const dot = e.currentTarget.getBoundingClientRect();
    const half = Math.min(144, box.width / 2);
    setHover({ ...s, left: Math.min(Math.max(dot.left + dot.width / 2 - box.left, half), box.width - half), top: dot.top - box.top });
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]" data-testid="movement-chart">
      <figure className="min-w-0" aria-labelledby={titleId}>
        <figcaption id={titleId} className="text-xs text-muted">
          <span className="font-medium text-text">Paid media spend per week, by channel</span> · US dollars · {weekLabel({ start: weeks[0].start, end: weeks[weeks.length - 1].end })} · {periodLabel} shaded · a hollow point counts fewer than 7 days
        </figcaption>

        <div role="group" aria-label="Channel" className="mt-2 flex flex-wrap gap-1.5" data-testid="movement-channels">
          {series.map((s, i) => (
            <button
              key={s.channel}
              ref={(el) => {
                channelRefs.current[i] = el;
              }}
              type="button"
              aria-pressed={channel === s.channel}
              tabIndex={i === (channelFocus ?? channelStop) ? 0 : -1}
              onFocus={() => setChannelFocus(i)}
              onKeyDown={(e) => {
                const next = rovingIndex(e, series.length, i);
                if (next !== null) channelRefs.current[next]?.focus();
              }}
              onClick={() => {
                setChannel(s.channel);
                if (sel) select({ channel: s.channel, week: sel.week });
              }}
              className={`inline-flex min-h-8 items-center gap-1.5 rounded-md border px-2 text-xs font-medium ${channel === s.channel ? "border-accent bg-accent-soft text-text" : "border-border bg-surface text-muted hover:bg-surface-2"}`}
              data-channel={s.channel}
            >
              <svg aria-hidden width="18" height="8" className="shrink-0">
                <line x1="1" x2="17" y1="4" y2="4" stroke={colorOf(s.channel)} strokeWidth="2.5" strokeDasharray={DASHES[i % DASHES.length]} />
              </svg>
              {s.label}
            </button>
          ))}
        </div>

        <div ref={plotRef} className="relative mt-2">
          <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`Paid media spend per week by channel at ${scopeLabel}. A gap means no spend record. Exact values are in the table below the chart.`}>
            {periodIdx.length > 0 && (
              <rect x={x(periodIdx[0]) - 6} y={pad.t} width={x(periodIdx[periodIdx.length - 1]) - x(periodIdx[0]) + 12} height={H - pad.t - pad.b} fill="var(--accent)" opacity="0.05" />
            )}
            {ticks.map((t) => (
              <g key={t}>
                <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="var(--border)" />
                <text x={pad.l - 6} y={y(t) + 4} fontSize="10" textAnchor="end" fill="var(--faint)">
                  {t === 0 ? "$0" : `$${(t / 100).toLocaleString("en-US", { maximumFractionDigits: 0 })}`}
                </text>
              </g>
            ))}
            {weeks.map((w, i) => (
              <text key={w.start} x={x(i)} y={H - 8} fontSize="10" textAnchor="middle" fill="var(--faint)">
                {i % 2 === 0 || i === weeks.length - 1 ? new Date(`${w.start}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : ""}
              </text>
            ))}
            {markers.map((m) => {
              const mx = xOfDate(m.date);
              if (mx === null) return null;
              const right = mx > W - 180;
              return (
                <g key={m.exceptionId} data-marker={m.exceptionId}>
                  <line x1={mx} x2={mx} y1={pad.t} y2={H - pad.b} stroke="var(--bad)" strokeDasharray="3 3" />
                  <text x={right ? mx - 4 : mx + 4} y={pad.t - 6} fontSize="10" textAnchor={right ? "end" : "start"} fill="var(--bad)">
                    Coverage gap from {new Date(`${m.date}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })} · #{m.exceptionId}
                  </text>
                </g>
              );
            })}
            {/* Touch targets larger than the dots, under every line and dot, so a dot is always on top. */}
            <g data-hit-layer>
              {series.flatMap((s) =>
                s.cells.map((c, i) =>
                  c.cents === null ? null : <circle key={`${s.channel}|${c.week}`} cx={x(i)} cy={y(c.cents)} r={12} fill="transparent" className="cursor-pointer" {...pointHandlers({ channel: s.channel, week: c.week })} />,
                ),
              )}
            </g>
            {series.map((s, si) => {
              const color = colorOf(s.channel);
              const segments: string[] = [];
              let d = "";
              s.cells.forEach((c, i) => {
                if (c.cents === null) {
                  if (d) segments.push(d);
                  d = "";
                  return;
                }
                d += `${d ? "L" : "M"}${x(i)},${y(c.cents)} `;
              });
              if (d) segments.push(d);
              return (
                <g key={s.channel} data-series={s.channel} data-focus={s.channel === focus}>
                  {segments.map((p) => (
                    <path key={p} d={p} fill="none" stroke={color} strokeWidth="2.5" strokeDasharray={DASHES[si % DASHES.length]} />
                  ))}
                  {s.cells.map((c, i) =>
                    c.cents === null ? null : (
                      // Not a tab stop: the buttons are the keyboard path, the table has the values.
                      <circle
                        key={c.week}
                        cx={x(i)}
                        cy={y(c.cents)}
                        r={sel?.channel === s.channel && sel.week === c.week ? 7 : 4}
                        // Hollow when the point counts fewer than 7 days: days without a record, or a
                        // week cut by the window's edge. A solid point at the edge read as a drop.
                        fill={c.status === "partial" || weeks[i].days < 7 ? "var(--surface)" : color}
                        stroke={color}
                        strokeWidth="2"
                        className="cursor-pointer"
                        {...pointHandlers({ channel: s.channel, week: c.week })}
                        data-point={`${s.channel}|${c.week}`}
                        data-status={c.status}
                      />
                    ),
                  )}
                </g>
              );
            })}
            {selected && <line x1={x(selected.index)} x2={x(selected.index)} y1={pad.t} y2={H - pad.b} stroke="var(--accent)" strokeDasharray="2 2" />}
          </svg>
          {hover && hovered && (
            <div
              role="tooltip"
              className="pointer-events-none absolute z-10 w-max max-w-[18rem] -translate-x-1/2 -translate-y-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-xs leading-5 text-text shadow-raised"
              style={{ left: hover.left, top: hover.top - 8 }}
              data-testid="movement-tooltip"
            >
              {sentenceOf(hovered)}
            </div>
          )}
        </div>

        <div role="group" aria-label="Week" className="mt-1 flex flex-wrap gap-1" data-testid="movement-weeks">
          {weeks.map((w, i) => (
            <button
              key={w.start}
              ref={(el) => {
                weekRefs.current[i] = el;
              }}
              type="button"
              aria-pressed={sel?.week === w.start}
              tabIndex={i === (weekFocus ?? weekStop) ? 0 : -1}
              onFocus={() => setWeekFocus(i)}
              onKeyDown={(e) => {
                const next = rovingIndex(e, weeks.length, i);
                if (next !== null) weekRefs.current[next]?.focus();
              }}
              onClick={() => select({ channel, week: w.start })}
              className={`min-h-8 rounded border px-1.5 text-[11px] tabular-nums ${sel?.week === w.start ? "border-accent bg-accent text-white" : w.inPeriod ? "border-border bg-surface text-text hover:bg-surface-2" : "border-border bg-surface-2 text-muted hover:bg-surface"}`}
              data-week={w.start}
            >
              {weekLabel(w)}
            </button>
          ))}
        </div>

        <details className="mt-3 rounded-md border border-border" data-testid="movement-table">
          <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-text">Exact weekly values (the chart&apos;s data)</summary>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[34rem] border-collapse text-xs">
              <caption className="sr-only">Paid media spend per week by channel at {scopeLabel}</caption>
              <thead>
                <tr className="border-y border-border text-left text-muted">
                  <th scope="col" className="px-3 py-1.5 font-semibold">Week</th>
                  {series.map((s) => (
                    <th key={s.channel} scope="col" className="px-3 py-1.5 text-right font-semibold">{s.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {weeks.map((w, wi) => (
                  <tr key={w.start} className={`border-b border-border last:border-b-0 ${w.inPeriod ? "" : "text-muted"}`}>
                    <th scope="row" className="px-3 py-1.5 text-left font-normal tabular-nums">{weekLabel(w)}{w.days < 7 ? ` (${w.days} days)` : ""}</th>
                    {series.map((s) => (
                      <td key={s.channel} className="px-3 py-1.5 text-right tabular-nums" data-cell={`${s.channel}|${w.start}`}>
                        <CellValue cell={s.cells[wi]} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </figure>

      <div
        ref={liveRef}
        tabIndex={-1}
        className="min-w-0 space-y-2 rounded-lg border border-border bg-surface p-3 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        aria-live="polite"
        data-testid="movement-selection"
        data-selected={selected ? `${selected.series.channel}|${selected.week.start}` : ""}
      >
        {selected ? (
          <>
            <p className="text-sm font-semibold text-text" data-testid="movement-sentence">
              {sentenceOf(selected)}
            </p>
            {lines.map((l) => (
              <p key={l} className="text-sm text-muted">
                {l}
              </p>
            ))}
            {windowNote && (
              <p className="border-l-2 border-border-strong pl-2.5 text-sm text-text" data-testid="movement-window">
                {windowNote}
              </p>
            )}
            <div className="flex flex-wrap items-center gap-2 pt-1">
              {evidenceHref ? (
                // Secondary: the page's one primary action is the headline's (app/page.tsx).
                <Link
                  id={OPEN_EVIDENCE_ID}
                  href={evidenceHref}
                  onClick={() => rememberFocus(OPEN_EVIDENCE_ID)}
                  className={buttonClass({ variant: "secondary" })}
                  data-variant="secondary"
                  data-testid="open-evidence"
                >
                  Open evidence
                </Link>
              ) : (
                <span className="text-xs text-muted">Choose a branch above to open its stored records.</span>
              )}
              <button type="button" onClick={() => select(null)} className={buttonClass({ variant: "ghost" })} data-variant="ghost" data-testid="reset-selection">
                Reset
              </button>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted">Select a point, or a channel and a week below the chart, to see what the stored records say about it.</p>
        )}
      </div>
    </div>
  );
}

function CellValue({ cell }: { cell: Cell }) {
  switch (cell.status) {
    case "recorded":
      return <>{dollars(cell.cents!)}</>;
    case "partial":
      return (
        <>
          {dollars(cell.cents!)} <span className="text-faint">({cell.daysWithRecord} of {cell.daysDelivered} days)</span>
        </>
      );
    case "zero":
      return <>$0.00 <span className="text-faint">(recorded)</span></>;
    case "missing":
      return <span className="text-warn">no record</span>;
    case "not_delivered":
      return <span className="text-faint">not delivered yet</span>;
  }
}
