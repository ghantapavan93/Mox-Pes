import type { Pool } from "pg";
import { runOutcome, verificationSentence } from "@/lib/ingest/run-outcome";
import { branchRows } from "@/lib/metrics/scorecard";
import { PERIODS } from "@/lib/period";
import { verificationsByRun } from "@/lib/queries";
import type { Delivery, Sent, Step } from "./deliveries";

/**
 * The independent ledger for the B09 deliveries: what the source itself sent (captured by the
 * delivery fixture before the product mapped it) against what the product recorded: the runs,
 * the versions they stored, the accepted spend days, the incident's verification, the run
 * outcomes, and the totals before and after each step. Every expectation is derived from what was
 * sent and simple arithmetic, never from the product's own totals.
 */

export interface Check {
  stage: string;
  name: string;
  ok: boolean;
  detail: string;
}

export type States = "missing" | Step;

/** The facts no view may change unseen: money, customers, the incident, its case and the campaign record. */
export async function worldFacts(pool: Pool, gapId: number) {
  const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;
  const rows = await branchRows(pool, { from: PERIODS.oct.from, to: PERIODS.oct.to, branchIds: null });
  const b09 = rows.find((r) => r.branchId === "B09")!;
  const byChannel = Object.fromEntries(
    (
      await q(
        `select s.channel_code, sum(s.cost_cents)::bigint as c from ad_spend_daily s join campaign_branch_map m on m.campaign_id = s.campaign_id
         where m.branch_id = 'B09' and s.spend_date >= '2026-10-01' and s.spend_date < '2026-10-31' group by 1 order by 1`,
      )
    ).map((r) => [String(r.channel_code), Number(r.c)]),
  ) as Record<string, number>;
  const [incident] = await q(
    `select id, status, evidence -> 'verification' ->> 'verifiedAt' as verified_at,
            jsonb_array_length(coalesce(evidence -> 'previousVerifications', '[]'::jsonb)) as previous
     from exceptions where id = $1`,
    [gapId],
  );
  const [kase] = await q("select id, exception_id, state, reopen_count from cases where exception_id = $1", [gapId]);
  const [campaign] = await q("select name, channel_code, campaign_type, local_services_enabled from ad_campaigns where external_campaign_id = 'pmax-lsa-B09'");
  return {
    b09: { paidSpendCents: b09.paidSpendCents, acquired: b09.acquired, collectedCents: b09.collectedCents, byChannel },
    company: {
      spendCents: Number((await q("select sum(cost_cents)::bigint as c from ad_spend_daily"))[0].c),
      acquired: rows.reduce((t, r) => t + r.acquired, 0),
      collectedCents: rows.reduce((t, r) => t + r.collectedCents, 0),
    },
    incident: { id: Number(incident.id), status: String(incident.status), verifiedAt: incident.verified_at as string | null, previousVerifications: Number(incident.previous) },
    case: kase ? { id: Number(kase.id), state: String(kase.state), reopenCount: Number(kase.reopen_count) } : null,
    coverageGaps: (await q("select id, status from exceptions where kind = 'channel_coverage_gap' order by id")).map((r) => `${r.id}:${r.status}`),
    casesForGaps: Number((await q("select count(*)::int as n from cases c join exceptions x on x.id = c.exception_id where x.kind = 'channel_coverage_gap'"))[0].n),
    exceptionsByKind: Object.fromEntries((await q("select kind, count(*)::int as n from exceptions group by 1 order by 1")).map((r) => [String(r.kind), Number(r.n)])) as Record<string, number>,
    campaign: { name: String(campaign.name), channel: String(campaign.channel_code), type: campaign.campaign_type as string | null, localServices: Boolean(campaign.local_services_enabled) },
  };
}

export type WorldFacts = Awaited<ReturnType<typeof worldFacts>>;

/** The run labels the pipeline must show, in the product's words (DELIVERY-OUTCOMES.md). */
export function expectedOutcomes(gapId: number): Record<Step, string[]> {
  const used = (dates: string, n: number) => `Incident #${gapId}'s verification used ${dates} (${n} of 18 dates) to clear its coverage hold.`;
  const newer = ["No change to accepted records", "Stored, but a newer revision was already accepted"];
  return {
    partial: ["5 changes to accepted records", used("Oct 26–Oct 30", 5)],
    rest: ["13 changes to accepted records", used("Oct 13–Oct 25", 13)],
    duplicate: ["No change to accepted records", "Duplicate: every delivery was a version already stored"],
    older: newer,
    stale: newer,
  };
}

