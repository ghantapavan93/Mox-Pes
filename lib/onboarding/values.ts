import { isRealCalendarTime } from "@/lib/primitives";

/**
 * Value transforms used when an approved mapping compiles a row. Each one either returns the
 * canonical value or explains exactly why it cannot, and whether a fix could be automated.
 * Nothing here guesses: an ambiguous value is an error with a suggested question.
 */

export type ValueResult<T> = { ok: true; value: T } | { ok: false; code: string; detail: string; suggestion: string; safeToAutomate: boolean };
const bad = (code: string, detail: string, suggestion: string, safeToAutomate = false): ValueResult<never> => ({ ok: false, code, detail, suggestion, safeToAutomate });

export type DateOrder = "MDY" | "DMY";

export interface DateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** "+05:30" / "Z" when the value carried an offset; null for a local (zone-less) value. */
  offset: string | null;
  hasTime: boolean;
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/;
const SLASH = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp][Mm])?)?$/;

/** Parses the date formats exports actually use. `order` is required for slash dates. */
export function parseDateValue(raw: string, order: DateOrder | null): ValueResult<DateParts> {
  const v = raw.trim();
  const iso = ISO.exec(v);
  if (iso) {
    const [, y, mo, d, h = "0", mi = "0", s = "0", off] = iso;
    const parts = { year: +y, month: +mo, day: +d, hour: +h, minute: +mi, second: +s };
    if (!isRealCalendarTime(parts.year, parts.month, parts.day, parts.hour, parts.minute, parts.second)) {
      return bad("IMPOSSIBLE_DATE", `"${v}" is not a real date or time`, "Correct the value in the source system; it is not moved to a nearby day");
    }
    const offset = off === undefined ? null : off === "Z" ? "Z" : off.includes(":") ? off : `${off.slice(0, 3)}:${off.slice(3)}`;
    // Real offsets run from -12:00 to +14:00; "+25:00" would crash the conversion (data review #8).
    if (offset && offset !== "Z" && (Number(offset.slice(1, 3)) > 14 || Number(offset.slice(4, 6)) > 59)) {
      return bad("IMPOSSIBLE_DATE", `"${v}" has an impossible time-zone offset`, "Correct the value in the source system");
    }
    return { ok: true, value: { ...parts, offset, hasTime: iso[4] !== undefined } };
  }
  const slash = SLASH.exec(v);
  if (slash) {
    if (!order) return bad("DATE_ORDER_UNKNOWN", `"${v}" could be month-first or day-first`, "State the date order for this column in the mapping");
    const [, a, b, yRaw, hRaw, mi = "0", s = "0", ampm] = slash;
    if (yRaw.length === 2) return bad("TWO_DIGIT_YEAR", `"${v}" has a two-digit year`, "Export with four-digit years; the century is not guessed");
    const month = order === "MDY" ? +a : +b;
    const day = order === "MDY" ? +b : +a;
    let hour = hRaw === undefined ? 0 : +hRaw;
    if (ampm) {
      if (hour < 1 || hour > 12) return bad("IMPOSSIBLE_DATE", `"${v}" has an hour outside 1-12 with AM/PM`, "Correct the value in the source system");
      hour = (hour % 12) + (ampm.toLowerCase() === "pm" ? 12 : 0);
    }
    if (!isRealCalendarTime(+yRaw, month, day, hour, +mi, +s)) {
      return bad("IMPOSSIBLE_DATE", `"${v}" is not a real date (${order === "MDY" ? "month first" : "day first"})`, "Correct the value in the source system; it is not moved to a nearby day");
    }
    return { ok: true, value: { year: +yRaw, month, day, hour, minute: +mi, second: +s, offset: null, hasTime: hRaw !== undefined } };
  }
  if (/^\d{5}(\.\d+)?$/.test(v)) {
    return bad("SPREADSHEET_SERIAL", `"${v}" looks like a spreadsheet date serial number, not a date`, "Format the column as a date before exporting, or upload the .xlsx file itself");
  }
  return bad("UNREADABLE_DATE", `"${v.slice(0, 40)}" is not a date format this import reads`, "Export dates as YYYY-MM-DD or MM/DD/YYYY");
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
export const wallTimeOf = (p: DateParts) => `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
export const isoDateOf = (p: DateParts) => `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;

/**
 * Money written as text -> a canonical decimal string ("-1234.50"). US formats only:
 * "$1,234.56", "1234.5", "-$12.00", "(12.50)" (accounting negative). A value that reads two
 * ways ("1.234,56", "1,234" as a decimal comma) or another currency is refused.
 */
export function parseMoneyText(raw: string): ValueResult<string> {
  let v = raw.trim().replace(/\s+/g, "");
  if (/[€£¥₹]|EUR|GBP|CAD|MXN/i.test(v)) return bad("CURRENCY_NOT_USD", `"${raw.slice(0, 40)}" is not in US dollars`, "Convert in the source system; exchange rates are not applied here");
  v = v.replace(/USD$/i, "");
  // Exactly one way of saying "negative": parentheses, or one minus before or after the "$".
  // "--12", "-$-12" and "(-12)" are refused, not read as positive (data review #12).
  let negative = false;
  if (/^\(.*\)$/.test(v)) {
    negative = true;
    v = v.slice(1, -1);
  }
  const minus = /^-?\$?-?/.exec(v)![0];
  if ((minus.match(/-/g) ?? []).length + (negative ? 1 : 0) > 1) return bad("NOT_MONEY", `"${raw.slice(0, 40)}" has more than one negative sign`, "Check the value in the source system");
  if (minus.includes("-")) negative = true;
  v = v.slice(minus.length);
  if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(v) || /^\d+,\d{1,2}$/.test(v)) {
    return bad("AMBIGUOUS_NUMBER_FORMAT", `"${raw}" uses a decimal comma`, "Export with US number formatting");
  }
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(v) && !/^\.\d{1,2}$/.test(v)) {
    if (/^\d+\.\d{3,}$/.test(v)) return bad("FRACTIONAL_CENTS", `"${raw}" has more than two decimals`, "Round in the source system; cents are not rounded here");
    return bad("NOT_MONEY", `"${raw.slice(0, 40)}" is not an amount`, "Check the column holds amounts");
  }
  const plain = v.replace(/,/g, "");
  const [whole, fraction = ""] = (plain.startsWith(".") ? `0${plain}` : plain).split(".");
  if (whole.replace(/^0+(?=\d)/, "").length > 13) return bad("AMOUNT_OUT_OF_RANGE", `"${raw}" is too large to be exact`, "Check the value in the source system");
  const canonical = `${negative ? "-" : ""}${whole.replace(/^0+(?=\d)/, "")}${fraction ? `.${fraction.padEnd(2, "0")}` : ".00"}`;
  return { ok: true, value: canonical === "-0.00" ? "0.00" : canonical };
}

