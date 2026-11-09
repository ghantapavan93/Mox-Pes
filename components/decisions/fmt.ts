/**
 * Formatting for Decision Lab components that also render in the browser. lib/format pulls in
 * node:crypto through lib/primitives, so client components use these instead; the output
 * matches lib/format's money style (whole dollars from $1,000).
 */

export const usd = (cents: number | null | undefined): string => {
  if (cents === null || cents === undefined) return "—";
  const dollars = cents / 100;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: Math.abs(dollars) >= 1000 ? 0 : 2 }).format(dollars);
};

/** Customer counts in projections are expected values, so they keep one decimal. */
export const customers = (n: number | null | undefined, digits = 1): string =>
  n === null || n === undefined || Number.isNaN(n) ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const signed = (n: number, digits = 1): string => `${n > 0 ? "+" : n < 0 ? "−" : "±"}${customers(Math.abs(n), digits)}`;

export const percent = (ratio: number | null | undefined, digits = 1): string =>
  ratio === null || ratio === undefined || Number.isNaN(ratio) ? "—" : `${(ratio * 100).toFixed(digits)}%`;

/** A difference in rates, in percentage points with an explicit sign. */
export const points = (diff: number | null | undefined, digits = 1): string =>
  diff === null || diff === undefined ? "—" : `${diff > 0 ? "+" : diff < 0 ? "−" : "±"}${Math.abs(diff * 100).toFixed(digits)} pp`;

export const when = (iso: string): string =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" });
