import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { B09_STEPS, PATH_SECONDS, ROLE_LABEL } from "../../lib/demo/b09-path";
import { setRole } from "./action-center";
import { reseedDemo } from "./db";

/**
 * The four-minute B09 golden path, walked the way a presenter walks it: from /demo, step by step
 * through the guide bar, switching roles with its button, asserting every number the script
 * quotes against the golden fixture (tests/fixtures/b09-golden.json).
 *
 *   Overview → Incident → Evidence → Dry run → Approval → Verified correction →
 *   Decision readiness → Audit
 *
 * Named zz- so it runs last (Playwright orders files by name): it reseeds first, and the specs
 * before it need the B09 incident open or already executed by os-golden-path.
 */

const golden = JSON.parse(readFileSync(path.join(__dirname, "../fixtures/b09-golden.json"), "utf8")) as {
  summaryContains: string;
  spendAffected: string;
  leadsSinceGap: number;
  signalBefore: { ratio: string; status: string };
  signalAfter: { ratio: string; status: string };
  remap: { claimed: number; projected: number };
  conservedRows: string[];
  pathSeconds: number;
};

test.beforeAll(async () => {
  test.setTimeout(600_000);
  await reseedDemo();
});

async function next(page: Page, n: number) {
  await page.getByTestId("guide-next").click();
  await expect(page.getByTestId("guide-step")).toHaveText(`Step ${n} of 8 · ${B09_STEPS[n - 1].title}`);
}

async function useStepRole(page: Page, n: number) {
  await page.getByTestId("guide-use-role").click();
  await expect(page.getByTestId("viewer-label")).toContainText(ROLE_LABEL[B09_STEPS[n - 1].role]);
}

test("the eight steps add up to four minutes, matching the golden fixture", () => {
  expect(B09_STEPS.map((s) => s.key)).toEqual(["overview", "incident", "evidence", "dry_run", "approval", "verified", "readiness", "audit"]);
  expect(B09_STEPS.reduce((t, s) => t + s.seconds, 0)).toBe(PATH_SECONDS);
  expect(PATH_SECONDS).toBe(golden.pathSeconds);
});

