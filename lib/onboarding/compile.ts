import { z } from "zod";
import type { Projection, RawRecord } from "@/lib/adapters/contract";
import { mapperFor, referenceContext } from "@/lib/adapters/registry";
import { prepare } from "@/lib/ingest/ingest";
import { BRANCH_BY_ID } from "@/lib/reference";
import { canonicalJson, instantToWallTime, sha256, wallTimeToInstant } from "@/lib/primitives";
import { resolveBranch } from "./branches";
import { CANONICAL } from "./vocabulary";
import type { ParsedTable } from "./parse";
import { classify } from "./profile";
import { DATASETS, MONEY_MEANINGS, type DatasetId, type TargetField } from "./targets";
import { dollarsToMicros, isBlank, isoDateOf, parseCount, parseDateValue, parseIdentifier, parseMoneyText, wallTimeOf, type DateParts, type ValueResult } from "./values";

/**
 * Mapping spec -> source-native payloads -> the production mapper, row by row.
 *
 * The spec is what a person approved: which column is which field, what each money column
 * means, the date order, how zone-less times are read and how source values translate. The
 * compiled payload is exactly what that source's live feed would deliver, and it is validated
 * by `prepare()` with the deployed mapper: a dry run quarantines what live ingestion would
 * quarantine, with the same codes. Compilation is pure and deterministic, so a replay of the
 * same file with the same mapping version gives the same outcome.
 */

const MONEY_KEYS = Object.keys(MONEY_MEANINGS) as [keyof typeof MONEY_MEANINGS, ...Array<keyof typeof MONEY_MEANINGS>];

export const MappingSpecSchema = z.object({
  dataset: z.enum(["calls", "web_leads", "crm_payments", "ad_spend"]),
  /** field -> column name, or null when the person declared the field absent from this file. */
  columns: z.record(z.string(), z.string().max(200).nullable()),
  /** field -> a constant for every row (e.g. the platform of a single-platform report). */
  constants: z.record(z.string(), z.string().max(200)).default({}),
  /** field -> source value -> canonical value, for enum and branch fields. */
  valueMaps: z.record(z.string(), z.record(z.string().max(200), z.string().max(60))).default({}),
  dateOrder: z.enum(["MDY", "DMY"]).nullable().default(null),
  /** How zone-less times are read. "branch_local": in the row's branch time zone (DST-aware). */
  localTime: z.enum(["branch_local"]).nullable().default(null),
  /** field -> what the person confirmed the money column means. */
  moneyMeaning: z.record(z.string(), z.enum(MONEY_KEYS)).default({}),
  /** Ad reports: when the report was exported (the version clock of each spend day). */
  exportedAt: z.string().max(40).nullable().default(null),
});
export type MappingSpec = z.infer<typeof MappingSpecSchema>;

export interface SpecProblem {
  field: string | null;
  code: string;
  message: string;
}

export interface RowIssue {
  field: string;
  column: string | null;
  code: string;
  detail: string;
  suggestion: string;
  safeToAutomate: boolean;
}

export type RowOutcome =
  | { row: number; disposition: "eligible"; record: RawRecord; projection: Projection; externalId: string; entityId: string; hash: string; dayGrain: string[] }
  | { row: number; disposition: "invalid"; issues: RowIssue[] }
  | { row: number; disposition: "quarantined"; code: string; detail: string; externalId: string }
  | { row: number; disposition: "duplicate_in_file"; of: number; externalId: string }
  | { row: number; disposition: "conflict_in_file"; with: number; externalId: string };

/** Spec hash: identical rules have one identity, whatever their key order. */
export function specHash(spec: MappingSpec): string {
  return sha256(canonicalJson(spec)).slice(0, 16);
}

/** Header fingerprint: the same export layout gets the same fingerprint, whatever the row data. */
export function layoutFingerprint(table: Pick<ParsedTable, "sourceHeaders">): string {
  // In order: with repeated headers, a reordered export is a different layout (data review #11).
  return sha256(table.sourceHeaders.map((h) => h.trim().toLowerCase()).join("\u0001")).slice(0, 16);
}

