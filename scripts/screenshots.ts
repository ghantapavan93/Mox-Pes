import { chromium, type Browser } from "@playwright/test";

/** Captures read-only screenshots of the demo pages: `npx tsx scripts/screenshots.ts` (server on :3000). */
async function main() {
  const base = process.env.BASE_URL ?? "http://localhost:3000";
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.request.post(`${base}/api/role`, { data: { role: "engineer" } });
    const shots: Array<[string, string]> = [
      ["01-overview", "/?period=oct"],
      ["02-branch-b20", "/branches/B20?period=oct"],
      ["03-exceptions", "/exceptions"],
      ["04-integrations", "/integrations"],
      ["05-feedback", "/feedback?period=oct"],
    ];
    for (const [name, path] of shots) {
      await page.goto(`${base}${path}`);
      await page.waitForLoadState("networkidle");
      await page.screenshot({ path: `docs/screenshots/${name}.png`, fullPage: true });
    }
    // The Action Center queue (CaseQueue) links each case to its exception page.
    await page.goto(`${base}/exceptions?kind=quarantined_source_records`);
    await page.getByTestId("case-queue").getByRole("link", { name: "Quarantined source records", exact: true }).first().click();
    await page.waitForLoadState("networkidle");
    // The legacy replay panel's dry run; the Workflow panel has its own dry-run button.
    const replay = page.getByTestId("replay-panel");
    await replay.getByRole("button", { name: "Dry run (rolled back)" }).click();
    await replay.getByTestId("replay-result").waitFor();
    await page.screenshot({ path: "docs/screenshots/06-exception-dry-run.png", fullPage: true });
  } finally {
    await browser?.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
