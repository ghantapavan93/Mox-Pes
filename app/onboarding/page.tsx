import Link from "next/link";
import { Suspense } from "react";
import { UploadForm } from "@/components/onboarding/UploadForm";
import { Badge, Callout, Card, EmptyState, Forbidden, PageHeader, Skeleton, TableWrap, Td, Th } from "@/components/ui";
import { count, dateTime } from "@/lib/format";
import { onboardingAccess } from "@/lib/onboarding/access";
import { LIMITS } from "@/lib/onboarding/limits";
import { listUploads } from "@/lib/onboarding/service";
import { DATASETS, DATASET_IDS } from "@/lib/onboarding/targets";
import { businessNow, getPool, getViewer } from "@/lib/server";
import { LOCAL_DEMO_URL, WORKSPACE, availabilitySentence } from "@/lib/workspace";

export const metadata = { title: "Data onboarding" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default function OnboardingPage(props: Props) {
  return (
    <div className="space-y-6">
      <PageHeader
        crumbs={[{ label: "Systems" }, { label: "Data onboarding" }]}
        title="Data onboarding"
        badges={<Badge tone="accent">synthetic data only</Badge>}
        description={
          <>
            Bring an export the system has never seen. Its columns are matched to meanings with the evidence shown, what the file cannot say is asked, and every row
            is checked with the rules a live feed meets, then compared with the ledger.
          </>
        }
      />
      <Suspense fallback={<Skeleton lines={8} />}>
        <Uploads {...props} />
      </Suspense>
    </div>
  );
}

const STATUS_TONE: Record<string, "neutral" | "good" | "warn" | "bad" | "accent"> = { staged: "accent", published: "good", expired: "neutral", rejected: "bad", deleted: "neutral" };

const megabytes = (bytes: number) => `${bytes / 1_048_576} MB`;

/** "CRM (FieldRoutes-style API)" → "CRM"; "Ad platform (Google, …)" → "ad platform". */
const owner = (systemOfRecord: string) => {
  const name = systemOfRecord.replace(/ \(.*\)$/, "");
  return /^[A-Z]{2,}/.test(name) ? name : name[0].toLowerCase() + name.slice(1);
};

/**
 * What a file may be and what happens to it, stated before anything is sent (release design
 * §5.3). Generated from the dataset definitions, the parser's limits and the workspace's, so the
 * page cannot drift from what the server enforces.
 */
function UploadTerms({ workspace }: { workspace: boolean }) {
  const maxBytes = workspace ? WORKSPACE.maxBytes : LIMITS.maxUploadBytes;
  const maxRows = workspace ? WORKSPACE.maxRows : LIMITS.maxRows;
  return (
    <Card id="terms" title="Before you upload" subtitle="What a file may be, what is read from it, and what happens to it." testId="upload-terms">
      <div className="space-y-4 text-sm">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 md:grid-cols-2">
          <div>
            <dt className="font-semibold">Formats</dt>
            <dd className="text-muted">
              CSV or TSV (the delimiter is detected), XLSX (one worksheet at a time; formulas are never run) or JSON (an array of records). Text is read as UTF-8 or
              UTF-16; a file that is neither is read as Windows-1252, and the result says so.
            </dd>
          </div>
          <div>
            <dt className="font-semibold">Limits</dt>
            <dd className="text-muted" data-testid="upload-limits">
              Up to {megabytes(maxBytes)} and {count(maxRows)} rows{workspace ? ` on the public demo (the local demo takes ${megabytes(LIMITS.maxUploadBytes)} and ${count(LIMITS.maxRows)})` : ""}, {count(LIMITS.maxColumns)} columns and
              {" "}{count(LIMITS.maxCellChars)} characters a cell. A file over a limit is refused with the reason; nothing is cut off silently.
            </dd>
          </div>
          <div>
            <dt className="font-semibold">Dates and times</dt>
            <dd className="text-muted">
              ISO dates with a UTC offset are read as they are. Times without a zone are read only after you confirm they are the branch&apos;s local time, and slash
              dates (03/04/2026) only after you say whether the month or the day comes first. Calls and web leads need the time; payments may give the day alone.
            </dd>
          </div>
          <div>
            <dt className="font-semibold">Money</dt>
            <dd className="text-muted">
              US dollars only, and nothing is converted. An ad report that states another currency has those days held back; one that states none is read as US
              dollars, and the result says so.
            </dd>
          </div>
        </dl>
        <TableWrap label="Exports this page reads" minWidth={720}>
          <thead>
            <tr>
              <Th>Export</Th>
              <Th>Required columns</Th>
              <Th>Optional columns</Th>
              <Th>What the file may do</Th>
            </tr>
          </thead>
          <tbody>
            {DATASET_IDS.map((id) => {
              const d = DATASETS[id];
              return (
                <tr key={id} className="border-t border-border align-top">
                  <Td className="font-medium">{d.label}</Td>
                  <Td className="text-xs">{d.fields.filter((f) => f.required).map((f) => f.label).join(", ")}</Td>
                  <Td className="text-xs text-muted">{d.fields.filter((f) => !f.required).map((f) => f.label).join(", ") || "none"}</Td>
                  <Td className="text-xs">
                    {d.authority === "publish"
                      ? workspace
                        ? "Compared here; counted only in the local demo, after a second person approves the mapping"
                        : "Counted after a second person approves the mapping; a row the ledger holds is never overwritten"
                      : `Compared only: the ${owner(d.systemOfRecord)} owns these facts`}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </TableWrap>
        <div>
          <p className="font-semibold">What happens to the file</p>
          <p className="text-muted" data-testid="upload-retention">
            {workspace ? (
              <>
                It is read and profiled on this server, compared with the ledger, and never added to it or sent to a model. Only your browser can open it: a
                private cookie names your workspace, with no account. It is available for {WORKSPACE.retentionHours} hours, then deleted within a day with every
                row, mapping and result (sooner if the demo is full), and you can delete it at any time.
              </>
            ) : (
              <>
                It is read and profiled on this server and never sent to a model. Its cells are personal data: they are staged apart from the ledger and deleted
                when the upload is published, rejected or {LIMITS.retentionHours} hours old. The profile, the mapping versions and every row&apos;s outcome stay as
                the record.
              </>
            )}
          </p>
        </div>
      </div>
    </Card>
  );
}

async function Uploads({ searchParams }: Props) {
  const viewer = await getViewer();
  const access = onboardingAccess(viewer);
  if (access === null) {
    return <Forbidden message="Data onboarding is limited to company-wide analyst, engineer and approver roles: an export spans every branch." />;
  }
  const workspace = access === "workspace";
  const [uploads, sp] = await Promise.all([listUploads(getPool(), viewer, await businessNow()), searchParams]);
  const maxBytes = workspace ? WORKSPACE.maxBytes : LIMITS.maxUploadBytes;
  const maxRows = workspace ? WORKSPACE.maxRows : LIMITS.maxRows;
  const canUpload = workspace || viewer.can.propose;
  return (
    <>
      {sp.deleted === "1" && workspace && (
        <Callout tone="good" title="Deleted" testId="workspace-deleted">
          The upload, its rows, its mappings and its result are gone.
        </Callout>
      )}
      <Card
        title="Upload an export"
        subtitle={workspace ? "Compared with the ledger, never added to it. Only your browser can open it." : "The file is staged apart from the ledger. Its cells are personal data and are deleted when the upload is published, rejected or 24 hours old."}
      >
        <UploadForm
          canUpload={canUpload}
          reason={canUpload ? null : `${viewer.label} reviews and approves; uploading is for analysts and engineers.`}
          maxBytes={maxBytes}
          scope={workspace ? "workspace" : "company"}
          limits={`CSV, XLSX or JSON, up to ${megabytes(maxBytes)} and ${count(maxRows)} rows. ${workspace ? `Available for ${WORKSPACE.retentionHours} hours, then deleted.` : "Staged rows are deleted after 24 hours."}`}
        />
      </Card>
      {workspace && (
        <Callout title="Comparison workspace on the public demo" testId="workspace-mode">
          Upload an export and see what it would change: every row is checked and compared with the ledger, and nothing is added to it. Files are counted only in
          the{" "}
          <a href={LOCAL_DEMO_URL} className="text-accent hover:underline">
            local demo
          </a>
          , after a second person approves the mapping and publishes; ad-spend and payment files are compared, never counted. This is a public demo: upload a
          synthetic or test export, not real customer data.
        </Callout>
      )}
      <UploadTerms workspace={workspace} />
      {!workspace && (
        <Callout title="What a file may do">
          Calls and web leads may be <strong>published</strong> after approval, to backfill deliveries the live feed missed; a row the ledger already holds is never overwritten.
          CRM payments and ad spend are <strong>reconcile only</strong>: the file is compared with the ledger, fact by fact, and every cent of difference is listed.
        </Callout>
      )}
      <Card title={workspace ? "Your uploads" : "Recent uploads"} flush>
        {uploads.length === 0 ? (
          <div className="p-4">
            <EmptyState title="No uploads yet">Upload an export or try one of the synthetic samples above.</EmptyState>
          </div>
        ) : (
          <TableWrap flush label={workspace ? "Your uploads" : "Recent uploads"} minWidth={760}>
            <thead>
              <tr>
                <Th>File</Th>
                <Th>Looks like</Th>
                <Th align="right">Rows</Th>
                {!workspace && <Th>Status</Th>}
                <Th>{workspace ? "Started" : "Uploaded"}</Th>
                <Th>{workspace ? "Available" : "Staged rows"}</Th>
              </tr>
            </thead>
            <tbody>
              {uploads.map((u) => (
                <tr key={u.id} className="border-t border-border">
                  <Td>
                    <Link href={`/onboarding/${u.id}`} className="font-medium text-accent hover:underline">
                      {u.filename}
                    </Link>
                    <span className="ml-2 text-xs uppercase text-faint">{u.format}</span>
                  </Td>
                  <Td>{u.dataset ? DATASETS[u.dataset].label : <span className="text-muted">No dataset fits</span>}</Td>
                  <Td align="right">{count(u.rowCount)}</Td>
                  {!workspace && (
                    <Td>
                      <Badge tone={STATUS_TONE[u.status] ?? "neutral"} dot>
                        {u.status}
                      </Badge>
                    </Td>
                  )}
                  <Td>
                    <span className="text-sm">{dateTime(u.workspaceStartedAt ?? u.uploadedAt)}</span>
                    {!workspace && <span className="block text-xs text-muted">{u.uploadedBy}</span>}
                  </Td>
                  <Td className="text-sm">
                    {u.workspaceStartedAt ? availabilitySentence(u.workspaceStartedAt) : u.rowsPurged ? <span className="text-muted">deleted</span> : <span>until {dateTime(u.expiresAt)}</span>}
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>
    </>
  );
}
