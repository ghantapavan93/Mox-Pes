// The decision boundary on the recorded B03 cases (exp-n1 C, D, E, R; ../n1-rerun/) and the new
// controls, each in its own rolled-back transaction on revenue_signal_audit_dm. For every case it
// prints what each surface says: the branch card, the Decision Lab note, readiness and scenarios,
// the builder's preselected move and the Overview's holds. Run once on the code before the change
// and once after; the printer reads new fields only where they exist.
//
// Usage (from the repo): npx tsx docs/agent-work/product-audit/harness/boundary/cases.mts [case ...]
//   cases: R D C E RDfix Z S (default: all)
import { createHash } from "node:crypto";
import { deliverAds, inRollback, mod, money, octDays, settle, storedPayload } from "./common.mjs";

const X = "B03"; // the recorded branch (trustworthy in October, most Meta customers)
const CONTROL = "B04"; // shares META-1 (Meta) and GA-WEST (Search) with B03; its own Local Services account

async function view(db: any, branch: string) {
  const { budgetSignal, decisionHolds } = await mod("lib/metrics/decision.ts");
  const decision = await mod("lib/metrics/decision.ts");
  const copyMod = await mod("lib/decision/signal-copy.ts");
  const { decisionVerdicts } = await mod("lib/decision/verdicts.ts");
  const { scenario, DEFAULT_ASSUMPTIONS } = await mod("lib/decision/scenario.ts");
  const { PERIODS } = await mod("lib/period.ts");
  const { VIEWERS } = await mod("lib/viewer.ts");
  const period = PERIODS.oct;
  const viewer = VIEWERS.marketing;
  const s = await budgetSignal(db, branch, { from: period.from, to: period.to });
  const copy = copyMod.budgetSignalCopy(s, branch, "oct");
  const v = await decisionVerdicts(db, viewer, { branchId: branch, period });
  const lines: string[] = [];
  lines.push(`card.gate: ${copy.gate.label}`);
  lines.push(`card.headline: ${copy.headline}`);
  if (copy.blocked) lines.push(`card.blocked: ${copy.blocked}`);
  if (copy.invalid) lines.push(`card.invalid: ${copy.invalid}`);
  if (copy.decision) lines.push(`card.decision: [${copy.decision.tone}] ${copy.decision.label}: ${copy.decision.text}`);
  for (const e of copy.excluded ?? []) lines.push(`card.excluded: ${e}`);
  for (const l of copy.limitations ?? []) lines.push(`card.limitation: ${l}`);
  for (const c of s.channels) {
    const el = s.eligibility?.find((x: any) => x.channelCode === c.channelCode);
    lines.push(`card.row: ${c.label} | ${money(c.spendCents)} | ${c.acquired} | ${money(c.cacCents)}${el?.reasons?.length ? ` | ${el.reasons.map((r: any) => r.code).join(",")}` : ""}`);
  }
  // Decision Lab: the note beside the verdicts, and the move the builder preselects.
  const note = copyMod.budgetSignalNote
    ? copyMod.budgetSignalNote(v.budgetSignal)
    : `${s.signal === "shift" && s.from && s.to ? `Budget signal: ${s.from.label} costs ${s.ratio.toFixed(1)}× ${s.to.label} per customer` : "Budget signal: no shift signalled"} · ${s.trustworthy ? "gate open" : "gated"}`;
  lines.push(`lab.note: ${typeof note === "string" ? note : `${note.text} · ${note.badge}`}`);
  const withSpend = v.channels.filter((c: any) => c.spendCents > 0).sort((a: any, b: any) => b.spendCents - a.spendCents);
  const preselect = copyMod.builderDefaults
    ? copyMod.builderDefaults(v.budgetSignal, withSpend.map((c: any) => c.channelCode))
    : !s.trustworthy
      ? { from: "", to: "" }
      : s.signal === "shift" && s.from
        ? { from: s.from.channelCode, to: s.to.channelCode }
        : { from: withSpend[0]?.channelCode ?? "", to: withSpend[1]?.channelCode ?? "" };
  lines.push(`lab.builder: ${preselect.from || "(none)"} → ${preselect.to || "(none)"}`);
  for (const c of v.channels) {
    const fails = c.readiness.blockers;
    const codes = [...new Set(fails.map((b: any) => b.code))].join(",");
    const special = fails.filter((b: any) => !["budget_gate", "min_customers", "freshness"].includes(b.code)).map((b: any) => b.text);
    lines.push(`lab.readiness: ${c.label} = ${c.readiness.status}${codes ? ` [${codes}]` : ""}${special.length ? ` — ${special.join(" | ")}` : ""}`);
  }
  for (const [from, to] of [["google_search", "meta"], ["google_search", "google_lsa"]]) {
    try {
      const r = await scenario(db, viewer, { branchId: branch, period: "oct", changes: [{ fromChannel: from, toChannel: to, amountCents: 50_000 }], assumptions: DEFAULT_ASSUMPTIONS });
      lines.push(`lab.scenario ${from}→${to}: decisionReady=${r.decisionReady} blockers=[${r.blockers.map((b: any) => b.code).join(",")}]${r.warnings.length ? ` warnings: ${r.warnings.join(" | ")}` : ""}`);
    } catch (e: any) {
      lines.push(`lab.scenario ${from}→${to}: refused ${e.status ?? ""}: ${e.message}`);
    }
  }
  const holds = await decisionHolds(db, [branch], 8, period);
  lines.push(`overview.incidentHolds: ${holds.length ? holds.map((h: any) => `#${h.exceptionId} ${h.kind}${h.refusedRevision ? " (refused revision)" : ""}`).join("; ") : "none"}`);
  if (decision.evidenceHolds) {
    const ev = await decision.evidenceHolds(db, [branch], period);
    lines.push(`overview.evidenceHolds: ${ev.length ? ev.map((h: any) => `[${h.code}] ${h.summary}`).join("; ") : "none"}`);
  }
  return lines;
}

async function ledger(db: any) {
  const { rows } = await db.query(
    `select (select coalesce(sum(cost_cents), 0) from ad_spend_daily) as spend, (select count(*) from ad_spend_daily) as days,
            (select coalesce(sum(amount_cents), 0) from crm_payments where status = 'successful') as collected`,
  );
  return `ledger: spend ${money(Number(rows[0].spend))} over ${rows[0].days} campaign-days; collected ${money(Number(rows[0].collected))}`;
}

const show = (label: string, lines: string[]) => console.log(`\n--- ${label}\n${lines.join("\n")}`);
const digest = (lines: string[]) => createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 12);
async function control(db: any, label: string, before: string[]) {
  const after = await view(db, CONTROL);
  console.log(`\n--- ${label}: ${CONTROL} control ${digest(before) === digest(after) ? `identical to before the case (${digest(after)})` : "CHANGED"}`);
  if (digest(before) !== digest(after)) show(`${CONTROL} after`, after);
}

