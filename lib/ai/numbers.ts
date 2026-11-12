/**
 * Numeric claim verification, outside the model.
 *
 * Grounding by evidence id (lib/ai/analyst.ts) proves a claim cites records a tool returned; it
 * does not prove the claim's NUMBERS are the records' numbers. This module checks every dollar
 * amount, percentage and count a claim writes in figures against TYPED facts taken from the
 * outputs of the tool calls that returned the claim's cited ids, at the precision the claim
 * states them:
 *
 *   money    only from fields named …Cents (÷100), and "$" amounts in system-written text;
 *   percent  only from share / rate / ratio fields (×100) or …Pct / …Percent fields, and "%" text;
 *   count    only from integer fields and the length of returned lists, and counts in text.
 *
 * Never facts: ids, hashes, timestamps, versions, raw source payloads, names, notes, questions
 * (source- or user-controlled text could otherwise plant a figure), and any number of the wrong
 * type ($0.69 is not supported by "69 customers"; 69% is not supported by a count of 69).
 * Independent review (2026-11-12) found each of those holes in the first version.
 *
 * Deliberately literal: a figure the model computed itself (a sum, a ratio, a forecast) appears
 * in no tool output and fails. Not checked (stated, not hidden): numbers written as words, bare
 * decimals without a unit ("2.9×"), day-of-month numbers next to a month, years 1990–2039.
 */

export interface ClaimNumber {
  text: string;
  kind: "money" | "percent" | "count";
  value: number;
  /** Decimal places as written: the precision the claim asserts. */
  decimals: number;
  /** K/M/B or thousand/million/billion as written (money only). */
  scale: number;
}

export interface NumberCheck {
  text: string;
  kind: ClaimNumber["kind"];
  supported: boolean;
}

/** Typed facts from tool outputs. Money in dollars, percentages in percent units. */
export interface Facts {
  money: Set<number>;
  percent: Set<number>;
  count: Set<number>;
}

export const emptyFacts = (): Facts => ({ money: new Set(), percent: new Set(), count: new Set() });

export function mergeFacts(into: Facts, from: Facts): Facts {
  for (const k of ["money", "percent", "count"] as const) for (const n of from[k]) into[k].add(n);
  return into;
}

const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december";
const SCALE: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9 };
const NUM = String.raw`(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?`;
const UNIT = String.raw`(?:\s?(k|m|b|bn)\b|\s(thousand|million|billion)\b)?`;
const COUNT_NOUN = String.raw`(?:(?:new|paid|open|held|unique|stored|excluded|quarantined)\s+)*(?:customer|lead|record|call|campaign|exception|branch|feed|channel|sample|day|prospect|payment|refund|run)(?:e?s|\((?:e)?s\))?\b`;

function money(text: string, whole: string, frac: string | undefined, unit: string | undefined): ClaimNumber {
  return { text: text.trim(), kind: "money", value: Number(`${whole.replace(/,/g, "")}${frac ? `.${frac}` : ""}`), decimals: frac ? frac.length : 0, scale: unit ? SCALE[unit.toLowerCase()] : 1 };
}

