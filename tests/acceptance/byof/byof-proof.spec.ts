import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import type { Pool } from "pg";
import { createPool } from "@/lib/db";
import { acceptanceDatabaseName, acceptanceDatabaseUrl, acceptanceOut, acceptancePort, REPO } from "../b09/env";
import { BYOF } from "./settings";

/**
 * The bring-your-own-file proof (docs/agent-work/BYOF-WORKFLOW.md). `npm run acceptance:byof`
 * starts from an empty workspace, builds this checkout and serves it, then a new visitor:
 *
 *   finds the upload from the Overview, with no ids → takes the analyst role in the header
 *   → uploads an export the importer has never seen (tests/fixtures/byof) through the file input
 *   → answers only what the file cannot say → reads the result
 *
 * three times: the valid file, the same report with a Canadian-dollar account in it, and the
 * valid file again. Every expectation comes from tests/fixtures/byof/expected.json, computed by an
 * independent script and committed before the first upload. Checks are soft, so one failure still
 * leaves a complete record in <ACCEPTANCE_OUT>/results.json. Screens at 1280 and 390 px go beside it.
 */

type Expected = {
  files: Record<"valid" | "twoAccounts", { file: string; sha256: string; dataRows: number; expect: Record<string, unknown> }>;
};
const FIXTURE = path.join(REPO, "tests", "fixtures", "byof");
const expected = JSON.parse(readFileSync(path.join(FIXTURE, "expected.json"), "utf8")) as Expected;
const valid = expected.files.valid.expect as { validRows: number; spendCents: number; firstDay: string; lastDay: string; campaigns: string[] };
const two = expected.files.twoAccounts.expect as { usDollarRows: { rows: number; spendCents: number }; canadianDollarRows: { rows: number; spendCents: number } };
const BASE = `http://localhost:${acceptancePort(BYOF.port)}`;
const OUT = acceptanceOut(BYOF.out);
const VIEWPORTS = { desktop: { width: 1280, height: 800 }, phone: { width: 390, height: 844 } };

type Check = { stage: string; name: string; ok: boolean; detail: string };
const checks: Check[] = [];
const errors: Array<{ stage: string; url: string; text: string }> = [];
let stage = "setup";

function check(name: string, ok: boolean, detail: unknown = "") {
  const d = (typeof detail === "string" ? detail : JSON.stringify(detail)).replace(/\s+/g, " ").slice(0, 700);
  checks.push({ stage, name, ok, detail: d });
  expect.soft(ok, `${stage} · ${name} :: ${d}`).toBe(true);
}

const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const monthDay = (iso: string) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function watch(page: Page) {
  page.on("console", (m) => {
    if (m.type() === "error") errors.push({ stage, url: page.url().replace(BASE, ""), text: m.text().slice(0, 400) });
  });
  page.on("pageerror", (e) => errors.push({ stage, url: page.url().replace(BASE, ""), text: `pageerror: ${String(e.message).slice(0, 400)}` }));
}

async function shot(page: Page, name: string) {
  mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, `${name}.jpg`), type: "jpeg", quality: 70 });
}

/** What the reader sees without scrolling: the text of every visible element inside the viewport. */
async function firstScreen(page: Page): Promise<string> {
  return page.evaluate(() => {
    const out: string[] = [];
    const root = document.querySelector("main") ?? document.body;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const el = n.parentElement;
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      if (r.width === 0 || r.height === 0 || r.bottom <= 0 || r.top >= innerHeight || s.visibility === "hidden" || s.display === "none") continue;
      const t = (n.textContent ?? "").replace(/\s+/g, " ").trim();
      if (t) out.push(t);
    }
    return out.join(" ");
  });
}

/** Filled primary actions (links or buttons) visible without scrolling. */
async function primaryActions(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll("main a, main button")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return el.classList.contains("bg-accent") && el.classList.contains("text-white") && r.width > 0 && r.bottom > 0 && r.top < innerHeight && (el as HTMLElement).offsetParent !== null;
      })
      .map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim()),
  );
}

