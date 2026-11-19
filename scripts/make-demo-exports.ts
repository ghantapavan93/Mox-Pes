import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createPool } from "@/lib/db";
import { instantToWallTime } from "@/lib/primitives";
import { BRANCH_BY_OFFICE } from "@/lib/reference";

/**
 * npm run demo:exports — writes the synthetic exports the /onboarding samples offer
 * (public/samples/), derived from the SEEDED demo ledger so a reconciliation finds real
 * records, plus deliberate, documented disagreements:
 *
 *   demo-crm-payments.csv   25 of the ledger's payments for two offices, as a CRM export would
 *                           show them, except: one amount $20.00 higher, one payment voided in
 *                           the file but successful in the ledger, one payment left out (the
 *                           ledger has it, the file does not), one payment the ledger has never
 *                           seen, and three rows a spreadsheet damaged (padded id, scientific
 *                           notation, an impossible date). It also carries the invoice "Total"
 *                           and a "Contract Value" column, which must never be read as cash.
 *   demo-google-ads.csv     Three days of two real campaigns, one day's cost restated, with the
 *                           report's title lines and total rows.
 *   demo-calls.csv          The held-out call export with its dates moved into the demo period.
 *
 * Deterministic: the same seeded database gives the same files.
 */
const OUT = path.join(process.cwd(), "public", "samples");
const pool = createPool(process.env.DATABASE_URL ?? "postgres://postgres@127.0.0.1:54333/revenue_signal");

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const line = (cells: string[]) => cells.map(csvCell).join(",");
const usd = (cents: number) => {
  const s = `$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return cents < 0 ? `(${s.slice(1)})` : s;
};
const mdY = (wall: string) => `${wall.slice(5, 7)}/${wall.slice(8, 10)}/${wall.slice(0, 4)}`;

async function payments() {
  const rows = (
    await pool.query<{ crm_payment_id: string; crm_customer_id: string; office_id: number; crm_ticket_id: string | null; amount_cents: string; status: string; paid_at: Date; original_payment_id: string | null; total_cents: string | null }>(
      `select p.crm_payment_id, p.crm_customer_id, p.office_id, p.crm_ticket_id, p.amount_cents, p.status, p.paid_at, p.original_payment_id, t.total_cents
       from crm_payments p left join crm_tickets t on t.crm_ticket_id = p.crm_ticket_id
       where p.office_id in (105, 131) and p.paid_at >= '2026-10-20' and p.paid_at < '2026-10-28'
       order by p.paid_at, p.crm_payment_id limit 26`,
    )
  ).rows;
  if (rows.length < 26) throw new Error(`Expected 26 seeded payments, found ${rows.length}: run npm run db:seed first`);
  const out = [line(["Payment #", "Cust #", "Office", "Ticket #", "Net Paid", "Total", "Contract Value", "Status", "Date Paid", "Original Payment #", "Payment Method"])];
  const notes: string[] = [];
  rows.forEach((r, i) => {
    if (i === 7) {
      notes.push(`left out: payment ${r.crm_payment_id} (the ledger has it; the file does not)`);
      return;
    }
    const zone = BRANCH_BY_OFFICE.get(r.office_id)!.timezone;
    let amount = Number(r.amount_cents);
    let status = r.status;
    let customer = r.crm_customer_id;
    let date = mdY(instantToWallTime(r.paid_at, zone));
    if (i === 3) {
      amount += 2_000;
      notes.push(`amount differs: payment ${r.crm_payment_id} is $20.00 higher in the file`);
    }
    if (i === 5 && status === "successful") {
      status = "voided";
      notes.push(`status differs: payment ${r.crm_payment_id} is voided in the file, successful in the ledger`);
    }
    if (i === 10) {
      customer = `00${customer}`;
      notes.push(`damaged: payment ${r.crm_payment_id} has a zero-padded customer id`);
    }
    if (i === 12) {
      customer = "1.23457E+17";
      notes.push(`damaged: payment ${r.crm_payment_id} has a customer id rounded into scientific notation`);
    }
    if (i === 14) {
      date = "02/30/2026";
      notes.push(`damaged: payment ${r.crm_payment_id} has an impossible date`);
    }
    const total = r.total_cents === null ? "" : usd(Number(r.total_cents));
    const contract = usd((Number(r.total_cents ?? r.amount_cents) * 4) | 0);
    out.push(line([r.crm_payment_id, customer, String(r.office_id), r.crm_ticket_id ?? "", usd(amount), total, contract, status, date, r.original_payment_id ?? "", i % 3 === 0 ? "ACH" : "Card"]));
  });
  const last = rows[rows.length - 1];
  out.push(line(["990001", last.crm_customer_id, String(last.office_id), "", "$59.00", "$59.00", "$236.00", "successful", mdY(instantToWallTime(last.paid_at, BRANCH_BY_OFFICE.get(last.office_id)!.timezone)), "", "Card"]));
  notes.push("not in ledger: payment 990001");
  writeFileSync(path.join(OUT, "demo-crm-payments.csv"), out.join("\n") + "\n");
  return notes;
}

async function spend() {
  const rows = (
    await pool.query<{ ad_account_id: string; external_campaign_id: string; name: string; d: string; cost_cents: string; clicks: number; platform_conversions: number }>(
      `select c.ad_account_id, c.external_campaign_id, c.name, to_char(s.spend_date, 'YYYY-MM-DD') as d, s.cost_cents, s.clicks, s.platform_conversions
       from ad_spend_daily s join ad_campaigns c on c.id = s.campaign_id
       where c.id in (select id from ad_campaigns where platform = 'google_ads' order by id limit 2) and s.spend_date between '2026-10-20' and '2026-10-22'
       order by s.spend_date, c.external_campaign_id`,
    )
  ).rows;
  const out = ["Campaign report", "\"October 20, 2026 - October 22, 2026\"", line(["Day", "Campaign", "Campaign ID", "Campaign status", "Currency code", "Clicks", "Cost", "Conversions"])];
  let total = 0;
  let clicks = 0;
  const notes: string[] = [`account: ${rows[0]?.ad_account_id}`];
  rows.forEach((r, i) => {
    let cost = Number(r.cost_cents);
    if (i === 2) {
      cost += 1_250;
      notes.push(`restated: ${r.external_campaign_id} on ${r.d} costs $12.50 more in the file`);
    }
    total += cost;
    clicks += r.clicks;
    out.push(line([r.d, r.name, r.external_campaign_id, "Enabled", "USD", String(r.clicks), (cost / 100).toLocaleString("en-US", { minimumFractionDigits: 2 }), `${r.platform_conversions}.00`]));
  });
  out.push(line(["Total: Account", "", "", "", "USD", String(clicks), (total / 100).toLocaleString("en-US", { minimumFractionDigits: 2 }), ""]));
  writeFileSync(path.join(OUT, "demo-google-ads.csv"), out.join("\n") + "\n");
  return notes;
}

function calls() {
  const src = readFileSync(path.join(process.cwd(), "tests", "fixtures", "onboarding", "holdout", "callrail-style-export.csv"), "utf8");
  // Into the demo period, on days with no daylight-saving change.
  const shifted = src.replace(/11\/03\/2026/g, "10/20/2026").replace(/11\/04\/2026/g, "10/21/2026").replace(/CAL100(\d\d)/g, "DEMO100$1");
  writeFileSync(path.join(OUT, "demo-calls.csv"), shifted);
  return ["the held-out call export, moved to Oct 20-21 2026 with DEMO ids"];
}

async function main() {
  const notes = {
    payments: await payments(),
    spend: await spend(),
    calls: calls(),
    "missed calls": ["paid calls for B01 Alder's October customers who have no lead record, made by `npm run demo:missed-calls` (scripts/make-missed-calls.ts); counted in a private copy, they move B01's paid-media CAC"],
  };
  writeFileSync(path.join(OUT, "README.md"), `# Demo exports (synthetic)\n\nGenerated by \`npm run demo:exports\` from the seeded demo ledger. Deliberate differences:\n\n${Object.entries(notes).map(([k, v]) => `## ${k}\n\n${v.map((n) => `- ${n}`).join("\n")}`).join("\n\n")}\n`);
  console.log(JSON.stringify(notes, null, 2));
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
