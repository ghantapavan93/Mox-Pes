import { chromium } from "@playwright/test";

/** Captures read-only screenshots of the demo pages: `npx tsx scripts/screenshots.ts` (server on :3000). */
async function main() {
  const base = process.env.BASE_URL ?? "http://localhost:3000";
  const browser = await chromium.launch();
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
  await page.goto(`${base}/exceptions?kind=quarantined_source_records`);
  await page.getByTestId("exception-table").getByRole("link", { name: "Quarantined source records", exact: true }).first().click();
  await page.waitForLoadState("networkidle");
  await page.getByRole("button", { name: "Dry run (rolled back)" }).click();
  await page.getByTestId("replay-result").waitFor();
  await page.screenshot({ path: "docs/screenshots/06-exception-dry-run.png", fullPage: true });
  await browser.close();
}
main();