/** Problems with the spec itself. Any problem blocks the dry run: the rules are incomplete. */
export function validateSpec(spec: MappingSpec, table: ParsedTable): SpecProblem[] {
  const target = DATASETS[spec.dataset];
  const problems: SpecProblem[] = [];
  const columns = new Set(table.columns);
  for (const field of target.fields) {
    const column = spec.columns[field.key];
    const constant = spec.constants[field.key];
    if (column && !columns.has(column)) problems.push({ field: field.key, code: "UNKNOWN_COLUMN", message: `${field.label}: column "${column}" is not in this file` });
    if (field.required && !column && constant === undefined) problems.push({ field: field.key, code: "REQUIRED_FIELD_UNMAPPED", message: `${field.label} is required: choose a column${field.kind === "enum" ? " or a fixed value" : ""}` });
    if (constant !== undefined && field.kind === "enum" && !CANONICAL[`${spec.dataset}.${field.key}`]?.includes(constant)) {
      problems.push({ field: field.key, code: "INVALID_CONSTANT", message: `${field.label}: "${constant}" is not one of ${CANONICAL[`${spec.dataset}.${field.key}`]?.join(", ")}` });
    }
    // A constant is a statement about every row: allowed for a code (the platform) or an id (the
    // ad account), never for money, a time or a person, which would skip every check those get.
    if (constant !== undefined && field.kind !== "enum" && field.kind !== "identifier") {
      problems.push({ field: field.key, code: "CONSTANT_NOT_ALLOWED", message: `${field.label} must come from a column; a fixed value is not accepted` });
    }
    // Value translations must land on values the mapper accepts (data review #8): a typo here
    // would otherwise surface as a crash in the dry run, not as a question.
    for (const [source, target] of Object.entries(spec.valueMaps[field.key] ?? {})) {
      const allowed = field.kind === "branch" ? BRANCH_BY_ID.has(target) : (CANONICAL[`${spec.dataset}.${field.key}`] ?? []).includes(target);
      if (!allowed) problems.push({ field: field.key, code: "INVALID_TRANSLATION", message: `${field.label}: "${source.slice(0, 40)}" is translated to "${target.slice(0, 40)}", which is not a valid ${field.kind === "branch" ? "branch" : "value"}` });
    }
    if (field.kind === "money" && column) {
      const stated = spec.moneyMeaning[field.key];
      if (!stated) problems.push({ field: field.key, code: "MONEY_MEANING_UNCONFIRMED", message: `${field.label}: confirm what "${column}" means (for example, cash collected vs. invoice total)` });
      else if (stated !== field.moneyMeaning) {
        problems.push({ field: field.key, code: "WRONG_MONEY_MEANING", message: `"${column}" is ${MONEY_MEANINGS[stated].toLowerCase()}; ${field.label} needs ${MONEY_MEANINGS[field.moneyMeaning!].toLowerCase()}. It cannot be used.` });
      }
    }
    if ((field.kind === "datetime" || field.kind === "date") && column) {
      const index = table.columns.indexOf(column);
      const values = table.rows.map((r) => r[index]).filter((v): v is string => !isBlank(v));
      const kinds = new Set(values.map(classify));
      if ((kinds.has("date_us") || kinds.has("date_ambiguous")) && !spec.dateOrder) {
        problems.push({ field: field.key, code: "DATE_ORDER_REQUIRED", message: `${field.label}: "${column}" has dates like 03/04/2026. State whether the month or the day comes first.` });
      }
      // Any value without an offset (a local time, or a date alone) needs a stated time zone.
      const zoneless = values.some((v) => !/(Z|[+-]\d{2}:?\d{2})$/.test(v.trim()));
      if (field.kind === "datetime" && zoneless && !spec.localTime) {
        problems.push({ field: field.key, code: "TIME_ZONE_REQUIRED", message: `${field.label}: "${column}" has times without a time zone. Confirm they are in each branch's local time.` });
      }
    }
  }
  if (spec.dataset === "ad_spend" && !spec.exportedAt) problems.push({ field: null, code: "EXPORT_TIME_REQUIRED", message: "State when this report was exported: platforms restate recent days, so the export time orders versions" });
  if (spec.exportedAt && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?Z$/.test(spec.exportedAt)) problems.push({ field: null, code: "INVALID_EXPORT_TIME", message: "The export time must be an ISO UTC instant" });
  return problems;
}

// ── Row compilation ───────────────────────────────────────────────────────────

