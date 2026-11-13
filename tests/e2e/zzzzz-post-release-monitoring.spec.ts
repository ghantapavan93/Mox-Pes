import { spawnSync } from "node:child_process";
import { expect, test, type Page } from "@playwright/test";
import type { Pool } from "pg";
import { mapperFor, referenceContext } from "../../lib/adapters/registry";
import { createChange, decideChange, releaseChange } from "../../lib/changeguard/service";
import { createPool, DEFAULT_DATABASE_URL, getNow } from "../../lib/db";
import { dateTime } from "../../lib/format";
import { runStream } from "../../lib/ingest/ingest";
import { InMemorySourceClient } from "../../lib/sim/clients";
import { VIEWERS } from "../../lib/viewer";

/**
 * Scheduled post-release monitoring (R-30) in the browser, on the seeded demo world:
 * the lsa-B44-x → B44 mapping (released by zzz-changeguard, or here when this spec runs alone)
 * is checked by the real worker (`npm run worker -- --once`, its own process) as the business
 * clock moves: one clean check, then a call revision that moves one of the campaign's calls to
 * B39 (another brand). The ChangeGuard page shows "verified at release" apart from the latest
 * result, the last successful verification that the failed check did not move, the review item,
 * and a read-only evidence page that hides B39 from a viewer whose scope is B40–B44.
 *
 * Runs LAST: it moves the demo's business clock forward and puts it back at the end; the review
 * item and the call revision stay. Reseed afterwards (`npm run db:seed`).
 */
const HOUR = 3_600_000;
const URL_ = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const shown = (page: Page, id: string) => page.getByTestId(id).filter({ visible: true });

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

/** One loop of the real worker, as a separate process against the demo database. */
function runWorkerOnce(): string {
  const r = spawnSync("npm", ["run", "worker", "--", "--once"], { shell: true, encoding: "utf8", env: { ...process.env, DATABASE_URL: URL_ }, timeout: 120_000 });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

let pool: Pool;
let originalClock: Date;
let changeId: number;
let releasedAt: Date;

async function setClock(when: Date) {
  await pool.query("update app_clock set now = $1", [when]);
}

/** One polling run of the demo's call feed at `when` (the real ingestion path). */
async function deliverCalls(payloads: Array<Record<string, unknown>>, when: Date) {
  const client = new InMemorySourceClient("calls", "calls", payloads.map((payload) => ({ stream: "calls", entity: "call", visibleAt: when.getTime() - 60_000, payload })));
  const r = await runStream(pool, { client, mapper: mapperFor("calls"), ctx: referenceContext, now: when, windowEnd: when, overlapMs: 0, initialCursor: new Date(when.getTime() - 24 * HOUR) });
  expect(r.status).toBe("succeeded");
}

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  pool = createPool(URL_);
  originalClock = await getNow(pool);
  const existing = await pool.query<{ id: string; released_at: Date }>(
    "select id, released_at from config_changes where kind = 'campaign_mapping' and status = 'verified' and title like 'lsa-B44-x:%' order by id desc limit 1",
  );
  if (existing.rows[0]) {
    changeId = Number(existing.rows[0].id);
    releasedAt = new Date(existing.rows[0].released_at);
  } else {
    const campaign = Number((await pool.query<{ id: string }>("select id from ad_campaigns where external_campaign_id = 'lsa-B44-x'")).rows[0].id);
    const proposed = await createChange(pool, VIEWERS.marketing, { kind: "campaign_mapping", payload: { campaignId: campaign, branchId: "B44" }, reason: "Leads for this campaign arrive at B44" }, originalClock);
    await decideChange(pool, VIEWERS.approver, proposed.id, { decision: "approve", reason: "Evidence and brand agree; spend conserved", configHash: proposed.configHash, preflightHash: proposed.preflightHash! }, originalClock);
    const released = await releaseChange(pool, VIEWERS.marketing, proposed.id, originalClock);
    changeId = released.id;
    releasedAt = new Date(released.releasedAt!);
  }
});

test.afterAll(async () => {
  await setClock(originalClock);
  await pool.end();
});

