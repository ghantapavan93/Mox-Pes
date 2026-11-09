import { createHash } from "node:crypto";

// ── Money ────────────────────────────────────────────────────────────────────
// Money is integer cents end to end. Source systems send decimal strings ("149.00") or
// micros (Google Ads); both are parsed exactly, never through a float.

const DECIMAL_MONEY = /^(-)?(\d+)(?:\.(\d{1,2}))?$/;

export function parseMoneyToCents(value: string): number {
  const match = DECIMAL_MONEY.exec(value.trim());
  if (!match) throw new Error(`Not a money amount: "${value}"`);
  const [, sign, whole, fraction = ""] = match;
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return sign ? -cents : cents;
}

/** Google Ads reports cost in micros (1/1,000,000 of the currency unit). Half-up to cents. */
export function microsToCents(micros: number | string): number {
  const value = BigInt(micros);
  return Number((value + 5_000n) / 10_000n);
}

export function formatCents(cents: number, opts: { compact?: boolean } = {}): string {
  const dollars = cents / 100;
  if (opts.compact && Math.abs(dollars) >= 10_000) {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 }).format(dollars);
  }
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: Math.abs(dollars) >= 1000 ? 0 : 2 }).format(dollars);
}

// ── Identity ─────────────────────────────────────────────────────────────────
// PII never reaches the projections: phone and email are normalised and hashed at the
// adapter boundary. The same normalisation is used for every source, so a caller and a
// web form from the same person hash to the same key.

export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/\D/g, "");
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (national.length !== 10) return null;
  return `+1${national}`;
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const email = raw.trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) ? email : null;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hashPhone(raw: string | null | undefined): string | null {
  const phone = normalizePhone(raw);
  return phone ? sha256(`phone:${phone}`) : null;
}

export function hashEmail(raw: string | null | undefined): string | null {
  const email = normalizeEmail(raw);
  return email ? sha256(`email:${email}`) : null;
}

/** Stable JSON: object keys sorted, so equal payloads hash equally regardless of key order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function payloadHash(payload: unknown): string {
  return sha256(canonicalJson(payload));
}

// ── Time ─────────────────────────────────────────────────────────────────────
// The CRM sends "YYYY-MM-DD HH:MM:SS" with no zone: wall-clock time at the branch.
// Arizona does not observe DST; Dallas does. Conversion must use the branch's IANA zone.

const LEGACY_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function zoneOffsetMinutes(utcMillis: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMillis));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return (asUtc - utcMillis) / 60_000;
}

/** Interprets a zone-less wall-clock timestamp in `timeZone` and returns the instant. */
export function wallTimeToInstant(wallTime: string, timeZone: string): Date {
  const m = LEGACY_TIMESTAMP.exec(wallTime);
  if (!m) throw new Error(`Not a "YYYY-MM-DD HH:MM:SS" timestamp: "${wallTime}"`);
  const naiveUtc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  // Two passes settle the offset across a DST boundary.
  let instant = naiveUtc - zoneOffsetMinutes(naiveUtc, timeZone) * 60_000;
  instant = naiveUtc - zoneOffsetMinutes(instant, timeZone) * 60_000;
  return new Date(instant);
}

/** Formats an instant as the CRM would: zone-less wall time at the branch. */
export function instantToWallTime(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

export function isLegacyTimestamp(value: string): boolean {
  return LEGACY_TIMESTAMP.test(value);
}

export function isIsoWithOffset(value: string): boolean {
  return ISO_WITH_OFFSET.test(value);
}
