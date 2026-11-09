import { expect, test, type Page } from "@playwright/test";
import { seedIdentityConflicts, type ConflictFixture } from "./db";

/**
 * The Revenue Signal OS modules in the browser: Customer 360 (search → journey → stored
 * payload), the CRM Integration Studio (a rate-limit fault recovered by a retry against the
 * local FieldRoutes mock), identity review permissions, and the ⌘K command menu.
 *
 * Runs against the demo database as the earlier specs left it; the Studio test syncs a
 * handful of synthetic records and the identity test adds two clearly-fake fixture groups
 * (see db.ts), so reseed the demo afterwards (`npm run db:seed`).
 */

type Role = "guest" | "marketing" | "engineer" | "approver" | "partner";

async function setRole(page: Page, role: Role) {
  const res = await page.request.post("/api/role", { data: { role } });
  expect(res.ok()).toBe(true);
}

test.describe("Customer 360", () => {
  test("search by lead id → journey timeline → stored payload drawer", async ({ page }) => {
    await setRole(page, "marketing");
    await page.goto("/customers");
    await page.getByRole("searchbox").fill("CAL0000838");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page).toHaveURL(/q=CAL0000838/);
    const firstResult = page.getByTestId("customer-table").getByRole("link").first();
    await expect(firstResult).toBeVisible();
    await firstResult.click();
    await expect(page).toHaveURL(/\/customers\/(\d+|P-\d+)$/);

    const timeline = page.getByTestId("journey-timeline");
    await expect(timeline).toBeVisible();
    const source = timeline.getByRole("button", { name: /^Show source payload for / }).first();
    await source.click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toContainText("Source record");
    await expect(drawer).toContainText("Payload as stored (redacted at ingest)");
    await expect(drawer).toContainText(/Stored versions of this record \(\d+\)/);
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(source).toBeFocused();
  });

  test("a branch partner cannot open another branch's customer", async ({ page }) => {
    await setRole(page, "partner");
    const res = await page.request.get("/api/customers?branch=B21");
    expect(res.status()).toBe(403);
  });
});

