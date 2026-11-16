import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { DecisionPanel } from "@/components/onboarding/DecisionPanel";
import { MappingEditor, type ColumnFacts, type EditorDataset } from "@/components/onboarding/MappingEditor";
import { Badge, Callout, Card, EmptyState, Forbidden, KV, PageHeader, Pager, Skeleton, TableWrap, Td, Th } from "@/components/ui";
import { ActionError } from "@/lib/actions";
import { count, dateTime } from "@/lib/format";
import type { ColumnProfile } from "@/lib/onboarding/profile";
import { getUpload, rowResults, type UploadDetail } from "@/lib/onboarding/service";
import { DATASETS, DATASET_IDS, MONEY_MEANINGS } from "@/lib/onboarding/targets";
import { parseRecordId } from "@/lib/record-id";
import { BRANCHES } from "@/lib/reference";
import { businessNow, getPool, getViewer } from "@/lib/server";
import type { Viewer } from "@/lib/viewer";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export const metadata = { title: "Data upload" };

export default function OnboardingUploadPage(props: Props) {
  return (
    <Suspense fallback={<Skeleton lines={12} />}>
      <Workspace {...props} />
    </Suspense>
  );
}

/** Exact dollars and cents: reconciliation never rounds. */
const exact = (cents: number) => `${cents < 0 ? "−" : ""}$${(Math.abs(cents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const DISPOSITION: Record<string, { label: string; tone: "neutral" | "bad" | "warn" | "good" | "accent" }> = {
  eligible: { label: "New, eligible", tone: "good" },
  matches_ledger: { label: "Matches ledger", tone: "neutral" },
  differs_from_ledger: { label: "Differs from ledger", tone: "warn" },
  invalid: { label: "Needs correction", tone: "bad" },
  quarantined: { label: "Quarantined", tone: "bad" },
  duplicate_in_file: { label: "Duplicate in file", tone: "neutral" },
  conflict_in_file: { label: "Conflict in file", tone: "warn" },
  published: { label: "Published", tone: "good" },
};

function findings(c: ColumnProfile): string[] {
  const out: string[] = [];
  if (c.placeholders) out.push(`${c.placeholders} placeholder${c.placeholders === 1 ? "" : "s"} (N/A, null…)`);
  if (c.nonconforming) out.push(`${c.nonconforming} value${c.nonconforming === 1 ? "" : "s"} unlike the rest`);
  if (c.leadingZeros) out.push(`${c.leadingZeros} with leading zeros`);
  if (c.scientificIds) out.push(`${c.scientificIds} in scientific notation (rounded by a spreadsheet)`);
  if (c.formulaLike) out.push(`${c.formulaLike} would run as a spreadsheet formula`);
  if (c.numeric?.negatives) out.push(`${c.numeric.negatives} negative`);
  if (c.numeric?.outliers) out.push(`${c.numeric.outliers} outlier${c.numeric.outliers === 1 ? "" : "s"}`);
  if (c.kinds.date_ambiguous) out.push("dates could be month- or day-first");
  return out;
}

const looksLike = (c: ColumnProfile) => (c.personal ? `${c.inferred.replace(/_/g, " ")} · personal` : c.inferred.replace(/_/g, " "));

function stepState(detail: UploadDetail, viewer: Viewer) {
  const latest = detail.mappings[0] ?? null;
  const dry = detail.dryRun;
  const dryMapping = dry ? detail.mappings.find((m) => m.id === dry.mappingId) ?? null : null;
  const authority = dry?.authority ?? (latest ? DATASETS[latest.spec.dataset].authority : null);
  const published = detail.publication !== null;
  return [
    { key: "upload", title: "Upload", state: "done" as const, note: `${detail.upload.format.toUpperCase()} · ${count(detail.upload.rowCount)} rows` },
    { key: "profile", title: "Profile", state: "done" as const, note: `${detail.table.columns.length} columns${detail.table.warnings.length ? ` · ${detail.table.warnings.length} warnings` : ""}` },
    {
      key: "mapping",
      title: "Map meanings",
      state: !latest ? ("todo" as const) : latest.problems.length ? ("attention" as const) : ("done" as const),
      note: !latest ? (detail.assistant.dataset.chosen ? `Suggested: ${DATASETS[detail.assistant.dataset.chosen].label}` : "No dataset fits; choose one or stop") : latest.problems.length ? `${latest.problems.length} question${latest.problems.length === 1 ? "" : "s"} open` : `Version ${latest.version} · ${latest.status}`,
    },
    {
      key: "dry-run",
      title: "Dry run",
      state: !dry ? ("todo" as const) : dry.mappingId !== latest?.id ? ("attention" as const) : ("done" as const),
      note: !dry ? "Every row checked, nothing written" : `${count(dry.counts.eligible)} new · ${count(dry.counts.invalid + dry.counts.quarantined)} held back`,
    },
    {
      key: "decision",
      title: "Independent approval",
      state: !dryMapping ? ("todo" as const) : dryMapping.status === "approved" ? ("done" as const) : dryMapping.status === "rejected" ? ("blocked" as const) : ("waiting" as const),
      note: !dryMapping ? "After the dry run" : dryMapping.status === "proposed" ? `Waiting for a role other than ${dryMapping.proposedRole}${viewer.can.approve ? "" : " (an approver)"}` : `${dryMapping.status} by ${dryMapping.decidedBy}`,
    },
    {
      key: "outcome",
      title: authority === "reconcile" ? "Reconcile with ledger" : "Publish",
      state: published ? ("done" as const) : authority === "reconcile" && dry ? ("done" as const) : ("todo" as const),
      note: published
        ? `Published ${count((detail.publication!.stats as { published?: number }).published ?? 0)} rows`
        : authority === "reconcile"
          ? dry
            ? dry.ledger.counts.matches + dry.ledger.counts.differs === 0
              ? "Nothing to compare: the ledger holds none of these rows"
              : `${count(dry.counts.differs_from_ledger)} differ from the ledger`
            : "Compare only: never published"
          : "Approved rows go through intake",
    },
  ];
}

const PLATFORM: Record<string, string> = { google_ads: "Google Ads", google_lsa: "Google Local Services", microsoft_ads: "Microsoft Ads", meta: "Meta" };
/** Lines the dry run left out because they are not records at all: a report total, a title or footer line. */
const NOT_RECORDS = new Set(["SUMMARY_ROW", "TEXT_LINE"]);

const dayLabel = (iso: string, withYear: boolean) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" });
const rangeLabel = (first: string, last: string) => (first === last ? dayLabel(first, true) : `${dayLabel(first, false)}–${dayLabel(last, true)}`);
const plural = (n: number, one: string, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`;