const sum = (xs: Array<{ cents: number }>) => xs.reduce((t, x) => t + x.cents, 0);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export async function ledgerChecks(pool: Pool, gapId: number, deliveries: Record<Step, Delivery>, facts: Record<States, WorldFacts>): Promise<{ checks: Check[]; records: Record<string, unknown> }> {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail: unknown = "") => checks.push({ stage: "ledger", name, ok, detail: (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 600) });
  const steps = Object.keys(deliveries) as Step[];
  const run = Object.fromEntries(steps.map((s) => [s, deliveries[s].runId])) as Record<Step, number>;
  const ids = steps.map((s) => run[s]);
  const sent = Object.fromEntries(steps.map((s) => [s, deliveries[s].sent])) as Record<Step, Sent[]>;

  check("the five deliveries are runs #676–#680, as in the recorded proof (RELEASE-CANDIDATE.md §3)", same(ids, [676, 677, 678, 679, 680]), run);

  // What the product recorded: the runs, the versions they stored, the accepted days today.
  const runs = (await pool.query("select id, fetched, inserted, duplicates, projected, rows_changed from ingestion_runs where id = any($1::bigint[]) order by id", [ids])).rows;
  const row = (s: Step) => runs.find((r) => Number(r.id) === run[s])!;
  const stored = (
    await pool.query(
      `select ingestion_run_id as run, payload ->> 'date' as date, (payload ->> 'costMicros')::bigint / 10000 as cents, payload ->> 'fetchedAt' as fetched_at, delivery_count
       from raw_events where ingestion_run_id = any($1::bigint[]) order by run, date`,
      [ids],
    )
  ).rows.map((r) => ({ run: Number(r.run), date: String(r.date), cents: Number(r.cents), fetchedAt: String(r.fetched_at), deliveries: Number(r.delivery_count) }));
  const accepted = (
    await pool.query(
      `select s.spend_date::text as date, s.channel_code, s.cost_cents, re.ingestion_run_id as run, re.payload ->> 'fetchedAt' as fetched_at
       from ad_spend_daily s join ad_campaigns c on c.id = s.campaign_id left join raw_events re on re.id = s.raw_event_id
       where c.external_campaign_id = 'pmax-lsa-B09' and s.spend_date between '2026-10-13' and '2026-10-30' order by 1`,
    )
  ).rows.map((r) => ({ date: String(r.date), channel: String(r.channel_code), cents: Number(r.cost_cents), run: Number(r.run), fetchedAt: String(r.fetched_at) }));
  const storedBy = (s: Step) => stored.filter((x) => x.run === run[s]).map(({ date, cents, fetchedAt }) => ({ date, cents, fetchedAt }));
  const asSent = (s: Step) => sent[s].map(({ date, cents, fetchedAt }) => ({ date, cents, fetchedAt }));

  // partial (#676): five newer fetches, all accepted, filed as Local Services.
  const p = sent.partial;
  check("partial sent Oct 26–30, fetched 13:00", same(p.map((d) => d.date), ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"]) && p.every((d) => d.fetchedAt === "2026-10-31T13:00:00Z"), p);
  check("partial stored those 5 versions as sent", same(storedBy("partial"), asSent("partial")), storedBy("partial"));
  check("partial row: stored 5, 5 changes recorded", [row("partial").inserted, row("partial").rows_changed].join() === "5,5", row("partial"));
  check("partial: the 5 days are accepted on its versions, filed as Local Services", same(accepted.filter((a) => a.run === run.partial).map((a) => `${a.date}:${a.channel}`), p.map((d) => `${d.date}:google_lsa`)), accepted.filter((a) => a.run === run.partial));

  // rest (#677): the other 13 dates.
  const r = sent.rest;
  check("rest sent Oct 13–25, fetched 13:10", r.length === 13 && r[0].date === "2026-10-13" && r[12].date === "2026-10-25" && r.every((d) => d.fetchedAt === "2026-10-31T13:10:00Z"), r.map((d) => d.date));
  check("rest stored those 13 versions as sent", same(storedBy("rest"), asSent("rest")), storedBy("rest").length);
  check("rest row: stored 13, 13 changes recorded", [row("rest").inserted, row("rest").rows_changed].join() === "13,13", row("rest"));

  // duplicate (#678): the same 13 versions again.
  check("duplicate sent exactly rest's versions again", same(sent.duplicate, r), sent.duplicate.length);
  check("duplicate row: stored 0, 13 duplicates, 0 changes recorded", [row("duplicate").inserted, row("duplicate").duplicates, row("duplicate").rows_changed].join() === "0,13,0", row("duplicate"));
  check("duplicate stored nothing of its own; rest's versions were each delivered twice", stored.every((x) => x.run !== run.duplicate) && stored.filter((x) => x.run === run.rest).every((x) => x.deliveries === 2), stored.filter((x) => x.run === run.rest).map((x) => x.deliveries));

  // older (#679) and stale (#680): older fetches of Oct 20, $50 higher; stale also says "Search".
  const restOct20 = r.find((d) => d.date === "2026-10-20")!;
  const o = sent.older[0];
  const st = sent.stale[0];
  check("older sent Oct 20, fetched 13:05 (before rest's 13:10), $50 more", sent.older.length === 1 && o.date === "2026-10-20" && o.fetchedAt === "2026-10-31T13:05:00Z" && o.cents === restOct20.cents + 5_000, sent.older);
  check("stale sent Oct 20, fetched 13:07, $50 more, as a Search campaign", sent.stale.length === 1 && st.date === "2026-10-20" && st.fetchedAt === "2026-10-31T13:07:00Z" && st.cents === restOct20.cents + 5_000 && st.campaignName === "B09 Coral | Search" && st.campaignType === "SEARCH" && st.localServicesEnabled === false, sent.stale);
  for (const s of ["older", "stale"] as const) {
    check(`${s} row: stored 1, 0 changes recorded`, row(s).inserted === 1 && row(s).rows_changed === 0, row(s));
    check(`${s} stored its version as sent`, same(storedBy(s), asSent(s)), storedBy(s));
  }
  const oct20 = accepted.find((a) => a.date === "2026-10-20")!;
  check("Oct 20 is still rest's version and amount after older and stale", oct20.run === run.rest && oct20.cents === restOct20.cents && oct20.fetchedAt === "2026-10-31T13:10:00Z" && oct20.channel === "google_lsa", oct20);
  check("all 18 dates are accepted as Local Services, on partial's or rest's versions", accepted.length === 18 && accepted.every((a) => a.channel === "google_lsa" && (a.run === run.partial || a.run === run.rest)), accepted.map((a) => `${a.date}:${a.channel}:#${a.run}`));
  check("stale left the campaign record as the newest fetch had it", same(facts.stale.campaign, facts.older.campaign) && facts.stale.campaign.channel === "google_lsa" && facts.stale.campaign.name === "B09 Coral | Local Services (Performance Max, pay-per-lead)", { before: facts.older.campaign, after: facts.stale.campaign });

  // The verification: recorded once, on the incident, naming rest and partial only.
  const incident = (await pool.query("select status, evidence from exceptions where id = $1", [gapId])).rows[0];
  const v = incident.evidence.verification as { coveredCents: number; runs: Array<{ runId: number; cents: number; dates: string[] }> } | undefined;
  const used = await verificationsByRun(pool, ids);
  check("one verification, none before it", incident.status === "resolved" && !!v && !incident.evidence.previousVerifications, { status: incident.status, previous: incident.evidence.previousVerifications ?? null });
  check("it names rest and partial, with the cents the source sent for their dates", same(v?.runs.map((x) => [x.runId, x.cents, x.dates.length]), [[run.rest, sum(r), 13], [run.partial, sum(p), 5]]), v?.runs.map((x) => [x.runId, x.cents, x.dates.length]));
  check("covered cents = what the source re-sent = $2,123.52", v?.coveredCents === sum(p) + sum(r) && v?.coveredCents === 212_352, { covered: v?.coveredCents, sent: sum(p) + sum(r) });
  check("no verification names duplicate, older or stale", !used.has(run.duplicate) && !used.has(run.older) && !used.has(run.stale), [...used.keys()]);

  // The labels, as the pipeline shows them.
  const want = expectedOutcomes(gapId);
  const outcomes = Object.fromEntries(
    steps.map((s) => {
      const x = row(s);
      const o2 = runOutcome({ fetched: x.fetched, inserted: x.inserted, duplicates: x.duplicates, projected: x.projected, rowsChanged: x.rows_changed }, used.get(run[s]));
      return [s, [o2.effect, ...(o2.reason ? [o2.reason] : []), ...o2.verifications.map(verificationSentence)]];
    }),
  ) as Record<Step, string[]>;
  for (const s of steps) check(`${s} (#${run[s]}) label: ${want[s][0]}${want[s][1] ? `; ${want[s][1].slice(0, 50)}` : ""}`, same(outcomes[s], want[s]), outcomes[s]);

  // Reclassified, not added; nothing else opened.
  const states: States[] = ["missing", ...steps];
  const t = (s: States) => facts[s];
  check("B09's paid spend is 1,664,923¢ in every state", states.every((s) => t(s).b09.paidSpendCents === 1_664_923), states.map((s) => t(s).b09.paidSpendCents));
  check("company spend, customers and cash are the same in every state", states.every((s) => same(t(s).company, t("missing").company)), states.map((s) => t(s).company));
  check("B09's customers and cash are the same in every state", states.every((s) => t(s).b09.acquired === t("missing").b09.acquired && t(s).b09.collectedCents === t("missing").b09.collectedCents), states.map((s) => [t(s).b09.acquired, t(s).b09.collectedCents]));
  const lsa = (s: States) => t(s).b09.byChannel.google_lsa ?? 0;
  const search = (s: States) => t(s).b09.byChannel.google_search ?? 0;
  check(
    "Local Services gained exactly what Search lost: partial's then rest's cents",
    lsa("partial") - lsa("missing") === sum(p) && search("missing") - search("partial") === sum(p) && lsa("rest") - lsa("partial") === sum(r) && search("partial") - search("rest") === sum(r),
    states.map((s) => ({ state: s, lsa: lsa(s), search: search(s) })),
  );
  check("duplicate, older and stale moved no channel's spend", (["duplicate", "older", "stale"] as const).every((s) => same(t(s).b09.byChannel, t("rest").b09.byChannel)), (["rest", "duplicate", "older", "stale"] as const).map((s) => t(s).b09.byChannel));
  check("one coverage-gap incident throughout: open, still open, then resolved", same(states.map((s) => t(s).coverageGaps.join()), [`${gapId}:open`, `${gapId}:open`, `${gapId}:resolved`, `${gapId}:resolved`, `${gapId}:resolved`, `${gapId}:resolved`]), states.map((s) => t(s).coverageGaps));
  check("one case for it throughout, never reopened", states.every((s) => t(s).casesForGaps === 1 && t(s).case?.id === t("missing").case?.id && t(s).case?.reopenCount === 0), states.map((s) => t(s).case));
  check("no incident of any kind opened from first to last", same(t("stale").exceptionsByKind, t("missing").exceptionsByKind), { missing: t("missing").exceptionsByKind, last: t("stale").exceptionsByKind });
  const recon = (await pool.query("select payload from domain_events where type = 'reconciliation.run_completed' and occurred_at >= '2026-10-31T13:05:00Z' order by id")).rows.map((x) => x.payload as { opened: number; resolved: number });
  // A delivery that stores nothing (the duplicate) records no intake event, so it triggers no reconciliation.
  check("each reconciliation after a delivery opened nothing; one resolved the gap", recon.length > 0 && recon.every((x) => x.opened === 0) && recon.reduce((n, x) => n + x.resolved, 0) === 1, recon.map((x) => ({ opened: x.opened, resolved: x.resolved })));

  return { checks, records: { runIds: run, sent, runs, stored, accepted, verification: v, outcomes, reconciliations: recon } };
}
