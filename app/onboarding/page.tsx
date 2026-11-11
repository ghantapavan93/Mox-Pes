import Link from "next/link";
import { Suspense } from "react";
import { UploadForm } from "@/components/onboarding/UploadForm";
import { Badge, Callout, Card, EmptyState, Forbidden, PageHeader, Skeleton, TableWrap, Td, Th } from "@/components/ui";
import { count, dateTime } from "@/lib/format";
import { listUploads } from "@/lib/onboarding/service";
import { DATASETS } from "@/lib/onboarding/targets";
import { businessNow, getPool, getViewer } from "@/lib/server";

export default function OnboardingPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        crumbs={[{ label: "Systems" }, { label: "Data onboarding" }]}
        title="Data onboarding"
        badges={<Badge tone="accent">synthetic data only</Badge>}
        description={
          <>
            Bring an export the system has never seen. It is profiled, its columns are matched to business meanings with the evidence shown, ambiguous meanings are
            put to you as questions, and every row is checked with the same rules a live feed meets. Nothing reaches the ledger without an independent approval, and
            payments and ad spend can only be compared, never published: the CRM and the ad platforms own those facts.
          </>
        }
      />
      <Suspense fallback={<Skeleton lines={8} />}>
        <Uploads />
      </Suspense>
    </div>
  );
}

const STATUS_TONE: Record<string, "neutral" | "good" | "warn" | "bad" | "accent"> = { staged: "accent", published: "good", expired: "neutral", rejected: "bad", deleted: "neutral" };

async function Uploads() {
  const viewer = await getViewer();
  if (viewer.branchIds !== null || !(viewer.can.propose || viewer.can.approve)) {
    return <Forbidden message="Data onboarding is limited to company-wide analyst, engineer and approver roles: an export spans every branch." />;
  }
  const uploads = await listUploads(getPool(), viewer, await businessNow());
  return (
    <>
      <Card title="Upload an export" subtitle="The file is staged apart from the ledger. Its cells are personal data and are deleted when the upload is published, rejected or 24 hours old.">
        <UploadForm canUpload={viewer.can.propose} reason={viewer.can.propose ? null : `${viewer.label} reviews and approves; uploading is for analysts and engineers.`} />
      </Card>
      <Callout title="What a file may do">
        Calls and web leads may be <strong>published</strong> after approval, to backfill deliveries the live feed missed; a row the ledger already holds is never overwritten.
        CRM payments and ad spend are <strong>reconcile only</strong>: the file is compared with the ledger, fact by fact, and every cent of difference is listed.
      </Callout>
      <Card title="Recent uploads" flush>
        {uploads.length === 0 ? (
          <div className="p-4">
            <EmptyState title="No uploads yet">Upload an export or try one of the synthetic samples above.</EmptyState>
          </div>
        ) : (
          <TableWrap flush label="Recent uploads" minWidth={760}>
            <thead>
              <tr>
                <Th>File</Th>
                <Th>Looks like</Th>
                <Th align="right">Rows</Th>
                <Th>Status</Th>
                <Th>Uploaded</Th>
                <Th>Staged rows</Th>
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
                  <Td>
                    <Badge tone={STATUS_TONE[u.status] ?? "neutral"} dot>
                      {u.status}
                    </Badge>
                  </Td>
                  <Td>
                    <span className="text-sm">{dateTime(u.uploadedAt)}</span>
                    <span className="block text-xs text-muted">{u.uploadedBy}</span>
                  </Td>
                  <Td>{u.rowsPurged ? <span className="text-muted">deleted</span> : <span>until {dateTime(u.expiresAt)}</span>}</Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>
    </>
  );
}
