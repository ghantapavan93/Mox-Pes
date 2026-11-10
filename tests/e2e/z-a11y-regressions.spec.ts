import { expect, test, type Page } from "@playwright/test";

/**
 * Regression checks for the 2026-11-09 audit's accessibility and paging findings (J4–J13).
 * Read-only: nothing here writes to the database.
 *
 * Expects the demo database as the other specs leave it: the B09 coverage-gap incident has the
 * executed re-map proposal that os-golden-path.spec.ts creates (the proposal-card checks need it).
 */

type Role = "guest" | "marketing" | "engineer" | "approver" | "partner";

async function setRole(page: Page, role: Role) {
  const res = await page.request.post("/api/role", { data: { role } });
  expect(res.ok()).toBe(true);
}

/** The B09 Google Local Services coverage-gap incident page, found through the search API. */
async function b09GapHref(page: Page): Promise<string> {
  const res = await page.request.get(`/api/search?q=${encodeURIComponent("spend at B09 stopped")}`);
  expect(res.ok()).toBe(true);
  const { hits } = (await res.json()) as { hits: Array<{ kind: string; href: string; title: string }> };
  const gap = hits.find((h) => h.kind === "incident" && /Channel coverage gap/.test(h.title));
  expect(gap, "the B09 coverage-gap incident is searchable").toBeDefined();
  return gap!.href;
}

test.describe("command menu · combobox semantics (J10)", () => {
  test("the input is a combobox that controls the results listbox and tracks the active option", async ({ page }) => {
    await setRole(page, "marketing");
    await page.goto("/");
    const opener = page.getByRole("button", { name: "Open command menu" });
    await opener.click();

    const input = page.getByTestId("command-input");
    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute("role", "combobox");
    const listId = await input.getAttribute("aria-controls");
    expect(listId).toBeTruthy();
    const list = page.locator(`[id="${listId}"]`);
    await expect(list).toHaveAttribute("role", "listbox");
    await expect(list).toHaveAttribute("data-testid", "command-results");

    await input.fill("B09");
    await expect(page.getByTestId("command-results").getByRole("option", { name: /branch\s*B09/ })).toBeVisible();
    await expect(input).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("ArrowDown");
    const activeId = await input.getAttribute("aria-activedescendant");
    expect(activeId).toBeTruthy();
    const activeOption = page.locator(`[id="${activeId}"]`);
    await expect(activeOption).toHaveAttribute("role", "option");
    await expect(activeOption).toHaveAttribute("aria-selected", "true");

    // Tab stays inside the dialog.
    await page.keyboard.press("Tab");
    await expect(input).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(input).toBeFocused();

    // "No matches." is a status message outside the listbox, not a fake option.
    await input.fill("zzzz-no-such-thing-qqqq");
    const none = page.getByRole("dialog", { name: "Command menu" }).getByRole("status");
    await expect(none).toHaveText("No matches.");
    await expect(page.getByTestId("command-results").getByText("No matches.")).toHaveCount(0);
    await expect(input).toHaveAttribute("aria-expanded", "false");

    // Escape closes and returns focus to the opener.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Command menu" })).toHaveCount(0);
    await expect(opener).toBeFocused();
  });
});

test.describe("proposal card · status region and diff row headers (J8, J12)", () => {
  test("an executed proposal keeps a status region, and its before/after rows are row headers", async ({ page }) => {
    await setRole(page, "approver");
    await page.goto(await b09GapHref(page));
    const card = page.getByTestId("proposal").first();
    await expect(card).toBeVisible();

    // One always-mounted polite status region per card, even after the proposal stopped being live.
    const status = card.getByRole("status");
    await expect(status).toHaveCount(1);
    await expect(status).toHaveAttribute("aria-live", "polite");

    // The execution result can take focus (it receives it after Execute).
    const execution = card.getByTestId("execution-result");
    await expect(execution).toHaveAttribute("tabindex", "-1");

    // Before/after: each label is a row header, and change is stated in text, not only by style.
    await expect(execution.getByRole("rowheader", { name: "Total ad spend" })).toBeVisible();
    await expect(execution.getByRole("rowheader", { name: "Exception" }).first()).toBeVisible();
    await expect(execution.locator("tr", { hasText: "Total ad spend" })).toContainText("(unchanged)");
    await expect(execution.locator("tr", { hasText: "Exception" }).first()).toContainText("(changed)");
    // The visible "conserved" badges are unchanged by the hidden text.
    await expect(execution.locator("tr", { hasText: "Total ad spend" }).getByText("conserved")).toBeVisible();
  });
});

test.describe("weekly bars · data table (J11)", () => {
  test("each chart references a visually hidden table of its weekly values", async ({ page }) => {
    await setRole(page, "marketing");
    await page.goto("/branches/B20?period=oct");
    const chart = page.getByRole("img", { name: "Paid-media CAC" });
    await expect(chart).toBeVisible();
    const tableId = await chart.getAttribute("aria-describedby");
    expect(tableId).toBeTruthy();
    const table = page.locator(`[id="${tableId}"]`);
    await expect(table).toHaveCount(1);
    expect(await table.evaluate((el) => el.tagName)).toBe("TABLE");
    await expect(table.getByRole("columnheader", { name: "Week of" })).toBeAttached();
    expect(await table.locator("tbody tr").count()).toBeGreaterThan(0);
    await expect(table.locator("tbody th[scope=row]").first()).toHaveText(/^\d{4}-\d{2}-\d{2}$/);
  });
});

test.describe("paging and parameter validation (J4, J6, J7)", () => {
  test("a customers page past the end says so and links to the last page", async ({ page }) => {
    await setRole(page, "marketing");
    await page.goto("/customers?page=9999");
    const pastEnd = page.getByTestId("customers-past-end");
    await expect(pastEnd).toBeVisible();
    await expect(pastEnd).toContainText("past the last page");
    await expect(page.getByTestId("customers-empty")).toHaveCount(0);
    await pastEnd.getByRole("link", { name: "Go to the last page" }).click();
    await expect(page.getByTestId("customer-table").locator("tr").first()).toBeVisible();
  });

  test("an inherited property name as ?period= falls back to the default period", async ({ page }) => {
    await setRole(page, "marketing");
    for (const period of ["toString", "constructor", "__proto__"]) {
      const res = await page.goto(`/?period=${period}`);
      expect(res?.status(), `/?period=${period}`).toBe(200);
      await expect(page.getByRole("heading", { name: "Where did the conversions go?" })).toBeVisible();
    }
  });

  test("an exact audit subject does not match longer ids with the same prefix", async ({ page }) => {
    await setRole(page, "approver");
    await page.goto("/audit?subject=case:1");
    await expect(page.getByRole("heading", { name: "Audit & Health" })).toBeVisible();
    // Subject cells are links whose text is the subject; none may be case:10, case:11, …
    await expect(page.getByTestId("audit-feed").getByText(/^case:1\d+$/)).toHaveCount(0);
    const subjects = await page.getByTestId("audit-feed").locator("tr td:nth-child(4)").allTextContents();
    for (const s of subjects) expect(s.trim()).toBe("case:1");
  });
});