/** Why the first group of held-back rows was not counted, in the reader's words. */
function heldBackReason(issue: DryRunIssue, rows: number): string {
  const subject = plural(rows, "row");
  if (issue.code === "CURRENCY_UNSUPPORTED") {
    const currency = /account currency ([A-Z]{3})/.exec(issue.example.detail)?.[1];
    return `${subject} ${rows === 1 ? "was" : "were"} not counted: ${rows === 1 ? "it is" : "they are"} stated in ${currency ?? "another currency"}, and only US dollars are summed. Nothing is converted.`;
  }
  return `${subject} ${rows === 1 ? "was" : "were"} not counted. The first: ${issue.example.detail}.`;
}

type DryRunIssue = NonNullable<UploadDetail["dryRun"]>["issues"][number];

/**
 * The result of the latest dry run, first on the page: one verified conclusion, one limitation,
 * one next action (BYOF-WORKFLOW.md). Every figure is the dry run's own; the profile, mapping,
 * counts and every row stay below it.
 */
function ResultCard({ uploadId, dry }: { uploadId: number; dry: NonNullable<UploadDetail["dryRun"]> }) {
  const c = dry.counts;
  const counted = (c.eligible ?? 0) + (c.matches_ledger ?? 0) + (c.differs_from_ledger ?? 0);
  const compared = dry.ledger.counts.matches + dry.ledger.counts.differs;
  const notRecords = dry.issues.filter((i) => NOT_RECORDS.has(i.code)).reduce((t, i) => t + i.rows, 0);
  const heldBack = (c.invalid ?? 0) + (c.quarantined ?? 0) + (c.conflict_in_file ?? 0) - notRecords;
  const reasons = dry.issues.filter((i) => !NOT_RECORDS.has(i.code) && i.code !== "DUPLICATE_IN_FILE");
  const heldDisposition = (c.quarantined ?? 0) > 0 ? "quarantined" : (c.conflict_in_file ?? 0) > 0 ? "conflict_in_file" : "invalid";
  const spend = dry.scope ?? null;
  const total = dry.ledger.money?.fileTotalCents ?? null;
  const platform = spend ? spend.platforms.map((p) => PLATFORM[p] ?? p).join(" and ") : null;

  const conclusion = spend && total !== null
    ? `${plural(counted, "campaign-day")} of ${platform} spend, ${rangeLabel(spend.firstDay, spend.lastDay)}: ${exact(total)} in US dollars.`
    : `${count(counted)} of ${count(dry.total - notRecords)} rows passed every check.`;
  const ledgerLine =
    compared === 0
      ? `The ledger holds none of ${counted === 1 ? "it" : "them"}, so nothing was compared.`
      : `${count(dry.ledger.counts.matches)} match the ledger and ${count(dry.ledger.counts.differs)} differ${dry.ledger.money ? ` (${exact(dry.ledger.money.matchedDifferenceCents)} on the shared rows)` : ""}.`;
  const support = [
    spend ? `${plural(spend.campaigns, "campaign")} in ${spend.accounts.length === 1 ? `account ${spend.accounts[0]}` : `accounts ${spend.accounts.join(", ")}`}. Every row passed the checks the live feed applies.` : "Every counted row passed the checks the live feed applies.",
    ledgerLine,
    dry.authority === "reconcile" ? "Nothing was added to the ledger." : "Nothing is in the ledger until an approver publishes it.",
    notRecords > 0 ? `${plural(notRecords, "line")} of the file ${notRecords === 1 ? "is not a record" : "are not records"} (a report total, a title or footer line) and ${notRecords === 1 ? "was" : "were"} left out.` : "",
  ].filter(Boolean).join(" ");

  const limitation =
    heldBack > 0 && reasons.length > 0
      ? heldBackReason(reasons[0], heldBack)
      : spend && spend.currency.assumed > 0
        ? "The file states no currency, so costs were read as US dollars. The live feed would hold these days until someone confirms the account's currency."
        : spend
          ? "Compare only: an ad report cannot add spend to the ledger, and spend alone does not tell leads, customers or cost per customer."
          : dry.authority === "reconcile"
            ? "Compare only: this export can show differences from the ledger; it never changes the ledger."
            : "An approver, a different role, must approve the mapping before these rows are published.";

  const next =
    heldBack > 0
      ? { href: `/onboarding/${uploadId}?rows=${heldDisposition}#rows`, label: `Review the ${plural(heldBack, "row")} not counted` }
      : { href: `/onboarding/${uploadId}?${compared === 0 ? "rows=eligible" : "page=1"}#rows`, label: `See the ${plural(counted, "row")} behind this result` };

  return (
    <section id="result" aria-labelledby="result-title" data-testid="upload-result" data-dry-run={dry.id} className="scroll-mt-20 rounded-lg border border-border bg-surface p-4 shadow-raised">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="result-title" className="text-xs font-semibold uppercase tracking-wider text-faint">Result</h2>
        {dry.authority === "reconcile" && <Badge tone="neutral">compare only</Badge>}
      </div>
      <p className="mt-2 text-base font-semibold" data-testid="result-conclusion">{conclusion}</p>
      <p className="mt-1 text-sm text-muted">{support}</p>
      <p className="mt-3 rounded-md border border-warn/40 bg-warn-soft px-3 py-2 text-sm" data-testid="result-limitation">
        <span className="font-semibold">Limitation: </span>
        {limitation}
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Link href={next.href} className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover" data-testid="result-next">
          {next.label}
        </Link>
        <span className="text-xs text-faint">The file&apos;s profile, the mapping and every row&apos;s outcome are below.</span>
      </div>
    </section>
  );
}

