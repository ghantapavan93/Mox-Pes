import Link from "next/link";
import { Suspense } from "react";
import { ChangeForm } from "@/components/changes/ChangeForm";
import { Badge, Callout, Card, EmptyState, PageHeader, Skeleton, TableWrap, Td, Th } from "@/components/ui";
import { listCampaignOptions, listChanges } from "@/lib/changeguard/service";
import { dateTime } from "@/lib/format";
import { BRANCHES } from "@/lib/reference";
import { getPool, getViewer } from "@/lib/server";
import { STATUS_TONE } from "./status";

export default function ChangesPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        crumbs={[{ label: "Systems" }, { label: "ChangeGuard" }]}
        title="ChangeGuard"
        badges={<Badge tone="accent">synthetic environment only</Badge>}
        description={
          <p className="max-w-3xl">
            Check a configuration change before it lands. A proposed campaign mapping is run through the production write path in a transaction that is rolled back,
            measured against reporting, approved by a different person against exactly what was checked, released into the synthetic environment and verified. No
            ad platform, call-tracking or CRM account is touched.
          </p>
        }
      />
      <Suspense fallback={<Skeleton lines={10} />}>
        <Changes />
      </Suspense>
    </div>
  );
}

async function Changes() {
  const viewer = await getViewer();
  const pool = getPool();
  const [changes, campaigns] = await Promise.all([listChanges(pool, viewer), viewer.can.propose ? listCampaignOptions(pool, viewer) : Promise.resolve([])]);
  const branches = BRANCHES.filter((b) => !viewer.branchIds || viewer.branchIds.includes(b.id)).map((b) => ({ id: b.id, label: `${b.id} ${b.name} (${b.brandId})` }));
  return (
    <>
      {viewer.can.propose ? (
        <Card title="Propose a campaign mapping change" subtitle="Campaigns without a branch are listed first. The preflight answers fourteen questions before anyone reviews it.">
          <ChangeForm campaigns={campaigns} branches={branches} />
        </Card>
      ) : (
        <Callout title="Read-only for your role">{viewer.label} can read changes in scope. Analysts and engineers propose; approvers decide.</Callout>
      )}
      <Card title="Changes" flush>
        {changes.length === 0 ? (
          <div className="p-4">
            <EmptyState title="No changes yet">Propose one above: an unmapped campaign is a good first change.</EmptyState>
          </div>
        ) : (
          <TableWrap flush label="Configuration changes" minWidth={720} testId="change-list">
            <thead>
              <tr>
                <Th>Change</Th>
                <Th>Preflight</Th>
                <Th>Status</Th>
                <Th>Proposed</Th>
              </tr>
            </thead>
            <tbody>
              {changes.map((c) => (
                <tr key={c.id} className="border-t border-border">
                  <Td>
                    <Link href={`/changes/${c.id}`} className="font-medium text-accent hover:underline">
                      #{c.id} {c.title}
                    </Link>
                    <span className="block text-xs text-muted">{c.kind === "campaign_mapping" ? "Campaign mapping" : "Source contract check"}</span>
                  </Td>
                  <Td>{c.preflight ? <Badge tone={c.preflight.verdict === "fail" ? "bad" : c.preflight.verdict === "warn" ? "warn" : "good"}>{c.preflight.verdict}</Badge> : <span className="text-muted">—</span>}</Td>
                  <Td>
                    <Badge tone={STATUS_TONE[c.status]} dot>
                      {c.status.replaceAll("_", " ")}
                    </Badge>
                  </Td>
                  <Td>
                    <span className="text-sm">{dateTime(c.createdAt)}</span>
                    <span className="block text-xs text-muted">{c.authorSubject}</span>
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
