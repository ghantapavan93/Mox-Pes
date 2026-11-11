import type { ParsedTable } from "./parse";

/**
 * Column profiles over EVERY row of the parsed table (bounded by LIMITS.maxRows, so there is
 * no sampling to disclose; `sampled` stays false and says so).
 *
 * A profile describes what values LOOK like. It never decides what a column MEANS: "these
 * values look like US phone numbers" is evidence for a mapping, not a mapping.
 *
 * Personal data: values of a column that looks personal (phones, emails, names, free text)
 * are never returned, only counts and masked shapes.
 */

export type ValueKind =
  | "empty"
  | "integer"
  | "decimal"
  | "money_text"
  | "boolean"
  | "datetime_offset"
  | "datetime_local"
  | "date_iso"
  | "date_us"
  | "date_ambiguous"
  | "phone"
  | "email"
  | "zip"
  | "scientific"
  | "text";

export interface ColumnProfile {
  index: number;
  name: string;
  /** The dominant kind among non-missing values (ties resolve to "text"). */
  inferred: ValueKind;
  /** Count of non-missing values of each kind. */
  kinds: Partial<Record<ValueKind, number>>;
  total: number;
  missing: number;
  /** Placeholders such as "N/A", "null", "-" counted as missing. */
  placeholders: number;
  distinct: number;
  /** Non-missing values that occur more than once, counted per occurrence beyond the first. */
  duplicateValues: number;
  /** Non-missing values that do not match the inferred kind. */
  nonconforming: number;
  leadingZeros: number;
  /** Values that would run as a formula if opened in a spreadsheet (=, +, -, @ followed by text). */
  formulaLike: number;
  /** Identifier-like values a spreadsheet has turned into scientific notation (1.23457E+17). */
  scientificIds: number;
  maxLength: number;
  numeric: { min: number; max: number; mean: number; p50: number; negatives: number; outliers: number } | null;
  dateFormats: string[];
  /** Up to 8 most frequent values, for low-cardinality, non-personal columns only. */
  topValues: Array<{ value: string; count: number }> | null;
  personal: "phone" | "email" | "name" | "free_text" | null;
  /** Shapes like "(###) ###-####" or "Aaaa Aaaa": safe to show for any column. */
  shapes: Array<{ shape: string; count: number }>;
  looksLikeIdentifier: boolean;
}

export interface TableProfile {
  rows: number;
  columns: ColumnProfile[];
  sampled: false;
  /** Rows whose every mapped-or-not cell repeats an earlier row exactly. */
  duplicateRows: number;
}

const PLACEHOLDERS = new Set(["n/a", "na", "null", "nil", "none", "-", "--", "#n/a", "undefined", "?", "tbd"]);

export function isMissing(value: string | null): boolean {
  return value === null || value.trim() === "";
}
export function isPlaceholder(value: string | null): boolean {
  return value !== null && PLACEHOLDERS.has(value.trim().toLowerCase());
}

const RE = {
  integer: /^[+-]?\d+$/,
  decimal: /^[+-]?(\d+\.\d*|\.\d+)$/,
  money: /^\(?[+-]?\$?\s?\(?-?(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?\)?$/,
  boolean: /^(true|false|yes|no|y|n)$/i,
  datetimeOffset: /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/,
  datetimeLocal: /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/,
  dateIso: /^\d{4}-\d{2}-\d{2}$/,
  // Slash, dot or dash separated, the same forms the compiler reads (03/04/2026, 03.04.2026, 03-04-2026).
  dateSlash: /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})(\s+\d{1,2}:\d{2}(:\d{2})?\s*([AaPp][Mm])?)?$/,
  phone: /^(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}$/,
  email: /^[^\s@]{1,64}@[^\s@.]{1,63}(\.[^\s@.]{1,63})+$/,
  zip: /^\d{5}(-\d{4})?$/,
  scientific: /^[+-]?\d(\.\d+)?[eE][+-]?\d+$/,
  formula: /^[=+\-@\t\r]/,
  name: /^[A-Z][a-z'’-]+(\s[A-Z][a-z'’.-]*){1,3}$/,
};

