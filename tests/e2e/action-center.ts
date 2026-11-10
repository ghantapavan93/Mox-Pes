import { expect, type Page } from "@playwright/test";

export type Role = "guest" | "marketing" | "engineer" | "approver" | "partner" | "brand";

/** Demo role switch (POST /api/role). Production derives the viewer from SSO instead. */
export async function setRole(page: Page, role: Role): Promise<void> {
  const res = await page.request.post("/api/role", { data: { role } });
  expect(res.ok()).toBe(true);
}

/**
 * Applies a fix the only way the product allows a write to stored records: an engineer
 * proposes it and dry-runs it, an approver (another role) approves, the application executes
 * it once. The page must already be on the exception. Leaves the approver role active.
 */
export async function fixThroughActionCenter(page: Page, fix: { kind: "replay_quarantine" | "remap_channel"; mapper: string; rationale: string; approval: string }): Promise<void> {
  await setRole(page, "engineer");
  await page.reload();
  const form = page.getByTestId("propose-form");
  await form.getByRole("combobox", { name: "Fix" }).selectOption(fix.kind);
  await form.getByRole("combobox", { name: "Mapper" }).selectOption(fix.mapper);
  await form.getByRole("textbox", { name: "Rationale" }).fill(fix.rationale);
  await form.getByRole("button", { name: "Propose fix" }).click();
  const card = page.getByTestId("proposal").first();
  await expect(card).toContainText("proposed by engineer");
  await card.getByRole("button", { name: "Run dry run (rolled back)" }).click();
  await expect(card).toContainText("Awaiting approval");

  await setRole(page, "approver");
  await page.reload();
  const approverCard = page.getByTestId("proposal").first();
  await approverCard.getByRole("textbox", { name: "Decision reason" }).fill(fix.approval);
  await approverCard.getByRole("button", { name: "Approve" }).click();
  await expect(approverCard).toContainText("Approved · ready to execute");
  await approverCard.getByRole("button", { name: "Execute (application, once)" }).click();
  await expect(approverCard.getByTestId("execution-result")).toContainText("Execution succeeded and verified");
}
