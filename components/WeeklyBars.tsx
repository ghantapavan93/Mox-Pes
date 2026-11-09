import type { WeekPoint } from "@/lib/queries";

/** Small-multiple weekly bars. Values are computed from WeekPoint; nothing is stored. */
export function WeeklyBars({
  points,
  value,
  format,
  label,
  reference,
}: {
  points: WeekPoint[];
  value: (p: WeekPoint) => number | null;
  format: (v: number) => string;
  label: string;
  reference?: { value: number; label: string };
}) {
  const values = points.map(value);
  const max = Math.max(...values.map((v) => v ?? 0), reference?.value ?? 0, 1);
  const w = 100 / points.length;
  return (
    <figure>
      <figcaption className="mb-2 text-xs font-medium text-muted">{label}</figcaption>
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="h-32 w-full" role="img" aria-label={label}>
        {values.map((v, i) =>
          v === null ? null : (
            <rect key={points[i].weekStart} x={i * w + w * 0.15} width={w * 0.7} y={40 - (v / max) * 38} height={(v / max) * 38} className="fill-accent/70">
              <title>{`Week of ${points[i].weekStart}: ${format(v)}`}</title>
            </rect>
          ),
        )}
        {reference && (
          <line x1="0" x2="100" y1={40 - (reference.value / max) * 38} y2={40 - (reference.value / max) * 38} className="stroke-bad" strokeWidth="0.4" strokeDasharray="1.5 1" vectorEffect="non-scaling-stroke" />
        )}
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-faint">
        <span>{points[0]?.weekStart}</span>
        {reference && <span className="text-bad">– – {reference.label}</span>}
        <span>{points[points.length - 1]?.weekStart}</span>
      </div>
    </figure>
  );
}
