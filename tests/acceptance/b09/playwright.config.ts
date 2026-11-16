import path from "node:path";
import { defineConfig, devices } from "@playwright/test";
import { acceptanceDatabaseUrl, acceptanceOut, acceptancePort, REPO } from "./env";

/**
 * Step 2 of `npm run acceptance:b09` (docs/agent-work/B09-ACCEPTANCE-RUNNER.md). It builds this
 * checkout and starts its own production server on ACCEPTANCE_PORT, over the acceptance database
 * that step 1 (prepare.ts) seeded, then runs the proof. It never reuses a server: if anything
 * already listens on the port, Playwright stops before any test runs.
 *
 * The demo's own config (playwright.config.ts) is untouched: it still reuses a server on port 3000
 * outside CI and writes to DATABASE_URL (REMAINING-RISKS.md R-55).
 */
const DATABASE_URL = acceptanceDatabaseUrl();
const PORT = acceptancePort();
const OUT = acceptanceOut();

export default defineConfig({
  testDir: ".",
  testMatch: "b09-proof.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30 * 60_000,
  outputDir: path.join(OUT, "artifacts"),
  reporter: [["list"], ["json", { outputFile: path.join(OUT, "report.json") }]],
  // Bounded waits: an element that never appears fails its check within a minute, instead of
  // holding the run until the test's 30-minute limit.
  use: { baseURL: `http://localhost:${PORT}`, trace: "retain-on-failure", viewport: { width: 1280, height: 800 }, actionTimeout: 60_000, navigationTimeout: 120_000 },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } }],
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
