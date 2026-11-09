import { expect, test } from "@playwright/test";

/**
 * Records the 2-minute demo path as a video: RECORD_DEMO=1 npx playwright test demo-video
 * Skipped otherwise. Mutates the database (it replays), so reseed afterwards.
 */
test.skip(!process.env.RECORD_DEMO, "set RECORD_DEMO=1 to record the demo video");
test.use({ video: { mode: "on", size: { width: 1440, height: 900 } }, viewport: { width: 1440, height: 900 } });

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("demo walkthrough", async ({ page }) => {
  test.setTimeout(180_000);
  await page.request.post("/api/role", { data: { role: "marketing" } });
  await page.goto("/?period=oct");
  await expect(page.getByTestId("headline-answer")).toBeVisible();
  await pause(6000);
  await page.mouse.wheel(0, 500);
  await pause(5000);

  await page.getByRole("link", { name: /B20 Heron/ }).first().click();
  await expect(page.getByRole("heading", { name: /B20 Heron/ })).toBeVisible();
  await pause(5000);
  await page.mouse.wheel(0, 450);
  await pause(5000);

  await page.getByRole("link", { name: "Quarantined source records" }).click();
  await expect(page.getByTestId("exception-summary")).toBeVisible();
  await pause(5000);
  await page.mouse.wheel(0, 600);
  await pause(4000);
  await page.mouse.wheel(0, -600);

  await page.getByTestId("role-switcher").selectOption("engineer");
  await expect(page.getByTestId("replay-panel")).toBeVisible();
  await pause(2000);
  await page.getByRole("button", { name: "Dry run (rolled back)" }).click();
  await expect(page.getByTestId("replay-result")).toContainText("Dry run");
  await pause(8000);

  await page.getByRole("button", { name: /^Replay \d+ records$/ }).click();
  await expect(page.getByTestId("replay-result")).toContainText(/Replay committed|Committed replay/);
  await pause(6000);
  await page.getByRole("button", { name: "Send the same request again" }).click();
  await expect(page.getByTestId("replay-result")).toContainText("Already processed");
  await pause(5000);

  await page.goto("/feedback?period=oct");
  await pause(5000);
  await page.goto("/?period=oct");
  await pause(6000);
});
