import { z } from "zod";
import { CURRENCY_UNSTATED } from "@/lib/currency/rules";
import type { Queryable } from "@/lib/db";
import { feedFreshness, staleReason } from "@/lib/decision/verdicts";
import { branchRows, paidCac, totals, type BranchRow } from "@/lib/metrics/scorecard";
import { PERIODS, type PeriodKey } from "@/lib/period";
import { BRANCH_BY_ID, BRANCHES, BRANDS } from "@/lib/reference";
import { canSeeBranch, ForbiddenError, type Viewer } from "@/lib/viewer";
import { counterpart, DefinitionSchema, type Attribute, type Definition, type Family, type ProductDefinition, type ScopeKind } from "./definitions";

/**
 * Shadow Mode, metric snapshots (docs/agent-work/SHADOW-MODE.md §1–2): is another system's
 * figure for a scope and window the same fact as the product's, and does it agree?
 *
 * Reads only. The verdict order is the contract's: a refusal first (nothing about a scope the
 * viewer cannot see is computed), then NOT_DETERMINABLE, INCOMPATIBLE_DEFINITION,
 * INCOMPLETE_EVIDENCE, and only then MATCH or MISMATCH. Every query runs one after another on
 * the caller's connection, so a caller can hold one snapshot for the whole check.
 */

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a date like 2026-10-01");
const amount = z.union([z.string().max(40), z.number()]).nullable();

