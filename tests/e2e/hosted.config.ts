import { defineConfig, devices } from "@playwright/test";

/**
 * The release journeys against a running deployment (release design WP-J): the rehearsal server,
 * the Preview deployment or Production. BASE_URL names it; nothing is started or seeded here.
 * Without DATABASE_URL, the journeys that need the database skip themselves.
 *
 *   BASE_URL=https://… npx playwright test -c tests/e2e/hosted.config.ts --grep @core
 */
const baseURL = process.env.BASE_URL;
if (!baseURL) throw new Error("BASE_URL names the deployment to test");

export default defineConfig({
  testDir: ".",
  testMatch: ["release-journeys.spec.ts"],
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  reporter: [["list"]],
  use: { baseURL, trace: "retain-on-failure", viewport: { width: 1440, height: 900 } },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
});
