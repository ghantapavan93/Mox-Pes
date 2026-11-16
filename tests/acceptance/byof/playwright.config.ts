import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { acceptanceDatabaseUrl, acceptanceOut, acceptancePort, REPO } from "../b09/env";
import { BYOF } from "./settings";

/**
 * Step 2 of `npm run acceptance:byof` (docs/agent-work/BYOF-WORKFLOW.md). It builds this checkout
 * and starts its own production server on ACCEPTANCE_PORT (default 3991), over the empty database
 * that step 1 (prepare.ts) prepared, then runs the journey. It never reuses a server: if anything
 * already listens on the port, Playwright stops before any test runs.
 */
const DATABASE_URL = acceptanceDatabaseUrl(BYOF.database);
const PORT = acceptancePort(BYOF.port);
const OUT = acceptanceOut(BYOF.out);

export default defineConfig({
  testDir: ".",
  testMatch: "byof-proof.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 20 * 60_000,
  outputDir: path.join(OUT, "artifacts"),
  reporter: [["list"], ["json", { outputFile: path.join(OUT, "report.json") }]],
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: `npm run build && npm run start -- -p ${PORT}`,
    cwd: REPO,
    port: PORT,
    reuseExistingServer: false,
    timeout: 15 * 60_000,
    stdout: "pipe",
    stderr: "pipe",
    // Only these two: never spread process.env here, since the JSON reporter writes this object
    // into the report. Playwright adds them to the runner's own environment.
    env: { DEMO_MODE: "1", DATABASE_URL },
  },
});