/** Each step links to the panel where it happens (the upload and outcome live with profile and decision). */
const STEP_ANCHOR: Record<string, string> = { upload: "profile", profile: "profile", mapping: "mapping", "dry-run": "dry-run", decision: "decision", outcome: "decision" };

const STEP_STYLE = {
  done: { dot: "bg-good", word: "Done" },
  todo: { dot: "bg-border-strong", word: "To do" },
  attention: { dot: "bg-warn", word: "Needs input" },
  waiting: { dot: "bg-accent", word: "Waiting" },
  blocked: { dot: "bg-bad", word: "Rejected" },
};

async function Workspace({ params, searchParams }: Props) {
  const uploadId = parseRecordId((await params).id);
  if (uploadId === null) notFound();
  const viewer = await getViewer();
  if (viewer.branchIds !== null || !(viewer.can.propose || viewer.can.approve)) {
    return <Forbidden message="Data onboarding is limited to company-wide analyst, engineer and approver roles: an export spans every branch." />;
  }
  let detail: UploadDetail;
  try {
    detail = await getUpload(getPool(), viewer, uploadId, await businessNow());
  } catch (error) {
    if (error instanceof ActionError && error.status === 404) notFound();
    throw error;
  }
  const sp = await searchParams;
  const filter = typeof sp.rows === "string" && DISPOSITION[sp.rows] ? sp.rows : undefined;
  const page = parseRecordId(typeof sp.page === "string" ? sp.page : null) ?? 1;
  const rows = await rowResults(getPool(), viewer, { uploadId, disposition: filter, page });
  const steps = stepState(detail, viewer);
  const dry = detail.dryRun;
  const latest = detail.mappings[0] ?? null;
  const dryMapping = dry ? detail.mappings.find((m) => m.id === dry.mappingId) ?? null : null;
  const staged = detail.upload.status === "staged" && !detail.upload.rowsPurged;

  const datasets: EditorDataset[] = DATASET_IDS.map((d) => ({
    id: d,
    label: DATASETS[d].label,
    authority: DATASETS[d].authority,
    fields: DATASETS[d].fields.map((f) => ({ key: f.key, label: f.label, meaning: f.meaning, kind: f.kind, required: f.required, values: f.values, moneyMeaning: f.moneyMeaning, personal: f.personal, untrustedText: f.untrustedText })),
    branches: BRANCHES.map((b) => ({ id: b.id, name: b.name })),
  }));
  const columnFacts: ColumnFacts[] = detail.profile.columns.map((c) => ({
    name: c.name,
    looksLike: looksLike(c),
    slashDates: Boolean(c.kinds.date_us || c.kinds.date_ambiguous),
    zoneless: Boolean(c.kinds.datetime_local || c.kinds.date_us || c.kinds.date_ambiguous || c.kinds.date_iso),
  }));
  const proposerRole = dryMapping?.proposedRole ?? null;
  const canDecide = viewer.can.approve && proposerRole !== viewer.role;
  const dryCurrent = dry !== null && dryMapping !== null && dry.mappingId === latest?.id;
  const canPublish = viewer.can.approve && staged && dryCurrent && dryMapping?.status === "approved" && (dry?.publishable ?? 0) > 0;
  const lastPage = Math.max(1, Math.ceil(rows.total / rows.pageSize));
  const hrefFor = (p: number) => `/onboarding/${uploadId}?${new URLSearchParams({ ...(filter ? { rows: filter } : {}), page: String(p) })}#rows`;

  return (
    <div className="space-y-6">
      <PageHeader
        crumbs={[{ href: "/onboarding", label: "Data onboarding" }, { label: detail.upload.filename }]}
        eyebrow={`Upload #${detail.upload.id} · ${detail.upload.uploadedBy}`}
        title={detail.upload.filename}
        badges={
          <>
            <Badge tone={detail.upload.status === "published" ? "good" : detail.upload.status === "staged" ? "accent" : "neutral"} dot>
              {detail.upload.status}
            </Badge>
            <Badge tone="accent">synthetic</Badge>
          </>
        }
        description={
          detail.upload.rowsPurged ? (
            <>The staged rows were deleted ({detail.upload.status === "published" ? "after publication" : "after retention or on request"}). The profile, the mapping versions and every row&apos;s disposition remain as the record.</>
          ) : (
            <>Staged until {dateTime(detail.upload.expiresAt)}. Nothing in this file has touched the ledger{detail.publication ? " except what was published below" : ""}.</>
          )
        }
      />

      {dry && <ResultCard uploadId={uploadId} dry={dry} />}

      <nav aria-label="Onboarding steps" className="rounded-lg border border-border bg-surface p-3 shadow-raised" data-testid="step-rail">
        <ol className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-6">
          {steps.map((s, i) => (
            <li key={s.key} className="min-w-0">
              <a href={`#${STEP_ANCHOR[s.key]}`} className="flex h-full min-w-0 gap-2 rounded-md px-2 py-1.5 hover:bg-surface-2">
                <span aria-hidden className={`mt-1.5 size-2 shrink-0 rounded-full ${STEP_STYLE[s.state].dot}`} />
                <span className="min-w-0">
                  <span className="block text-xs font-semibold">
                    {i + 1}. {s.title} <span className="font-normal text-muted">· {STEP_STYLE[s.state].word}</span>
                  </span>
                  <span className="block truncate text-xs text-muted">{s.note}</span>
                </span>
              </a>
            </li>
          ))}
        </ol>
      </nav>

      <Card id="profile" title="What is in the file" subtitle="Every row was profiled; nothing was sampled. Personal columns show shapes and counts, never values.">
        <div className="space-y-4">
          <KV
            items={[
              ["Rows", count(detail.upload.rowCount)],
              ["Columns", count(detail.table.columns.length)],
              ["Encoding", detail.table.encoding],
              ["Delimiter", detail.table.delimiter === "\t" ? "tab" : detail.table.delimiter ?? "n/a"],
              ["Worksheet", detail.table.sheet ? `${detail.table.sheet.name} (of ${detail.table.sheet.available.length})` : "n/a"],
              ["Exact duplicate rows", count(detail.profile.duplicateRows)],
            ]}
          />
          {detail.table.warnings.length > 0 && (
            <Callout tone="warn" title={`${detail.table.warnings.length} things the file did that a person should know`}>
              <ul className="list-disc pl-5">
                {detail.table.warnings.slice(0, 8).map((w, i) => (
                  <li key={i}>{w.message}</li>
                ))}
              </ul>
            </Callout>
          )}
          {detail.assistant.suspiciousHeaders.length > 0 && (
            <Callout tone="bad" title="Headers that read like instructions">
              {detail.assistant.suspiciousHeaders.map((h) => `"${h.slice(0, 60)}"`).join(", ")} were treated as data. Their text was not used as evidence for any mapping.
            </Callout>
          )}
          <TableWrap label="Column profiles" minWidth={820}>
            <thead>
              <tr>
                <Th>Column</Th>
                <Th>Looks like</Th>
                <Th align="right">Filled</Th>
                <Th align="right">Distinct</Th>
                <Th>Findings</Th>
                <Th>Values (shape or top values)</Th>
              </tr>
            </thead>
            <tbody>
              {detail.profile.columns.map((c) => (
                <tr key={c.index} className="border-t border-border align-top">
                  <Td className="font-medium">{c.name}</Td>
                  <Td>
                    {looksLike(c)}
                    {c.personal && <span className="ml-1"><Badge tone="warn">personal</Badge></span>}
                  </Td>
                  <Td align="right">{c.total ? `${Math.round(((c.total - c.missing) / c.total) * 100)}%` : "—"}</Td>
                  <Td align="right">{count(c.distinct)}</Td>
                  <Td>{findings(c).length ? <ul className="space-y-0.5 text-xs">{findings(c).map((x) => <li key={x}>{x}</li>)}</ul> : <span className="text-xs text-faint">none</span>}</Td>
                  <Td className="text-xs">
                    {c.topValues ? (
                      <span className="break-words">{c.topValues.slice(0, 4).map((v) => `${v.value} (${v.count})`).join(", ")}</span>
                    ) : (
                      <span className="font-mono text-muted">{c.shapes.slice(0, 2).map((s) => s.shape).join("  ")}</span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </div>
      </Card>

      <Card
        id="mapping"
        title="Map each field to what it means"
        subtitle={
          detail.assistant.dataset.abstained
            ? `The assistant did not choose a dataset: ${detail.assistant.dataset.reason}`
            : `Suggestions come from header vocabulary and the values themselves (${detail.assistant.engine}; no row leaves this server). Nothing is accepted until you save a version.`
        }
      >
        {staged ? (
          <MappingEditor
            uploadId={uploadId}
            datasets={datasets}
            moneyMeanings={MONEY_MEANINGS}
            columns={columnFacts}
            suggestions={detail.assistant.fields}
            suggestedDataset={detail.assistant.dataset.chosen}
            initial={latest?.spec ?? null}
            initialValues={detail.values}
            canPropose={viewer.can.propose}
            proposeReason={viewer.can.propose ? null : `${viewer.label} reviews mappings; an analyst or engineer proposes them.`}
          />
        ) : (
          <p className="text-sm text-muted">This upload is {detail.upload.status}; its mapping can no longer change. The approved mapping applies to the next export with the same layout.</p>
        )}
        {detail.mappings.length > 0 && (
          <div className="mt-5">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-faint">Mapping versions for this export layout</h3>
            <ul className="mt-2 space-y-1 text-sm" data-testid="mapping-versions">
              {detail.mappings.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">v{m.version}</span>
                  <Badge tone={m.status === "approved" ? "good" : m.status === "rejected" ? "bad" : m.status === "proposed" ? "accent" : "neutral"}>{m.status}</Badge>
                  <span className="text-muted">
                    {DATASETS[m.spec.dataset].label} · proposed by {m.proposedBy}
                    {m.decidedBy ? ` · ${m.status} by ${m.decidedBy}${m.reason ? `: “${m.reason}”` : ""}` : ""}
                  </span>
                  <span className="font-mono text-xs text-faint">rules {m.specHash}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      <Card id="dry-run" title="Dry run" subtitle="Every row compiled to the source's native shape and checked by the deployed mapper, then compared with the ledger. Nothing was written to the ledger.">
        {!dry ? (
          <EmptyState title="No dry run yet">Save a mapping version above; the dry run follows automatically.</EmptyState>
        ) : (
          <div className="space-y-5">
            {!dryCurrent && <Callout tone="warn" title="This dry run used an earlier mapping version">Run the latest version before approving or publishing.</Callout>}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-8" data-testid="dry-run-counts">
              {Object.entries(DISPOSITION)
                .filter(([k]) => k !== "published")
                .map(([k, d]) => (
                  <Link key={k} href={`/onboarding/${uploadId}?rows=${k}#rows`} className="rounded-md border border-border px-3 py-2 hover:border-accent">
                    <span className="block text-[11px] text-muted">{d.label}</span>
                    <span className="block text-lg font-semibold tabular-nums">{count(dry.counts[k] ?? 0)}</span>
                  </Link>
                ))}
            </div>
            <p className="text-sm" data-testid="accounted">
              {dry.accounted ? (
                <>
                  <strong>Every row is accounted for:</strong> {count(dry.total)} rows, {count(dry.total)} dispositions. None was dropped.
                </>
              ) : (
                <strong className="text-bad">Row accounting failed: dispositions do not add up to the rows.</strong>
              )}
            </p>
            {dry.issues.length > 0 && (
              <TableWrap label="Issues found by the dry run" minWidth={760}>
                <thead>
                  <tr>
                    <Th>Issue</Th>
                    <Th>Field</Th>
                    <Th align="right">Rows</Th>
                    <Th>Example</Th>
                    <Th>What to do</Th>
                  </tr>
                </thead>
                <tbody>
                  {dry.issues.map((i) => (
                    <tr key={`${i.code}:${i.field}`} className="border-t border-border align-top">
                      <Td>
                        <span className="font-mono text-xs">{i.code}</span>
                        {i.safeToAutomate && <span className="ml-1"><Badge tone="neutral">safe to automate</Badge></span>}
                      </Td>
                      <Td>{i.field === "*" ? "row" : i.field}</Td>
                      <Td align="right">{count(i.rows)}</Td>
                      <Td className="text-xs">Row {i.example.row}: {i.example.detail}</Td>
                      <Td className="text-xs">{i.example.suggestion}</Td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
            )}
            {dry.ledger.money && (
              <div className="rounded-lg border border-border p-3 text-sm" data-testid="money-reconciliation">
                <p className="font-semibold">Money, reconciled to the cent</p>
                <p className="text-xs text-muted">{dry.ledger.money.meaning}. Only facts with the same meaning and grain are compared.</p>
                <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1 sm:grid-cols-2">
                  <div className="flex justify-between gap-2"><dt>File total</dt><dd className="font-mono tabular-nums">{exact(dry.ledger.money.fileTotalCents)}</dd></div>
                  <div className="flex justify-between gap-2"><dt>= rows the ledger holds (file side)</dt><dd className="font-mono tabular-nums">{exact(dry.ledger.money.matchedFileCents)}</dd></div>
                  <div className="flex justify-between gap-2"><dt>+ rows the ledger lacks ({count(dry.ledger.money.notInLedgerRows)})</dt><dd className="font-mono tabular-nums">{exact(dry.ledger.money.notInLedgerCents)}</dd></div>
                  <div className="flex justify-between gap-2"><dt>Ledger, same rows</dt><dd className="font-mono tabular-nums">{exact(dry.ledger.money.matchedLedgerCents)}</dd></div>
                  <div className="flex justify-between gap-2 font-semibold"><dt>Difference on shared rows</dt><dd className="font-mono tabular-nums">{exact(dry.ledger.money.matchedDifferenceCents)}</dd></div>
                  <div className="flex justify-between gap-2"><dt>Ledger records the file lacks ({dry.ledger.money.ledgerOnly.scope || "no scope"})</dt><dd className="font-mono tabular-nums">{count(dry.ledger.money.ledgerOnly.rows)} · {exact(dry.ledger.money.ledgerOnly.cents)}</dd></div>
                </dl>
                <p className="mt-2 text-xs text-muted">A difference is not automatically an error in either system. Each one is listed below; correcting the ledger goes through the Action Center, never through a file.</p>
              </div>
            )}
            {dry.ledger.differences.length > 0 && (
              <TableWrap label="Differences from the ledger" minWidth={560}>
                <thead>
                  <tr>
                    <Th>Row</Th>
                    <Th>Fact</Th>
                    <Th>File says</Th>
                    <Th>Ledger says</Th>
                  </tr>
                </thead>
                <tbody>
                  {dry.ledger.differences.flatMap((d) =>
                    d.diffs.map((x) => (
                      <tr key={`${d.row}:${x.fact}`} className="border-t border-border">
                        <Td>{d.row}</Td>
                        <Td>{x.fact}</Td>
                        <Td className="font-mono text-xs">{x.file}</Td>
                        <Td className="font-mono text-xs">{x.ledger}</Td>
                      </tr>
                    )),
                  )}
                </tbody>
              </TableWrap>
            )}
          </div>
        )}
      </Card>

      {dry && (
        <Card id="rows" title="Every row and what happened to it" flush subtitle={filter ? `Showing: ${DISPOSITION[filter].label}. ` : "All dispositions."}>
          <div className="flex flex-wrap gap-2 px-4 pt-3 text-xs">
            <Link href={`/onboarding/${uploadId}#rows`} aria-current={!filter ? "true" : undefined} className={`rounded border px-2 py-0.5 ${!filter ? "border-accent text-accent" : "border-border"}`}>All</Link>
            {Object.entries(DISPOSITION).map(([k, d]) => (
              <Link key={k} href={`/onboarding/${uploadId}?rows=${k}#rows`} aria-current={filter === k ? "true" : undefined} className={`rounded border px-2 py-0.5 ${filter === k ? "border-accent text-accent" : "border-border"}`}>
                {d.label}
              </Link>
            ))}
          </div>
          {rows.total === 0 ? (
            <div className="p-4"><EmptyState title="No rows with this disposition" /></div>
          ) : (
            <>
              <TableWrap flush label="Row results" minWidth={820}>
                <thead>
                  <tr>
                    <Th align="right">Source row</Th>
                    <Th>Disposition</Th>
                    <Th>Reason</Th>
                    <Th>Detail</Th>
                    <Th>Suggested correction</Th>
                  </tr>
                </thead>
                <tbody>
                  {(rows.rows as Array<{ row_ref: number; disposition: string; code: string | null; field: string | null; detail: string | null; suggestion: string | null; raw_event_id: string | null }>).map((r) => (
                    <tr key={r.row_ref} className="border-t border-border align-top">
                      <Td align="right">{r.row_ref}</Td>
                      <Td><Badge tone={DISPOSITION[r.disposition]?.tone ?? "neutral"}>{DISPOSITION[r.disposition]?.label ?? r.disposition}</Badge></Td>
                      <Td className="font-mono text-xs">{r.code ?? "—"}{r.field && r.field !== "*" ? ` · ${r.field}` : ""}</Td>
                      <Td className="break-words text-xs">{r.detail ?? (r.raw_event_id ? `raw event #${r.raw_event_id}` : "—")}</Td>
                      <Td className="text-xs">{r.suggestion ?? "—"}</Td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
              <Pager page={page} lastPage={lastPage} first={(page - 1) * rows.pageSize + 1} last={Math.min(page * rows.pageSize, rows.total)} total={rows.total} hrefFor={hrefFor} label="Row results pages" />
            </>
          )}
        </Card>
      )}

      <Card id="decision" title={dry?.authority === "reconcile" ? "Approval" : "Approval and publication"} subtitle="A different role must approve the exact rules the dry run used. Publication re-checks the ledger and skips any row it gained since.">
        {detail.publication ? (
          <Callout tone="good" title="Published">
            {count((detail.publication.stats as { published?: number }).published ?? 0)} rows went through intake on {dateTime(detail.publication.publishedAt)} by {detail.publication.publishedBy}. Identity resolution and reconciliation picked them up like any delivery.{" "}
            <Link href={`/audit?subject=onboarding:${uploadId}`} className="text-accent hover:underline">Audit trail</Link>
          </Callout>
        ) : !dry || !dryMapping ? (
          <p className="text-sm text-muted">Available after a dry run.</p>
        ) : (
          <DecisionPanel
            uploadId={uploadId}
            dryRunId={dry.id}
            mappingId={dryMapping.id}
            mappingStatus={dryMapping.status}
            canDecide={canDecide}
            decideReason={!viewer.can.approve ? `${viewer.label} cannot approve. An approver (a different role) decides.` : proposerRole === viewer.role ? "The role that proposed this mapping cannot approve it." : null}
            canPublish={Boolean(canPublish)}
            publishReason={
              !viewer.can.approve
                ? "Publication is for an approver."
                : !dryCurrent
                  ? "Dry-run the latest mapping version first."
                  : dryMapping.status !== "approved"
                    ? "Approve the mapping first."
                    : (dry.publishable ?? 0) === 0
                      ? "No new rows: everything eligible is already in the ledger."
                      : !staged
                        ? "The staged rows are no longer available."
                        : null
            }
            publishable={dry.publishable}
            authority={dry.authority}
          />
        )}
      </Card>
    </div>
  );
}