const cases: Record<string, () => Promise<void>> = {
  // R: one person revokes B03's Local Services currency rule: all of its spend is excluded at intake.
  R: () =>
    inRollback(async (tx, pool) => {
      const b4 = await view(tx, CONTROL);
      const { revokeCurrencyRule } = await mod("lib/currency/rules.ts");
      const { VIEWERS } = await mod("lib/viewer.ts");
      const rule = (await tx.query("select id from currency_rules where platform = 'google_lsa' and ad_account_id = $1", [`LSA-${X}`])).rows[0];
      const now = new Date("2026-10-31T13:40:00Z");
      console.log("\nR revoke:", JSON.stringify(await revokeCurrencyRule(pool, VIEWERS.engineer, { ruleId: Number(rule.id), reason: "audit: account currency not confirmed", now })));
      await settle(pool, now);
      console.log(await ledger(tx));
      show(`R: ${X} after the Local Services rule is revoked`, await view(tx, X));
      await control(tx, "R", b4);
    }),
  // D: a refused newer revision of B03's Meta spend on Oct 20 (CAD, 3× the amount); META-1 is shared.
  D: () =>
    inRollback(async (tx, pool) => {
      const b4 = await view(tx, CONTROL);
      const p = await storedPayload(tx, `fb-${X}`, "2026-10-20");
      await deliverAds(pool, [{ ...p, fetchedAt: "2026-10-31T13:20:00Z", currencyCode: "CAD", costMicros: String(BigInt(String(p.costMicros)) * 3n) }], "2026-10-31T13:25:00Z");
      console.log(await ledger(tx));
      show(`D: ${X} with a refused revision of Meta on Oct 20`, await view(tx, X));
      await control(tx, "D (same META-1 account)", b4);
    }),
  // C: every October Meta day is re-sent stating an account with no currency rule: all excluded.
  C: () =>
    inRollback(async (tx, pool) => {
      const recs = [];
      for (const d of octDays()) recs.push({ ...(await storedPayload(tx, `fb-${X}`, d)), accountId: "META-2", fetchedAt: "2026-10-31T13:20:00Z" });
      await deliverAds(pool, recs, "2026-10-31T13:25:00Z");
      console.log(await ledger(tx));
      show(`C: ${X} with all October Meta spend excluded`, await view(tx, X));
    }),
  // E: D, then a newer revision of Oct 20 that states an account with no rule: the refused-revision
  // incident resolves ("no longer counted"), and Oct 20 is left with no counted amount (held).
  E: () =>
    inRollback(async (tx, pool) => {
      const p = await storedPayload(tx, `fb-${X}`, "2026-10-20");
      await deliverAds(pool, [{ ...p, fetchedAt: "2026-10-31T13:20:00Z", currencyCode: "CAD", costMicros: String(BigInt(String(p.costMicros)) * 3n) }], "2026-10-31T13:25:00Z");
      await deliverAds(pool, [{ ...p, fetchedAt: "2026-10-31T13:30:00Z", accountId: "META-2" }], "2026-10-31T13:35:00Z");
      const q = await tx.query("select id, status, resolution from exceptions where kind = 'quarantined_source_records' and branch_id = $1", [X]);
      console.log("\nE incident:", JSON.stringify(q.rows));
      console.log(await ledger(tx));
      show(`E: ${X} after the refused revision is superseded by an excluded one`, await view(tx, X));
    }),
  // RDfix: R and D together, then an accepted newer revision of Oct 20 corrects D only.
  RDfix: () =>
    inRollback(async (tx, pool) => {
      const { revokeCurrencyRule } = await mod("lib/currency/rules.ts");
      const { VIEWERS } = await mod("lib/viewer.ts");
      const rule = (await tx.query("select id from currency_rules where platform = 'google_lsa' and ad_account_id = $1", [`LSA-${X}`])).rows[0];
      await revokeCurrencyRule(pool, VIEWERS.engineer, { ruleId: Number(rule.id), reason: "audit: account currency not confirmed", now: new Date("2026-10-31T13:10:00Z") });
      const p = await storedPayload(tx, `fb-${X}`, "2026-10-20");
      await deliverAds(pool, [{ ...p, fetchedAt: "2026-10-31T13:20:00Z", currencyCode: "CAD", costMicros: String(BigInt(String(p.costMicros)) * 3n) }], "2026-10-31T13:25:00Z");
      show(`RDfix 1: ${X} with Local Services held and a refused Meta revision`, await view(tx, X));
      await deliverAds(pool, [{ ...p, fetchedAt: "2026-10-31T13:40:00Z" }], "2026-10-31T13:45:00Z");
      const q = await tx.query("select id, status, resolution from exceptions where kind = 'quarantined_source_records' and branch_id = $1", [X]);
      console.log("\nRDfix incident after the accepted newer revision:", JSON.stringify(q.rows));
      console.log(await ledger(tx));
      show(`RDfix 2: ${X} after the correction (Local Services still held)`, await view(tx, X));
    }),
  // Z: the source records $0.00 for every October Local Services day (accepted newer revisions).
  Z: () =>
    inRollback(async (tx, pool) => {
      const recs = [];
      for (const d of octDays()) recs.push({ ...(await storedPayload(tx, `lsa-${X}`, d)), costMicros: "0", fetchedAt: "2026-10-31T13:20:00Z" });
      await deliverAds(pool, recs, "2026-10-31T13:25:00Z");
      console.log(await ledger(tx));
      show(`Z: ${X} with Local Services recorded at $0.00`, await view(tx, X));
    }),
  // S: B03's Search campaign (GA-WEST, shared with B01, B02, B04, B05, B06) re-sent for October
  // stating an account with no currency rule: B03's October Search spend is excluded. B04 must not move.
  S: () =>
    inRollback(async (tx, pool) => {
      const b4 = await view(tx, CONTROL);
      const recs = [];
      for (const d of octDays()) recs.push({ ...(await storedPayload(tx, `gs-${X}`, d)), accountId: "GA-WEST-X", fetchedAt: "2026-10-31T13:20:00Z" });
      await deliverAds(pool, recs, "2026-10-31T13:25:00Z");
      console.log(await ledger(tx));
      show(`S: ${X} with October Search spend excluded`, await view(tx, X));
      await control(tx, "S (same GA-WEST account)", b4);
    }),
};

const which = process.argv.slice(2);
await inRollback(async (tx) => show(`baseline: ${X} on the seed`, [await ledger(tx), ...(await view(tx, X))]));
for (const name of which.length ? which : Object.keys(cases)) {
  if (!cases[name]) throw new Error(`unknown case ${name}`);
  await cases[name]();
}
