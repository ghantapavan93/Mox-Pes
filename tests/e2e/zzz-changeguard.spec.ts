import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Marketing ChangeGuard in the browser, on the seeded demo world, end to end:
 * a campaign mapping to the wrong branch is blocked by preflight with the exact contradiction,
 * the corrected change is resubmitted, the author cannot decide it, a different person approves
 * it against the hashes shown, it is released into the synthetic environment and verified.
 *
 * Runs LAST (zzz-): releasing the mapping clears the demo's unmapped-spend exception and moves
 * B44's numbers, which earlier specs and pixel baselines read. Reseed afterwards
 * (`npm run db:seed`).
 */
/** Next keeps the previous route mounted but hidden (React Activity): assert on the visible copy. */
const shown = (page: Page, id: string) => page.getByTestId(id).filter({ visible: true });

async function setRole(page: Page, role: "marketing" | "approver" | "guest") {
  const res = await page.request.post("/api/role", { data: { role } });
  expect(res.ok()).toBe(true);
}

/**
 * Clicks a button that posts a ChangeGuard request and waits for that request. A preflight or a
 * release runs the production write path and two 44-branch scorecards: 4–5 s over HTTP (4.8 s
 * measured on 2026-11-13), so an assertion's default 5 s window raced it (R-20's pattern,
 * tests/e2e/action-center.ts). The 60 s bound only stops a hung request hanging the suite.
 */
async function clickAndWait(page: Page, button: Locator, path: RegExp, status: number) {
  const done = page.waitForResponse((r) => path.test(new URL(r.url()).pathname) && r.request().method() === "POST", { timeout: 60_000 });
  await button.click();
  expect((await done).status()).toBe(status);
}

test("wrong branch blocked → corrected → approved by a different person → released → verified", async ({ page }) => {
  test.setTimeout(180_000);
  await setRole(page, "marketing");
  await page.goto("/changes");
  await expect(page.getByRole("heading", { level: 1, name: "ChangeGuard" })).toBeVisible();

  const form = page.getByRole("form", { name: "Propose a mapping change" });
  await form.getByLabel("Campaign").selectOption({ label: "lsa-B44-x · B44 | Local Services | Expansion (unmapped)" });
  await form.getByLabel(/Map to branch/).selectOption("B04");
  await form.getByLabel(/Why/).fill("New expansion campaign for the Briar office");
  await clickAndWait(page, form.getByRole("button", { name: "Propose and preflight" }), /^\/api\/changes$/, 201);

  await expect(page).toHaveURL(/\/changes\/\d+$/);
  await expect(shown(page, "change-status")).toContainText("preflight failed");
  const failed = shown(page, "q-failed");
  await expect(failed).toContainText("LEAD_EVIDENCE_DISAGREES");
  await expect(failed).toContainText("CROSS_BRAND");
  // The reporting consequence, and that it is a preview: B04 would carry spend, B44's paid count moves.
  const affected = shown(page, "q-affected");
  await expect(affected).toContainText("B04 (proposed)");
  await expect(affected).toContainText("B44 (lead evidence)");
  await expect(affected).toContainText("Other branches changed in the preview: none");
  await expect(shown(page, "q-tested").locator("li[data-check]")).toHaveCount(14);

  // What must be corrected: the evidence names B44; resubmit.
  await expect(shown(page, "q-correct")).toContainText("Map it to B44 instead");
  await clickAndWait(page, page.getByRole("button", { name: "Resubmit corrected change" }), /^\/api\/changes$/, 201);
  await expect(shown(page, "change-status")).toContainText("ready for review");
  const correctedUrl = page.url();
  await expect(shown(page, "q-failed")).toContainText("Nothing failed");
  await expect(shown(page, "change-actions")).toContainText("You proposed this change; a different person must decide it.");

  await setRole(page, "approver");
  await page.goto(correctedUrl);
  await page.getByLabel(/Why do you decide this/).fill("Leads and brand agree with B44; spend conserved");
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(shown(page, "change-status")).toContainText("approved");

  await setRole(page, "marketing");
  await page.goto(correctedUrl);
  await clickAndWait(page, page.getByRole("button", { name: "Release to the synthetic environment" }), /^\/api\/changes\/\d+$/, 200);
  await expect(shown(page, "change-status")).toContainText("verified");
  const after = shown(page, "q-after");
  await expect(after).toContainText("configuration success: The live mapping is B44");
  await expect(after).toContainText("data integrity success: B44 gained exactly $4,539.34 of paid spend from unallocated");
  await expect(after).toContainText("Measured business improvement: not measured");
});

test("a read-only role sees changes but no actions", async ({ page }) => {
  await setRole(page, "guest");
  await page.goto("/changes");
  await expect(page.getByText(/can read changes in scope/)).toBeVisible();
  await expect(page.getByRole("form", { name: "Propose a mapping change" })).toHaveCount(0);
  await shown(page, "change-list").getByRole("link").first().click();
  await expect(page.getByRole("button", { name: /Approve|Release|Re-run preflight/ })).toHaveCount(0);
});
