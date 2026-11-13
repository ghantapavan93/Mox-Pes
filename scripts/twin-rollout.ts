import { createChange } from "@/lib/changeguard/service";
import { NewChangeSchema } from "@/lib/changeguard/model";
import { createPool, DEFAULT_DATABASE_URL } from "@/lib/db";
import { migrate } from "@/lib/migrate";
import { superviseEvaluation } from "@/lib/twin/runner";
import { isVariant, VARIANTS } from "@/lib/twin/scenario";
import { createEvaluation } from "@/lib/twin/store";
import { databaseName } from "@/lib/twin/world";
import { VIEWERS } from "@/lib/viewer";

/**
 * Runs one Reliability Twin evaluation of the calls@1.2 rollout against the application database
 * named by DATABASE_URL (the control plane; the simulation runs in its own twin database).
 *
 *   npm run twin -- [--variant standard|scope_leak|source_outage] [--change <id>] [--no-interruptions]
 *
 * Without --change it reuses the latest calls source-contract change, or proposes one through
 * ChangeGuard (createChange: the production path, preflight included).
 */

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

export const CALLS_UPGRADE_CHANGE = NewChangeSchema.parse({
  kind: "source_contract",
  reason: "Roll out calls@1.2: outbound, spam and not-a-lead calls are excluded instead of counted as leads (VENDOR-CONTRACTS C-3)",
  payload: {
    source: "calls",
    entity: "call",
    samples: [
      { id: "SAMPLE-1", branch_tag: "B12", start_time: "2026-10-20T15:00:00Z", tracking_phone_number: "+18885550100", source: "Google Ads", gclid: null, campaign: null, agent_note: null, customer_phone_number: "+14805551000", direction: "inbound", lead_status: "good_lead" },
      { id: "SAMPLE-2", branch_tag: "B12", start_time: "2026-10-20T16:00:00Z", tracking_phone_number: "+18885550100", source: "Google Ads", gclid: null, campaign: null, agent_note: null, customer_phone_number: "+14805551001", direction: "outbound" },
      { id: "SAMPLE-3", branch_tag: "B12", start_time: "2026-10-20T17:00:00Z", tracking_phone_number: "+18885550100", source: "Facebook", gclid: null, campaign: null, agent_note: null, customer_phone_number: "+14805551002", spam: true },
    ],
  },
});

async function main() {
  const url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const variant = arg("variant") ?? "standard";
  if (!isVariant(variant)) throw new Error(`--variant must be one of ${Object.keys(VARIANTS).join(", ")}`);
  const control = createPool(url);
  let evaluationId: number;
  try {
    await migrate(control);
    let changeId = arg("change") ? Number(arg("change")) : null;
    if (changeId === null) {
      const existing = await control.query<{ id: string }>("select id from config_changes where kind = 'source_contract' and payload ->> 'source' = 'calls' order by id desc limit 1");
      changeId = existing.rows[0] ? Number(existing.rows[0].id) : (await createChange(control, VIEWERS.marketing, CALLS_UPGRADE_CHANGE)).id;
    }
    evaluationId = await createEvaluation(control, VIEWERS.engineer, { changeId, variant, controlDatabase: databaseName(url), now: new Date() });
    console.log(`change ${changeId}: evaluation ${evaluationId} (${VARIANTS[variant].label})`);
  } finally {
    await control.end();
  }
  const started = Date.now();
  const ev = await superviseEvaluation(url, evaluationId, { mainUrl: url, interruptions: !process.argv.includes("--no-interruptions"), log: (line) => console.log(line) });
  console.log(`\n${ev.status} in ${Math.round((Date.now() - started) / 1000)} s · twin ${ev.twinDatabase}${ev.error ? ` · ${ev.error}` : ""}`);
  for (const s of ev.stages) {
    console.log(`  ${s.key} ${s.label.padEnd(12)} ${s.status.padEnd(10)} ${s.violated.length ? `failed ${s.violated.join(", ")}` : ""}`);
    for (const g of s.gates) console.log(`      ${g.status === "pass" ? "✓" : g.status === "fail" ? "✗" : "–"} ${g.id.padEnd(3)} ${g.detail.slice(0, 220)}`);
    if (s.recovery) console.log(`      recovery: ${JSON.stringify(s.recovery).slice(0, 400)}`);
    if (Object.keys(s.metrics).length) console.log(`      metrics: ${JSON.stringify(s.metrics)}`);
  }
  process.exitCode = ev.status === "ERROR" ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