interface Ctx {
  spec: MappingSpec;
  table: ParsedTable;
  index: Map<string, number>;
  row: Array<string | null>;
  issues: RowIssue[];
  /** Fields whose value had a date but no time; they are compared with the ledger by day only. */
  dayGrain: string[];
}

/** Fields that may arrive as a date only (an export of payments by day). Calls and leads need the time. */
const DAY_GRAIN_ALLOWED = new Set(["crm_payments.paid_at"]);

function cell(ctx: Ctx, field: TargetField): string | null {
  const constant = ctx.spec.constants[field.key];
  if (constant !== undefined) return constant;
  const column = ctx.spec.columns[field.key];
  if (!column) return null;
  const raw = ctx.row[ctx.index.get(column)!];
  return isBlank(raw) ? null : raw!.trim();
}

function take<T>(ctx: Ctx, field: TargetField, result: ValueResult<T>): T | undefined {
  if (result.ok) return result.value;
  ctx.issues.push({ field: field.key, column: ctx.spec.columns[field.key] ?? null, code: result.code, detail: result.detail, suggestion: result.suggestion, safeToAutomate: result.safeToAutomate });
  return undefined;
}

function issue(ctx: Ctx, field: TargetField, code: string, detail: string, suggestion: string, safeToAutomate = false): undefined {
  ctx.issues.push({ field: field.key, column: ctx.spec.columns[field.key] ?? null, code, detail, suggestion, safeToAutomate });
  return undefined;
}

function required(ctx: Ctx, field: TargetField): string | undefined {
  const v = cell(ctx, field);
  if (v === null) return issue(ctx, field, "MISSING_VALUE", `${field.label} is blank`, "Fill the value in the source system and export again");
  return v;
}

function translated(ctx: Ctx, field: TargetField, value: string): string | undefined {
  const canon = CANONICAL[`${ctx.spec.dataset}.${field.key}`] ?? [];
  if (field.kind === "enum" && canon.includes(value)) return value;
  const mapped = ctx.spec.valueMaps[field.key]?.[value];
  if (mapped !== undefined) return mapped;
  if (field.kind === "branch") {
    const exact = resolveBranch(value);
    if (exact?.via === "branch_id") return exact.branchId; // a branch id names itself
  }
  return issue(ctx, field, field.kind === "branch" ? "UNKNOWN_BRANCH" : "UNMAPPED_VALUE", `${field.label} "${value.slice(0, 60)}" has no confirmed translation`, field.kind === "branch" ? "Map this value to a branch in the mapping review, or leave the row quarantined" : "Translate this value in the mapping review, or leave the row quarantined");
}

/** A datetime as an instant (ISO with offset) or as office wall time, per the target's convention. */
function instant(ctx: Ctx, field: TargetField, raw: string, branchId: string | undefined, want: "iso" | "wall"): string | undefined {
  const parsed = take(ctx, field, parseDateValue(raw, ctx.spec.dateOrder));
  if (!parsed) return undefined;
  if (!parsed.hasTime && field.kind === "datetime") {
    if (!DAY_GRAIN_ALLOWED.has(`${ctx.spec.dataset}.${field.key}`)) return issue(ctx, field, "TIME_MISSING", `"${raw}" has a date but no time`, "Export the full timestamp");
    // Start of the local day; the comparison with the ledger uses the day, never this time.
    ctx.dayGrain.push(field.key);
  }
  const zone = branchId ? BRANCH_BY_ID.get(branchId)?.timezone : undefined;
  // Never return without an issue on record: a silent undefined would build a broken payload.
  const noZone = () =>
    ctx.issues.some((i) => i.field === "branch") ? undefined : issue(ctx, field, "BRANCH_REQUIRED", `"${raw}" cannot be placed in a time zone without the row's branch`, "Fix the branch for this row");
  if (parsed.offset !== null) {
    const iso = `${isoDateOf(parsed)}T${wallTimeOf(parsed).slice(11)}${parsed.offset}`;
    if (want === "iso") return iso;
    if (!zone) return noZone();
    return instantToWallTime(new Date(iso), zone);
  }
  if (ctx.spec.localTime !== "branch_local") return issue(ctx, field, "TIME_ZONE_REQUIRED", `"${raw}" has no time zone`, "Confirm in the mapping that times are branch-local");
  if (!zone) return noZone();
  const wall = wallTimeOf(parsed);
  return localCheck(ctx, field, wall, zone, raw) ? (want === "wall" ? wall : wallTimeToInstant(wall, zone).toISOString().replace(".000Z", "Z")) : undefined;
}