async function ledger(pool: Pool) {
  const n = async (table: string) => Number((await pool.query(`select count(*)::int as n from ${table}`)).rows[0].n);
  return { rawEvents: await n("raw_events"), spendDays: await n("ad_spend_daily"), campaigns: await n("ad_campaigns"), leads: await n("leads"), payments: await n("crm_payments") };
}

/** The latest dry run of an upload, as stored: what the screen should be reporting. */
async function dryRun(pool: Pool, uploadId: number) {
  const run = (await pool.query("select id, summary from onboarding_dry_runs where upload_id = $1 order by id desc limit 1", [uploadId])).rows[0];
  if (!run) return null;
  const rows = (await pool.query("select disposition, code, count(*)::int as n from onboarding_row_results where dry_run_id = $1 group by 1, 2 order by 1, 2", [run.id])).rows as Array<{ disposition: string; code: string | null; n: number }>;
  const summary = run.summary as { total: number; counts: Record<string, number>; ledger: { money: { fileTotalCents: number; notInLedgerRows: number } | null; counts: { matches: number; differs: number } } };
  return { id: Number(run.id), total: summary.total, counts: summary.counts, money: summary.ledger.money, compared: summary.ledger.counts, rows };
}

/** Answers what the file cannot say, as a user does, and records what the assistant had suggested. */
async function review(page: Page) {
  const editor = page.getByTestId("mapping-editor");
  await editor.waitFor({ timeout: 60_000 });
  const datasetSelect = editor.getByLabel("This file contains");
  const suggestedDataset = await datasetSelect.inputValue();
  if (suggestedDataset !== "ad_spend") await datasetSelect.selectOption("ad_spend");
  const want: Record<string, string | null> = { platform: null, account_id: "Account number", campaign_id: "Campaign ID", campaign_name: "Campaign name", date: "Gregorian date", cost: "Spend", clicks: "Clicks", conversions: "Conversions" };
  const assistant: Record<string, string | null> = {};
  for (const [field, column] of Object.entries(want)) {
    const select = editor.getByTestId(`field-${field}`).getByLabel(/^Column for /);
    const before = await select.inputValue();
    assistant[field] = before === "" ? null : before;
    if ((column ?? "") !== before) await select.selectOption(column ?? "");
  }
  // Currency is optional and left as the assistant set it: a user need not know it matters.
  const currencySelect = editor.getByTestId("field-currency").getByLabel(/^Column for /);
  assistant.currency = (await currencySelect.count()) ? (await currencySelect.inputValue()) || null : "(no currency field)";
  // The file has no platform column: one platform for every row is the user's answer.
  await editor.getByTestId("field-platform").getByLabel("Same value for every row").selectOption("microsoft_ads");
  await editor.getByTestId("money-cost").selectOption("ad_cost");
  const questions = editor.getByTestId("mapping-questions");
  const monthFirst = questions.getByRole("radio", { name: /month first/ });
  if (await monthFirst.count()) await monthFirst.check();
  // The report's last completed day is Oct 26, 6:00 AM Central (11:00 UTC); it was exported after.
  await questions.getByLabel("Report exported at (UTC)").fill("2026-10-26T12:00");
  await editor.getByTestId("propose-and-dry-run").click();
  return { suggestedDataset, assistant };
}

/** Upload through the file input, review, and wait for the result. Returns the upload id. */
async function journey(page: Page, file: string) {
  await page.goto("/onboarding");
  await page.getByLabel("Export file").setInputFiles(file);
  await page.getByRole("button", { name: "Upload and profile" }).click();
  await page.waitForURL(/\/onboarding\/\d+/, { timeout: 60_000 });
  const uploadId = Number(new URL(page.url()).pathname.split("/").pop());
  const answers = await review(page);
  await page.getByTestId("accounted").waitFor({ timeout: 120_000 });
  // The page scrolls itself to the outcome after the dry run; let it settle where the reader lands.
  await page.waitForTimeout(1_500);
  return { uploadId, answers };
}