/** Dollars (canonical decimal) -> micros string, exactly. */
export function dollarsToMicros(decimal: string): string {
  const negative = decimal.startsWith("-");
  const [whole, fraction = "00"] = decimal.replace("-", "").split(".");
  const micros = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(2, "0").slice(0, 2)) * 10_000n;
  return (negative ? -micros : micros).toString();
}

/** A count: a non-negative whole number, possibly written "1,204". */
export function parseCount(raw: string): ValueResult<number> {
  const v = raw.trim().replace(/,/g, "");
  if (/^\d+\.0+$/.test(v)) return { ok: true, value: Number(v.split(".")[0]) };
  if (/^\d+\.\d+$/.test(v)) return bad("FRACTIONAL_COUNT", `"${raw}" is not a whole number`, "Platforms report fractional conversions for data-driven attribution; choose a rounding rule in the source report", false);
  if (!/^\d{1,10}$/.test(v) || Number(v) > 2_147_483_647) return bad("NOT_A_COUNT", `"${raw.slice(0, 40)}" is not a count`, "Check the column holds counts");
  return { ok: true, value: Number(v) };
}

/**
 * An identifier as text. Scientific notation means a spreadsheet already rounded it, so the
 * original is lost; a padded numeric id is refused for numeric-id systems (the CRM).
 */
export function parseIdentifier(raw: string, numeric: boolean): ValueResult<string> {
  const v = raw.trim();
  if (/^[+-]?\d(\.\d+)?[eE][+-]?\d+$/.test(v)) {
    return bad("MANGLED_ID", `"${v}" was rounded by a spreadsheet (scientific notation)`, "Re-export with the column formatted as text; the original id cannot be recovered from this value");
  }
  if (!numeric) {
    if (v.length > 120 || /[\u0000-\u001f]/.test(v)) return bad("INVALID_ID", `The id "${v.slice(0, 40)}" is not usable`, "Check the column holds ids");
    return { ok: true, value: v };
  }
  if (/^0\d+$/.test(v)) return bad("PADDED_ID", `"${v}" has leading zeros; the CRM's ids do not`, "Confirm with the CRM which record this is; zeros are not stripped automatically");
  if (!/^[1-9]\d{0,14}$/.test(v)) return bad("INVALID_ID", `"${v.slice(0, 40)}" is not a CRM id`, "CRM ids are whole numbers of up to 15 digits");
  return { ok: true, value: v };
}

/** Values that mean "no value" in exports. */
export function isBlank(raw: string | null): boolean {
  return raw === null || /^\s*(|n\/a|na|null|none|nil|-|--|#n\/a|undefined)\s*$/i.test(raw);
}
