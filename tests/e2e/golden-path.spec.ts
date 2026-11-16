import { expect, test } from "@playwright/test";
import { fixThroughActionCenter, setRole } from "./action-center";

/**
 * Audit 2026-11-09 (J1): the replay panel used to COMMIT too, so an engineer could change stored
 * records with no approval. It is now a dry-run preview; commits are refused by the API (409)
 * and go through the Action Center. The two tests that committed through the panel now assert
 * the refusal and then apply the same fix through propose → dry run → approve → execute.
 */

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

  test("an engineer dry-runs; the panel cannot commit; the fix applies through approval, once", async ({ page }) => {
    await setRole(page, "engineer");
    await page.goto("/branches/B20?period=oct");
    await page.getByRole("link", { name: "Quarantined source records" }).click();
    await expect(page).toHaveURL(/\/exceptions\/\d+$/);
    const exceptionId = Number(page.url().match(/\/exceptions\/(\d+)$/)![1]);
    const panel = page.getByTestId("replay-panel");

    // Wait on the dry run's own request, not a fixed window: it takes 3 to 3.5 s here, and longer
    // on a busy machine (R-20; SUITE-STABILIZATION.md).
    const dryRun = page.waitForResponse((r) => r.url().endsWith("/api/replays") && r.request().method() === "POST");
    await panel.getByRole("button", { name: "Dry run (rolled back)" }).click();
    expect((await dryRun).status()).toBe(200);
    await expect(panel.getByTestId("replay-result")).toContainText("Dry run — nothing was saved");
    await expect(panel.getByTestId("replay-result")).toContainText("still quarantined 0");
    await expect(panel.getByTestId("replay-preview-note")).toBeVisible();
    await expect(panel.getByRole("button", { name: /^Replay \d+ records$/ })).toHaveCount(0);
    const commit = await page.request.post("/api/replays", { data: { exceptionId, mapperVersion: "1.1", dryRun: false, idempotencyKey: "e2e-direct-commit" } });
    expect(commit.status()).toBe(409);

    await fixThroughActionCenter(page, {
      kind: "replay_quarantine", mapper: "1.1",
      rationale: "calls@1.1 reads the renamed caller field; replay the held records",
      approval: "Dry run projects every held record and conserves the ledger",
    });
    await expect(page.getByTestId("exception-summary")).toBeVisible();
    await expect(page.getByTestId("case-timeline")).toContainText("Resolved");

    // Executing again is idempotent: the stored execution comes back, nothing runs twice.
    const proposalId = Number((await page.getByTestId("proposal").first().textContent())!.match(/#(\d+)/)![1]);
    const again = await page.request.post(`/api/proposals/${proposalId}`, { data: { action: "execute" } });
    expect(again.ok()).toBe(true);
    expect((await again.json()).alreadyProcessed).toBe(true);
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

  test("an out-of-scope incident reads as missing and does not name its branch (audit 2026-11-09, E-6)", async ({ page }) => {
    await setRole(page, "marketing");
    const res = await page.request.get(`/api/search?q=${encodeURIComponent("spend at B09 stopped")}`);
    const { hits } = (await res.json()) as { hits: Array<{ kind: string; href: string }> };
    const href = hits.find((h) => h.kind === "incident")!.href;
    await setRole(page, "partner");
    await page.goto(href);
    await expect(page.getByText(/could not be found/i)).toBeVisible();
    await expect(page.locator("main")).not.toContainText("cannot view exceptions");
    await expect(page.locator("main")).not.toContainText("B09");
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

  test("an engineer previews the re-map; it applies only through approval; the signal then reads clean and spend is unchanged", async ({ page }) => {
    await setRole(page, "engineer");
    await page.goto("/branches/B09?period=oct");
    const before = await page.getByTestId("budget-signal").locator("tbody").innerText();
    await page.getByTestId("budget-signal").getByRole("link").first().click();
    const panel = page.getByTestId("replay-panel");
    const dryRun = page.waitForResponse((r) => r.url().endsWith("/api/replays") && r.request().method() === "POST");
    await panel.getByRole("button", { name: "Dry run (rolled back)" }).click();
    expect((await dryRun).status()).toBe(200);
    await expect(panel.getByTestId("replay-result")).toContainText("Dry run — nothing was saved");
    await expect(panel.getByRole("button", { name: /^Re-map \d+ records$/ })).toHaveCount(0);

    await fixThroughActionCenter(page, {
      kind: "remap_channel", mapper: "1.1",
      rationale: "ads@1.1 files PMax campaigns with local services enabled as Local Services",
      approval: "Dry run conserves spend, customers, invoices and collected revenue",
    });
    await expect(page.getByText(/Lineage recorded/)).toBeVisible();

    await page.goto("/branches/B09?period=oct");
    const signal = page.getByTestId("budget-signal");
    await expect(signal).toContainText("Data integrity: no blocking incidents");
    expect(await signal.locator("tbody").innerText()).not.toEqual(before);
  });
});
