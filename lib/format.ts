import { formatCents } from "@/lib/primitives";

export const money = (cents: number | null | undefined, compact = false) =>
  cents === null || cents === undefined ? "—" : formatCents(cents, { compact });

export const count = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n.toLocaleString("en-US"));

export const pct = (ratio: number | null | undefined, digits = 0) =>
  ratio === null || ratio === undefined || Number.isNaN(ratio) ? "—" : `${(ratio * 100).toFixed(digits)}%`;

export const dateTime = (d: Date | string | null | undefined) =>
  d
    ? new Date(d).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" })
    : "—";

export const date = (d: Date | string | null | undefined) =>
  d ? new Date(d).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }) : "—";

export const KIND_LABEL: Record<string, string> = {
  quarantined_source_records: "Quarantined source records",
  payment_without_ticket: "Payment without invoice",
  branch_mismatch: "Branch mismatch",
  unmapped_spend: "Unmapped spend",
  channel_conflict: "D2D / paid conflict",
  payload_conflict: "Conflicting payload",
  channel_coverage_gap: "Channel coverage gap",
};