/** A local time that does not exist (spring-forward gap) or exists twice (fall-back) is not guessed. */
function localCheck(ctx: Ctx, field: TargetField, wall: string, zone: string, raw: string): boolean {
  const at = wallTimeToInstant(wall, zone);
  if (instantToWallTime(at, zone) !== wall) {
    issue(ctx, field, "NONEXISTENT_LOCAL_TIME", `"${raw}" falls in the daylight-saving gap in ${zone}`, "Check the source time; clocks skipped this hour");
    return false;
  }
  for (const shift of [-3_600_000, 3_600_000]) {
    if (instantToWallTime(new Date(at.getTime() + shift), zone) === wall) {
      issue(ctx, field, "AMBIGUOUS_LOCAL_TIME", `"${raw}" happened twice in ${zone} (clocks fell back)`, "Export with a UTC offset to tell the two apart");
      return false;
    }
  }
  return true;
}

const f = (dataset: DatasetId, key: string) => DATASETS[dataset].fields.find((x) => x.key === key)!;

function compileCalls(ctx: Ctx): RawRecord | null {
  const F = (k: string) => f("calls", k);
  const id = (() => {
    const v = required(ctx, F("call_id"));
    return v === undefined ? undefined : take(ctx, F("call_id"), parseIdentifier(v, false));
  })();
  const branchRaw = required(ctx, F("branch"));
  const branch = branchRaw === undefined ? undefined : translated(ctx, F("branch"), branchRaw);
  const startedRaw = required(ctx, F("started_at"));
  const started = startedRaw === undefined ? undefined : instant(ctx, F("started_at"), startedRaw, branch, "iso");
  const caller = required(ctx, F("caller_phone"));
  const sourceRaw = required(ctx, F("call_source"));
  const source = sourceRaw === undefined ? undefined : translated(ctx, F("call_source"), sourceRaw);
  if (ctx.issues.length > 0) return null;
  return {
    entity: "call",
    payload: {
      id, branch_tag: branch, start_time: started, customer_phone_number: caller,
      tracking_phone_number: cell(ctx, F("tracking_number")) ?? "", source,
      gclid: cell(ctx, F("click_id")), campaign: cell(ctx, F("campaign")), agent_note: cell(ctx, F("note")),
    },
  };
}

function compileWebLeads(ctx: Ctx): RawRecord | null {
  const F = (k: string) => f("web_leads", k);
  const idRaw = required(ctx, F("lead_id"));
  const id = idRaw === undefined ? undefined : take(ctx, F("lead_id"), parseIdentifier(idRaw, false));
  const branchRaw = required(ctx, F("branch"));
  const branch = branchRaw === undefined ? undefined : translated(ctx, F("branch"), branchRaw);
  const atRaw = required(ctx, F("submitted_at"));
  const at = atRaw === undefined ? undefined : instant(ctx, F("submitted_at"), atRaw, branch, "iso");
  const formRaw = required(ctx, F("form_type"));
  const form = formRaw === undefined ? undefined : translated(ctx, F("form_type"), formRaw);
  const zipRaw = required(ctx, F("zip"));
  // A ZIP a spreadsheet stored as a number ("2108") lost its leading zero; it is not re-padded silently.
  const zip = zipRaw === undefined ? undefined : /^\d{5}$/.test(zipRaw) ? zipRaw : /^\d{5}-\d{4}$/.test(zipRaw) ? zipRaw.slice(0, 5) : issue(ctx, F("zip"), /^\d{3,4}$/.test(zipRaw) ? "ZIP_LOST_LEADING_ZERO" : "INVALID_ZIP", `ZIP "${zipRaw}" is not five digits`, /^\d{3,4}$/.test(zipRaw) ? "The export dropped leading zeros; re-export the column as text" : "Check the value", false);
  if (ctx.issues.length > 0) return null;
  return {
    entity: "lead",
    payload: {
      messageId: id,
      timestamp: at,
      properties: {
        form, branch_id: branch, zip, phone: cell(ctx, F("phone")), email: cell(ctx, F("email")),
        utm_source: cell(ctx, F("utm_source")), utm_medium: cell(ctx, F("utm_medium")), utm_campaign: cell(ctx, F("utm_campaign")),
        gclid: cell(ctx, F("click_id")), message: cell(ctx, F("message")),
      },
    },
  };
}