test("verified at release, then a clean scheduled check, then a conflicting revision: confirmed drift, mapping untouched", async ({ page }) => {
  test.setTimeout(240_000);
  const slot1 = new Date(releasedAt.getTime() + 24 * HOUR + 5 * 60_000);
  const slot2 = new Date(releasedAt.getTime() + 48 * HOUR + 5 * 60_000);

  await setRole(page, "marketing");
  await page.goto(`/changes/${changeId}`);
  await expect(shown(page, "monitoring")).toHaveAttribute("data-state", "current");
  await expect(shown(page, "verified-at-release")).toContainText(dateTime(releasedAt.toISOString()));
  await expect(shown(page, "latest-check")).toContainText("No check has run yet.");
  await expect(shown(page, "next-check")).toContainText(dateTime(new Date(releasedAt.getTime() + 24 * HOUR).toISOString()));

  // Slot 1: the feed delivered, nothing contradicts the approval.
  await setClock(slot1);
  await deliverCalls([], new Date(slot1.getTime() - 60 * 60_000));
  expect(runWorkerOnce()).toContain(`"changeId":${changeId}`);
  await page.reload();
  await expect(shown(page, "monitoring")).toHaveAttribute("data-state", "current");
  await expect(shown(page, "latest-check")).toContainText(`Current · ${dateTime(slot1.toISOString())}`);
  await expect(shown(page, "last-verified")).toContainText(dateTime(slot1.toISOString()));
  await expect(shown(page, "verified-at-release")).toContainText(dateTime(releasedAt.toISOString()));

  // A revision of one of the campaign's calls: its tracking number now belongs to B39.
  const lead = (
    await pool.query<{ payload: Record<string, unknown> }>(
      "select r.payload from v_leads l join raw_events r on r.id = l.raw_event_id where l.campaign_external_id = 'lsa-B44-x' and l.effective_branch_id = 'B44' order by l.id limit 1",
    )
  ).rows[0];
  await deliverCalls([{ ...lead.payload, branch_tag: "B39", agent_note: "Tracking number moved to the Ridge office" }], new Date(slot1.getTime() + 6 * HOUR));
  const before = (await pool.query("select branch_id from campaign_branch_map m join ad_campaigns c on c.id = m.campaign_id where c.external_campaign_id = 'lsa-B44-x'")).rows;

  // Slot 2: the worker finds it.
  await setClock(slot2);
  expect(runWorkerOnce()).toContain('"outcome":"drift"');
  await page.reload();
  await expect(shown(page, "monitoring")).toHaveAttribute("data-state", "confirmed_drift");
  await expect(shown(page, "monitoring-state")).toContainText("Confirmed drift");
  await expect(shown(page, "latest-check")).toContainText(`Confirmed drift · ${dateTime(slot2.toISOString())}`);
  // The failed check did not refresh the last success; verified-at-release is unchanged.
  await expect(shown(page, "last-verified")).toContainText(dateTime(slot1.toISOString()));
  await expect(shown(page, "verified-at-release")).toContainText(dateTime(releasedAt.toISOString()));
  await expect(shown(page, "change-status")).toContainText("recovery required");
  await expect(shown(page, "q-after")).toContainText("B39");
  expect((await pool.query("select branch_id from campaign_branch_map m join ad_campaigns c on c.id = m.campaign_id where c.external_campaign_id = 'lsa-B44-x'")).rows).toEqual(before);
  expect(await axeViolations(page)).toEqual([]);

  // The review item, then the read-only evidence.
  await shown(page, "review-item").getByRole("link").click();
  await expect(page.getByRole("heading", { level: 1, name: "Mapping drift after release" })).toBeVisible();
  await page.getByTestId("drift-evidence-link").filter({ visible: true }).click();
  await expect(page).toHaveURL(new RegExp(`/changes/${changeId}/checks/\\d+$`));
  await expect(shown(page, "check-outcome")).toContainText("Confirmed drift");
  await expect(page.getByRole("region", { name: "Contradicting lead records" }).filter({ visible: true })).toContainText("B39");
  // Read-only: the evidence page offers no action on the change.
  await expect(page.locator("main").getByRole("button", { name: /Approve|Reject|Release|Re-verify|Re-run/ })).toHaveCount(0);
  expect(await axeViolations(page)).toEqual([]);
  const evidenceUrl = page.url();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(shown(page, "check-outcome")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
  await page.goto(`/changes/${changeId}`);
  await expect(shown(page, "monitoring")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
  await page.setViewportSize({ width: 1280, height: 800 });

  // Scope: the brand lead (B40–B44) reads the change and the evidence, but not B39's record.
  await setRole(page, "brand");
  await page.goto(evidenceUrl);
  await expect(page.getByText("Part of this evidence is outside your scope")).toBeVisible();
  await expect(page.locator("main")).not.toContainText("B39");
  await page.goto(`/changes/${changeId}`);
  await expect(shown(page, "monitoring")).toHaveAttribute("data-state", "confirmed_drift");
  await expect(shown(page, "q-after")).not.toContainText("B39");
  // The B20 partner cannot read this change or its evidence at all.
  await setRole(page, "partner");
  await page.goto(evidenceUrl);
  await expect(page.getByRole("heading", { name: /403/ })).toBeVisible();
});
