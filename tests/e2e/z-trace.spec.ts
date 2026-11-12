import { expect, test } from "@playwright/test";
import { setRole } from "./action-center";

/**
 * Metric trace in the browser: from the number on a branch page to the records behind it, and
 * from there to an investigation with the question already asked. Read-only; any seed state.
 */

test("a branch's paid CAC opens its trace: reproduced, with campaigns, customers and limits", async ({ page }) => {
  await setRole(page, "marketing");
  await page.goto("/branches/B09?period=oct");
  await page.getByTestId("trace-link-paidCac").click();
  await expect(page).toHaveURL(/\/branches\/B09\/trace\?period=oct&metric=paid_cac/);
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Where does $");
  await expect(page.getByTestId("trace-reproduced")).toContainText("the same as the scorecard to the cent");
  // The incident's mechanism is visible without any AI: the migrated campaign's spend, filed as search by ads@1.0.
  const campaigns = page.getByTestId("trace-campaigns");
  await expect(campaigns).toContainText("pmax-lsa-B09");
  await expect(campaigns.locator("tr", { hasText: "pmax-lsa-B09" })).toContainText("ads@1.0");
  await expect(page.getByTestId("trace-customers").getByRole("link").first()).toHaveAttribute("href", /\/customers\/\d+$/);
  await expect(page.getByTestId("trace-missing")).toContainText("channel coverage gap");
  await expect(page.getByTestId("trace-limitations")).toContainText("association, not proof");

  const investigate = page.getByTestId("trace-investigate");
  await expect(investigate).toHaveAttribute("href", /\/investigator\?branch=B09&q=Why/);
});

test("a branch outside the viewer's scope is refused", async ({ page }) => {
  await setRole(page, "partner");
  await page.goto("/branches/B09/trace?period=oct");
  await expect(page.getByText("cannot view branch B09")).toBeVisible();
  const api = await page.request.get("/api/metrics/trace?branch=B09&period=oct");
  expect(api.status()).toBe(403);
});
