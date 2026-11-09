import { expect, test, type Page } from "@playwright/test";

async function setRole(page: Page, role: "marketing" | "engineer" | "partner") {
  const res = await page.request.post("/api/role", { data: { role } });
  expect(res.ok()).toBe(true);
}

test.describe.serial("investigate → replay → verify", () => {
  test("the overview points at the incident branch", async ({ page }) => {
    await setRole(page, "marketing");
    await page.goto("/?period=oct");
    await expect(page.getByRole("heading", { name: "Where did the conversions go?" })).toBeVisible();
    await expect(page.getByTestId("headline-answer")).toContainText("start with B20");
    const firstRow = page.getByTestId("branch-table").locator("tr").first();
    await expect(firstRow).toContainText("B20 Heron");
    await expect(firstRow).toContainText("CAC");
  });

  test("the branch page shows why, and links to the exception", async ({ page }) => {
    await setRole(page, "marketing");
    await page.goto("/branches/B20?period=oct");
    await expect(page.getByRole("heading", { name: /B20 Heron/ })).toBeVisible();
    await page.getByRole("link", { name: "Quarantined source records" }).click();
    await expect(page.getByTestId("exception-summary")).toContainText("quarantined (MISSING_FIELD)");
    await expect(page.getByText("Switch to")).toBeVisible(); // marketing cannot replay
  });

  test("an engineer dry-runs, replays, and a repeated request changes nothing", async ({ page }) => {
    await setRole(page, "engineer");
    await page.goto("/branches/B20?period=oct");
    await page.getByRole("link", { name: "Quarantined source records" }).click();
    const panel = page.getByTestId("replay-panel");

    await panel.getByRole("button", { name: "Dry run (rolled back)" }).click();
    await expect(panel.getByTestId("replay-result")).toContainText("Dry run — nothing was saved");
    await expect(panel.getByTestId("replay-result")).toContainText("still quarantined 0");

    await panel.getByRole("button", { name: /^Replay \d+ records$/ }).click();
    await expect(page.getByText("Resolved", { exact: false }).first()).toBeVisible();
    await expect(panel.getByTestId("replay-result")).toContainText(/Replay committed|Committed replay for this exception/);

    await panel.getByRole("button", { name: "Send the same request again" }).click();
    await expect(panel.getByTestId("replay-result")).toContainText("Already processed");
  });

  test("after replay the branch is no longer flagged for unattributed customers", async ({ page }) => {
    await setRole(page, "marketing");
    await page.goto("/?period=oct");
    const b20 = page.getByTestId("branch-table").locator("tr", { hasText: "B20 Heron" });
    await expect(b20.getByText(/Unattributed .*× median/)).toHaveCount(0);
  });

  test("a branch partner cannot read another branch", async ({ page }) => {
    await setRole(page, "partner");
    await page.goto("/branches/B01");
    // Next.js also renders an (empty) route announcer with role="alert".
    await expect(page.getByRole("alert").filter({ hasText: "403" })).toBeVisible();
    const api = await page.request.get("/api/metrics?branch=B01");
    expect(api.status()).toBe(403);
    const own = await page.request.get("/api/metrics?branch=B20");
    expect(own.status()).toBe(200);
  });

  test("the replay API refuses non-engineers", async ({ page }) => {
    await setRole(page, "marketing");
    const res = await page.request.post("/api/replays", { data: { exceptionId: 1, mapperVersion: "1.1", dryRun: true, idempotencyKey: "e2e-forbidden-key" } });
    expect(res.status()).toBe(403);
  });
});

test.describe.serial("ChangeGuard: a reclassified channel blocks a budget decision until re-mapped", () => {
  test("the B09 budget signal is marked untrustworthy and links to the coverage gap", async ({ page }) => {
    await setRole(page, "marketing");
    await page.goto("/branches/B09?period=oct");
    const signal = page.getByTestId("budget-signal");
    await expect(signal).toContainText("Not trustworthy yet");
    await expect(signal).toContainText("Google Search costs");
    await signal.getByRole("link").first().click();
    await expect(page.getByTestId("exception-summary")).toContainText("Google Local Services spend at B09 stopped");
    await expect(page.getByText("Switch to")).toBeVisible(); // marketing cannot re-map
  });

  test("an engineer re-maps the stored records; the signal becomes sound and spend is unchanged", async ({ page }) => {
    await setRole(page, "engineer");
    await page.goto("/branches/B09?period=oct");
    const before = await page.getByTestId("budget-signal").locator("tbody").innerText();
    await page.getByTestId("budget-signal").getByRole("link").first().click();
    const panel = page.getByTestId("replay-panel");
    await panel.getByRole("button", { name: "Dry run (rolled back)" }).click();
    await expect(panel.getByTestId("replay-result")).toContainText("Dry run — nothing was saved");
    await panel.getByRole("button", { name: /^Re-map \d+ records$/ }).click();
    await expect(panel.getByTestId("replay-result")).toContainText(/Re-map committed|Committed re-map for this exception/);
    await expect(page.getByText("Lineage recorded")).toBeVisible();

    await page.goto("/branches/B09?period=oct");
    const signal = page.getByTestId("budget-signal");
    await expect(signal).toContainText("Data integrity: no blocking incidents");
    expect(await signal.locator("tbody").innerText()).not.toEqual(before);
  });
});