test.describe.serial("Integration Studio · rate limit → retry → success", () => {
  const OFFICE = 103; // B03
  let jobId = 0;

  test("an engineer arms a rate_limit fault, runs a sync, sees the retry succeed, then clears the fault", async ({ page }) => {
    test.setTimeout(180_000);
    await setRole(page, "engineer");
    await page.goto("/integrations");
    const faults = page.getByTestId("fault-panel");
    // Start from a mock that answers like a healthy tenant.
    if (await faults.getByRole("button", { name: "Clear all faults" }).count()) {
      await faults.getByRole("button", { name: "Clear all faults" }).click();
      await expect(faults.getByRole("status")).toContainText("All faults cleared.");
    }

    await faults.getByRole("combobox", { name: "Fault" }).selectOption("rate_limit");
    await faults.getByRole("combobox", { name: "Office" }).selectOption(String(OFFICE));
    await faults.getByRole("combobox", { name: "Entity" }).selectOption("payment");
    await faults.getByRole("spinbutton", { name: "Retry-After (s)" }).fill("2");
    await faults.getByRole("button", { name: "Arm fault" }).click();
    await expect(faults.getByRole("status")).toContainText("Fault armed: rate_limit.");
    await expect(faults.locator("li", { hasText: "rate_limit" }).first()).toContainText(`office ${OFFICE} · payment`);

    const run = page.getByTestId("run-sync");
    await run.getByRole("combobox", { name: "Offices" }).selectOption(String(OFFICE));
    await run.getByRole("combobox", { name: "Entities" }).selectOption("payment");
    await run.getByRole("button", { name: "Run sync" }).click();
    await expect(run.getByRole("status")).toContainText("Queued 1 job");

    // The live table polls; the job backs off for Retry-After and then succeeds.
    const jobs = page.getByTestId("jobs-live");
    const row = jobs.locator("tbody tr").filter({ hasText: "payment" }).first();
    await expect(row.getByText("succeeded")).toBeVisible({ timeout: 120_000 });
    const link = row.getByRole("link", { name: /^#\d+$/ });
    jobId = Number((await link.textContent())!.slice(1));
    // Attempt column: it succeeded on a later attempt than the first.
    await expect(row.locator("td").nth(4)).toHaveText(/^[2-9]\/\d+$/);

    await link.click();
    await expect(page).toHaveURL(new RegExp(`/integrations/jobs/${jobId}$`));
    await expect(page.getByText("API call trace")).toBeVisible();
    await expect(page.locator("td", { hasText: /^429$/ }).first()).toBeVisible();
    await expect(page.locator("td", { hasText: /^200$/ }).first()).toBeVisible();

    await page.goto("/integrations");
    const armed = page.getByTestId("fault-panel").locator("li", { hasText: "rate_limit" }).first();
    await expect(armed).toContainText("fired 1");
    await page.getByTestId("fault-panel").getByRole("button", { name: "Clear all faults" }).click();
    await expect(page.getByTestId("fault-panel")).toContainText("No faults armed");

    // The audit page shows the connector's health from the same read model.
    await page.goto("/audit");
    await expect(page.getByTestId("connector-health")).toContainText("Rate limited (429s)");
  });
});

test.describe.serial("identity review permissions", () => {
  let fixture: ConflictFixture;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    fixture = await seedIdentityConflicts();
  });

  test("guests, approvers and branch partners can read the conflict but not decide it", async ({ page }) => {
    const [customerId] = fixture.accept.customerIds;
    for (const role of ["guest", "approver", "partner"] as const) {
      await setRole(page, role);
      await page.goto(`/customers/${customerId}`);
      const conflicts = page.getByTestId("identity-conflicts");
      await expect(conflicts.locator("tr", { hasText: fixture.accept.leadId }).first()).toContainText("pending");
      await expect(conflicts.getByRole("button", { name: /Same person/ })).toHaveCount(0);
      await expect(page.getByText("Your role is read-only here.")).toBeVisible();
    }
    // The API refuses the same people, whatever the UI shows.
    const list = await page.request.get(`/api/identity/conflicts?status=pending`);
    expect(list.ok()).toBe(true);
    const ids = ((await list.json()).rows as Array<{ id: number; leadSourceRecordId: string }>)
      .filter((c) => c.leadSourceRecordId === fixture.accept.leadId)
      .map((c) => c.id);
    expect(ids.length).toBe(2);
    for (const role of ["guest", "approver", "partner"] as const) {
      await setRole(page, role);
      const res = await page.request.post(`/api/identity/conflicts/${ids[0]}/decision`, { data: { decision: "accept", reason: "trying without permission" } });
      expect(res.status()).toBe(403);
    }
  });

  test("a marketing analyst accepts one match; its sibling is rejected automatically", async ({ page }) => {
    const [accepted, sibling] = fixture.accept.customerIds;
    await setRole(page, "marketing");
    await page.goto(`/customers/${accepted}`);
    const row = page.getByTestId("identity-conflicts").locator("tr", { hasText: fixture.accept.leadId }).first();
    await row.getByRole("textbox", { name: "Reason for the decision" }).fill("Caller confirmed this account on the recording");
    await row.getByRole("button", { name: `Same person: link to ${accepted}` }).click();
    await expect(page.getByTestId("identity-conflicts").locator("tr", { hasText: fixture.accept.leadId }).first()).toContainText("accepted");
    await expect(page.getByTestId("identity-links")).toContainText("Accepted by a reviewer");

    await page.goto(`/customers/${sibling}`);
    await expect(page.getByTestId("identity-conflicts").locator("tr", { hasText: fixture.accept.leadId }).first()).toContainText("rejected");
  });

  test("an integration engineer rejects a match", async ({ page }) => {
    const [, other] = fixture.reject.customerIds;
    await setRole(page, "engineer");
    await page.goto(`/customers/${other}`);
    const row = page.getByTestId("identity-conflicts").locator("tr", { hasText: fixture.reject.leadId }).first();
    await row.getByRole("textbox", { name: "Reason for the decision" }).fill("Different household; shared office line");
    await row.getByRole("button", { name: "Different person" }).click();
    await expect(page.getByTestId("identity-conflicts").locator("tr", { hasText: fixture.reject.leadId }).first()).toContainText("rejected");
  });
});

test.describe("command menu", () => {
  test("⌘K finds branch B09 and its incident", async ({ page }) => {
    await setRole(page, "marketing");
    await page.goto("/");
    await page.keyboard.press("Control+k");
    const input = page.getByTestId("command-input");
    await expect(input).toBeFocused();
    await input.fill("B09");
    const results = page.getByTestId("command-results");
    await expect(results.getByRole("option", { name: /branch\s*B09/ })).toBeVisible();
    const incident = results.getByRole("option", { name: /incident\s*#\d+ Channel coverage gap/ });
    await expect(incident).toBeVisible();
    await incident.click();
    await expect(page).toHaveURL(/\/exceptions\/\d+$/);
    await expect(page.getByTestId("exception-summary")).toContainText("B09");

    await page.keyboard.press("Control+k");
    await page.getByTestId("command-input").fill("B09");
    await expect(page.getByTestId("command-results").getByRole("option", { name: /branch\s*B09/ })).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/branches\/B09$/);
  });
});