/** Classifies one non-missing value. Order matters: the most specific shape wins. */
export function classify(raw: string): ValueKind {
  const v = raw.trim();
  if (v === "") return "empty";
  // No date, number, phone or email is this long; skipping the shape tests keeps every
  // classification bounded whatever a 10,000-character cell contains (security review #3).
  if (v.length > 320) return "text";
  if (RE.datetimeOffset.test(v)) return "datetime_offset";
  if (RE.datetimeLocal.test(v)) return "datetime_local";
  if (RE.dateIso.test(v)) return "date_iso";
  const slash = RE.dateSlash.exec(v);
  if (slash) {
    const a = Number(slash[1]);
    const b = Number(slash[2]);
    // 03/04/2026 is March 4 or April 3: only the file's other rows (or a person) can tell.
    if (a <= 12 && b <= 12 && a !== b) return "date_ambiguous";
    return "date_us";
  }
  if (RE.email.test(v)) return "email";
  if (RE.zip.test(v) && v.length === 5) return "zip";
  if (RE.phone.test(v) && v.replace(/\D/g, "").length >= 10) return "phone";
  if (RE.scientific.test(v)) return "scientific";
  if (RE.integer.test(v)) return "integer";
  if (RE.decimal.test(v)) return "decimal";
  if (RE.money.test(v) && /[$,()]/.test(v)) return "money_text";
  if (RE.boolean.test(v)) return "boolean";
  return "text";
}

/** A masked shape: digits -> #, letters -> A/a. Never reveals a value. */
export function shapeOf(raw: string): string {
  return raw
    .trim()
    .slice(0, 40)
    .replace(/[A-Z]/g, "A")
    .replace(/[a-z]/g, "a")
    .replace(/\d/g, "#")
    .replace(/a{2,}/g, "a+")
    .replace(/A{2,}/g, "A+");
}

/**
 * Dates written with slashes: infers the field order from the rows that disambiguate
 * (a first part over 12 means day-first; a second part over 12 means month-first).
 */
export function slashDateOrder(values: string[]): "MDY" | "DMY" | "conflict" | "unknown" {
  let mdy = 0;
  let dmy = 0;
  for (const v of values) {
    const m = RE.dateSlash.exec(v.trim());
    if (!m) continue;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 12 && b <= 12) dmy++;
    if (b > 12 && a <= 12) mdy++;
  }
  if (mdy > 0 && dmy > 0) return "conflict";
  if (mdy > 0) return "MDY";
  if (dmy > 0) return "DMY";
  return "unknown";
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

const NUMERIC_KINDS = new Set<ValueKind>(["integer", "decimal", "money_text"]);
const DATE_KINDS = new Set<ValueKind>(["datetime_offset", "datetime_local", "date_iso", "date_us", "date_ambiguous"]);

/** Parses a numeric-looking value for statistics only (never for money arithmetic). */
function statNumber(v: string): number | null {
  const negative = /^\(.*\)$/.test(v.trim()) || v.trim().startsWith("-");
  const n = Number(v.replace(/[$,()\s+-]/g, ""));
  return Number.isFinite(n) ? (negative ? -n : n) : null;
}

