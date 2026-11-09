import { createPool, DEFAULT_DATABASE_URL, getNow } from "@/lib/db";
import { resolveIdentities } from "@/lib/identity/resolve";

/**
 * Brings identity resolution up to date on an existing database without reseeding:
 * `npx tsx scripts/resolve-identities.ts` (DATABASE_URL overrides the demo database).
 *
 * Additive and idempotent: it creates or updates identities, links and conflicts only — it
 * never touches source projections, metrics or reviewer decisions. Runs at the business clock
 * (app_clock), so the demo stays reproducible. Prints the stats and the ambiguity counts that
 * decide how much reviewer work the data needs.
 */
async function main() {
  const pool = createPool(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  try {
    const now = await getNow(pool);
    const stats = await resolveIdentities(pool, now, { log: (line) => console.log(line) });
    console.log(JSON.stringify(stats, null, 2));
    const { rows } = await pool.query<{ shared_phone_customers: string; multi_match_leads: string; disagreements: string }>(
      `with cand as (
         select l.id as lead_id, c.crm_customer_id, l.phone_hash = c.phone_hash as via_phone, l.email_hash = c.email_hash as via_email
         from leads l join crm_customers c on c.phone_hash = l.phone_hash or c.email_hash = l.email_hash
       ), per_lead as (
         select lead_id, count(distinct crm_customer_id) filter (where via_phone) as by_phone,
                count(distinct crm_customer_id) filter (where via_email) as by_email,
                count(distinct crm_customer_id) as total
         from cand group by lead_id
       )
       select (select count(*) from (select phone_hash from crm_customers where phone_hash is not null
                                     group by phone_hash having count(*) > 1) s) as shared_phone_customers,
              (select count(*) from per_lead where by_phone > 1 or (by_phone = 0 and by_email > 1)) as multi_match_leads,
              (select count(*) from per_lead where by_phone = 1 and total > 1) as disagreements`,
    );
    console.log(
      `ambiguity in this data: ${rows[0].shared_phone_customers} phone hashes shared by >1 CRM customer, ` +
        `${rows[0].multi_match_leads} leads matching >1 CRM customer, ${rows[0].disagreements} leads whose phone and email point at different customers`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
