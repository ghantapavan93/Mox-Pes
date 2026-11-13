import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import type { Pool } from "pg";
import { mapperFor, referenceContext } from "../../lib/adapters/registry";
import { createChange, decideChange, releaseChange } from "../../lib/changeguard/service";
import { createPool, DEFAULT_DATABASE_URL, getNow } from "../../lib/db";
import { runStream } from "../../lib/ingest/ingest";
import { InMemorySourceClient } from "../../lib/sim/clients";
import { VIEWERS } from "../../lib/viewer";

/**
 * The flagship drift review in the browser (docs/agent-work/DRIFT-REVIEW.md), on the demo world's
 * lsa-B44-x drift (released to B44 on 10 of 10 calls; one call revised to B39). Every check is run
 * by the real worker (`npm run worker -- --once`, its own process) as the business clock moves;
 * records arrive through the polling ingestion path.
 *
 *   desktop  Incidents → the case → the proof → both stored versions (drawer, Esc, focus back) →
 *            "Reviewed — no mapping change" → reload and a fresh browser: the decision persisted →
 *            the same evidence again: still reviewed → a second lead at B41: the SAME case reopens
 *   phone    (390 px) Incidents → the reopened case → the new lead's versions → "Needs
 *            investigation" (the owner is required) → reload
 *   stale    a save over newer evidence is refused, the draft kept, the new lead marked
 *   roles    guest: read-only; brand lead (B40–B44): B39 counted, never named, the note withheld
 *   320 px   reflow, nothing hidden; keyboard order and visible, unobscured focus
 *
 * Runs LAST (after zzzzz-post-release-monitoring): it moves the business clock and puts it back;
 * the reviews and revisions stay. Reseed afterwards. DRIFT_SCREENS=<dir> saves labelled screenshots.
 */
const HOUR = 3_600_000;
const URL_ = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const SCREENS = process.env.DRIFT_SCREENS ?? null;
const BUILD = process.env.DRIFT_BUILD ?? "build";
const shown = (page: Page, id: string) => page.getByTestId(id).filter({ visible: true });

let pool: Pool;
let originalClock: Date;
let changeId: number;
let exceptionId: number;

async function setRole(page: Page, role: string) {
  const res = await page.request.post("/api/role", { data: { role } });
  expect(res.ok()).toBe(true);
}

async function axeViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
  return page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (ctx: Document, opts: unknown) => Promise<{ violations: Array<{ id: string; impact: string; nodes: Array<{ target: string[] }> }> }> } }).axe;
    const result = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] } });
    return result.violations.map((v) => `${v.id} (${v.impact}) ×${v.nodes.length}: ${v.nodes[0]?.target.join(" ")}`);
  });
}

const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

/** The same page at 390 px (no sideways scroll), then back to the desktop width. */
async function atPhoneWidth(page: Page, check: () => Promise<void>) {
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await noSideScroll(page)).toBe(true);
  await check();
  await page.setViewportSize({ width: 1440, height: 900 });
}

