"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { dollars, explainCell, pointTitle, weekLabel } from "@/lib/metrics/movement-copy";
import type { Cell, Marker, Series, WeekInfo } from "@/lib/metrics/movement";

/**
 * The "What changed" chart: paid media spend per week, one line per channel, one unit (US
 * dollars). A week without a spend record is a gap in its line, never a point at $0; a recorded
 * $0 is a point on the axis. Selecting a channel and a week (a point, or the buttons below the
 * chart, which work by keyboard and touch) explains that one point beside the chart and offers
 * its stored records. The selection is kept in the URL (`channel`, `week`) without a server
 * round trip, so the evidence page can send the reviewer back to it.
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

function niceMax(cents: number): number {
  const dollarsMax = Math.max(1, cents / 100);
  const step = 10 ** Math.floor(Math.log10(dollarsMax));
  const top = Math.ceil(dollarsMax / step) * step;
  return top * 100;
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
  const [sel, setSel] = useState<Selection | null>(initial);
  const [channel, setChannel] = useState<string>(initial?.channel ?? defaultChannel);
  const liveRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

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

  useEffect(() => {
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

  const selected = useMemo(() => {
    if (!sel) return null;
    const s = series.find((x) => x.channel === sel.channel);
    const wi = weeks.findIndex((w) => w.start === sel.week);
    if (!s || wi < 0) return null;
    return { series: s, cell: s.cells[wi], week: weeks[wi], index: wi };
  }, [sel, series, weeks]);

  const lines = selected ? explainCell(selected.series, selected.cell, selected.week, markers) : [];
  const windowNote = selected ? (windowNotes[`${selected.series.channel}|${selected.week.start}`] ?? null) : null;
  const focus = sel?.channel ?? channel;
  const colorOf = (c: string) => (c === focus ? FOCUS : OTHER);
  const evidenceHref = selected && evidenceBase ? `${evidenceBase}&channel=${encodeURIComponent(selected.series.channel)}&week=${selected.week.start}` : null;

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
              type="button"
              aria-pressed={channel === s.channel}
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

        <svg viewBox={`0 0 ${W} ${H}`} className="mt-2 h-auto w-full" role="img" aria-label={`Paid media spend per week by channel at ${scopeLabel}. A gap means no spend record. Exact values are in the table below the chart.`}>
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
                      onClick={() => select({ channel: s.channel, week: c.week })}
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

        <div role="group" aria-label="Week" className="mt-1 flex flex-wrap gap-1" data-testid="movement-weeks">
          {weeks.map((w) => (
            <button
              key={w.start}
              type="button"
              aria-pressed={sel?.week === w.start}
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
            <p className="text-sm font-semibold text-text">
              {pointTitle(selected.series, selected.week, scopeLabel)}
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
                <Link href={evidenceHref} className="inline-flex min-h-9 items-center rounded-md bg-accent px-3 text-sm font-semibold text-white hover:bg-accent-hover" data-testid="open-evidence">
                  Open evidence
                </Link>
              ) : (
                <span className="text-xs text-muted">Choose a branch above to open its stored records.</span>
              )}
              <button type="button" onClick={() => select(null)} className="inline-flex min-h-9 items-center rounded-md border border-border px-3 text-sm hover:bg-surface-2" data-testid="reset-selection">
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