export const SnapshotSchema = z.strictObject({
  system: z.string().min(1).max(80),
  datasetId: z.string().max(120).optional(),
  asOf: z.string().datetime({ offset: true }),
  /** Validated by the comparator: a missing or unreadable definition is NOT_DETERMINABLE, not a 400. */
  definition: z.unknown().optional(),
  scope: z.union([z.strictObject({ branch: z.string().max(10) }), z.strictObject({ brand: z.string().max(40) }), z.strictObject({ company: z.literal(true) })]),
  period: z.strictObject({ from: day, to: day }),
  currency: z.string().max(8).nullable(),
  value: amount,
  numerator: amount.optional(),
  denominator: z.number().int().nonnegative().nullable().optional(),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

export type SnapshotVerdict = "MATCH" | "MISMATCH" | "INCOMPLETE_EVIDENCE" | "INCOMPATIBLE_DEFINITION" | "NOT_DETERMINABLE";

/** A dimension of disagreement, named as the contract names it. */
export type Dimension = `definition.${Attribute}` | "definition" | "currency" | "scope" | "period" | `evidence.${"currency_held" | "feed_stale" | "unreadable"}` | "value" | "numerator" | "denominator" | "revision";

export interface SnapshotCheck {
  verdict: SnapshotVerdict;
  dimensions: Dimension[];
  /** One line per dimension, in the reader's words. */
  findings: string[];
  scope: { kind: ScopeKind; id: string | null; label: string };
  window: { from: string; to: string; fromInstant: string; toInstant: string } | null;
  theirs: { system: string; definition: Definition | null; value: string | null; numerator: string | null; denominator: number | null; currency: string | null; asOf: string };
  /** The product's figure for the same scope and window under its own definition; null when not computed. */
  ours: { metric: ProductDefinition["metric"]; label: string; definitionVersion: string; unit: "usd_cents" | "count"; value: number | null; numerator: number | null; denominator: number | null } | null;
  /** Where the product's figure is reproduced from records (a trace page), when the window is a product period. */
  proof: { href: string | null; evidenceIds: string[] };
  limitations: string[];
  nextStep: string;
}

const DAY_MS = 86_400_000;
/** The product holds September and October 2026, by UTC day. */
const HELD_FROM = new Date("2026-09-01T00:00:00Z");
const HELD_TO = new Date("2026-11-01T00:00:00Z");

const dollars = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const shown = (v: number | null, unit: "usd_cents" | "count") => (v === null ? "undefined" : unit === "usd_cents" ? dollars(v) : String(v));

/**
 * A decimal as written, in ten-thousandths of the unit (so "237.004" is not silently "237.00").
 * Null for null; undefined for something that is not a plain decimal.
 */
function units(value: string | number | null | undefined): number | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  const text = typeof value === "number" ? String(value) : value.trim();
  const m = /^(-?)(\d{1,12})(?:\.(\d{1,4}))?$/.exec(text);
  if (!m) return undefined;
  const whole = Number(m[2]) * 10_000 + Number((m[3] ?? "").padEnd(4, "0"));
  return m[1] ? -whole : whole;
}

/** The scope as the product knows it, or a refusal. Unknown and invisible look the same to a scoped viewer. */
function resolve(viewer: Viewer, scope: Snapshot["scope"]): { kind: ScopeKind; id: string | null; label: string; branchIds: string[] | null } | "unknown" {
  if ("company" in scope) {
    if (viewer.branchIds) throw new ForbiddenError(`${viewer.label} cannot check company-wide figures`);
    return { kind: "company", id: null, label: "All branches", branchIds: null };
  }
  if ("brand" in scope) {
    const brand = BRANDS.find((b) => b.id === scope.brand);
    const ids = brand ? BRANCHES.filter((b) => b.brandId === brand.id).map((b) => b.id) : [];
    if (!brand) {
      if (viewer.branchIds) throw new ForbiddenError(`Brand ${scope.brand} not found in your scope`);
      return "unknown";
    }
    if (!ids.every((id) => canSeeBranch(viewer, id))) throw new ForbiddenError(`${viewer.label} cannot check ${brand.name}`);
    return { kind: "brand", id: brand.id, label: brand.name, branchIds: ids };
  }
  const branch = BRANCH_BY_ID.get(scope.branch);
  if (!branch) {
    if (viewer.branchIds) throw new ForbiddenError(`Branch ${scope.branch} not found in your scope`);
    return "unknown";
  }
  if (!canSeeBranch(viewer, branch.id)) throw new ForbiddenError(`${viewer.label} cannot check branch ${branch.id}`);
  return { kind: "branch", id: branch.id, label: `${branch.id} ${branch.name}`, branchIds: [branch.id] };
}

/** The sources a family's figure is read from: for completeness and for revisions. */
const SOURCES: Record<Family, { ads: boolean; leads: boolean; crm: "payment" | "customer" | "both" | null }> = {
  spend: { ads: true, leads: false, crm: null },
  customers: { ads: false, leads: true, crm: "customer" },
  cash: { ads: false, leads: false, crm: "payment" },
  cac: { ads: true, leads: true, crm: "customer" },
};
const LEAD_SOURCES = ["calls", "web", "d2d"];

function sourceList(f: Family): string[] {
  const s = SOURCES[f];
  return [...(s.ads ? ["ads"] : []), ...(s.leads ? LEAD_SOURCES : []), ...(s.crm ? ["crm"] : [])];
}

/** CRM entities a family reads: payments for cash, everything else for customers. */
function crmEntityFilter(f: Family): string {
  const crm = SOURCES[f].crm;
  return crm === "payment" ? "re.entity = 'payment'" : crm === "customer" ? "re.entity <> 'payment'" : "true";
}

/** The branch a raw event belongs to: what its payload names, else (ad spend) its campaign's mapping. */
const EVENT_BRANCH = `coalesce(payload_branch(re.payload), (
    select m.branch_id from ad_campaigns c join campaign_branch_map m on m.campaign_id = c.id
    where c.platform = re.payload ->> 'platform' and c.external_campaign_id = re.payload ->> 'campaignId'))`;

async function productFigure(db: Queryable, ours: ProductDefinition, branchIds: string[] | null, from: Date, to: Date): Promise<{ value: number | null; numerator: number | null; denominator: number | null }> {
  let rows: Pick<BranchRow, "paidSpendCents" | "paidAcquired" | "acquired" | "collectedCents" | "refundsCents">[];
  let unallocated = 0;
  if (branchIds === null) {
    const t = await totals(db, { from, to, branchIds: null });
    rows = [t];
    unallocated = t.unallocatedSpendCents;
  } else {
    rows = await branchRows(db, { from, to, branchIds });
  }
  const sum = (k: "paidSpendCents" | "paidAcquired" | "acquired" | "collectedCents" | "refundsCents") => rows.reduce((t, r) => t + r[k], 0);
  switch (ours.metric) {
    case "paidCac":
      return { value: paidCac(sum("paidSpendCents"), sum("paidAcquired")), numerator: sum("paidSpendCents"), denominator: sum("paidAcquired") };
    case "paidSpend":
      return { value: sum("paidSpendCents"), numerator: null, denominator: null };
    case "companySpend":
      return { value: sum("paidSpendCents") + unallocated, numerator: null, denominator: null };
    case "paidCustomers":
      return { value: sum("paidAcquired"), numerator: null, denominator: null };
    case "newCustomers":
      return { value: sum("acquired"), numerator: null, denominator: null };
    case "collected":
      return { value: sum("collectedCents"), numerator: null, denominator: null };
    case "grossPayments":
      return { value: sum("collectedCents") + sum("refundsCents"), numerator: null, denominator: null };
  }
}

/** Why the product's own evidence for this scope and window is incomplete for this family. */
async function incompleteness(db: Queryable, family: Family, branchIds: string[] | null, from: Date, to: Date, now: Date): Promise<Array<{ dim: Dimension; text: string }>> {
  const out: Array<{ dim: Dimension; text: string }> = [];
  const fromDay = from.toISOString().slice(0, 10);
  const toDay = to.toISOString().slice(0, 10);
  if (SOURCES[family].ads) {
    const { rows } = await db.query<{ days: string }>(
      `select count(*) as days from raw_events re
       where re.source = 'ads' and re.status = 'excluded' and re.exclusion_code = $1
         and re.payload ->> 'date' >= $2 and re.payload ->> 'date' < $3
         and ($4::text[] is null or ${EVENT_BRANCH} = any($4::text[]))`,
      [CURRENCY_UNSTATED, fromDay, toDay, branchIds],
    );
    const days = Number(rows[0].days);
    if (days > 0) out.push({ dim: "evidence.currency_held", text: `${days} campaign-day(s) of spend in the window are held: the feed stated no currency and no authorized rule establishes it` });
  }
  const sources = sourceList(family);
  const stale = (await feedFreshness(db)).filter((f) => {
    if (!sources.includes(f.source)) return false;
    if (f.source !== "crm" || !f.stream) return true;
    const payments = f.stream.includes("payment");
    return SOURCES[family].crm === "both" || (SOURCES[family].crm === "payment") === payments;
  });
  for (const f of stale) {
    const why = staleReason(f, now);
    if (why) out.push({ dim: "evidence.feed_stale", text: `${f.stream ?? f.source}: ${why}` });
  }
  const { rows: unread } = await db.query<{ source: string; n: string }>(
    `select re.source, count(*) as n from raw_events re
     where re.status = 'quarantined' and re.source = any($1::text[]) and (re.source <> 'crm' or ${crmEntityFilter(family)})
       and re.occurred_at >= $2 and re.occurred_at < $3
       and ($4::text[] is null or ${EVENT_BRANCH} is null or ${EVENT_BRANCH} = any($4::text[]))
     group by re.source order by re.source`,
    [sources, from, to, branchIds],
  );
  for (const u of unread) out.push({ dim: "evidence.unreadable", text: `${u.n} ${u.source} record(s) dated in the window could not be read, so the figure cannot include them` });
  return out;
}

/** Records changing this family's figure in the scope and window that arrived after the snapshot was taken. */
async function laterRevisions(db: Queryable, family: Family, branchIds: string[] | null, from: Date, to: Date, asOf: Date): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `select count(*) as n from raw_events re
     where re.source = any($1::text[]) and (re.source <> 'crm' or ${crmEntityFilter(family)})
       and greatest(re.received_at, re.last_delivered_at) > $4
       and ((re.occurred_at >= $2 and re.occurred_at < $3)
            or (re.payload ->> 'date' >= to_char($2::timestamptz at time zone 'UTC', 'YYYY-MM-DD')
                and re.payload ->> 'date' < to_char($3::timestamptz at time zone 'UTC', 'YYYY-MM-DD')))
       and ($5::text[] is null or ${EVENT_BRANCH} = any($5::text[]))`,
    [sourceList(family), from, to, asOf, branchIds],
  );
  return Number(rows[0].n);
}

