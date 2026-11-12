/**
 * Numeric claim verification, outside the model.
 *
 * Grounding by evidence id (lib/ai/analyst.ts) proves a claim cites records a tool returned; it
 * does not prove the claim's NUMBERS are the records' numbers. A claim can cite
 * `branch_metrics:B09:oct` and still say "$310" where the tool said $241.29. This module checks
 * every dollar amount, percentage and multi-digit count in a claim against the numbers in the
 * outputs of the tool calls that returned the claim's cited ids, at the precision the claim
 * states them. Anything else (dates, ids, versions, single digits) is not checked.
 *
 * It is deliberately literal: a number the model computed itself (a sum, a ratio, a forecast)
 * appears in no tool output and fails. Authoritative financial figures come from tools.
 */

export interface ClaimNumber {
  text: string;
  kind: "money" | "percent" | "count";
  value: number;
  /** Decimal places as written: the precision the claim asserts. */
  decimals: number;
  /** K/M suffix multiplier as written (money only). */
  scale: number;
}

export interface NumberCheck {
  text: string;
  kind: ClaimNumber["kind"];
  supported: boolean;
}

const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december";

/** The checkable numbers in a claim. */
export function claimNumbers(text: string): ClaimNumber[] {
  const out: ClaimNumber[] = [];
  let rest = text;
  // Money: $1,234 · $1,234.56 · $1.2K · $3M (and −$ / -$).
  rest = rest.replace(/[−-]?\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s?([KkMm])?\b/g, (m, whole: string, frac: string | undefined, suffix: string | undefined) => {
    const value = Number(`${whole.replace(/,/g, "")}${frac ? `.${frac}` : ""}`);
    out.push({ text: m.trim(), kind: "money", value, decimals: frac ? frac.length : 0, scale: suffix ? (suffix.toLowerCase() === "k" ? 1_000 : 1_000_000) : 1 });
    return " ";
  });
  // Percentages: 14.4% · 50 %.
  rest = rest.replace(/(\d+(?:\.(\d+))?)\s?%/g, (m, n: string, frac: string | undefined) => {
    out.push({ text: m, kind: "percent", value: Number(n), decimals: frac ? frac.length : 0, scale: 1 });
    return " ";
  });
  // Things that look numeric but are not quantities: evidence ids, branch ids, versions, times,
  // ISO dates, "Oct 12" / "12 Oct", years.
  rest = rest
    .replace(/\b[a-z_]+:[\w.:-]+/gi, " ")
    .replace(/\b[A-Za-z]+\d+[\w-]*/g, " ")
    .replace(/@?\d+\.\d+(?:\.\d+)*/g, " ")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")
    .replace(/\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?\b/g, " ")
    .replace(new RegExp(String.raw`\b(?:${MONTHS})\.?\s+\d{1,2}(?:\s*[–-]\s*\d{1,2})?\b`, "gi"), " ")
    .replace(new RegExp(String.raw`\b\d{1,2}\s+(?:${MONTHS})\b`, "gi"), " ")
    .replace(/\b(?:19|20)\d{2}\b/g, " ");
  for (const m of rest.matchAll(/(?<![\w.,])(\d{1,3}(?:,\d{3})+|\d{2,})(?![\w.,]\d)/g)) {
    out.push({ text: m[1], kind: "count", value: Number(m[1].replace(/,/g, "")), decimals: 0, scale: 1 });
  }
  return out;
}

/** Every number in a tool output: numeric fields, numeric strings and numbers inside text. */
export function outputNumbers(output: unknown, into: Set<number> = new Set(), depth = 0): Set<number> {
  if (depth > 12 || output === null || output === undefined) return into;
  if (typeof output === "number") {
    if (Number.isFinite(output)) into.add(output);
  } else if (typeof output === "string") {
    if (output.length <= 2000) for (const m of output.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)) {
      const n = Number(m[0].replace(/,/g, ""));
      if (Number.isFinite(n)) into.add(n);
    }
  } else if (Array.isArray(output)) {
    // How many items a tool returned is itself a fact of its output ("of the 25 read").
    into.add(output.length);
    for (const v of output.slice(0, 500)) outputNumbers(v, into, depth + 1);
  } else if (typeof output === "object") {
    for (const v of Object.values(output as Record<string, unknown>)) outputNumbers(v, into, depth + 1);
  }
  return into;
}

function close(a: number, b: number, decimals: number): boolean {
  return Math.abs(a - b) < 0.5 * 10 ** -decimals + 1e-9;
}

/** Does any fact support this number at the precision it is written? */
export function supports(n: ClaimNumber, facts: ReadonlySet<number>): boolean {
  for (const f of facts) {
    switch (n.kind) {
      case "money": {
        // Facts may be cents (most tools) or dollars (text). Compare in the claim's unit.
        const shown = (v: number) => v / n.scale;
        const precision = n.scale === 1 ? n.decimals : Math.max(n.decimals, 1);
        if (close(shown(Math.abs(f) / 100), n.value, precision) || close(shown(Math.abs(f)), n.value, precision)) return true;
        break;
      }
      case "percent":
        if (close(Math.abs(f) * 100, n.value, n.decimals) || close(Math.abs(f), n.value, n.decimals)) return true;
        break;
      case "count":
        if (Math.abs(f) === n.value) return true;
        break;
    }
  }
  return false;
}

export function checkNumbers(text: string, facts: ReadonlySet<number>): NumberCheck[] {
  return claimNumbers(text).map((n) => ({ text: n.text, kind: n.kind, supported: supports(n, facts) }));
}
