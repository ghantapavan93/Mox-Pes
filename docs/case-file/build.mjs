// Builds the shareable case-file page from numbers the app computed (snapshot.json,
// written by `npm run export:snapshot`). No number on the page is typed by hand.
//   node docs/case-file/build.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const s = JSON.parse(readFileSync(join(here, "snapshot.json"), "utf8"));

const sum = (rows, key) => rows.reduce((acc, r) => acc + Number(r[key]), 0);
const company = (rows) => ({
  paidCacCents: Math.round(sum(rows, "paidSpendCents") / sum(rows, "paidAcquired")),
  unknownShare: sum(rows, "unknownAcquired") / sum(rows, "acquired"),
});
const branch = (rows) => {
  const b = rows.find((r) => r.branchId === s.branch);
  return {
    id: b.branchId, name: b.name, spendCents: b.paidSpendCents, acquired: b.acquired, paidAcquired: b.paidAcquired,
    unknownAcquired: b.unknownAcquired, paidCacCents: Math.round(b.paidSpendCents / b.paidAcquired),
    unknownShare: b.unknownAcquired / b.acquired, channelConflicts: b.channelConflicts, collectedCents: b.collectedCents,
    rawLeads: b.rawLeads,
  };
};

const sample = s.incident.samples[0];
const data = {
  branch: { before: branch(s.october.rowsBefore), after: branch(s.october.rowsAfter) },
  company: { before: company(s.october.rowsBefore), after: company(s.october.rowsAfter) },
  weekly: s.weekly.branchBefore.map((w, i) => ({
    week: w.weekStart,
    before: { paid: w.paidAcquired, unknown: w.unknownAcquired, other: w.acquired - w.paidAcquired - w.unknownAcquired },
    after: (({ paidAcquired: p, unknownAcquired: u, acquired: a }) => ({ paid: p, unknown: u, other: a - p - u }))(s.weekly.branchAfter[i]),
  })),
  bridge: s.october.bridge,
  incident: {
    records: s.incident.quarantinedRecords,
    customersWithoutLead: s.incident.evidence.customersWithoutLead,
    acvCents: s.incident.evidence.annualContractValueCents,
    firstOccurredAt: s.incident.evidence.firstOccurredAt,
    detectedAt: s.incident.firstDetectedAt,
    error: s.incident.evidence.sampleError,
    sample: { id: sample.id, payload: sample.payload },
  },
  replay: s.replay,
  feedback: s.feedback,
  ingestion: {
    runs: s.ingestion.runs, failedRuns: s.ingestion.failed, duplicates: s.ingestion.duplicates,
    events: sum(s.ingestion.streams, "events"), deliveries: sum(s.ingestion.streams, "deliveries"),
  },
};

const template = readFileSync(join(here, "template.html"), "utf8");
if (!template.includes("__DATA__")) throw new Error("template.html has no __DATA__ slot");
writeFileSync(join(here, "index.html"), template.replace("__DATA__", JSON.stringify(data)));
console.log("Wrote docs/case-file/index.html");
