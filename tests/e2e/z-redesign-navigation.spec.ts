import { expect, test } from "@playwright/test";
import { setRole } from "./action-center";

/**
 * The navigation the phase-2 redesign added (docs/design-system.md, "Screens"). Each test checks
 * that a summary on the page leads to the records behind it, through the URL, and that the
 * permissions and numbers stay those of the server: no assertion here depends on a number that a
 * golden-path spec changes.
 */

test.describe("Incidents", () => {
  test("an incident type filters the queue, shows a removable chip, and removing it restores the queue", async ({ page }) => {
    await setRole(page, "marketing");
    await page.goto("/exceptions");
    const total = await page.getByTestId("case-queue").locator("tr").count();
    expect(total).toBeGreaterThan(0);

    const kind = page.getByTestId("kind-breakdown").getByRole("link", { name: /Branch mismatch/ });
    await kind.click();
    await expect(page).toHaveURL(/\/exceptions\?kind=branch_mismatch$/);
    await expect(page.getByTestId("kind-breakdown").getByRole("link", { name: /Branch mismatch/ })).toHaveAttribute("aria-current", "true");
    for (const link of await page.getByTestId("case-queue").getByRole("link").allTextContents()) expect(link).toBe("Branch mismatch");

    const chip = page.getByTestId("queue-filters").getByRole("link", { name: /Type: Branch mismatch/ });
    await chip.click();
    await expect(page).toHaveURL(/\/exceptions$/);
    await expect(page.getByTestId("queue-filters")).toHaveCount(0);
  });

  test("the workflow strip links each state to its cases and marks the current one", async ({ page }) => {
    await setRole(page, "marketing");
    await page.goto("/exceptions");
    const strip = page.getByTestId("state-counts");
    await strip.getByRole("link", { name: /^Resolved/ }).click();
    await expect(page).toHaveURL(/state=resolved/);
    await expect(page.getByTestId("state-counts").getByRole("link", { name: /^Resolved/ })).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("heading", { name: /^Resolved \(/ })).toBeVisible();
  });

  test("a branch partner sees only their branch, and a filter cannot widen it", async ({ page }) => {
    await setRole(page, "partner");
    await page.goto("/exceptions");
    await expect(page.getByText("Action Center · Branch B20")).toBeVisible();
    for (const cell of await page.getByTestId("case-queue").locator("tr td:nth-child(2)").allTextContents()) expect(cell.trim()).toBe("B20");
    await page.goto("/exceptions?branch=B09");
    // Next's route announcer is also role="alert"; match the refusal by its text.
    await expect(page.getByRole("alert").filter({ hasText: "403" })).toBeVisible();
  });
});

test.describe("Integrations", () => {
  test("the three views live in the URL and each shows its own sections", async ({ page }) => {
    await setRole(page, "engineer");
    await page.goto("/integrations");
    const views = page.getByTestId("integration-views");
    await expect(views.getByRole("link", { name: "CRM connector" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("run-sync")).toBeVisible();

    await views.getByRole("link", { name: "Field mapping" }).click();
    await expect(page).toHaveURL(/view=mapping/);
    await expect(page.getByRole("heading", { name: "Field mapping inspector" })).toBeVisible();
    await expect(page.getByTestId("run-sync")).toHaveCount(0);

    await page.getByTestId("integration-views").getByRole("link", { name: "Ingestion pipeline" }).click();
    await expect(page).toHaveURL(/view=pipeline/);
    await expect(page.getByRole("heading", { name: "Quarantine groups" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Full audit trail" })).toHaveAttribute("href", "/audit");
  });

  test("an unknown view falls back to the connector view, and a branch role is refused", async ({ page }) => {
    await setRole(page, "engineer");
    await page.goto("/integrations?view=toString");
    await expect(page.getByTestId("integration-views").getByRole("link", { name: "CRM connector" })).toHaveAttribute("aria-current", "page");
    await setRole(page, "partner");
    await page.goto("/integrations");
    await expect(page.getByRole("alert").filter({ hasText: "limited to company-wide roles" })).toBeVisible();
  });
});

test.describe("Audit & Health", () => {
  test("the health strip comes first and links to the section that explains each number", async ({ page }) => {
    await setRole(page, "approver");
    await page.goto("/audit");
    const kpis = page.getByTestId("health-kpis");
    await expect(kpis).toContainText("Feeds");
    await expect(kpis.getByRole("link", { name: /Domain events not yet handled/ })).toHaveAttribute("href", "#events");
    await expect(page.getByTestId("audit-sections").getByRole("link", { name: "Audit trail" })).toHaveAttribute("href", "#audit-trail");
    // DOM order: health before the audit trail.
    const order = await page.evaluate(() => {
      const kpi = document.querySelector('[data-testid="health-kpis"]')!;
      const trail = document.getElementById("audit-trail")!;
      return kpi.compareDocumentPosition(trail) & Node.DOCUMENT_POSITION_FOLLOWING;
    });
    expect(order).toBeTruthy();
  });

  test("an audit row opens to its full detail, formatted", async ({ page }) => {
    await setRole(page, "approver");
    await page.goto("/audit");
    const first = page.getByTestId("audit-feed").locator("tr").first();
    const pre = first.locator("details pre");
    await expect(pre).toBeHidden();
    await first.locator("details summary").click();
    await expect(pre).toBeVisible();
    expect(JSON.parse((await pre.textContent())!)).toBeTruthy();
  });

  test("a filter shows as a chip that removes it", async ({ page }) => {
    await setRole(page, "approver");
    await page.goto("/audit?actor=system");
    const chip = page.getByTestId("audit-filters").getByRole("link", { name: /Actor: system/ });
    await expect(chip).toBeVisible();
    await chip.click();
    await expect(page).toHaveURL(/\/audit#audit-trail$/);
  });
});

test.describe("Customers, Decision Lab, Definitions", () => {
  test("the identity review queue comes before the customer directory", async ({ page }) => {
    await setRole(page, "marketing");
    await page.goto("/customers");
    const before = await page.evaluate(() => {
      const review = document.getElementById("identity-review")!;
      const table = document.querySelector('[data-testid="customer-table"]')!;
      return Boolean(review.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    expect(before).toBe(true);
  });

  test("Decision Lab sections are numbered by the three questions and readiness comes first", async ({ page }) => {
    await setRole(page, "marketing");
    await page.goto("/decisions?branch=B09&period=oct");
    const nav = page.getByTestId("decision-sections");
    await expect(nav.getByRole("link")).toHaveText(["1 · Are the records right?", "2 · Enough evidence?", "Scenarios", "3 · Did spend cause it?"]);
    await expect(page.locator("#readiness")).toHaveAttribute("data-testid", "readiness-summary");
  });

  test("a KPI's definition links to its dictionary entry", async ({ page }) => {
    await setRole(page, "marketing");
    await page.goto("/?period=oct");
    const stat = page.locator("details").filter({ hasText: "Show definition" }).first();
    await stat.locator("summary").click();
    const link = stat.getByRole("link", { name: "Full definition" });
    const href = (await link.getAttribute("href"))!;
    expect(href).toMatch(/^\/definitions#metric-\w+$/);
    await link.click();
    await expect(page.locator(href.slice("/definitions".length))).toBeVisible();
  });
});