function compilePayments(ctx: Ctx): RawRecord | null {
  const F = (k: string) => f("crm_payments", k);
  const num = (key: string, optional: boolean) => {
    const v = optional ? cell(ctx, F(key)) : required(ctx, F(key));
    if (v === null) return "0"; // the CRM's own "no reference" value; only for optional references
    return v === undefined ? undefined : take(ctx, F(key), parseIdentifier(v, true));
  };
  const paymentID = num("payment_id", false);
  const customerID = num("customer_id", false);
  const ticketID = num("ticket_id", true);
  const originalPaymentID = num("original_payment_id", true);
  const branchRaw = required(ctx, F("branch"));
  const branch = branchRaw === undefined ? undefined : translated(ctx, F("branch"), branchRaw);
  const amountRaw = required(ctx, F("amount"));
  const amount = amountRaw === undefined ? undefined : take(ctx, F("amount"), parseMoneyText(amountRaw));
  const statusRaw = required(ctx, F("status"));
  const status = statusRaw === undefined ? undefined : translated(ctx, F("status"), statusRaw);
  const paidRaw = required(ctx, F("paid_at"));
  const paid = paidRaw === undefined ? undefined : instant(ctx, F("paid_at"), paidRaw, branch, "wall");
  if (ctx.issues.length > 0) return null;
  const officeID = String(BRANCH_BY_ID.get(branch!)!.crmOfficeId);
  const statusCode = { successful: "1", failed: "0", voided: "2" }[status as "successful"];
  return { entity: "payment", payload: { paymentID, customerID, officeID, ticketID, amount, originalPaymentID, status: statusCode, date: paid } };
}

function compileAdSpend(ctx: Ctx): RawRecord | null {
  const F = (k: string) => f("ad_spend", k);
  const platformRaw = required(ctx, F("platform"));
  const platform = platformRaw === undefined ? undefined : translated(ctx, F("platform"), platformRaw);
  const accountId = required(ctx, F("account_id"));
  const campaignRaw = required(ctx, F("campaign_id"));
  const campaignId = campaignRaw === undefined ? undefined : take(ctx, F("campaign_id"), parseIdentifier(campaignRaw, false));
  const campaignName = required(ctx, F("campaign_name"));
  const dateRaw = required(ctx, F("date"));
  let date: string | undefined;
  if (dateRaw !== undefined) {
    const parsed = take(ctx, F("date"), parseDateValue(dateRaw, ctx.spec.dateOrder));
    if (parsed) date = isoDateOf(parsed as DateParts);
  }
  const costRaw = required(ctx, F("cost"));
  const cost = costRaw === undefined ? undefined : take(ctx, F("cost"), parseMoneyText(costRaw));
  if (cost !== undefined && cost.startsWith("-")) issue(ctx, F("cost"), "NEGATIVE_COST", `Cost "${costRaw}" is negative`, "Platform credits are not spend; record them separately");
  const clicksRaw = required(ctx, F("clicks"));
  const clicks = clicksRaw === undefined ? undefined : take(ctx, F("clicks"), parseCount(clicksRaw));
  const convRaw = required(ctx, F("conversions"));
  const conversions = convRaw === undefined ? undefined : take(ctx, F("conversions"), parseCount(convRaw));
  if (ctx.issues.length > 0) return null;
  return {
    entity: "spend_day",
    payload: { platform, accountId, campaignId, campaignName, date, costMicros: dollarsToMicros(cost!), clicks, conversions, fetchedAt: ctx.spec.exportedAt },
  };
}

/** When the business event happened, per projection (spend days start at midnight UTC of their date). */
function eventTime(projection: Projection): Date | null {
  switch (projection.table) {
    case "leads":
      return projection.row.occurredAt;
    case "crm_payments":
      return projection.row.paidAt;
    case "ad_spend_daily":
      return new Date(`${projection.row.spendDate}T00:00:00Z`);
    default:
      return null;
  }
}

