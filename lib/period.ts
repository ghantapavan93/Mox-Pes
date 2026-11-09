export type PeriodKey = "oct" | "sep" | "all";

export interface Period {
  key: PeriodKey;
  label: string;
  from: Date;
  to: Date;
}

export const PERIODS: Record<PeriodKey, Period> = {
  oct: { key: "oct", label: "Oct 1–30, 2026 (UTC)", from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-10-31T00:00:00Z") },
  sep: { key: "sep", label: "Sep 1–30, 2026 (UTC)", from: new Date("2026-09-01T00:00:00Z"), to: new Date("2026-10-01T00:00:00Z") },
  all: { key: "all", label: "Sep 1 – Oct 30, 2026 (UTC)", from: new Date("2026-09-01T00:00:00Z"), to: new Date("2026-10-31T00:00:00Z") },
};

export function parsePeriod(value: string | string[] | undefined): Period {
  const key = Array.isArray(value) ? value[0] : value;
  return key && key in PERIODS ? PERIODS[key as PeriodKey] : PERIODS.oct;
}
