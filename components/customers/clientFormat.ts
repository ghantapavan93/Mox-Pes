/**
 * Formatting for the module's CLIENT components. lib/format pulls in lib/primitives, which
 * imports node:crypto for hashing and must stay out of the browser bundle; these two helpers
 * produce exactly the same strings as lib/format's `dateTime` and `money` (UTC, USD).
 */

export function utcDateTime(d: string | null | undefined): string {
  return d
    ? new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" })
    : "—";
}

export function usd(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  const dollars = cents / 100;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: Math.abs(dollars) >= 1000 ? 0 : 2 }).format(dollars);
}