test("B09 golden path: overview → incident → evidence → dry run → approval → verified correction → readiness → audit", async ({ page }) => {
  test.setTimeout(240_000);
  const started = Date.now();

  // 1 · Overview — the number a marketer would act on is on hold.
  await setRole(page, "marketing");
  await page.goto("/demo");
  await expect(page.getByTestId("demo-state")).toContainText("Ready");
  await page.getByTestId("demo-start").click();
  await expect(page.getByTestId("guide-step")).toHaveText("Step 1 of 8 · Overview");
  const hold = page.getByTestId("decision-holds").locator("li", { hasText: golden.summaryContains });
  await expect(hold).toContainText("Channel imbalance");
  const gapId = Number(new URL(page.url()).searchParams.get("gap"));
  expect(gapId).toBeGreaterThan(0);

  // 2 · Incident.
  await next(page, 2);
  await expect(page).toHaveURL(new RegExp(`/exceptions/${gapId}\\?`));
  await expect(page.getByTestId("exception-summary")).toContainText(golden.summaryContains);

  // 3 · Evidence — every number the script quotes.
  await next(page, 3);
  await expect(page.locator("#evidence")).toContainText("Spend affected");
  await expect(page.locator("#evidence")).toContainText(golden.spendAffected);
  await expect(page.getByText(`${golden.leadsSinceGap} leads in total`)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Campaign lineage" })).toBeVisible();
  await expect(page.getByTestId("crm-outcomes")).toContainText("Collected");
  const signal = page.getByTestId("budget-signal");
  await expect(signal).toContainText(golden.signalBefore.ratio);
  await expect(signal).toContainText(golden.signalBefore.status);

  // 4 · Dry run — an engineer proposes the re-map and runs it in a rolled-back transaction.
  await next(page, 4);
  await useStepRole(page, 4);
  const form = page.getByTestId("propose-form");
  await form.getByRole("combobox", { name: "Fix" }).selectOption("remap_channel");
  await form.getByRole("combobox", { name: "Mapper" }).selectOption("1.1");
  await form.getByRole("textbox", { name: "Rationale" }).fill("ads@1.1 files PMax campaigns with local services enabled as Local Services");
  await form.getByRole("button", { name: "Propose fix" }).click();
  const card = page.getByTestId("proposal").first();
  await expect(card).toContainText("proposed by engineer");
  // The dry run re-projects and reconciles inside a rolled-back transaction (about 4–5 s here):
  // wait for that request to finish, not for a fixed assertion timeout.
  const dryRun = page.waitForResponse((r) => /\/api\/proposals\/\d+$/.test(r.url()) && r.request().method() === "POST", { timeout: 60_000 });
  await card.getByRole("button", { name: "Run dry run (rolled back)" }).click();
  expect((await dryRun).status()).toBe(200);
  await expect(card).toContainText("Awaiting approval");
  await expect(card.getByText("conserved")).toHaveCount(golden.conservedRows.length);
  await expect(signal).toContainText(golden.signalBefore.status); // nothing was saved
  const proposalId = Number((await card.textContent())!.match(/#(\d+)/)![1]);
  expect((await page.request.post(`/api/proposals/${proposalId}`, { data: { action: "approve", reason: "self-approval attempt" } })).status()).toBe(403);

  // 5 · Approval — a different role.
  await next(page, 5);
  await useStepRole(page, 5);
  const approverCard = page.getByTestId("proposal").first();
  await approverCard.getByRole("textbox", { name: "Decision reason" }).fill("Dry run conserves spend, customers, invoices and collected revenue");
  await approverCard.getByRole("button", { name: "Approve" }).click();
  await expect(approverCard).toContainText("Approved · ready to execute");

  // 6 · Verified correction — the application executes once and proves the ledger unchanged.
  await next(page, 6);
  const executeCard = page.getByTestId("proposal").first();
  await executeCard.getByRole("button", { name: "Execute (application, once)" }).click();
  const execution = executeCard.getByTestId("execution-result");
  await expect(execution).toContainText("Execution succeeded and verified");
  await expect(execution).toContainText(new RegExp(`claimed ${golden.remap.claimed} · .*projected ${golden.remap.projected}`));
  for (const row of golden.conservedRows) await expect(execution.locator("tr", { hasText: row }).getByText("conserved")).toBeVisible();
  await expect(execution.locator("tr", { hasText: "Exception" }).first()).toContainText("resolved");
  const again = await page.request.post(`/api/proposals/${proposalId}`, { data: { action: "execute" } });
  expect((await again.json()).alreadyProcessed).toBe(true);

  // 7 · Decision readiness — the comparison is now sound to look at.
  await next(page, 7);
  await useStepRole(page, 7);
  await expect(page).toHaveURL(/\/branches\/B09\?/);
  // The visible one: Next keeps the previous route mounted but hidden (React Activity) for
  // instant back navigation, so the incident page's own budget card is still in the DOM.
  const after = page.getByTestId("budget-signal").filter({ visible: true });
  await expect(after).toContainText(golden.signalAfter.ratio);
  await expect(after).toContainText(golden.signalAfter.status);
  const lab = await page.request.get(`/decisions?branch=B09&period=oct`);
  expect(lab.ok()).toBe(true);
  expect(await lab.text()).not.toContain(`/exceptions/${gapId}"`);

  // 8 · Audit — one row per actor.
  await next(page, 8);
  await useStepRole(page, 8);
  const audit = page.getByTestId("case-audit");
  await expect(audit.locator("tr", { hasText: "proposal_create" })).toContainText("engineer");
  await expect(audit.locator("tr", { hasText: "proposal_dry_run" })).toContainText("engineer");
  await expect(audit.locator("tr", { hasText: "proposal_approve" })).toContainText("approver");
  await expect(audit.locator("tr", { hasText: "proposal_execute" })).toContainText("revenue-signal-app on behalf of approver");
  await expect(page.getByTestId("guide-done")).toBeVisible();

  // The automated walk fits well inside the presenter's four minutes.
  expect(Date.now() - started).toBeLessThan(PATH_SECONDS * 1_000);
});
