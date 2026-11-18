import { expect, test, type Page } from "@playwright/test";
import { unseenCallsCsv } from "../fixtures/onboarding/unseen";
import { clearWorkspace, expireWorkspaceItem, ledgerCalls } from "./db";

/**
 * The release journeys (docs/agent-work/release/RELEASE-DESIGN.md §6), each as a cold reviewer
 * walks it. The e2e server runs with PUBLIC_WORKSPACE=1, so a browser without a role cookie is the
 * hosted demo's visitor: a guest with its own workspace.
 *
 * J2 · Upload to result, twice: one visitor uploads an export the app has never seen and reads what
 * was read, what counted, what did not and why; another visitor cannot open it, and nothing either
 * of them sees as shared moves.
 */

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => clearWorkspace());
test.afterAll(async () => clearWorkspace());

/** The Overview's one figure and the four data times on Audit & Health, as a visitor reads them. */
async function sharedFigures(page: Page) {
  await page.goto("/?period=oct");
  const atRisk = (await page.getByTestId("at-risk-figure").textContent())?.trim() ?? "";
  await page.goto("/audit");
  const times = (await page.getByTestId("data-times").innerText()).trim();
  return { atRisk, times };
}

/** Picks a file in the chooser and sends it, as a visitor does. */
async function upload(page: Page, name: string, buffer: Buffer) {
  await page.goto("/onboarding");
  await page.getByLabel("Export file").setInputFiles({ name, mimeType: "text/csv", buffer });
  await page.getByTestId("upload-submit").click();
}

/** Answers the two questions the file cannot (month or day first; branch-local times) and dry-runs it. */
async function answerAndCompare(page: Page) {
  const questions = page.getByTestId("mapping-questions");
  await questions.getByLabel("month first (March 4)").check();
  await questions.getByText(/branch local time/).click();
  await page.getByTestId("propose-and-dry-run").click();
  await expect(page.getByTestId("upload-result")).toBeVisible({ timeout: 90_000 });
}

/**
 * Visible primaries only: Next keeps the page a visitor came from mounted but hidden, so Back
 * restores it, and its controls stay in the document.
 */
const PRIMARY = '[data-variant="primary"]:visible';

/** The result card's top edge lies inside the first screen. */
async function resultOnFirstScreen(page: Page, height: number) {
  await page.reload();
  // The page streams: the card is in the document, hidden, until its content has arrived.
  await expect(page.getByTestId("upload-result")).toBeVisible();
  const box = await page.getByTestId("upload-result").boundingBox();
  expect(box, "the result card is rendered").not.toBeNull();
  expect(box!.y, `the result starts inside the first ${height} px`).toBeLessThan(height - 40);
}