const NEXT: Record<SnapshotVerdict, string> = {
  MATCH: "Nothing to do: both systems agree for this scope and window.",
  MISMATCH: "Open the product's trace to see every record behind its figure, then take the difference to the owner of the other system.",
  INCOMPLETE_EVIDENCE: "Resolve the product's missing evidence first (Integrations → pipeline, or the currency rules), then check again.",
  INCOMPATIBLE_DEFINITION: "Not an error: the two figures measure different things. Ask for the other system's figure under the product's definition, or label each figure with its definition.",
  NOT_DETERMINABLE: "Ask the other system for what is missing (its definition, its currency, or a figure by UTC day), then check again.",
};

function traceHref(scope: { kind: ScopeKind; id: string | null }, family: Family, ours: ProductDefinition, from: Date, to: Date): string | null {
  if (scope.kind !== "branch") return null;
  const key = (Object.keys(PERIODS) as PeriodKey[]).find((k) => PERIODS[k].from.getTime() === from.getTime() && PERIODS[k].to.getTime() === to.getTime());
  if (!key) return null;
  const metric = family === "cash" ? "collected" : family === "spend" ? "paid_spend" : ours.metric === "paidCac" ? "paid_cac" : null;
  return metric ? `/branches/${scope.id}/trace?period=${key}&metric=${metric}` : null;
}