const COMPILERS: Record<DatasetId, (ctx: Ctx) => RawRecord | null> = {
  calls: compileCalls,
  web_leads: compileWebLeads,
  crm_payments: compilePayments,
  ad_spend: compileAdSpend,
};

/**
 * Compiles and dry-runs every row. Pure: no database. `now` is the delivery time the mapper
 * sees (it orders clock-less versions), so pass the same `now` to replay identically.
 */
export function compileRows(table: ParsedTable, spec: MappingSpec, now: Date): RowOutcome[] {
  const index = new Map(table.columns.map((c, i) => [c, i]));
  const mapper = mapperFor(DATASETS[spec.dataset].source);
  const outcomes: RowOutcome[] = [];
  const byExternal = new Map<string, { row: number; hash: string }>();
  const ragged = new Set(table.raggedRows);
  for (const [i, row] of table.rows.entries()) {
    const rowRef = table.rowRefs[i];
    const ctx: Ctx = { spec, table, index, row, issues: [], dayGrain: [] };
    if (ragged.has(rowRef)) {
      outcomes.push({ row: rowRef, disposition: "invalid", issues: [{ field: "*", column: null, code: "RAGGED_ROW", detail: "The row has a different number of cells than the header", suggestion: "A delimiter or quote inside a value probably shifted the columns; fix the export", safeToAutomate: false }] });
      continue;
    }
    // A report's own total line ("Total: Account") is not data. Excluding it is safe to automate.
    const firstCell = row.find((c) => !isBlank(c));
    // "Total", "Totals", "Grand total", "Total: Account". Not "Total Home Protection - Dallas",
    // a real campaign whose spend must count (data review #9).
    if (firstCell && /^(grand\s+)?totals?\s*(:.*)?$/i.test(firstCell.trim())) {
      outcomes.push({ row: rowRef, disposition: "invalid", issues: [{ field: "*", column: null, code: "SUMMARY_ROW", detail: `"${firstCell.trim().slice(0, 40)}" is a report total, not a record`, suggestion: "Excluded; totals are recomputed from the rows", safeToAutomate: true }] });
      continue;
    }
    const record = COMPILERS[spec.dataset](ctx);
    if (!record) {
      outcomes.push({ row: rowRef, disposition: "invalid", issues: ctx.issues });
      continue;
    }
    const p = prepare(record, mapper, referenceContext, now);
    // One export holds one version of a record: the same record twice is a duplicate when the
    // content matches and a conflict when it does not (keyed by record, not by version).
    const key = p.identity.entityId === "unidentified" ? p.identity.externalId : `${p.identity.entity}:${p.identity.entityId}`;
    const seen = byExternal.get(key);
    if (seen) {
      outcomes.push(seen.hash === p.hash ? { row: rowRef, disposition: "duplicate_in_file", of: seen.row, externalId: p.identity.externalId } : { row: rowRef, disposition: "conflict_in_file", with: seen.row, externalId: p.identity.externalId });
      continue;
    }
    byExternal.set(key, { row: rowRef, hash: p.hash });
    if (!p.result.ok) {
      outcomes.push({ row: rowRef, disposition: "quarantined", code: p.result.code, detail: p.result.detail, externalId: p.identity.externalId });
      continue;
    }
    // A record from after the business clock means a time-zone or clock error in the export,
    // not news from the future. A day of slack covers a zone misread at the edge of a day.
    const at = eventTime(p.result.projection);
    if (at !== null && at.getTime() > now.getTime() + 86_400_000) {
      outcomes.push({ row: rowRef, disposition: "invalid", issues: [{ field: "*", column: null, code: "FUTURE_TIMESTAMP", detail: `The record is dated ${at.toISOString().slice(0, 16).replace("T", " ")}Z, after the business clock (${now.toISOString().slice(0, 16).replace("T", " ")}Z)`, suggestion: "Check the export's time zone and the source system's clock", safeToAutomate: false }] });
      continue;
    }
    outcomes.push({ row: rowRef, disposition: "eligible", record, projection: p.result.projection, externalId: p.identity.externalId, entityId: p.identity.entityId, hash: p.hash, dayGrain: ctx.dayGrain });
  }
  return outcomes;
}