export function profileColumn(name: string, index: number, values: Array<string | null>): ColumnProfile {
  const kinds: Partial<Record<ValueKind, number>> = {};
  const counts = new Map<string, number>();
  const shapes = new Map<string, number>();
  let missing = 0;
  let placeholders = 0;
  let leadingZeros = 0;
  let formulaLike = 0;
  let scientificIds = 0;
  let maxLength = 0;
  let nameLike = 0;
  const present: string[] = [];
  for (const raw of values) {
    if (isMissing(raw)) {
      missing++;
      continue;
    }
    const v = raw!;
    if (isPlaceholder(v)) {
      missing++;
      placeholders++;
      continue;
    }
    present.push(v);
    const k = classify(v);
    kinds[k] = (kinds[k] ?? 0) + 1;
    counts.set(v, (counts.get(v) ?? 0) + 1);
    const shape = shapeOf(v);
    shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
    maxLength = Math.max(maxLength, v.length);
    if (/^0\d+$/.test(v.trim())) leadingZeros++;
    if (RE.formula.test(v) && !RE.integer.test(v.trim()) && !RE.decimal.test(v.trim()) && !RE.money.test(v.trim())) formulaLike++;
    if (k === "scientific") scientificIds++;
    if (RE.name.test(v.trim())) nameLike++;
  }

  const ranked = Object.entries(kinds).sort((a, b) => b[1] - a[1]) as Array<[ValueKind, number]>;
  let inferred: ValueKind = ranked.length === 0 ? "empty" : ranked[0][0];
  // A column of mostly integers with some money_text, or decimals, is still numeric money.
  const numericTotal = ranked.filter(([k]) => NUMERIC_KINDS.has(k)).reduce((s, [, n]) => s + n, 0);
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1] && !(NUMERIC_KINDS.has(ranked[0][0]) && NUMERIC_KINDS.has(ranked[1][0]))) inferred = "text";
  if (kinds.money_text && numericTotal === present.length) inferred = "money_text";
  else if (kinds.decimal && (kinds.integer ?? 0) + kinds.decimal === present.length) inferred = "decimal";
  const dateTotal = ranked.filter(([k]) => DATE_KINDS.has(k)).reduce((s, [, n]) => s + n, 0);
  if ((kinds.date_ambiguous || kinds.date_us) && dateTotal === present.length) {
    const order = slashDateOrder(present);
    inferred = order === "MDY" || order === "DMY" ? "date_us" : "date_ambiguous";
  }
  const conforming =
    inferred === "money_text" || inferred === "decimal"
      ? numericTotal
      : inferred === "date_us" || inferred === "date_ambiguous"
        ? dateTotal
        : (kinds[inferred] ?? 0);

  let numeric: ColumnProfile["numeric"] = null;
  // ZIP-shaped columns get statistics too: five-digit spreadsheet date serials look like ZIPs.
  if (NUMERIC_KINDS.has(inferred) || inferred === "zip") {
    const nums = present.map(statNumber).filter((n): n is number => n !== null).sort((a, b) => a - b);
    if (nums.length > 0) {
      const q1 = percentile(nums, 0.25);
      const q3 = percentile(nums, 0.75);
      const fence = (q3 - q1) * 3;
      numeric = {
        min: nums[0],
        max: nums[nums.length - 1],
        mean: nums.reduce((s, n) => s + n, 0) / nums.length,
        p50: percentile(nums, 0.5),
        negatives: nums.filter((n) => n < 0).length,
        outliers: fence > 0 ? nums.filter((n) => n < q1 - fence || n > q3 + fence).length : 0,
      };
    }
  }

  const dateFormats = [...new Set(present.filter((v) => DATE_KINDS.has(classify(v))).map(shapeOf))].slice(0, 6);
  const personal: ColumnProfile["personal"] =
    inferred === "phone" ? "phone" : inferred === "email" ? "email" : nameLike > present.length * 0.6 ? "name" : inferred === "text" && maxLength > 60 ? "free_text" : null;
  const distinct = counts.size;
  const duplicateValues = [...counts.values()].reduce((s, n) => s + (n > 1 ? n - 1 : 0), 0);
  const lowCardinality = distinct > 0 && distinct <= 25 && distinct < present.length;
  // Top values only for code-like columns: short values that repeat (statuses, sources, branch
  // names). A column of mostly distinct values may be people ("DOE, JANE") or addresses, which
  // the personal-data heuristics can miss, so its values are never stored (security review #8).
  const codeLike = maxLength <= 30 && distinct <= Math.max(1, present.length / 2);
  const topValues = !personal && lowCardinality && codeLike ? [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([value, count]) => ({ value: value.slice(0, 30), count })) : null;
  const looksLikeIdentifier = (inferred === "integer" || inferred === "text" || inferred === "scientific") && present.length > 0 && distinct / present.length > 0.9 && maxLength <= 40 && personal === null;

  return {
    index,
    name,
    inferred,
    kinds,
    total: values.length,
    missing,
    placeholders,
    distinct,
    duplicateValues,
    nonconforming: present.length - conforming,
    leadingZeros,
    formulaLike,
    scientificIds,
    maxLength,
    numeric,
    dateFormats,
    topValues,
    personal,
    shapes: [...shapes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([shape, count]) => ({ shape, count })),
    looksLikeIdentifier,
  };
}

export function profileTable(table: ParsedTable): TableProfile {
  const columns = table.columns.map((name, i) => profileColumn(name, i, table.rows.map((r) => r[i])));
  const seen = new Set<string>();
  let duplicateRows = 0;
  for (const r of table.rows) {
    const key = JSON.stringify(r);
    if (seen.has(key)) duplicateRows++;
    else seen.add(key);
  }
  return { rows: table.rows.length, columns, sampled: false, duplicateRows };
}
