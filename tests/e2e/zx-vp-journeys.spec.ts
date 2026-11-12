import { expect, test, type Page } from "@playwright/test";
import type { Pool } from "pg";
import { createPool, DEFAULT_DATABASE_URL, getNow } from "../../lib/db";
import { PERIODS } from "../../lib/period";
import { crm, ingest } from "../helpers";
import { setRole } from "./action-center";

/**
 * VP war room, phase 3: browser journeys that check what was PERSISTED, not only what was shown
 * (docs/agent-work/vp-acceptance/BRIEF.md). Each journey drives the production pages and then
 * reads the database directly to confirm the effect, or the absence of one.
 *
 *   J2  finance controller: B09's collected cash equals an independent reference computed from
 *       the raw source payloads (not from the product's projected tables or its queries).
 *   J3  wrong premise: "Why did paid CAC increase?" for a branch whose CAC fell is answered as a
 *       false premise; re-testing keeps version 1 and stores version 2; a note persists.
 *   J5  source correction: a refund arrives from the CRM; the cash figure drops by exactly the
 *       refund, still reproduces from records and still equals the reference; redelivering the
 *       same refund changes nothing.
 *   J6  scope and permission: out-of-scope reads and writes are refused, and nothing is stored.
 *   J8  executive decision: Decision Lab readiness → a projection that stores nothing → a saved,
 *       audited scenario.
 *
 * Named zx- so it runs after the read-only z- specs and before zy-/zz-: J5 adds a refund at
 * B09 (zz-b09 reseeds before it reads B09; zy- reads only B44).
 */

const OCT = PERIODS.oct;
const CASH_TRACE = "/branches/B09/trace?period=oct&metric=collected";

