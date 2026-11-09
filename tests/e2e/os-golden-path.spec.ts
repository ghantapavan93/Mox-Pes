import { expect, test, type Page } from "@playwright/test";
import { reseedDemo } from "./db";

/**
 * The Revenue Signal OS golden path, end to end in the browser, with roles switched through
 * POST /api/role (demo only; production derives the viewer from SSO):
 *
 *   B09 LSA → PMax: overview + branch show the imbalance and the gated budget signal → the
 *   Decision Lab says "not ready" and links the incident → the incident shows campaign, spend,
 *   leads and CRM outcomes → "Investigate with AI" runs the investigator scoped to it, which
 *   cites evidence and creates a remap_channel proposal → an engineer dry-runs it on the
 *   server → an approver (a different role) approves → the application executes the
 *   re-projection → verification proves the ledger unchanged → the audit trail shows every
 *   step → overview, branch and Decision Lab show the new state.
 *
 *   B20 call feed: the second scenario through the Action Center (a human proposal).
 *
 * The earlier spec (golden-path.spec.ts) repairs both incidents through the legacy replay
 * panel, so this file reseeds the demo database first.
 */

type Role = "guest" | "marketing" | "engineer" | "approver" | "partner";

async function setRole(page: Page, role: Role) {
  const res = await page.request.post("/api/role", { data: { role } });
  expect(res.ok()).toBe(true);
}

test.beforeAll(async () => {
  test.setTimeout(600_000);
  await reseedDemo();
});

