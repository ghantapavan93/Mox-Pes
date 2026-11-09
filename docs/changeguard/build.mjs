// Builds the ChangeGuard case file from numbers the app computed (snapshot.json, written by
// `npm run export:changeguard`). No number on the page is typed by hand.
//   node docs/changeguard/build.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const s = JSON.parse(readFileSync(join(here, "snapshot.json"), "utf8"));

const signal = (x) => ({
  ratio: x.ratio, trustworthy: x.trustworthy, signal: x.signal,
  from: x.from && { label: x.from.label, cacCents: x.from.cacCents },
  to: x.to && { label: x.to.label, cacCents: x.to.cacCents },
  blockers: x.blockers.length,
  channels: x.channels.map((c) => ({ code: c.channelCode, label: c.label, spendCents: c.spendCents, acquired: c.acquired, cacCents: c.cacCents })),
});

/** One row per day: Local Services and Search spend, before and after the re-map. */
const days = [];
for (let t = Date.parse("2026-09-01T00:00:00Z"); t < Date.parse("2026-10-31T00:00:00Z"); t += 864e5) {
  const date = new Date(t).toISOString().slice(0, 10);
  const pick = (rows, channel) => rows.find((r) => r.date === date && r.channel === channel)?.cents ?? 0;
  days.push({
    date,
    before: { lsa: pick(s.before.daily, "google_lsa"), search: pick(s.before.daily, "google_search") },
    after: { lsa: pick(s.after.daily, "google_lsa"), search: pick(s.after.daily, "google_search") },
  });
}

const ev = s.gap.evidence;
const data = {
  branch: s.branch,
  gap: {
    id: s.gap.id,
    detectedAt: s.gap.firstDetectedAt,
    lastSpendDate: ev.lastSpendDate,
    gapStart: ev.gapStart,
    leadsSinceGap: ev.leadsSinceGap,
    acquisitionsSinceGap: ev.acquisitionsSinceGap,
    misfiledCents: s.gap.amountCents,
    predecessor: ev.predecessors[0],
    successor: ev.successors[0],
  },
  samples: s.samples.map((r) => ({ id: Number(r.id), version: r.adapter_version, classified: r.classified, payload: r.payload })),
  signal: { before: signal(s.before.signal), after: signal(s.after.signal) },
  days,
  remap: s.remap,
  ledger: { before: s.before.ledger, after: s.after.ledger },
  lineage: s.after.lineage[0],
  status: s.after.exceptionStatus,
};

const template = readFileSync(join(here, "template.html"), "utf8");
if (!template.includes("__DATA__")) throw new Error("template.html has no __DATA__ slot");
writeFileSync(join(here, "index.html"), template.replace("__DATA__", JSON.stringify(data)));
console.log("Wrote docs/changeguard/index.html");
