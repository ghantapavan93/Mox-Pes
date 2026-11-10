import { useId } from "react";
import type { WeekPoint } from "@/lib/queries";

/**
 * Weekly new customers serviced, stacked by how their source is known: paid media, unknown,
 * everything else. Colour is never the only signal: the legend names each band, and the exact
 * values are in a visually hidden table the chart references (aria-describedby).
 */
export function StackedWeeks({ points, label, highlightFrom }: { points: WeekPoint[]; label: string; highlightFrom?: string }) {
  const tableId = `${useId()}-data`;
  const rows = points.map((p) => ({
    week: p.weekStart,
    paid: p.paidAcquired,
    unknown: p.unknownAcquired,
    other: Math.max(0, p.acquired - p.paidAcquired - p.unknownAcquired),
  }));
  const max = Math.max(1, ...rows.map((r) => r.paid + r.unknown + r.other));
  const n = rows.length;
  const gap = 1.2;
  const w = (100 - gap * (n - 1)) / n;
  const h = 56;
  const y = (v: number) => (v / max) * h;
  const fmt = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return (
    <figure>
      <figcaption className="sr-only">{label}</figcaption>
      <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted" aria-hidden>
        <Legend color="var(--chart-paid)">Paid media</Legend>
        <Legend color="var(--chart-unknown)">Unknown source</Legend>
        <Legend color="var(--chart-other)">Organic, door-to-door, other</Legend>
      </div>
      <svg viewBox={`0 0 100 ${h + 8}`} preserveAspectRatio="none" className="h-44 w-full" role="img" aria-label={label} aria-describedby={tableId}>
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <line key={f} x1="0" x2="100" y1={h - h * f} y2={h - h * f} stroke="var(--border)" strokeWidth="0.3" vectorEffect="non-scaling-stroke" />
        ))}
        {rows.map((r, i) => {
          const x = i * (w + gap);
          const dim = highlightFrom && r.week < highlightFrom ? 0.45 : 1;
          let top = h;
          const seg = (v: number, fill: string) => {
            const height = y(v);
            top -= height;
            return v > 0 ? <rect x={x} y={top} width={w} height={height} fill={fill} opacity={dim} /> : null;
          };
          return (
            <g key={r.week}>
              {seg(r.paid, "var(--chart-paid)")}
              {seg(r.other, "var(--chart-other)")}
              {seg(r.unknown, "var(--chart-unknown)")}
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex justify-between text-[11px] text-faint" aria-hidden>
        <span>{rows[0] ? fmt(rows[0].week) : ""}</span>
        <span>{rows[n - 1] ? fmt(rows[n - 1].week) : ""}</span>
      </div>
      {/* sr-only on a wrapper: a <table> ignores the 1px width and would widen the page. */}
      <div className="sr-only">
        <table id={tableId}>
        <caption>{label}</caption>
        <thead>
          <tr>
            <th scope="col">Week of</th>
            <th scope="col">Paid media</th>
            <th scope="col">Unknown source</th>
            <th scope="col">Other</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.week}>
              <th scope="row">{fmt(r.week)}</th>
              <td>{r.paid}</td>
              <td>{r.unknown}</td>
              <td>{r.other}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </figure>
  );
}

function Legend({ color, children }: { color: string; children: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="size-2.5 rounded-sm" style={{ background: color }} />
      {children}
    </span>
  );
}
