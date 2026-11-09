import type { z } from "zod";
import { fail, type MapFailure } from "./contract";

/** Turns the first schema issue into a stable error code + human detail. */
export function schemaFailure(entity: string, error: z.ZodError): MapFailure {
  const issue = error.issues[0];
  const path = [entity, ...issue.path.map(String)].join(".");
  const missing = issue.code === "invalid_type" && /received undefined/.test(issue.message);
  return fail(missing ? "MISSING_FIELD" : "SCHEMA_VIOLATION", `${path}: ${issue.message}`);
}

export function isFailure(value: unknown): value is MapFailure {
  return typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false;
}
