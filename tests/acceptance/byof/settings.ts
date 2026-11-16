import path from "node:path";

/** The bring-your-own-file runner's defaults: its own database, port and output, apart from the B09 runner's. */
export const BYOF = {
  database: "revenue_signal_acceptance_byof",
  port: 3991,
  out: path.join("test-results", "acceptance-byof"),
} as const;