/** Checks one snapshot. Throws ForbiddenError when the viewer may not see its scope. */
export async function compareSnapshot(db: Queryable, viewer: Viewer, snapshot: Snapshot, now: Date): Promise<SnapshotCheck> {
  const resolved = resolve(viewer, snapshot.scope);
  const theirsDef = DefinitionSchema.safeParse(snapshot.definition);
  const definition = theirsDef.success ? theirsDef.data : null;
  const theirs = {
    system: snapshot.system,
    definition,
    value: snapshot.value === null ? null : String(snapshot.value),
    numerator: snapshot.numerator === undefined || snapshot.numerator === null ? null : String(snapshot.numerator),
    denominator: snapshot.denominator ?? null,
    currency: snapshot.currency,
    asOf: snapshot.asOf,
  };
  const base = { theirs, limitations: [] as string[], proof: { href: null as string | null, evidenceIds: [] as string[] } };
  const undetermined = (dims: Dimension[], findings: string[], scope: SnapshotCheck["scope"], window: SnapshotCheck["window"] = null): SnapshotCheck => ({
    ...base, verdict: "NOT_DETERMINABLE", dimensions: dims, findings, scope, window, ours: null, nextStep: NEXT.NOT_DETERMINABLE,
  });

  if (resolved === "unknown") {
    const id = "branch" in snapshot.scope ? snapshot.scope.branch : "brand" in snapshot.scope ? snapshot.scope.brand : null;
    return undetermined(["scope"], [`${id} is not a branch or brand the product knows`], { kind: "branch" in snapshot.scope ? "branch" : "brand", id, label: String(id) });
  }
  const scope = { kind: resolved.kind, id: resolved.id, label: resolved.label };

  const from = new Date(`${snapshot.period.from}T00:00:00Z`);
  const to = new Date(new Date(`${snapshot.period.to}T00:00:00Z`).getTime() + DAY_MS);
  const window = Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())
    ? null
    : { from: snapshot.period.from, to: snapshot.period.to, fromInstant: from.toISOString(), toInstant: to.toISOString() };

  // 1 · NOT_DETERMINABLE: what is missing to even frame the comparison.
  const missing: Array<{ dim: Dimension; text: string }> = [];
  if (!definition) missing.push({ dim: "definition", text: snapshot.definition === undefined ? "The snapshot does not say what its number means (no definition)" : "The snapshot's definition is outside the shared vocabulary" });
  if (!window || to.getTime() <= from.getTime()) missing.push({ dim: "period", text: "The window ends before it starts" });
  else if (from < HELD_FROM || to > HELD_TO) missing.push({ dim: "period", text: "The product holds September and October 2026 only" });
  if (definition?.periodBasis === "office_local_day") missing.push({ dim: "period", text: "The figure is by office-local day; the product's figures are by UTC day and it does not recompute on local days" });
  if (snapshot.currency === null) missing.push({ dim: "currency", text: "The snapshot does not state its currency" });
  if (missing.length > 0 || !definition || !window) return undetermined([...new Set(missing.map((m) => m.dim))], missing.map((m) => m.text), scope, window);

  const match = counterpart(definition, resolved.kind);
  if (!match) return undetermined(["definition"], [`The product has no ${definition.family} figure`], scope, window);
  const { ours, differs } = match;
  const figure = await productFigure(db, ours, resolved.branchIds, from, to);
  const oursView = { metric: ours.metric, label: ours.label, definitionVersion: ours.definitionVersion, unit: ours.unit, ...figure };
  const proof = { href: traceHref(scope, definition.family, ours, from, to), evidenceIds: [`shadow:${scope.kind}:${scope.id ?? "company"}:${ours.metric}:${window.from}..${window.to}`] };

  // 2 · INCOMPATIBLE_DEFINITION: comparable only when every attribute and the currency agree.
  const currencyDiffers = (snapshot.currency ?? "").toUpperCase() !== "USD";
  if (differs.length > 0 || currencyDiffers) {
    const dims: Dimension[] = [...differs.map((a) => `definition.${a}` as const), ...(currencyDiffers ? (["currency"] as const) : [])];
    const findings = [
      ...differs.map((a) => `${a}: theirs is ${definition[a] ?? "not stated"}, the product's is ${ours[a] ?? "not applicable"}`),
      ...(currencyDiffers ? [`currency: theirs is ${snapshot.currency}; the product counts USD only and converts nothing`] : []),
    ];
    return { ...base, verdict: "INCOMPATIBLE_DEFINITION", dimensions: dims, findings, scope, window, ours: oursView, proof, nextStep: NEXT.INCOMPATIBLE_DEFINITION, limitations: [`The product's ${ours.label} (${shown(figure.value, ours.unit)}) is shown for reference only: it is not the same measure.`] };
  }

  // 3 · INCOMPLETE_EVIDENCE: the product's own figure leaves something out.
  const gaps = await incompleteness(db, definition.family, resolved.branchIds, from, to, now);
  const revisions = await laterRevisions(db, definition.family, resolved.branchIds, from, to, new Date(snapshot.asOf));
  const revisionNote = revisions > 0 ? `${revisions} record(s) that change this figure arrived after the snapshot was taken (${snapshot.asOf})` : null;
  if (gaps.length > 0) {
    const theirValue = units(snapshot.value);
    const agree = theirValue !== undefined && theirValue !== null && figure.value !== null && theirValue === figure.value * (ours.unit === "usd_cents" ? 100 : 10_000);
    return {
      ...base, verdict: "INCOMPLETE_EVIDENCE", dimensions: [...new Set(gaps.map((g) => g.dim))], findings: gaps.map((g) => g.text), scope, window, ours: oursView, proof, nextStep: NEXT.INCOMPLETE_EVIDENCE,
      limitations: [
        agree ? "The two values agree, but both could be missing the same records." : "The values cannot be judged until the product's evidence is complete.",
        ...(revisionNote ? [revisionNote] : []),
      ],
    };
  }

  // 4–5 · MATCH or MISMATCH, exactly: money to the cent as written, counts exactly.
  const scale = ours.unit === "usd_cents" ? 100 : 10_000;
  const theirValue = units(snapshot.value);
  const dims: Dimension[] = [];
  const findings: string[] = [];
  if (theirValue === undefined) {
    return undetermined(["value"], [`The value "${theirs.value}" is not a plain decimal`], scope, window);
  }
  const productUnits = figure.value === null ? null : figure.value * scale;
  if (theirValue !== productUnits) {
    dims.push("value");
    findings.push(`value: theirs is ${theirs.value ?? "undefined"}, the product's is ${shown(figure.value, ours.unit)}`);
  }
  if (ours.metric === "paidCac") {
    const n = units(snapshot.numerator);
    if (n !== undefined && n !== null && figure.numerator !== null && n !== figure.numerator * 100) {
      dims.push("numerator");
      findings.push(`numerator (spend): theirs is ${theirs.numerator}, the product's is ${dollars(figure.numerator)}`);
    }
    if (snapshot.denominator !== undefined && snapshot.denominator !== null && snapshot.denominator !== figure.denominator) {
      dims.push("denominator");
      findings.push(`denominator (paid customers): theirs is ${snapshot.denominator}, the product's is ${figure.denominator}`);
    }
  }
  if (dims.length > 0) {
    if (revisionNote) {
      dims.push("revision");
      findings.push(`revision: ${revisionNote}; the snapshot may predate them`);
    }
    return { ...base, verdict: "MISMATCH", dimensions: dims, findings, scope, window, ours: oursView, proof, nextStep: NEXT.MISMATCH };
  }
  return {
    ...base, verdict: "MATCH", dimensions: revisionNote ? ["revision"] : [], findings: [`Both report ${shown(figure.value, ours.unit)} for ${scope.label}, ${window.from} to ${window.to} (UTC days)`], scope, window, ours: oursView, proof, nextStep: NEXT.MATCH,
    limitations: revisionNote ? [`${revisionNote}; they did not change the figure.`] : [],
  };
}
