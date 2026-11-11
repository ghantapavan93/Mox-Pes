import { expect, test, type Page } from "@playwright/test";

/**
 * Revenue opportunities (Decision Lab → /decisions/opportunities): both journeys render with
 * every statement labelled by kind, a readiness level and its checks. Overrides are offered
 * only to a role with the approve permission, and never where stale data or an open
 * data-quality exception blocks the journey. Read-only: nothing is submitted here (the
 * override path is covered by tests/integration/opportunities.test.ts).
 */
async function setRole(page: Page, role: "marketing" | "approver") {
  const res = await page.request.post("/api/role", { data: { role } });
  expect(res.ok()).toBe(true);
}

test("Decision Lab links to revenue opportunities; both journeys are labelled fact by fact", async ({ page }) => {
  await setRole(page, "marketing");
  await page.goto("/decisions");
  await page.getByRole("link", { name: "Revenue opportunities" }).click();
  await expect(page).toHaveURL(/\/decisions\/opportunities/);
  await expect(page.getByRole("heading", { level: 1, name: "Revenue opportunities" })).toBeVisible();

  for (const journey of ["missed_follow_up", "retention"]) {
    const card = page.locator(`section#${journey}`);
    await expect(card).toBeVisible();
    await expect(page.getByTestId(`readiness-${journey}`)).toContainText(/Readiness: (blocked|monitor|validate|act)/);
    for (const kind of ["observed_fact", "inference", "hypothesis", "recommendation", "measured_outcome"]) {
      await expect(card.locator(`li[data-kind="${kind}"]`).first()).toBeVisible();
    }
    await expect(card.locator('li[data-kind="measured_outcome"]')).toContainText("None.");
  }
  // Marketing cannot approve, so no override form anywhere.
  await expect(page.getByRole("button", { name: "Record override" })).toHaveCount(0);
});

test("an approver is offered an override only where the block is a risk, not a data fault", async ({ page }) => {
  await setRole(page, "approver");
  // All branches: open data-quality exceptions in the demo world block both journeys, and that
  // cannot be overridden.
  await page.goto("/decisions/opportunities?period=all");
  await expect(page.getByTestId("readiness-missed_follow_up")).toContainText("blocked");
  await expect(page.getByText("(cannot be overridden)").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Record override" })).toHaveCount(0);

  // One branch, one month: small samples and immaterial values are risks an approver may accept.
  await page.goto("/decisions/opportunities?period=oct&branch=B03");
  await expect(page.getByRole("button", { name: "Record override" }).first()).toBeVisible();
  await setRole(page, "marketing");
});
