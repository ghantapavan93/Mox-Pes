import { expect, test } from "@playwright/test";
import { setRole } from "./action-center";
import { reseedDemo } from "./db";
import { stageSample } from "./onboarding";

/**
 * Data onboarding through the browser, as the people who would use it: an analyst uploads an
 * unfamiliar export, answers the questions the file cannot answer, and dry-runs it; an approver
 * (a different role) approves the exact rules and publishes. Everything here is the real UI
 * and the real API; the samples are synthetic (public/samples/README.md).
 *
 * Publishing changes the demo ledger, so the spec reseeds afterwards.
 */
test.describe.configure({ mode: "serial" });
test.afterAll(async () => {
  test.setTimeout(300_000);
  await reseedDemo();
});

test("an analyst maps an unfamiliar call export, an approver publishes it, and every row is accounted for", async ({ page }) => {
  test.setTimeout(180_000);
  await setRole(page, "marketing");
  await page.goto("/onboarding");
  await page.getByTestId("sample-demo-calls.csv").click();
  await page.waitForURL(/\/onboarding\/\d+$/);
  await expect(page.getByTestId("step-rail")).toContainText("Suggested: Tracked phone calls");

  // The phone column is profiled by shape, never by value.
  await expect(page.getByRole("region", { name: "Column profiles" })).toContainText("(###) ###-####");
  await expect(page.getByRole("region", { name: "Column profiles" })).not.toContainText("555-0101");

  // The two questions the file cannot answer must be answered; nothing is assumed.
  const questions = page.getByTestId("mapping-questions");
  await questions.getByLabel("month first (March 4)").check();
  await questions.getByText(/branch local time/).click();
  await page.getByTestId("propose-and-dry-run").click();
  await expect(page.getByTestId("accounted")).toContainText("Every row is accounted for: 12 rows, 12 dispositions");
  await expect(page.getByTestId("dry-run-counts")).toContainText("New, eligible6");

  // The analyst cannot approve their own mapping: the control says why.
  await expect(page.getByRole("button", { name: "Approve mapping" })).toBeDisabled();
  await expect(page.getByTestId("decision-panel")).toContainText("cannot approve");

  await setRole(page, "approver");
  await page.reload();
  await page.getByPlaceholder(/What you checked/).fill("Checked branch translations and the five rows held back");
  await page.getByRole("button", { name: "Approve mapping" }).click();
  await page.getByTestId("publish").click();
  await expect(page.getByText(/6 rows went through intake/)).toBeVisible();
  await expect(page.getByTestId("mapping-versions")).toContainText("approved");
});

test("a CRM payments export is compared with the ledger to the cent and can never be published", async ({ page }) => {
  test.setTimeout(120_000);
  const href = await stageSample(page, "demo-crm-payments.csv", { dryRun: true, answers: { moneyMeaning: { amount: "collected_payment" } } });
  await setRole(page, "approver");
  await page.goto(href);
  const money = page.getByTestId("money-reconciliation");
  await expect(money).toContainText("Difference on shared rows");
  const diffs = page.getByRole("region", { name: "Differences from the ledger" });
  await expect(diffs).toContainText("amount");
  await expect(diffs).toContainText("status");
  await expect(page.getByTestId("decision-panel")).toContainText("compare-only");
  await expect(page.getByTestId("publish")).toHaveCount(0);
});

test("branch-scoped and read-only roles cannot see onboarding at all", async ({ page }) => {
  const href = await stageSample(page, "demo-google-ads.csv");
  for (const role of ["partner", "brand", "guest"] as const) {
    await setRole(page, role);
    await page.goto("/onboarding");
    await expect(page.getByText(/limited to company-wide/)).toBeVisible();
    expect((await page.request.get(`/api${href.replace("/onboarding", "/onboarding/uploads")}`)).status()).toBe(403);
  }
});

test("a file that fits no dataset is not guessed at", async ({ page }) => {
  const href = await stageSample(page, "mixed-garbage.csv");
  await page.goto(href);
  await expect(page.getByTestId("step-rail")).toContainText("No dataset fits");
});
