import type { InvestigationStep } from "./steps";

/**
 * The NDJSON events POST /api/investigations streams (one JSON object per line). Type-only,
 * so the client component can import it without pulling server code into the bundle.
 */
export type InvestigationStreamEvent =
  | { type: "started"; id: number; mode: "deterministic" | "model" }
  | { type: "step"; step: InvestigationStep }
  | { type: "done"; id: number; mode: "deterministic" | "model"; latencyMs: number }
  | { type: "error"; id: number | null; message: string };
