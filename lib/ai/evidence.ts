import { z } from "zod";

/**
 * Evidence ids: stable, typed references to stored records, e.g. `exception:2455`,
 * `raw_event:156389`, `customer:415347`, `campaign:157`.
 *
 * Tools return them next to their data; every claim in an investigation must cite ids that a
 * tool returned in the same run (lib/ai/grounding.ts). The evidence drawer resolves an id back
 * to the stored record (lib/ai/queries.ts), so the format is part of the contract: never
 * change an existing kind's meaning.
 */

export const EVIDENCE_KINDS = [
  "exception",
  "raw_event",
  "customer",
  "lead",
  "payment",
  "campaign",
  "ingestion_run",
  "audit",
  "metric_definition",
  "branch_metrics",
  "channel_metrics",
  "readiness",
  "case",
  "proposal",
] as const;

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** kind:key — keys are numeric ids or colon-separated natural keys (branch_metrics:B09:oct). */
export const EVIDENCE_ID = /^([a-z_]+):([A-Za-z0-9_.-]+(?::[A-Za-z0-9_.-]+)*)$/;

export const EvidenceIdSchema = z
  .string()
  .max(120)
  .regex(EVIDENCE_ID, "an evidence id like exception:2455")
  .refine((v) => (EVIDENCE_KINDS as readonly string[]).includes(v.split(":")[0]), "unknown evidence kind");

export const evidence = {
  exception: (id: number) => `exception:${id}`,
  rawEvent: (id: number) => `raw_event:${id}`,
  customer: (id: number) => `customer:${id}`,
  lead: (id: number) => `lead:${id}`,
  payment: (id: number) => `payment:${id}`,
  campaign: (id: number) => `campaign:${id}`,
  ingestionRun: (id: number) => `ingestion_run:${id}`,
  audit: (id: number) => `audit:${id}`,
  metricDefinition: (key: string) => `metric_definition:${key}`,
  branchMetrics: (branchId: string, period: string) => `branch_metrics:${branchId}:${period}`,
  channelMetrics: (branchId: string, period: string, channel: string) => `channel_metrics:${branchId}:${period}:${channel}`,
  readiness: (branchId: string, period: string, channel: string) => `readiness:${branchId}:${period}:${channel}`,
  case: (id: number) => `case:${id}`,
  proposal: (id: number) => `proposal:${id}`,
};

export interface ParsedEvidenceId {
  kind: EvidenceKind;
  /** The key after the kind, e.g. "2455" or "B09:oct:google_lsa". */
  key: string;
  /** The key's parts. */
  parts: string[];
}

export function parseEvidenceId(value: string): ParsedEvidenceId | null {
  const match = EVIDENCE_ID.exec(value);
  if (!match || !(EVIDENCE_KINDS as readonly string[]).includes(match[1])) return null;
  return { kind: match[1] as EvidenceKind, key: match[2], parts: match[2].split(":") };
}

/** The numeric id of a single-key evidence id (`exception:2455` → 2455), else null. */
export function numericEvidenceId(value: string, kind: EvidenceKind): number | null {
  const parsed = parseEvidenceId(value);
  if (!parsed || parsed.kind !== kind || !/^\d{1,15}$/.test(parsed.key)) return null;
  return Number(parsed.key);
}

/** Order-preserving de-duplication. */
export function uniqueIds(ids: Iterable<string>): string[] {
  return [...new Set(ids)];
}