async function withPool<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
  const pool = createPool(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

const count = (sql: string, params: unknown[] = []) => withPool(async (pool) => Number((await pool.query(sql, params)).rows[0].n));

/**
 * Collected cash from the RAW source payloads, written independently of lib/lineage/cash.ts and
 * lib/metrics/scorecard.ts: per CRM payment id the most recently delivered version wins (payments
 * carry no dateUpdated; their version is ordered by receipt), status "1" is successful, the
 * office's wall-time date is read in the branch's timezone, and amounts are decimal dollars.
 */
async function referenceCollectedCents(branchId: string): Promise<{ cents: number; records: number }> {
  return withPool(async (pool) => {
    const { rows } = await pool.query(
      `with latest as (
         select distinct on (entity_id) entity_id, payload
         from raw_events
         where source = 'crm' and entity = 'payment' and status <> 'quarantined'
         order by entity_id, last_delivered_at desc, id desc)
       select coalesce(sum(round((l.payload->>'amount')::numeric * 100)), 0)::bigint as cents, count(*)::int as records
       from latest l join branches b on b.crm_office_id = (l.payload->>'officeID')::int
       where b.id = $1 and l.payload->>'status' = '1'
         and ((l.payload->>'date')::timestamp at time zone b.timezone) >= $2
         and ((l.payload->>'date')::timestamp at time zone b.timezone) < $3`,
      [branchId, OCT.from, OCT.to],
    );
    return { cents: Number(rows[0].cents), records: rows[0].records };
  });
}

/** "$18,239.00" → 1823900. */
const cents = (text: string) => Math.round(Number(text.replace(/[$,\s]/g, "")) * 100);

async function shownCollected(page: Page): Promise<number> {
  await page.goto(CASH_TRACE);
  await expect(page.getByTestId("cash-reproduced")).toBeVisible();
  return cents((await page.getByTestId("cash-collected").textContent())!);
}

test.describe.configure({ mode: "serial" });

test("J2 · collected cash equals an independent reference computed from the raw payloads", async ({ page }) => {
  await setRole(page, "approver");
  const shown = await shownCollected(page);
  const reference = await referenceCollectedCents("B09");
  expect(reference.records).toBeGreaterThan(0);
  expect(shown).toBe(reference.cents);

  // The branch scorecard tile shows the same figure and links to the trace.
  await page.goto("/branches/B09?period=oct");
  const tile = page.getByTestId("trace-link-collected");
  await expect(tile).toBeVisible();
  await tile.click();
  await expect(page).toHaveURL(/metric=collected/);
  expect(cents((await page.getByTestId("cash-collected").textContent())!)).toBe(shown);
});

test("J3 · a false premise is answered as one, and every re-test is kept", async ({ page }) => {
  test.setTimeout(120_000);
  await setRole(page, "marketing");
  const before = await count("select count(*) as n from inquiries where branch_id = 'B09'");

  await page.goto("/investigator?branch=B09");
  const open = page.getByTestId("open-inquiry");
  await expect(open.getByRole("combobox")).toHaveValue("B09");
  await open.getByRole("button", { name: "Why did paid CAC increase?" }).click();
  await expect(page).toHaveURL(/\/investigator\/inquiries\/\d+$/, { timeout: 60_000 });
  const id = Number(page.url().split("/").pop());

  // B09's paid CAC fell from September to October in the demo: there is no increase to explain.
  await expect(page.getByTestId("inquiry-conclusion")).toContainText("It did not increase, so there is no increase to explain.");
  await expect(page.getByText("version 1", { exact: false }).first()).toBeVisible();
  expect(await count("select count(*) as n from inquiries where branch_id = 'B09'")).toBe(before + 1);

  const actions = page.getByTestId("inquiry-actions");
  await actions.getByRole("button", { name: /Re-test/ }).click();
  await expect(actions).toContainText("Re-tested: version 2.", { timeout: 60_000 });
  await actions.getByRole("textbox").fill("Premise false; checked against the September trace.");
  await actions.getByRole("button", { name: /Add note/ }).click();
  await expect(actions).toContainText("Note added.");

  expect(await count("select count(*) as n from inquiry_versions where inquiry_id = $1", [id])).toBe(2);
  expect(await count("select count(*) as n from inquiry_notes where inquiry_id = $1 and text like 'Premise false%'", [id])).toBe(1);
});

test("J5 · a CRM refund lowers collected cash by exactly its amount, and a redelivery changes nothing", async ({ page }) => {
  test.setTimeout(120_000);
  await setRole(page, "approver");
  const before = await shownCollected(page);

  const refundId = 990_901;
  const original = await withPool(async (pool) => {
    const { rows } = await pool.query(
      `select p.crm_payment_id, p.crm_customer_id, p.crm_ticket_id from crm_payments p join branches b on b.crm_office_id = p.office_id
       where b.id = 'B09' and p.status = 'successful' and p.amount_cents >= 5000 and p.paid_at >= $1 and p.paid_at < $2
         and not exists (select 1 from crm_payments r where r.original_payment_id = p.crm_payment_id)
       order by p.crm_payment_id limit 1`,
      [OCT.from, OCT.to],
    );
    return rows[0] as { crm_payment_id: string; crm_customer_id: string; crm_ticket_id: string };
  });
  expect(original).toBeTruthy();
  const refund = crm.payment(
    refundId,
    Number(original.crm_customer_id),
    Number(original.crm_ticket_id),
    "B09",
    "-25.00",
    new Date("2026-10-20T15:00:00Z"),
    "1",
    String(original.crm_payment_id),
  );

  // Through the product's own write path, as the CRM connector would deliver it.
  await withPool(async (pool) => ingest(pool, "crm", [refund], { now: await getNow(pool) }));
  const afterRefund = await shownCollected(page);
  expect(afterRefund).toBe(before - 2_500);
  expect(afterRefund).toBe((await referenceCollectedCents("B09")).cents);
  // Every record is listed: the first 25 in the table, the rest one click further.
  const folded = page.getByText(/^Show the other \d+ record\(s\)$/);
  if (await folded.count()) await folded.click();
  const row = page.locator("tr", { hasText: String(refundId) });
  await expect(row).toBeVisible();
  await expect(row).toContainText("refund");
  await expect(row).toContainText(`of ${original.crm_payment_id}`);
  await expect(row).toContainText("−$25.00");

  // The same delivery again: absorbed as a redelivery, not a second refund.
  await withPool(async (pool) => ingest(pool, "crm", [refund], { now: await getNow(pool) }));
  expect(await shownCollected(page)).toBe(afterRefund);
  expect(await count("select count(*) as n from crm_payments where crm_payment_id = $1", [refundId])).toBe(1);
  expect(await count("select max(delivery_count) as n from raw_events where source = 'crm' and entity = 'payment' and entity_id = $1", [String(refundId)])).toBe(2);
});

test("J6 · out-of-scope reads and writes are refused, and nothing is stored", async ({ page }) => {
  // The branch partner and the brand lead cannot see B09.
  for (const role of ["partner", "brand"] as const) {
    await setRole(page, role);
    await page.goto(CASH_TRACE);
    // Next's own route announcer is also role="alert": take the one that says 403.
    await expect(page.getByRole("alert").filter({ hasText: "403 — not in your scope" })).toBeVisible();
    await expect(page.getByTestId("cash-collected")).toHaveCount(0);

    const inquiries = await count("select count(*) as n from inquiries");
    const res = await page.request.post("/api/inquiries", { data: { kind: "cac_change", branchId: "B09" } });
    expect(res.status()).toBe(403);
    expect(await count("select count(*) as n from inquiries")).toBe(inquiries);
  }

  // A read-only guest cannot save a scenario or decide a proposal.
  await setRole(page, "guest");
  const scenarios = await count("select count(*) as n from decision_scenarios");
  const save = await page.request.post("/api/decisions/scenarios", {
    data: { branchId: "B09", period: "oct", changes: [{ fromChannel: "google_search", toChannel: "google_lsa", amountCents: 10_000 }], save: true },
  });
  expect(save.status()).toBe(403);
  expect(await count("select count(*) as n from decision_scenarios")).toBe(scenarios);

  const proposalId = await count("select coalesce(min(id), 1) as n from action_proposals");
  const approvals = await count("select count(*) as n from action_approvals");
  const decide = await page.request.post(`/api/proposals/${proposalId}`, { data: { action: "approve", reason: "guest should not be able to approve this" } });
  expect([403, 404]).toContain(decide.status());
  expect(await count("select count(*) as n from action_approvals")).toBe(approvals);
});

test("J8 · an executive reads verified readiness, projects without storing, then saves an audited scenario", async ({ page }) => {
  test.setTimeout(120_000);
  await setRole(page, "marketing");
  await page.goto("/?period=oct");
  await expect(page.locator("main")).toContainText("new customers whose first evidenced touch was paid)");

  await page.goto("/decisions?branch=B09&period=oct");
  await expect(page.getByTestId("verified-readiness").locator("li").first()).toBeVisible({ timeout: 30_000 });

  const form = page.getByTestId("scenario-form");
  // While B09's budget signal is gated nothing is preselected and both actions are disabled.
  await expect(form).toContainText("Choose the two channels to compare.");
  await expect(form.getByRole("button", { name: "Run projection" })).toBeDisabled();
  // A select inside its <label> takes the selected option into its name: address them in order.
  const [from, to] = [form.getByRole("combobox").nth(0), form.getByRole("combobox").nth(1)];
  await from.selectOption({ index: 1 });
  await to.selectOption({ index: 2 });
  await form.getByLabel("Amount per month (USD)").fill("100");

  const scenarios = await count("select count(*) as n from decision_scenarios where branch_id = 'B09'");
  await form.getByRole("button", { name: "Run projection" }).click();
  await expect(page.getByText("Nothing is stored until you save.")).toHaveCount(0, { timeout: 30_000 });
  expect(await count("select count(*) as n from decision_scenarios where branch_id = 'B09'")).toBe(scenarios);

  await form.getByRole("button", { name: "Save scenario" }).click();
  const status = form.getByRole("status");
  await expect(status).toContainText(/Saved as scenario #\d+ \(audited\)\./, { timeout: 30_000 });
  const id = Number((await status.textContent())!.match(/#(\d+)/)![1]);
  expect(await count("select count(*) as n from decision_scenarios where id = $1 and branch_id = 'B09' and actor = 'marketing'", [id])).toBe(1);
  expect(await count("select count(*) as n from audit_log where action = 'save_scenario' and subject = $1 and actor = 'marketing'", [`decision_scenario:${id}`])).toBe(1);
});
