import { expect, test, type Page } from "@playwright/test";

/**
 * Reliability Twin in the browser: a person starts the staged rollout evaluation of the
 * calls@1.2 upgrade from its ChangeGuard page and reads the real, computed stage results:
 * the run that must stop (a cross-brand credit in stage B) and the one that must pass.
 *
 * Each evaluation clones the base world (built on first use) and runs every stage through the
 * production paths, so each takes minutes. Runs last; it writes only the change, its
 * evaluations and their twin databases (never the demo's business data).
 */
const shown = (page: Page, id: string) => page.getByTestId(id).filter({ visible: true });

async function setRole(page: Page, role: string) {
  const res = await page.request.post("/api/role", { data: { role } });
  expect(res.ok()).toBe(true);
}

/** axe-core, the same tags as the accessibility gate (z-quality-gates.spec.ts). */
async function axeViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
  return page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (ctx: Document, opts: unknown) => Promise<{ violations: Array<{ id: string; impact: string; nodes: Array<{ target: string[] }> }> }> } }).axe;
    const result = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] } });
    return result.violations.map((v) => `${v.id} (${v.impact}) ×${v.nodes.length}: ${v.nodes[0]?.target.join(" ")}`);
  });
}

async function callsChange(page: Page): Promise<number> {
  const res = await page.request.post("/api/changes", {
    data: {
      kind: "source_contract",
      reason: "Roll out calls@1.2: outbound, spam and not-a-lead calls are excluded",
      payload: { source: "calls", entity: "call", samples: [{ id: "E2E-1", branch_tag: "B12", start_time: "2026-10-20T15:00:00Z", tracking_phone_number: "+18885550100", source: "Google Ads", gclid: null, campaign: null, agent_note: null, customer_phone_number: "+14805551000", spam: true }] },
    },
  });
  expect(res.ok(), await res.text()).toBe(true);
  return (await res.json()).change.id;
}

async function runVariant(page: Page, label: RegExp) {
  const section = shown(page, "q-rollout");
  await section.getByTestId("rollout-variant").selectOption({ label: label.source.replace(/\\/g, "") });
  await section.getByTestId("rollout-run").click();
  // Loading state: the button and the live region say it is running.
  await expect(section.getByTestId("rollout-run")).toHaveText(/Evaluation running/, { timeout: 15_000 });
  await expect(section.getByRole("status").filter({ hasText: /Running/ })).toBeVisible();
}

test("a stopped rollout and a passing one, as computed, with no deployment claimed", async ({ page }) => {
  test.setTimeout(15 * 60_000);
  await setRole(page, "engineer");
  const id = await callsChange(page);
  await page.goto(`/changes/${id}`);
  const section = shown(page, "q-rollout");
  await expect(section).toContainText("A simulation, not a deployment");
  await expect(section.getByTestId("rollout-empty")).toBeVisible();

  // 1 · The variant that must stop at stage B.
  await runVariant(page, /Cross-brand credit \(expected to stop\)/);
  await expect(section.getByTestId("rollout-stopped")).toBeVisible({ timeout: 8 * 60_000 });
  await expect(section.getByTestId("rollout-stopped")).toContainText("Rollout stopped at stage B (5 branches)");
  // The stage rows only: each stage's details hold a table of their own.
  const rows = section.getByTestId("rollout-stages").locator("tr[data-stage]");
  await expect(rows.nth(0)).toHaveAttribute("data-status", "PASSED");
  await expect(rows.nth(1)).toHaveAttribute("data-status", "RECOVERED");
  await expect(rows.nth(2)).toHaveAttribute("data-status", "BLOCKED");
  await expect(rows.nth(2)).toContainText("Never executed: stage B (5 branches) failed a gate");
  await expect(rows.nth(1)).toContainText(/Gate I failed \(branches outside the stage unaffected did not hold\)/);
  await expect(rows.nth(1)).toContainText("Failed · rolled back");
  await rows.nth(1).getByText("Gates, inputs, recovery and evidence").click();
  const details = section.getByTestId("stage-details-B");
  await expect(details.locator('[data-gate="I"]')).toHaveAttribute("data-status", "fail");
  await expect(details).toContainText("B43 (brand joshuas");
  await expect(section.getByTestId("stage-recovery-B")).toContainText("Restored business state");
  await expect(section.getByTestId("stage-recovery-B")).toContainText("Verified.");

  // 2 · The standard rollout passes all three stages.
  await runVariant(page, /Standard rollout/);
  await expect(section.getByTestId("rollout-passed")).toBeVisible({ timeout: 8 * 60_000 });
  for (const n of [0, 1, 2]) await expect(rows.nth(n)).toHaveAttribute("data-status", "PASSED");
  await expect(section).toContainText("it is not evidence that 44 real branches are ready");
  // Both runs stay inspectable.
  await expect(section.getByRole("button", { name: /#\d+ failed/ })).toBeVisible();

  // No success language of a real deployment anywhere on the page.
  const text = (await page.locator("main").innerText()).toLowerCase();
  expect(text).not.toMatch(/deploy(ed|ment) (successful|succeeded|complete)|successfully deployed|now live|went live/);
  // Accessible with a stage's details open.
  await rows.nth(2).getByText("Gates, inputs, recovery and evidence").click();
  expect(await axeViolations(page)).toEqual([]);

  // Phone width: the table scrolls inside its own region; the page itself does not.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(shown(page, "rollout-stages")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);

  // A scoped viewer sees neither the change nor its evaluations.
  await setRole(page, "partner");
  expect((await page.request.get(`/api/changes/${id}/rollout`)).status()).toBe(403);
  expect((await page.request.post(`/api/changes/${id}/rollout`, { data: { variant: "standard" } })).status()).toBe(403);
});