test.describe("J2 · upload to result, twice", () => {
  test("@core two visitors: A reads its result and follows the ledger; B cannot open it, and nothing shared moves", async ({ browser }) => {
    test.setTimeout(240_000);
    const known = await ledgerCalls(2);
    expect(known, "the demo ledger holds calls to compare with").toHaveLength(2);
    const file = Buffer.from(unseenCallsCsv(known));

    const b = await (await browser.newContext()).newPage();
    const before = await sharedFigures(b);

    const a = await (await browser.newContext()).newPage();
    await a.goto("/onboarding");
    // What a file may be and what happens to it, before anything is sent.
    const terms = a.getByTestId("upload-terms");
    await expect(terms).toContainText("CSV or TSV");
    await expect(terms).toContainText("Tracked phone calls");
    await expect(terms).toContainText("US dollars only");
    await expect(a.getByTestId("upload-limits")).toContainText("Up to 4 MB and 10,000 rows");
    await expect(a.getByTestId("upload-retention")).toContainText("never added to it or sent to a model");
    expect(await a.locator(PRIMARY).count()).toBeLessThanOrEqual(1);

    await upload(a, "unseen-calls.csv", file);
    await a.waitForURL(/\/onboarding\/\d+$/);
    const resultUrl = new URL(a.url()).pathname;
    await expect(a.getByTestId("step-rail")).toContainText("Suggested: Tracked phone calls");
    await answerAndCompare(a);

    // The result names the mode and never claims the rows were counted.
    const result = a.getByTestId("upload-result");
    await expect(a.getByTestId("workspace-label")).toContainText("Nothing was added to the ledger.");
    await expect(a.getByTestId("workspace-label")).toContainText(/Available until .+ UTC, then deleted within a day/);
    const words = await result.innerText();
    expect(words).not.toMatch(/\bbooked\b|\bpublished\b/i);
    expect(words.replace(/Nothing was added to the ledger/g, "")).not.toMatch(/added to the ledger/i);
    await expect(a.getByTestId("dry-run-counts")).toContainText("Would count after staff approval (local demo only)");
    expect(await a.locator(PRIMARY).count()).toBeLessThanOrEqual(1);

    await resultOnFirstScreen(a, 900);
    await a.setViewportSize({ width: 390, height: 844 });
    await resultOnFirstScreen(a, 844);
    await a.setViewportSize({ width: 1440, height: 900 });

    // A compared row opens the ledger record it was compared with, and Back returns to the result.
    const link = a.getByTestId("ledger-link").first();
    await expect(link).toBeVisible();
    await link.click();
    await a.waitForURL(/\/customers\/[^/]+$/);
    await a.goBack();
    await a.waitForURL((u) => u.pathname === resultUrl);
    await expect(a.getByTestId("upload-result")).toBeVisible();

    // The workspace keeps the upload across a reload: the list opens it again.
    await a.goto("/onboarding");
    await a.reload();
    await a.getByRole("link", { name: "unseen-calls.csv" }).click();
    await a.waitForURL((u) => u.pathname === resultUrl);
    await expect(a.getByTestId("upload-result")).toBeVisible();

    // B: A's upload is not available, B's workspace is empty, and the shared figures are unchanged.
    await b.goto(resultUrl);
    await expect(b.getByTestId("workspace-not-available")).toContainText("This workspace item is not available.");
    expect((await b.request.get(`/api${resultUrl.replace("/onboarding", "/onboarding/uploads")}`)).status()).toBe(404);
    await b.goto("/onboarding");
    await expect(b.getByText("No uploads yet")).toBeVisible();
    expect(await sharedFigures(b)).toEqual(before);
  });

  test("@edge a malformed file, a file over 4 MB, the same file twice, and an expired upload", async ({ page }) => {
    test.setTimeout(180_000);
    // Malformed: refused with the parser's reason; nothing opens.
    await upload(page, "broken.csv", Buffer.from([0, 159, 146, 150, 0, 1, 2, 3]));
    await expect(page.getByTestId("upload-error")).not.toBeEmpty();
    expect(new URL(page.url()).pathname).toBe("/onboarding");

    // Over 4 MB: refused by the browser from the file's size, before a byte is sent.
    let sent = 0;
    page.on("request", (r) => {
      if (r.method() === "POST" && new URL(r.url()).pathname === "/api/onboarding/uploads") sent++;
    });
    await upload(page, "big.csv", Buffer.alloc(Math.round(4.5 * 1_048_576), 0x61));
    await expect(page.getByTestId("upload-error")).toHaveText("This file is 4.5 MB; the public demo takes files up to 4 MB.");
    expect(sent).toBe(0);

    // The same file twice: the second opens the first's result, with the same counts.
    const file = Buffer.from(unseenCallsCsv(await ledgerCalls(2)));
    await upload(page, "twice.csv", file);
    await page.waitForURL(/\/onboarding\/\d+$/);
    const url = new URL(page.url()).pathname;
    await answerAndCompare(page);
    const conclusion = await page.getByTestId("result-conclusion").innerText();
    await upload(page, "twice-again.csv", file);
    await page.waitForURL(/\/onboarding\/\d+\?repeat=1$/);
    expect(new URL(page.url()).pathname).toBe(url);
    await expect(page.getByTestId("repeat-notice")).toContainText("You uploaded this exact file on");
    await expect(page.getByTestId("result-conclusion")).toHaveText(conclusion);

    // Expired: after its 24 hours the upload is not available.
    await expireWorkspaceItem(Number(url.split("/").pop()));
    await page.goto(url);
    await expect(page.getByTestId("workspace-not-available")).toContainText("Items last 24 hours");
  });
});