/** The checkable numbers in a claim. */
export function claimNumbers(text: string): ClaimNumber[] {
  const out: ClaimNumber[] = [];
  let rest = text;
  // Money: $1,234 · $1,234.56 · $1.2K · $3 million · USD 310 · 310.00 dollars.
  rest = rest.replace(new RegExp(String.raw`[−-]?(?:\$|\bUSD\s?)\s?${NUM}${UNIT}`, "gi"), (m, w: string, f?: string, u1?: string, u2?: string) => {
    out.push(money(m, w, f, u1 ?? u2));
    return " ";
  });
  rest = rest.replace(new RegExp(String.raw`\b${NUM}${UNIT}\s?(?:dollars?|USD)\b`, "gi"), (m, w: string, f?: string, u1?: string, u2?: string) => {
    out.push(money(m, w, f, u1 ?? u2));
    return " ";
  });
  // Percentages: 14.4% · 50 % · 14.4 percent.
  rest = rest.replace(/(\d+(?:\.(\d+))?)\s?(?:%|percent\b|per cent\b)/gi, (m, n: string, frac?: string) => {
    out.push({ text: m.trim(), kind: "percent", value: Number(n), decimals: frac ? frac.length : 0, scale: 1 });
    return " ";
  });
  // Not quantities: evidence ids, branch ids, versions, times, ISO dates, days of a month, years.
  rest = rest
    .replace(/\b[a-z_]+:[\w.:-]+/gi, " ")
    .replace(/\bHTTP\s+\d{3}\b/gi, " ")
    .replace(/\b[a-z]+(?:_[a-z]+)+\s+#?\d+\b/g, " ") // an exception kind and its id: "quarantined_source_records 1063"
    // A record named in prose ("campaign 8677", "raw event 198055", "exception #2455") is an id.
    .replace(/\b(?:campaigns?|raw events?|exceptions?|customers?|leads?|runs?|changes?|cases?|proposals?|payments?|tickets?|investigations?|incidents?|records?|subscriptions?|appointments?)\s+#?\d+\b|#\d+\b/gi, " ")
    .replace(/\b[A-Za-z]+\d+[\w-]*/g, " ")
    .replace(/\b[A-Za-z][\w]*[-_][\w-]*\d[\w-]*/g, " ") // source record ids: msg-00000074, CAL-77
    .replace(/@?\d+\.\d+(?:\.\d+)*/g, " ")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")
    .replace(/\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?\b/g, " ")
    .replace(new RegExp(String.raw`\b(?:${MONTHS})\.?\s+(\d{1,2})(?:\s*[–-]\s*(\d{1,2}))?(?!\d)`, "gi"), (m, a: string, b?: string) =>
      Number(a) <= 31 && (b === undefined || Number(b) <= 31) ? " " : m.replace(/^\S+/, " "),
    )
    .replace(new RegExp(String.raw`\b(\d{1,2})\s+(?:${MONTHS})\b`, "gi"), (m, a: string) => (Number(a) <= 31 ? " " : m))
    .replace(/\b(?:199\d|20[0-3]\d)\b/g, " ");
  // Counts: any number of two digits or more, and a single digit before a counted noun.
  rest = rest.replace(new RegExp(String.raw`(?<![\w.,])(\d)\s+(?=${COUNT_NOUN})`, "gi"), (m, d: string) => {
    out.push({ text: d, kind: "count", value: Number(d), decimals: 0, scale: 1 });
    return " ";
  });
  for (const m of rest.matchAll(/(?<![\w.,])(\d{1,3}(?:,\d{3})+|\d{2,})(?![\w.,]\d)/g)) {
    out.push({ text: m[1], kind: "count", value: Number(m[1].replace(/,/g, "")), decimals: 0, scale: 1 });
  }
  return out;
}

/** Keys whose values are never facts: identities, times, versions, and source- or user-written text. */
const SKIP_KEY = /^(?:id|ids|.*(?:Id|Ids|_id|_ids)|.*hash|.*Hash|.*At|at|.*_at|.*[Vv]ersions?|question|text|payload|.*[Nn]ote|.*Text|name|.*Name|label|.*Label|externalCampaignId|subject|actor|title|input)$/;
/** System-written sentences whose figures are facts (reconciliation summaries, trace details, mapper errors). */
const TEXT_KEY = /^(?:summary|detail|sampleError|reason)$/;

/** Typed facts from a tool output (see the module comment). */
export function outputFacts(output: unknown, into: Facts = emptyFacts(), key = "", depth = 0): Facts {
  if (depth > 12 || output === null || output === undefined || SKIP_KEY.test(key)) return into;
  if (Array.isArray(output)) {
    into.count.add(output.length);
    for (const v of output.slice(0, 1000)) outputFacts(v, into, key, depth + 1);
    return into;
  }
  if (typeof output === "object") {
    for (const [k, v] of Object.entries(output as Record<string, unknown>)) outputFacts(v, into, k, depth + 1);
    return into;
  }
  if (typeof output === "string") {
    if (TEXT_KEY.test(key)) {
      for (const n of claimNumbers(output.slice(0, 4000))) {
        if (n.kind === "money") into.money.add(n.value * n.scale);
        else if (n.kind === "percent") into.percent.add(n.value);
        else into.count.add(n.value);
      }
      return into;
    }
    if (!/^-?\d+(?:\.\d+)?$/.test(output)) return into;
  }
  const v = Number(output);
  if (typeof output === "boolean" || !Number.isFinite(v)) return into;
  if (/Cents$/i.test(key)) into.money.add(v / 100);
  else if (/(?:^|[a-z])(?:Share|Rate|Ratio|share|rate|ratio)$/.test(key)) into.percent.add(v * 100);
  else if (/(?:Pct|Percent|pct|percent)$/.test(key)) into.percent.add(v);
  else if (Number.isInteger(v)) into.count.add(v);
  return into;
}

function within(a: number, b: number, tolerance: number): boolean {
  return Math.abs(Math.abs(a) - Math.abs(b)) <= tolerance + 1e-9;
}

/** Does a fact of the same type support this number at the precision it is written? */
export function supports(n: ClaimNumber, facts: Facts): boolean {
  switch (n.kind) {
    case "money": {
      const dollars = n.value * n.scale;
      const tolerance = 0.5 * 10 ** -n.decimals * n.scale;
      for (const f of facts.money) if (within(f, dollars, tolerance)) return true;
      return false;
    }
    case "percent":
      for (const f of facts.percent) if (within(f, n.value, 0.5 * 10 ** -n.decimals)) return true;
      return false;
    case "count":
      return facts.count.has(n.value);
  }
}

export function checkNumbers(text: string, facts: Facts): NumberCheck[] {
  return claimNumbers(text).map((n) => ({ text: n.text, kind: n.kind, supported: supports(n, facts) }));
}
