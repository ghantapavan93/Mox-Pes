import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.PORT ?? 3000);

export default defineConfig({
  testDir: "tests/e2e",
  // The golden path mutates the database (it replays records), so it reseeds first.
  globalSetup: "./tests/e2e/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    video: process.env.RECORD_DEMO ? "on" : "off",
    viewport: { width: 1440, height: 900 },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: {
    command: process.env.CI ? `npm run start -- -p ${PORT}` : `npm run dev -- -p ${PORT}`,
    port: PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
