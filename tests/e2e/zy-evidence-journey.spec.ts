import { expect, test, type Page } from "@playwright/test";
import { setRole } from "./action-center";

/**
 * The whole evidence journey, in the production browser (docs/agent-work/EVIDENCE-INTELLIGENCE.md):
 *
 *   an unexpected paid CAC → its trace (reproduced from records; what it cannot see) →
 *   a grounded investigation (claims checked outside the model) → the mapping correction,
 *   prefilled in ChangeGuard → previewed on the real write path → approved by a different
 *   person → released and verified → the trace now counts the campaign, linked to the change →
 *   the business outcome is stated as not measured.
 *
 * Named zy- so it runs after the read-only specs and before zz-b09, which reseeds: it maps
 * lsa-B44-x, which zzz-changeguard needs unmapped.
 */

const shown = (page: Page, id: string) => page.getByTestId(id).filter({ visible: true });
const TRACE = "/branches/B44/trace?period=oct&metric=paid_cac";

test("an unexpected CAC is traced, investigated, corrected through ChangeGuard and verified, and no improvement is claimed", async ({ page }) => {
  test.setTimeout(240_000);
  await setRole(page, "marketing");

  // 1 · The number and where it comes from.
  await page.goto("/branches/B44?period=oct");
  await page.getByTestId("trace-link-paidCac").click();
  await expect(page).toHaveURL(/\/branches\/B44\/trace\?period=oct&metric=paid_cac/);
  await expect(page.getByTestId("trace-reproduced")).toContainText("the same as the scorecard: spend to the cent, customers exactly");
  const before = (await page.getByRole("heading", { level: 1 }).textContent())!;
  const unmapped = page.getByTestId("trace-missing").locator("li", { hasText: "lsa-B44-x" });
  await expect(unmapped).toContainText("is mapped to no branch");
  await expect(page.getByTestId("trace-campaigns")).not.toContainText("lsa-B44-x");

  // 2 · A grounded investigation of that number.
  await page.getByTestId("trace-investigate").click();
  await expect(page.getByRole("textbox", { name: "Question" })).toHaveValue(/^Why is paid-media cac \$/i);
  await page.getByRole("button", { name: "Investigate", exact: true }).click();
  const findings = page.getByTestId("findings");
  await expect(findings).toContainText("lsa-B44-x", { timeout: 60_000 });
  await expect(findings).toContainText("reproduces exactly from stored records");
  const check = page.getByTestId("claim-check");
  await check.locator("summary").click();
  await expect(check).toContainText("Checked by code, not by the model");
  await expect(check).toContainText("0 rejected or conflicted");

  // 3 · The correction, prefilled from the trace, previewed on the real write path.
  await page.goto(TRACE);
  await page.getByTestId("trace-missing").locator("li", { hasText: "lsa-B44-x" }).getByTestId("trace-preview-mapping").click();
  await expect(page).toHaveURL(/\/changes\?campaign=\d+&branch=B44$/);
  const form = page.getByRole("form", { name: "Propose a mapping change" });
  await expect(form.getByLabel("Campaign").locator("option:checked")).toContainText("lsa-B44-x");
  await expect(form.getByLabel(/Map to branch/).locator("option:checked")).toContainText("B44");
  await form.getByRole("button", { name: "Propose and preflight" }).click();
  await expect(shown(page, "change-status")).toContainText("ready for review");
  await expect(shown(page, "q-failed")).toContainText("Nothing failed");
  await expect(shown(page, "evidence-levels")).toContainText("A prediction, not a fact about the live data");
  await expect(shown(page, "change-actions")).toContainText("a different person must decide it");

  // 4 · A different person approves exactly what was previewed.
  await setRole(page, "approver");
  await page.reload();
  await page.getByLabel(/Your decision is bound to configuration/).fill("Leads and brand agree with B44; spend conserved in the preview");
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(shown(page, "change-status")).toContainText("approved");

  // 5 · Released into the synthetic environment and verified; no improvement is claimed.
  await setRole(page, "marketing");
  await page.reload();
  await page.getByRole("button", { name: "Release to the synthetic environment" }).click();
  await expect(shown(page, "change-status")).toContainText("verified");
  const levels = shown(page, "evidence-levels");
  await expect(levels).toContainText(/\d+ of \d+ release checks passed/);
  await expect(levels).toContainText("Not measured.");
  await expect(shown(page, "q-after")).toContainText("B44 gained exactly");
  const history = page.getByRole("list", { name: "History" }).filter({ visible: true });
  await expect(history).toContainText("demo:approver");
  await expect(history).toContainText("verified");

  // 6 · The same trace now counts the campaign, linked to the change that mapped it.
  await page.goto(TRACE);
  await expect(page.getByTestId("trace-reproduced")).toContainText("the same as the scorecard: spend to the cent, customers exactly");
  const row = page.getByTestId("trace-campaigns").locator("tr", { hasText: "lsa-B44-x" });
  await expect(row).toContainText("version 2");
  await expect(row.getByRole("link", { name: /^change \d+$/ })).toBeVisible();
  await expect(page.getByTestId("trace-missing")).not.toContainText("lsa-B44-x");
  expect(await page.getByRole("heading", { level: 1 }).textContent()).not.toBe(before);
});