async function snap(page: Page, state: string, viewport: string, role: string, fullPage = true) {
  if (!SCREENS) return;
  mkdirSync(SCREENS, { recursive: true });
  // From the top: a full-page capture taken while scrolled draws the sticky shell mid-page.
  if (fullPage) await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${SCREENS}/final_${state}_${viewport}_${role}_${BUILD}.jpg`, fullPage, type: "jpeg", quality: 70 });
}

function runWorkerOnce(): string {
  const r = spawnSync("npm", ["run", "worker", "--", "--once"], { shell: true, encoding: "utf8", env: { ...process.env, DATABASE_URL: URL_ }, timeout: 120_000 });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

async function setClock(when: Date) {
  await pool.query("update app_clock set now = $1", [when]);
}

async function deliverCalls(payloads: Array<Record<string, unknown>>, when: Date) {
  const client = new InMemorySourceClient("calls", "calls", payloads.map((payload) => ({ stream: "calls", entity: "call", visibleAt: when.getTime() - 60_000, payload })));
  const r = await runStream(pool, { client, mapper: mapperFor("calls"), ctx: referenceContext, now: when, windowEnd: when, overlapMs: 0, initialCursor: new Date(when.getTime() - 24 * HOUR) });
  expect(r.status).toBe("succeeded");
}

/** The next scheduled slot of the change: the feed delivered an hour before, the worker runs at it. */
async function nextCheck(): Promise<string> {
  const due = new Date((await pool.query<{ monitor_due_at: Date }>("select monitor_due_at from config_changes where id = $1", [changeId])).rows[0].monitor_due_at);
  const now = await getNow(pool);
  const at = new Date(Math.max(due.getTime(), now.getTime()) + 5 * 60_000);
  await deliverCalls([], new Date(at.getTime() - HOUR));
  await setClock(at);
  return runWorkerOnce();
}

/** The current payload of the n-th lsa-B44-x call, by lead id. */
async function callPayload(n: number) {
  const { rows } = await pool.query<{ payload: Record<string, unknown>; branch: string }>(
    "select r.payload, l.effective_branch_id as branch from v_leads l join raw_events r on r.id = l.raw_event_id where l.campaign_external_id = 'lsa-B44-x' order by l.id offset $1 limit 1",
    [n],
  );
  return rows[0];
}

async function revise(n: number, branch: string) {
  const lead = await callPayload(n);
  await deliverCalls([{ ...lead.payload, branch_tag: branch, agent_note: `Tracking number moved to ${branch}` }], new Date((await getNow(pool)).getTime() + 2 * HOUR));
  const id = String(lead.payload.id ?? "");
  expect(id).toMatch(/^CAL\d+$/);
  return id;
}

const mapping = async () => (await pool.query("select m.branch_id, (select count(*)::int from campaign_mapping_versions v where v.campaign_id = c.id) as versions from campaign_branch_map m join ad_campaigns c on c.id = m.campaign_id where c.external_campaign_id = 'lsa-B44-x'")).rows;
const caseRow = async () => (await pool.query("select c.id, c.state, c.reopen_count from cases c where c.exception_id = $1", [exceptionId])).rows[0];

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  test.setTimeout(240_000);
  pool = createPool(URL_);
  originalClock = await getNow(pool);
  // The drift from zzzzz-post-release-monitoring, or the same one built here when this runs alone.
  let change = (await pool.query<{ id: string }>("select id from config_changes where kind = 'campaign_mapping' and status in ('verified', 'recovery_required') and title like 'lsa-B44-x:%' order by id desc limit 1")).rows[0];
  if (!change) {
    const campaign = Number((await pool.query<{ id: string }>("select id from ad_campaigns where external_campaign_id = 'lsa-B44-x'")).rows[0].id);
    const proposed = await createChange(pool, VIEWERS.marketing, { kind: "campaign_mapping", payload: { campaignId: campaign, branchId: "B44" }, reason: "Leads for this campaign arrive at B44" }, originalClock);
    await decideChange(pool, VIEWERS.approver, proposed.id, { decision: "approve", reason: "Evidence and brand agree; spend conserved", configHash: proposed.configHash, preflightHash: proposed.preflightHash! }, originalClock);
    change = { id: String((await releaseChange(pool, VIEWERS.marketing, proposed.id, originalClock)).id) };
  }
  changeId = Number(change.id);
  let item = (await pool.query<{ id: string }>("select id from exceptions where fingerprint = $1", [`mapping_drift:change:${changeId}`])).rows[0];
  if (!item) {
    await nextCheck();
    await revise(0, "B39");
    expect(await nextCheck()).toContain('"outcome":"drift"');
    item = (await pool.query<{ id: string }>("select id from exceptions where fingerprint = $1", [`mapping_drift:change:${changeId}`])).rows[0];
  }
  exceptionId = Number(item.id);
  expect((await caseRow()).state).toBe("detected");
  // The earlier spec puts the demo's frozen clock back before the checks it ran. People act after
  // the evidence they read: move the business clock past the latest check (restored at the end).
  const latest = new Date((await pool.query<{ ran_at: Date }>("select max(ran_at) as ran_at from change_monitor_runs where change_id = $1", [changeId])).rows[0].ran_at);
  if ((await getNow(pool)).getTime() < latest.getTime()) await setClock(new Date(latest.getTime() + 30 * 60_000));
});

test.afterAll(async () => {
  await setClock(originalClock);
  await pool.end();
});

test("desktop: find the case, read the proof, compare versions, decide, and the decision persists", async ({ page, browser }) => {
  test.setTimeout(240_000);
  const before = await mapping();
  await setRole(page, "marketing");

  // 1. Incidents, without a case id → the drift type → its case.
  await page.goto("/exceptions");
  await shown(page, "kind-breakdown").getByRole("link", { name: /Mapping drift after release/ }).click();
  await expect(page).toHaveURL(/\/exceptions\?kind=mapping_drift$/);
  await page.locator('main a[href^="/exceptions/"]').filter({ hasText: "Mapping drift after release" }).filter({ visible: true }).first().click();
  await expect(page).toHaveURL(new RegExp(`/exceptions/${exceptionId}$`));
  const caseUrl = page.url();

  // 2. What changed and what did not; the proof; three separate statements.
  const brief = shown(page, "drift-brief");
  await expect(brief).toHaveAttribute("data-state", "open");
  await expect(shown(page, "brief-headline")).toHaveText("One lead changed branches. The mapping stayed at B44.");
  await expect(shown(page, "brief-detail")).toContainText("revised at the source to point to B39");
  await expect(shown(page, "proof-release")).toContainText("10 of 10");
  await expect(shown(page, "proof-latest")).toContainText("9 of 10");
  const leadRow = shown(page, "changed-lead");
  await expect(leadRow).toHaveCount(1);
  await expect(leadRow).toContainText(/At release\s*B44.*now\s*B39/s);
  await expect(shown(page, "brief-detail")).toContainText("read now, is still B44 (version 2), as released");
  await expect(shown(page, "brief-finding")).toContainText("confirmed a change in the evidence the release was approved on. The check changed nothing.");
  await expect(shown(page, "brief-disposition")).toHaveText("Open — no one has reviewed it yet.");
  await expect(shown(page, "brief-outcome")).toContainText("No revenue impact was measured from this finding.");
  await expect(shown(page, "brief-outcome")).toContainText("is at stake, not lost");
  // The headline names no id or time; the primary action is the decision.
  await expect(shown(page, "brief-headline")).not.toContainText(/#|CAL|\d:\d\d/);
  await expect(shown(page, "record-decision")).toBeVisible();
  expect(await axeViolations(page)).toEqual([]);
  await snap(page, "case-open", "desktop-1440", "marketing");
  await atPhoneWidth(page, async () => {
    await expect(shown(page, "record-decision")).toBeVisible();
    await snap(page, "case-open", "phone-390", "marketing");
  });

  // 3. Both stored versions, in a drawer over the case; Esc returns focus to where it was.
  const compare = leadRow.getByTestId("compare-versions");
  await compare.click();
  const drawer = page.getByRole("dialog");
  await expect(drawer).toBeVisible();
  const branchRow = drawer.locator('tr[data-changed="true"]').filter({ hasText: "branch_tag" });
  await expect(branchRow.locator("td").nth(0)).toHaveText("B44");
  await expect(branchRow.locator("td").nth(1)).toHaveText("B39");
  await expect(drawer.getByRole("button", { name: /Close/ })).toBeFocused();
  expect(await axeViolations(page)).toEqual([]);
  await snap(page, "evidence-versions", "desktop-1440", "marketing", false);
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
  await expect(compare).toBeFocused();
  expect(page.url()).toBe(caseUrl);

  // 4. Reviewed — no mapping change, with a rationale.
  await shown(page, "record-decision").click();
  const form = page.getByRole("form", { name: "Record a decision" });
  await expect(form.getByRole("radio", { name: /Reviewed — no mapping change/ })).toBeFocused();
  await expect(form.getByTestId("save-decision")).toBeDisabled(); // no rationale yet
  await form.getByTestId("decision-rationale").fill("The B39 tracking number is a source correction at the vendor; B44 still gets 9 of 10 calls.");
  const saved = page.waitForResponse((r) => r.url().endsWith(`/api/exceptions/${exceptionId}/review`) && r.request().method() === "POST");
  await form.getByTestId("save-decision").click();
  expect((await saved).status()).toBe(200);
  await expect(shown(page, "case-decision")).toHaveAttribute("data-disposition", "reviewed_no_change");
  await expect(shown(page, "case-decision")).toBeFocused();
  await expect(shown(page, "drift-brief")).toHaveAttribute("data-state", "reviewed");

  // Persisted, not a toast: a reload, then a fresh browser context.
  await page.reload();
  const decision = shown(page, "case-decision");
  await expect(decision).toContainText("Reviewed — no mapping change");
  await expect(shown(page, "decision-meta")).toContainText("Marketing analyst");
  await expect(shown(page, "decision-meta")).toContainText(/reviewed check #\d+ \(1 changed lead\)/);
  await expect(shown(page, "case-decision").getByTestId("review-rationale")).toContainText("source correction at the vendor");
  await expect(shown(page, "case-status")).toContainText("Reviewed — no mapping change");
  await expect(shown(page, "record-decision")).toHaveCount(0);
  await expect(shown(page, "next-none")).toContainText("reopens on its own only if a later check finds a contradiction");
  expect(await axeViolations(page)).toEqual([]);
  await snap(page, "case-reviewed", "desktop-1440", "marketing");
  await atPhoneWidth(page, async () => {
    await expect(shown(page, "case-decision")).toBeVisible();
    await snap(page, "case-reviewed", "phone-390", "marketing");
  });
  const fresh = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  await fresh.request.post("/api/role", { data: { role: "engineer" } });
  const other = await fresh.newPage();
  await other.goto(caseUrl);
  await expect(other.getByTestId("case-decision").filter({ visible: true })).toContainText("Marketing analyst");
  await fresh.close();
  expect(await mapping()).toEqual(before);
  expect((await caseRow())).toMatchObject({ state: "closed_acknowledged", reopen_count: 0 });

  // 5. The same evidence again, through the monitoring path: a duplicate delivery, then a check.
  const same = await callPayload(0);
  await deliverCalls([same.payload], new Date((await getNow(pool)).getTime() + HOUR));
  expect(await nextCheck()).toContain('"outcome":"drift"');
  await page.reload();
  await expect(shown(page, "drift-brief")).toHaveAttribute("data-state", "reviewed");
  await expect(shown(page, "case-history").locator("li")).toHaveCount(2);
  await shown(page, "technical-history").locator("summary").click();
  await expect(shown(page, "check-history")).toContainText("Same evidence");
  expect((await caseRow())).toMatchObject({ state: "closed_acknowledged", reopen_count: 0 });
  expect((await pool.query("select count(*)::int as n from exceptions where kind = 'mapping_drift'")).rows[0].n).toBe(1);

  // 6. A second lead now points outside the approved branches (B41): the SAME case reopens, once.
  const second = await revise(1, "B41");
  expect(await nextCheck()).toContain('"outcome":"drift"');
  await page.goto(caseUrl);
  await expect(shown(page, "drift-brief")).toHaveAttribute("data-state", "reopened");
  await expect(shown(page, "case-status")).toContainText("Reopened — new evidence");
  const whatsNew = shown(page, "whats-new");
  await expect(whatsNew).toContainText("New since the last review: one more lead points outside the approved branches.");
  await expect(whatsNew.getByTestId("new-lead")).toContainText(second);
  await expect(whatsNew.getByTestId("new-lead")).toContainText("now points to B41");
  await expect(shown(page, "brief-headline")).toHaveText("Two leads changed branches. The mapping stayed at B44.");
  await expect(shown(page, "review-log")).toContainText("Reviewed — no mapping change");
  await expect(shown(page, "review-log")).toContainText("source correction at the vendor");
  await expect(shown(page, "case-history").locator("li").last()).toContainText("Reopened: new evidence");
  // The history reads in time order: opened, reviewed, reopened.
  const times = await shown(page, "case-history").locator("time").evaluateAll((ts) => ts.map((t) => Date.parse(t.getAttribute("datetime")!)));
  expect(times).toEqual([...times].sort((a, b) => a - b));
  expect(await axeViolations(page)).toEqual([]);
  await snap(page, "case-reopened", "desktop-1440", "marketing");
  expect((await caseRow())).toMatchObject({ id: expect.anything(), state: "detected", reopen_count: 1 });
  expect(await mapping()).toEqual(before);
});

test("phone 390: the reopened case, its new lead's versions, and needs investigation with a required owner", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await setRole(page, "engineer");
  await page.goto("/exceptions?kind=mapping_drift");
  await page.locator('main a[href^="/exceptions/"]').filter({ hasText: "Mapping drift after release" }).filter({ visible: true }).first().click();
  await expect(shown(page, "drift-brief")).toHaveAttribute("data-state", "reopened");
  expect(await noSideScroll(page)).toBe(true);
  await snap(page, "case-reopened", "phone-390", "engineer");

  const compare = shown(page, "whats-new").getByTestId("compare-versions");
  await compare.click();
  const drawer = page.getByRole("dialog");
  await expect(drawer.locator('tr[data-changed="true"]').filter({ hasText: "branch_tag" }).locator("td").nth(1)).toHaveText("B41");
  expect(await noSideScroll(page)).toBe(true);
  await snap(page, "evidence-versions", "phone-390", "engineer", false);
  await drawer.getByRole("button", { name: /Close/ }).click();
  await expect(compare).toBeFocused();

  await shown(page, "record-decision").click();
  const form = page.getByRole("form", { name: "Record a decision" });
  await form.getByRole("radio", { name: /Needs investigation/ }).check();
  await form.getByTestId("decision-rationale").fill("Ask the call vendor whether both numbers moved, and since when.");
  await expect(form.getByTestId("save-decision")).toBeDisabled(); // the owner is required
  await expect(form).toContainText("Choose an owner");
  await form.getByTestId("decision-owner").selectOption("engineer");
  const saved = page.waitForResponse((r) => r.url().endsWith(`/api/exceptions/${exceptionId}/review`) && r.request().method() === "POST");
  await form.getByTestId("save-decision").click();
  expect((await saved).status()).toBe(200);
  await page.reload();
  await expect(shown(page, "drift-brief")).toHaveAttribute("data-state", "investigating");
  await expect(shown(page, "case-decision")).toContainText("Needs investigation — owner: Integration engineer");
  await expect(shown(page, "case-decision").getByTestId("review-rationale")).toContainText("Ask the call vendor");
  // The earlier decision stays.
  await expect(shown(page, "review-log")).toContainText("Reviewed — no mapping change");
  await expect(shown(page, "record-decision")).toBeVisible();
  expect(await noSideScroll(page)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
  await snap(page, "case-investigating", "phone-390", "engineer");
  expect((await caseRow())).toMatchObject({ state: "investigating" });
});

test("stale save: newer evidence refuses the save, keeps the draft and marks what is new; then it saves", async ({ page }) => {
  test.setTimeout(180_000);
  await setRole(page, "marketing");
  await page.goto(`/exceptions/${exceptionId}`);
  await shown(page, "record-decision").click();
  const form = page.getByRole("form", { name: "Record a decision" });
  const note = "Both tracking numbers moved at the vendor; reviewed with the vendor's change log.";
  await form.getByTestId("decision-rationale").fill(note);

  // Meanwhile a third lead moves (B42) and the worker records it.
  const third = await revise(2, "B42");
  expect(await nextCheck()).toContain('"outcome":"drift"');

  const refused = page.waitForResponse((r) => r.url().endsWith(`/api/exceptions/${exceptionId}/review`) && r.request().method() === "POST");
  await form.getByTestId("save-decision").click();
  expect((await refused).status()).toBe(409);
  const conflict = shown(page, "stale-conflict");
  await expect(conflict).toContainText("Not saved: newer evidence arrived");
  await expect(conflict).toBeFocused();
  await expect(form.getByTestId("decision-rationale")).toHaveValue(note);
  await expect(page).toHaveURL(/\?since=\d+$/);
  await expect(shown(page, "since-check")).toContainText("one more lead");
  await expect(shown(page, "changed-lead").filter({ hasText: third })).toHaveAttribute("data-new", "true");
  expect((await caseRow())).toMatchObject({ state: "investigating" });
  expect(await axeViolations(page)).toEqual([]);
  await snap(page, "stale-conflict", "desktop-1440", "marketing");

  // Having read it, the same note now saves against the newest check.
  const saved = page.waitForResponse((r) => r.url().endsWith(`/api/exceptions/${exceptionId}/review`) && r.request().method() === "POST");
  await form.getByTestId("save-decision").click();
  expect((await saved).status()).toBe(200);
  // The page drops "?since=" itself once saved; then a reload shows the stored decision.
  await expect(page).not.toHaveURL(/since=/);
  await expect(shown(page, "drift-brief")).toHaveAttribute("data-state", "reviewed");
  await page.reload();
  await expect(shown(page, "drift-brief")).toHaveAttribute("data-state", "reviewed");
  await expect(shown(page, "decision-meta")).toContainText("(3 changed leads)");
  await expect(shown(page, "since-check")).toHaveCount(0);
});

test("roles: a guest reads without acting; the brand lead never sees B39 or the note that names it", async ({ page }) => {
  test.setTimeout(120_000);
  await setRole(page, "guest");
  await page.goto(`/exceptions/${exceptionId}`);
  await expect(shown(page, "case-decision")).toBeVisible();
  await expect(shown(page, "record-decision")).toHaveCount(0);
  await expect(page.locator("main").getByRole("button", { name: /Save decision|Record a decision/ })).toHaveCount(0);
  const guestPost = await page.request.post(`/api/exceptions/${exceptionId}/review`, { data: { disposition: "reviewed_no_change", runId: 1, evidenceKey: "0".repeat(64), rationale: "A guest trying to decide" } });
  expect(guestPost.status()).toBe(403);
  await snap(page, "case-reviewed", "desktop-1440", "guest");

  await setRole(page, "brand");
  await page.goto(`/exceptions/${exceptionId}`);
  await expect(shown(page, "drift-brief")).toBeVisible();
  await expect(page.locator("main")).not.toContainText("B39");
  await expect(shown(page, "hidden-leads")).toContainText("1 changed lead is at a branch outside your scope");
  await expect(shown(page, "changed-lead")).toHaveCount(2); // B41 and B42, in the brand's branches
  await expect(shown(page, "review-rationale-withheld").first()).toBeVisible();
  await expect(page.locator("main")).not.toContainText("source correction at the vendor");
  const brandPost = await page.request.post(`/api/exceptions/${exceptionId}/review`, { data: { disposition: "reviewed_no_change", runId: 1, evidenceKey: "0".repeat(64), rationale: "A brand lead trying to decide" } });
  expect(brandPost.status()).toBe(403);
  expect(await axeViolations(page)).toEqual([]);
  await snap(page, "case-reviewed", "desktop-1440", "brand");

  // The B20 partner cannot read the case at all: the page reads as missing (Next's not-found, inside
  // the streamed response, so the HTTP status is already 200), and nothing of the case is in it.
  await setRole(page, "partner");
  await page.goto(`/exceptions/${exceptionId}`);
  await expect(page.getByRole("heading", { name: "404" })).toBeVisible();
  const html = await page.content();
  for (const leak of ["B39", "CAL000", "lsa-B44-x", "drift-brief"]) expect(html, leak).not.toContain(leak);
  expect((await page.request.post(`/api/exceptions/${exceptionId}/review`, { data: { disposition: "reviewed_no_change", runId: 1, evidenceKey: "0".repeat(64), rationale: "A partner trying to decide" } })).status()).toBe(403);
});

test("320 px reflow, keyboard order, visible and unobscured focus", async ({ page }) => {
  test.setTimeout(120_000);
  await setRole(page, "marketing");
  // Reopen once more so the decision control is present: a fourth lead (B43).
  await revise(3, "B43");
  expect(await nextCheck()).toContain('"outcome":"drift"');
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto(`/exceptions/${exceptionId}`);
  await expect(shown(page, "drift-brief")).toHaveAttribute("data-state", "reopened");
  expect(await noSideScroll(page)).toBe(true);
  for (const id of ["brief-headline", "proof-latest", "record-decision"]) {
    const box = await shown(page, id).boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(321);
  }
  await snap(page, "case-reopened", "phone-320", "marketing");
  await shown(page, "whats-new").getByTestId("compare-versions").click();
  expect(await noSideScroll(page)).toBe(true);
  await page.keyboard.press("Escape");

  // Keyboard: from the headline, Tab reaches the new lead's versions before the decision.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/exceptions/${exceptionId}`);
  const order: string[] = [];
  await shown(page, "whats-new").focus();
  for (let i = 0; i < 40 && !order.includes("record-decision"); i++) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const header = document.querySelector("header");
      const headerBottom = header && getComputedStyle(header).position === "sticky" ? header.getBoundingClientRect().bottom : 0;
      const style = getComputedStyle(el);
      return { id: el.dataset.testid ?? el.textContent?.trim().slice(0, 30) ?? el.tagName, top: r.top, bottom: r.bottom, headerBottom, outline: style.outlineStyle !== "none" || style.boxShadow !== "none" };
    });
    if (!info) continue;
    order.push(info.id);
    // Visible focus, not hidden under a sticky bar.
    expect(info.outline, info.id).toBe(true);
    expect(info.bottom, info.id).toBeGreaterThan(info.headerBottom);
  }
  expect(order.indexOf("compare-versions")).toBeGreaterThanOrEqual(0);
  expect(order.indexOf("compare-versions")).toBeLessThan(order.indexOf("record-decision"));
});