/** The same upload at phone width, in its own context with the analyst role. */
async function phone(browser: Browser, uploadId: number, name: string) {
  const context = await browser.newContext({ baseURL: BASE, viewport: VIEWPORTS.phone, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  watch(page);
  await page.request.post("/api/role", { data: { role: "marketing" } });
  await page.goto(`/onboarding/${uploadId}`);
  await page.getByTestId("accounted").waitFor({ timeout: 60_000 });
  const result = page.locator('[data-testid="upload-result"]');
  if (await result.count()) await result.first().scrollIntoViewIfNeeded();
  else await page.locator("#dry-run").scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  const text = await firstScreen(page);
  const overflow = await page.evaluate(() => document.scrollingElement!.scrollWidth - innerWidth);
  await shot(page, `${name}-phone-390`);
  await context.close();
  return { text, overflow };
}

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const noFigureClaims = (text: string) =>
  !/\bCAC\b[^.]{0,30}\$\d|\$\d[\d,.]*\s*(per (new )?customer|CAC)|\b\d[\d,]*\s+(new )?(leads|customers)\b|\bROI\b[^.]{0,20}\d|\brecommend/i.test(text);

test("a cold start brings its own Microsoft Ads export: the valid file, a currency problem, then the same file again", async ({ browser }) => {
  test.setTimeout(20 * 60_000);
  const pool = createPool(acceptanceDatabaseUrl(BYOF.database));
  const started = new Date().toISOString();
  const record: Record<string, unknown> = {};
  const context = await browser.newContext({ baseURL: BASE, viewport: VIEWPORTS.desktop });
  const page = await context.newPage();
  watch(page);
  try {
    await test.step("setup: the frozen fixture, an empty workspace", async () => {
      stage = "setup";
      for (const key of ["valid", "twoAccounts"] as const) {
        const f = expected.files[key];
        check(`${f.file} is the frozen file (sha256)`, sha256(path.join(FIXTURE, f.file)) === f.sha256, sha256(path.join(FIXTURE, f.file)));
      }
      const before = await ledger(pool);
      record.ledgerBefore = before;
      check("the workspace is empty: no raw events, spend, campaigns, leads or payments", Object.values(before).every((n) => n === 0), before);
      check("no upload exists yet", Number((await pool.query("select count(*)::int as n from onboarding_uploads")).rows[0].n) === 0);
    });

    await test.step("cold start: a new visitor finds the upload from the Overview, with no ids", async () => {
      stage = "cold start";
      await page.goto("/");
      await page.getByRole("link", { name: "Data onboarding" }).filter({ visible: true }).first().click();
      await page.waitForURL(/\/onboarding$/);
      const guest = await firstScreen(page);
      check("the Overview's navigation leads to Data onboarding", page.url().endsWith("/onboarding"));
      check("as a guest, the page says which roles may upload", /analyst, engineer and approver/.test(guest), guest.slice(0, 300));
      await page.getByTestId("role-switcher").filter({ visible: true }).first().selectOption("marketing");
      await page.getByLabel("Export file").waitFor({ timeout: 30_000 });
      check("after choosing Marketing analyst in the header, the upload form is there", true);
      await shot(page, "1-upload-desktop-1280");
    });

    const runs: Record<string, { uploadId: number; dry: Awaited<ReturnType<typeof dryRun>>; screen: string }> = {};
    const files = [
      { key: "valid", file: expected.files.valid.file, label: "the valid file" },
      { key: "twoAccounts", file: expected.files.twoAccounts.file, label: "the file with a Canadian-dollar account" },
      { key: "duplicate", file: expected.files.valid.file, label: "the valid file again" },
    ] as const;
    for (const f of files) {
      await test.step(`${f.label}: upload, review, result`, async () => {
        stage = f.key;
        const { uploadId, answers } = await journey(page, path.join(FIXTURE, f.file));
        const screen = await firstScreen(page);
        const actions = await primaryActions(page);
        const dry = await dryRun(pool, uploadId);
        runs[f.key] = { uploadId, dry, screen };
        record[f.key] = { uploadId, answers, firstScreen: screen, primaryActions: actions, dryRun: dry };
        await shot(page, `${f.key === "valid" ? "2" : f.key === "twoAccounts" ? "3" : "4"}-result-${f.key}-desktop-1280`);
        const after = await ledger(pool);
        check("nothing reached the ledger: no raw events, spend, campaigns, leads or payments", Object.values(after).every((n) => n === 0), after);
        check("the file's Currency code column was mapped without the user touching it", answers.assistant.currency === "Currency code", answers.assistant);
        check("no figure for leads, customers, CAC, ROI or a budget recommendation on the first screen", noFigureClaims(screen), screen.slice(0, 400));
        check("the first screen offers exactly one next action", actions.length === 1, actions);
        check("the first screen states a limitation", /\b(cannot|can't|can not|does not|doesn't|not (tell|say|show|verified|checked|compared|counted|added))\b/i.test(screen), screen.slice(0, 400));
        const comparedNothing = dry !== null && dry.compared.matches + dry.compared.differs === 0;
        const page2 = await page.locator("main").innerText();
        check("no claim that the file agrees with a ledger that holds none of its rows (\"0 differ from the ledger\")", !(comparedNothing && /\b0 differ from the ledger\b/.test(page2)), (page2.match(/[^\n]*differ from the ledger[^\n]*/) ?? [""])[0]);

        if (f.key === "valid" || f.key === "duplicate") {
          check(`the stored dry run: ${valid.validRows} valid rows, ${usd(valid.spendCents)}`, dry?.counts.eligible === valid.validRows && dry?.money?.fileTotalCents === valid.spendCents, dry);
          // The file has 42 data rows and two lines that are not data: its Total row and its copyright line.
          const leftOut = (dry?.total ?? 0) - (dry?.counts.eligible ?? 0);
          check("no data row was refused: only the report's Total row and copyright line were left out", leftOut === 2, dry?.rows);
          check(`the first screen states the verified conclusion: ${valid.validRows} rows, ${usd(valid.spendCents)}, ${monthDay(valid.firstDay)}–${monthDay(valid.lastDay)}`, screen.includes(String(valid.validRows)) && screen.includes(usd(valid.spendCents)) && ((screen.includes(monthDay(valid.firstDay)) && screen.includes(monthDay(valid.lastDay))) || (screen.includes(valid.firstDay) && screen.includes(valid.lastDay))), screen.slice(0, 500));
          check("the first screen says the file added nothing to the ledger", /(nothing|not)\b[^.]{0,40}\b(added|written|stored in the ledger)|compare[- ]only|cannot add|never (added|published)/i.test(screen), screen.slice(0, 400));
          check("the first screen does not ask the user to correct non-data lines (the Total row, the copyright line)", !/Needs correction\s*[1-9]|[1-9]\d*\s+rows? needs? correction/i.test(screen), (screen.match(/Needs correction\s*\d+/) ?? [""])[0]);
        }
        if (f.key === "twoAccounts") {
          check(`the stored dry run counts only the ${two.usDollarRows.rows} US-dollar rows: ${usd(two.usDollarRows.spendCents)}`, dry?.counts.eligible === two.usDollarRows.rows && dry?.money?.fileTotalCents === two.usDollarRows.spendCents, dry);
          check(`the first screen states the US-dollar total ${usd(two.usDollarRows.spendCents)}, never ${usd(two.usDollarRows.spendCents + two.canadianDollarRows.spendCents)} (Canadian dollars summed as US)`, screen.includes(usd(two.usDollarRows.spendCents)) && !screen.includes(usd(two.usDollarRows.spendCents + two.canadianDollarRows.spendCents)), screen.slice(0, 500));
          check(`the first screen says the ${two.canadianDollarRows.rows} Canadian-dollar rows were not counted`, screen.includes(String(two.canadianDollarRows.rows)) && /\b(CAD|Canadian)\b/.test(screen), screen.slice(0, 500));
        }
        if (f.key === "duplicate") {
          const first = runs.valid?.dry;
          check("the duplicate upload gives the same result as the first upload of the file", !!first && !!dry && JSON.stringify(first.counts) === JSON.stringify(dry.counts) && first.money?.fileTotalCents === dry.money?.fileTotalCents, { first: first?.counts, again: dry?.counts });
          check(`nothing adds the two uploads together (no ${usd(valid.spendCents * 2)} anywhere)`, !page2.includes(usd(valid.spendCents * 2)));
          record.duplicateNamed = /same file|identical|already uploaded|uploaded before/i.test(screen);
        }

        // The evidence behind the conclusion, and back.
        const resultUrl = page.url();
        const rowLink = page.locator('main a[href*="rows="]').filter({ visible: true }).first();
        if (await rowLink.count()) {
          await rowLink.click();
          await page.waitForURL(/rows=/, { timeout: 30_000 });
          await page.locator("#rows").waitFor({ timeout: 30_000 });
          const rowsShown = await page.locator("#rows tbody tr").count();
          await page.goBack();
          await page.waitForTimeout(1_200);
          const back = await firstScreen(page);
          check("the rows behind the result open, and Back returns to the result", rowsShown > 0 && page.url().split("#")[0] === resultUrl.split("#")[0].replace(/[?&]rows=[^&#]*/, "") && back.includes(f.key === "twoAccounts" ? usd(two.usDollarRows.spendCents) : usd(valid.spendCents)), { rowsShown, url: page.url().replace(BASE, ""), back: back.slice(0, 200) });
        } else {
          check("the rows behind the result open, and Back returns to the result", false, "no link to the rows on the page");
        }

        const p = await phone(browser, uploadId, `${f.key === "valid" ? "2" : f.key === "twoAccounts" ? "3" : "4"}-result-${f.key}`);
        record[`${f.key}Phone`] = p;
        check("at 390 px: no sideways scroll of the page", p.overflow <= 1, p.overflow);
        check("at 390 px: the result's total is on the first screen", p.text.includes(f.key === "twoAccounts" ? usd(two.usDollarRows.spendCents) : usd(valid.spendCents)), p.text.slice(0, 300));
      });
    }

    stage = "errors";
    check("no console or page errors", errors.length === 0, errors);
  } finally {
    const out = OUT;
    mkdirSync(out, { recursive: true });
    const git = (args: string[]) => execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();
    const failed = checks.filter((c) => !c.ok);
    const result = {
      proof: "Bring-your-own-file workflow (docs/agent-work/BYOF-WORKFLOW.md); scripted, not a person",
      sha: git(["rev-parse", "HEAD"]),
      trackedChanges: git(["status", "--porcelain", "--untracked-files=no"]).split("\n").filter(Boolean),
      command: process.env.npm_lifecycle_event ? `npm run ${process.env.npm_lifecycle_event}` : process.argv.slice(1).join(" "),
      build: readFileSync(path.join(REPO, ".next", "BUILD_ID"), "utf8").trim(),
      server: BASE,
      database: acceptanceDatabaseName(BYOF.database),
      node: process.version,
      started,
      finished: new Date().toISOString(),
      summary: { checks: checks.length, passed: checks.length - failed.length, failed: failed.length, consoleOrPageErrors: errors.length },
      failed,
      checks,
      errors,
      record,
    };
    writeFileSync(path.join(out, "results.json"), JSON.stringify(result, null, 2));
    console.log(`[acceptance] ${result.summary.passed} of ${result.summary.checks} checks passed at ${result.sha.slice(0, 7)} (build ${result.build}); record: ${path.relative(REPO, path.join(out, "results.json"))}`);
    await context.close();
    await pool.end();
  }
});
