import { writeFileSync } from "node:fs";
import path from "node:path";
import { createPool } from "@/lib/db";
import { BRANCH_BY_ID } from "@/lib/reference";
import { generateWorld } from "@/lib/sim/world";

/**
 * public/samples/missed-calls-b01.csv: paid calls that a call-tracking export holds and the live
 * feed never delivered, for B01 Alder's October customers who have no lead record at all
 * (`v_acquisitions.attribution_basis = 'no_lead_record'`). Counted in a visitor's private copy
 * (lib/onboarding/preview.ts), they give those customers the paid search touch that brought them,
 * so B01's paid-media CAC and unattributed share move: a visitor's file changes that visitor's
 * dashboard. B01 is the branch the Overview tells a visitor to start with.
 *
 * Synthetic throughout. The customers and their phone numbers come from the seeded world
 * (lib/sim/world.ts: the same seed the hosted copy is loaded from); the calls are invented, each
 * two days before its customer's sale, inside the 60 days a first touch may precede it
 * (migration 0038). Read the customers from a database loaded like the hosted copy:
 *
 *   DATABASE_URL=postgres://postgres@127.0.0.1:54333/revenue_signal_rehearse npx tsx scripts/make-missed-calls.ts
 */

const BRANCH = "B01";
const OUT = path.join(process.cwd(), "public", "samples", "missed-calls-b01.csv");
const DAY = 86_400_000;
/**
 * The paid sources the calls came through, in turn: search, social, search, Bing. Each names its own
 * tracking number and the branch's campaign on that platform (gs-, fb-, ms-B01 in the seeded world).
 */
const PAID = [
  { source: "Google Ads", campaign: "gs", tracking: "(206) 555-0190" },
  { source: "Facebook", campaign: "fb", tracking: "(206) 555-0191" },
  { source: "Google Ads", campaign: "gs", tracking: "(206) 555-0190" },
  { source: "Bing", campaign: "ms", tracking: "(206) 555-0192" },
];

const pool = createPool(process.env.DATABASE_URL ?? "postgres://postgres@127.0.0.1:54333/revenue_signal_rehearse");

/** "(501) 555-0120": the CRM keeps phones in many layouts; a call-tracking export uses one. */
function usPhone(raw: string): string {
  const digits = raw.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
  if (digits.length !== 10) throw new Error(`not a 10-digit US phone: ${raw}`);
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

/** "10/03/2026 10:15 AM": the US layout the call-tracking sample uses. */
function usTime(at: Date): string {
  const h = at.getUTCHours();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(at.getUTCMonth() + 1)}/${pad(at.getUTCDate())}/${at.getUTCFullYear()} ${h % 12 === 0 ? 12 : h % 12}:${pad(at.getUTCMinutes())} ${h < 12 ? "AM" : "PM"}`;
}

async function main() {
  const customers = (
    await pool.query<{ crm_customer_id: string; sold_at: Date }>(
      `select crm_customer_id, sold_at from v_acquisitions
       where branch_id = $1 and attribution_basis = 'no_lead_record'
         and initial_completed_at >= '2026-10-01' and initial_completed_at < '2026-10-31'
       order by crm_customer_id`,
      [BRANCH],
    )
  ).rows;
  if (customers.length === 0) throw new Error(`${BRANCH} has no October customer without a lead record in this database`);

  // The CRM's own phone number for each customer: the latest version of its customer record.
  const phones = new Map<string, string>();
  for (const r of generateWorld().records) {
    if (r.entity === "customer" && typeof r.payload.customerID === "string" && typeof r.payload.phone1 === "string") phones.set(r.payload.customerID, r.payload.phone1);
  }

  const branch = BRANCH_BY_ID.get(BRANCH)!;
  const lines = ["Start Time,Company,Customer Phone Number,Tracking Phone Number,Source,Campaign,Duration (seconds),Call Status,Call Id,Note"];
  customers.forEach((c, i) => {
    const phone = phones.get(c.crm_customer_id);
    if (!phone) throw new Error(`customer ${c.crm_customer_id} has no phone in the seeded world`);
    // Two days before the sale, at a quarter past a morning hour: well inside the first-touch window
    // whichever time zone the visitor says the file is in.
    const at = new Date(Math.floor((c.sold_at.getTime() - 2 * DAY) / DAY) * DAY + (15 + (i % 4)) * 3_600_000 + 15 * 60_000);
    const paid = PAID[i % PAID.length];
    lines.push([usTime(at), branch.name, usPhone(phone), paid.tracking, paid.source, `${paid.campaign}-${BRANCH}`, String(90 + ((i * 37) % 180)), "Answered", `MISS${String(10001 + i)}`, ""].join(","));
  });
  writeFileSync(OUT, lines.join("\n") + "\n");
  console.log(`${OUT}: ${customers.length} calls for ${BRANCH} ${branch.name}`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