test.describe.serial("golden path · B09 LSA → PMax incident, from signal to verified fix", () => {
  let gapId = 0;
  let proposalId = 0;
  let investigationId = 0;

  test("a · the overview and the branch show the channel imbalance and a blocked budget signal", async ({ page }) => {
    await setRole(page, "marketing");
    await page.goto("/?period=oct");
    const holds = page.getByTestId("decision-holds");
    const b09 = holds.locator("li", { hasText: "Google Local Services spend at B09 stopped" });
    await expect(b09).toContainText("Channel imbalance");
    await expect(b09.getByRole("link", { name: "B09" })).toBeVisible();

    await b09.getByRole("link", { name: "B09" }).click();
    await expect(page.getByRole("heading", { name: /B09/ })).toBeVisible();
    const signal = page.getByTestId("budget-signal");
    await expect(signal).toContainText("Not trustworthy yet");
    await expect(signal).toContainText("Google Local Services spend at B09 stopped");
  });

  test("b · the Decision Lab says not ready and links the blocking incident", async ({ page }) => {
    await setRole(page, "marketing");
    await page.goto("/decisions?branch=B09&period=oct");
    const summary = page.getByTestId("readiness-summary");
    await expect(summary).toContainText("Not ready");
    await expect(summary).toContainText("Blocking incident #");
    await expect(page.getByTestId("verdict-row-google_lsa").getByTestId("verdict-readiness")).toContainText("Not ready");

    const link = summary.getByTestId("readiness-incident-link").first();
    gapId = Number((await link.getAttribute("href"))!.match(/\/exceptions\/(\d+)$/)![1]);
    expect(gapId).toBeGreaterThan(0);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/exceptions/${gapId}$`));
  });

  test("c · the incident shows campaign, spend, leads and CRM outcomes evidence", async ({ page }) => {
    await setRole(page, "marketing");
    await page.goto(`/exceptions/${gapId}`);
    await expect(page.getByTestId("exception-summary")).toContainText("Google Local Services spend at B09 stopped");
    await expect(page.getByRole("heading", { name: "Campaign lineage" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Stored spend records around the gap" })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Google Local Services leads after the gap/ })).toBeVisible();
    const outcomes = page.getByTestId("crm-outcomes");
    await expect(outcomes).toContainText("New customers");
    await expect(outcomes).toContainText("Invoiced");
    await expect(outcomes).toContainText("Collected");
    await expect(outcomes.getByRole("link", { name: /^#\d+$/ }).first()).toBeVisible();
    // Marketing cannot re-map directly, and there is no proposal yet.
    await expect(page.getByTestId("workflow-panel")).toContainText("No proposals yet.");
  });

  test("d · Investigate opens the AI investigator scoped to the incident; it cites evidence and proposes a re-map", async ({ page }) => {
    await setRole(page, "marketing");
    await page.goto(`/exceptions/${gapId}`);
    await page.getByTestId("investigate-link").click();
    await expect(page).toHaveURL(new RegExp(`/investigator\\?exception=${gapId}$`));
    await expect(page.getByTestId("investigation-scope")).toContainText(`#${gapId}`);
    await expect(page.getByRole("textbox", { name: "Question" })).toHaveValue(new RegExp(`exception #${gapId}`));

    await page.getByRole("button", { name: "Investigate", exact: true }).click();
    await page.waitForURL(/\/investigator\/\d+$/, { timeout: 60_000 });
    investigationId = Number(page.url().match(/\/investigator\/(\d+)$/)![1]);

    const findings = page.getByTestId("findings");
    await expect(findings).toContainText("Google Local Services");
    await expect(page.getByTestId("citation").filter({ hasText: `exception:${gapId}` }).first()).toBeVisible();
    expect(await page.getByTestId("citation").count()).toBeGreaterThan(5);
    // The stored trace (the live one from the question form can linger during navigation).
    await expect(page.locator("[data-testid=\"tool-trace\"]:not([aria-live])")).toContainText("compareMappingVersions");

    const proposed = page.getByTestId("proposed-actions");
    await expect(proposed).toContainText("Re-map channel");
    await expect(proposed).toContainText("Proposal created");
    await expect(proposed).toContainText("source ai");
    await expect(proposed).toContainText("Next: an integration engineer runs the dry run");
    proposalId = Number((await proposed.textContent())!.match(/Proposal #(\d+)/)![1]);
    expect(proposalId).toBeGreaterThan(0);

    // The proposing role can neither dry-run nor approve; the server says so.
    expect((await page.request.post(`/api/proposals/${proposalId}`, { data: { action: "dry_run" } })).status()).toBe(403);
    expect((await page.request.post(`/api/proposals/${proposalId}`, { data: { action: "approve", reason: "self-approval attempt" } })).status()).toBe(403);

    await proposed.getByRole("link", { name: /open the case/ }).click();
    await expect(page).toHaveURL(new RegExp(`/exceptions/${gapId}$`));
    const card = page.getByTestId("proposal").first();
    await expect(card).toContainText("AI-proposed");
    await expect(card).toContainText("Needs dry run");
    await expect(card).toContainText("proposed by marketing");
  });

  test("e · an integration engineer dry-runs it on the server: before/after, rolled back", async ({ page }) => {
    await setRole(page, "engineer");
    await page.goto(`/exceptions/${gapId}`);
    const card = page.getByTestId("proposal").first();
    await card.getByRole("button", { name: "Run dry run (rolled back)" }).click();
    await expect(card.getByRole("status")).toContainText("Dry run verified and rolled back");
    await expect(card).toContainText("Awaiting approval");
    await expect(card).toContainText("rolled back");
    // Before/after from the server-side dry run: the ledger rows are checked and conserved.
    await expect(card.getByText("conserved")).toHaveCount(5);
    await expect(card).toContainText("Total ad spend");
    // Nothing was saved: the incident is still open and the budget signal still gated.
    await expect(page.getByTestId("exception-summary")).toBeVisible();
    await expect(page.getByTestId("budget-signal")).toContainText("Not trustworthy yet");
    // An engineer cannot approve.
    await expect(card.getByRole("button", { name: "Approve" })).toHaveCount(0);
    expect((await page.request.post(`/api/proposals/${proposalId}`, { data: { action: "approve", reason: "engineer approval attempt" } })).status()).toBe(403);
  });

  test("f · an approver, a different role, approves", async ({ page }) => {
    await setRole(page, "approver");
    await page.goto(`/exceptions/${gapId}`);
    const card = page.getByTestId("proposal").first();
    await card.getByRole("textbox", { name: "Decision reason" }).fill("Dry run conserves spend, customers, invoices and collected revenue");
    await card.getByRole("button", { name: "Approve" }).click();
    await expect(card.getByRole("status")).toContainText("Approved");
    await expect(card).toContainText("Approved · ready to execute");
    await expect(card).toContainText("approved by approver");
  });

  test("g · h · the application executes the re-projection; metrics recompute and the ledger is verified unchanged", async ({ page }) => {
    await setRole(page, "approver");
    await page.goto(`/exceptions/${gapId}`);
    const card = page.getByTestId("proposal").first();
    await card.getByRole("button", { name: "Execute (application, once)" }).click();
    const execution = card.getByTestId("execution-result");
    await expect(execution).toContainText("Execution succeeded and verified");
    await expect(execution).toContainText("revenue-signal-app on behalf of approver");
    await expect(execution).toContainText(/claimed 22 · .*projected 22/);
    for (const row of ["Total ad spend", "Raw events stored", "CRM customers", "Invoiced", "Collected"]) {
      await expect(execution.locator("tr", { hasText: row }).getByText("conserved")).toBeVisible();
    }
    await expect(execution.locator("tr", { hasText: "Exception" }).first()).toContainText("resolved");
    await expect(execution.locator("tr", { hasText: "October budget signal" })).toContainText("trustworthy");
    await expect(page.getByText(/Lineage recorded: .* → .*/)).toBeVisible();

    // Executing again is idempotent: the stored execution comes back, nothing runs twice.
    const again = await page.request.post(`/api/proposals/${proposalId}`, { data: { action: "execute" } });
    expect(again.ok()).toBe(true);
    expect((await again.json()).alreadyProcessed).toBe(true);
  });

  test("i · the audit trail shows proposer, dry run, approver, executed records and verification", async ({ page }) => {
    await setRole(page, "approver");
    await page.goto(`/exceptions/${gapId}`);
    const timeline = page.getByTestId("case-timeline");
    for (const step of ["Proposal created", "Dry run", "Approved", "Execution"]) await expect(timeline).toContainText(step);
    await expect(timeline).toContainText("Resolved");

    // The case's audit rows: who proposed, who dry-ran, who approved, and who executed.
    const audit = page.getByTestId("case-audit");
    await expect(audit.locator("tr", { hasText: "proposal_create" })).toContainText("marketing");
    await expect(audit.locator("tr", { hasText: "proposal_dry_run" })).toContainText("engineer");
    await expect(audit.locator("tr", { hasText: "proposal_approve" })).toContainText("approver");
    await expect(audit.locator("tr", { hasText: "proposal_execute" })).toContainText("revenue-signal-app on behalf of approver");

    // The investigation that proposed it is audited too.
    await page.goto(`/audit?subject=${encodeURIComponent(`investigation:${investigationId}`)}`);
    await expect(page.getByTestId("audit-feed").locator("tr", { hasText: "investigation_complete" })).toContainText("marketing");

    // The investigation page now shows the proposal executed and verified.
    await page.goto(`/investigator/${investigationId}`);
    await expect(page.getByTestId("proposed-actions")).toContainText("verification passed");
  });

  test("j · overview, branch and Decision Lab reflect the new state", async ({ page }) => {
    await setRole(page, "marketing");
    await page.goto("/branches/B09?period=oct");
    await expect(page.getByTestId("budget-signal")).toContainText("Data integrity: no blocking incidents");

    await page.goto("/decisions?branch=B09&period=oct");
    const summary = page.getByTestId("readiness-summary");
    await expect(summary).not.toContainText(`#${gapId}`);
    await expect(page.getByTestId("verdict-row-google_lsa").getByTestId("verdict-readiness")).not.toContainText(`#${gapId}`);

    await page.goto("/?period=oct");
    await expect(page.getByTestId("decision-holds").or(page.getByTestId("decision-holds-empty"))).not.toContainText("B09");
  });
});

test.describe.serial("second scenario · B20 call-feed incident through the Action Center", () => {
  let exceptionId = 0;

  test("an engineer proposes a replay; the dry run verifies; an approver approves; the app executes", async ({ page }) => {
    await setRole(page, "engineer");
    await page.goto("/branches/B20?period=oct");
    await page.getByRole("link", { name: "Quarantined source records" }).click();
    await expect(page.getByTestId("exception-summary")).toContainText("quarantined (MISSING_FIELD)");
    exceptionId = Number(page.url().match(/\/exceptions\/(\d+)$/)![1]);

    const form = page.getByTestId("propose-form");
    await form.getByRole("combobox", { name: "Fix" }).selectOption("replay_quarantine");
    await form.getByRole("combobox", { name: "Mapper" }).selectOption("1.1");
    await form.getByRole("textbox", { name: "Rationale" }).fill("calls@1.1 reads the renamed caller field; replay the held records");
    await form.getByRole("button", { name: "Propose fix" }).click();
    const card = page.getByTestId("proposal").first();
    await expect(card).toContainText("Replay quarantine");
    await expect(card).toContainText("proposed by engineer");

    await card.getByRole("button", { name: "Run dry run (rolled back)" }).click();
    await expect(card).toContainText("Awaiting approval");
    await expect(card.getByText("conserved")).toHaveCount(5);

    await setRole(page, "approver");
    await page.reload();
    const approverCard = page.getByTestId("proposal").first();
    await approverCard.getByRole("textbox", { name: "Decision reason" }).fill("Dry run projects every held record and conserves the ledger");
    await approverCard.getByRole("button", { name: "Approve" }).click();
    await expect(approverCard).toContainText("Approved · ready to execute");
    await approverCard.getByRole("button", { name: "Execute (application, once)" }).click();
    await expect(approverCard.getByTestId("execution-result")).toContainText("Execution succeeded and verified");
    await expect(approverCard.getByTestId("execution-result").locator("tr", { hasText: "Exception" }).first()).toContainText("resolved");
  });

  test("after the replay B20 is no longer flagged for unattributed customers", async ({ page }) => {
    await setRole(page, "marketing");
    await page.goto("/?period=oct");
    const b20 = page.getByTestId("branch-table").locator("tr", { hasText: "B20 Heron" });
    await expect(b20.getByText(/Unattributed .*× median/)).toHaveCount(0);
    await page.goto(`/exceptions/${exceptionId}`);
    await expect(page.getByTestId("case-timeline")).toContainText("Resolved");
  });
});
