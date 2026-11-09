import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense, type ReactNode } from "react";
import { IdentityPanel } from "@/components/customers/IdentityPanel";
import { JourneyTimeline } from "@/components/customers/JourneyTimeline";
import { Badge, Card, Skeleton, TableWrap, Td, Th } from "@/components/ui";
import { KIND_LABEL, count, date, dateTime, money } from "@/lib/format";
import { LIFECYCLE_TONE, getCustomerJourney, getProspectJourney, parseJourneyRef, type CustomerJourney } from "@/lib/identity";
import { BRANCH_BY_ID, CHANNEL_BY_CODE, type ChannelCode } from "@/lib/reference";
import { getPool, getViewer } from "@/lib/server";

type Props = { params: Promise<{ id: string }> };

export default function CustomerJourneyPage(props: Props) {
  return (
    <Suspense fallback={<JourneySkeleton />}>
      <Journey {...props} />
    </Suspense>
  );
}

function JourneySkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading customer journey">
      <div className="h-16 animate-pulse rounded bg-surface-2" />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="h-16 animate-pulse rounded-lg bg-surface-2" />
        ))}
      </div>
      <Skeleton lines={10} />
    </div>
  );
}

const channelLabel = (code: string | null | undefined) => (code ? (CHANNEL_BY_CODE.get(code as ChannelCode)?.label ?? code) : "Unknown");
const BASIS_LABEL: Record<string, { text: string; tone: "good" | "warn" | "bad" }> = {
  lead_evidence: { text: "lead with tracking evidence", tone: "good" },
  lead_without_evidence: { text: "lead without evidence", tone: "warn" },
  no_lead_record: { text: "no lead record", tone: "bad" },
};
const Unknown = ({ children = "unknown" }: { children?: ReactNode }) => <span className="font-normal italic text-faint">{children}</span>;

/** Label/value rows for the narrow side column (KV's two-column grid is for full-width cards). */
function Facts({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="divide-y divide-dashed divide-border text-sm">
      {items.map(([k, v]) => (
        <div key={k} className="flex items-start justify-between gap-3 py-1">
          <dt className="shrink-0 text-muted">{k}</dt>
          <dd className="min-w-0 text-right font-medium tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

async function Journey({ params }: Props) {
  const { id } = await params;
  const ref = parseJourneyRef(id);
  if (!ref) notFound();
  const viewer = await getViewer();
  const pool = getPool();
  // Out of scope reads as missing (null → 404), never as a refusal naming the other branch.
  const journey: CustomerJourney | null =
    ref.kind === "customer" ? await getCustomerJourney(pool, ref.crmCustomerId, viewer.branchIds) : await getProspectJourney(pool, ref.identityId, viewer.branchIds);
  if (!journey) notFound();
  const o = journey.overview;
  const isCustomer = journey.ref.kind === "customer";
  const title = isCustomer ? `Customer ${journey.ref.crmCustomerId}` : `Prospect P-${journey.ref.identityId}`;

  return (
    <div className="space-y-6">
      <header>
        <p className="text-xs text-faint">
          <Link href="/customers" className="hover:underline">Customer Journeys</Link> / {isCustomer ? journey.ref.crmCustomerId : `P-${journey.ref.identityId}`}
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <Badge tone={LIFECYCLE_TONE[o.lifecycle]}>{o.lifecycle}</Badge>
          {o.branchId ? (
            <Link href={`/branches/${o.branchId}`} className="text-sm text-accent hover:underline">
              {o.branchId} {BRANCH_BY_ID.get(o.branchId)?.name}
            </Link>
          ) : (
            <Badge tone="warn">branch unknown</Badge>
          )}
          {o.flags.pendingConflicts > 0 && <Badge tone="warn">{o.flags.pendingConflicts} identity match{o.flags.pendingConflicts === 1 ? "" : "es"} to review</Badge>}
          {o.flags.d2dPaidConflict && <Badge tone="warn">D2D / paid conflict</Badge>}
          {o.flags.noLeadRecord && <Badge tone="bad">no lead record</Badge>}
          {o.retired && <Badge tone="neutral">retired prospect</Badge>}
        </div>
        <p className="mt-2 text-sm text-muted">
          {isCustomer ? <>CRM customer since {dateTime(o.customerSince)} · </> : <>No CRM customer record · </>}
          {count(o.leadRecords)} lead record{o.leadRecords === 1 ? "" : "s"}
          {o.firstTouch && <> · first touch {dateTime(o.firstTouch.at)} ({channelLabel(o.firstTouch.channelCode)}, {o.firstTouch.source} {o.firstTouch.sourceLeadId})</>}
          {journey.resolution.lastRunAt && <> · identity resolved as of {dateTime(journey.resolution.lastRunAt)}</>}
        </p>
        {o.flags.openExceptions.length > 0 && (
          <p className="mt-1 flex flex-wrap gap-2 text-xs">
            <span className="text-muted">Exceptions touching this customer:</span>
            {o.flags.openExceptions.map((e) => (
              <Link key={e.id} href={`/exceptions/${e.id}`} className="text-accent hover:underline">
                #{e.id} {KIND_LABEL[e.kind] ?? e.kind} ({e.status})
              </Link>
            ))}
          </p>
        )}
        {o.retired && (
          <p className="mt-2 rounded bg-surface-2 p-2 text-sm text-muted">
            Retired {dateTime(o.retired.at)}: its leads now belong to{" "}
            {o.retired.nowPartOf.length === 0
              ? "no identity yet"
              : o.retired.nowPartOf.map((p, i) => (
                  <span key={p.identityId}>
                    {i > 0 && ", "}
                    <Link className="text-accent hover:underline" href={p.crmCustomerId !== null ? `/customers/${p.crmCustomerId}` : `/customers/P-${p.identityId}`}>
                      {p.crmCustomerId !== null ? `customer ${p.crmCustomerId}` : `prospect P-${p.identityId}`}
                    </Link>
                  </span>
                ))}
            .
          </p>
        )}
      </header>

      {isCustomer && <MoneyStrip journey={journey} />}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card
          className="lg:col-span-2"
          title={`Timeline (${count(journey.timeline.length)} records)`}
          subtitle="Every lead and CRM record in source order. Each line names its table, id and raw event; open it to see the stored payload and the mapper version that read it."
        >
          <JourneyTimeline items={journey.timeline} journeyId={id} />
        </Card>
        <div className="space-y-6">
          {isCustomer ? <AttributionCard journey={journey} /> : <ProspectCard journey={journey} />}
          <FreshnessCard journey={journey} />
          <UnknownsCard journey={journey} />
        </div>
      </div>

      <IdentityPanel journey={journey} viewer={viewer} />

      {isCustomer && <RecordsCard journey={journey} />}
    </div>
  );
}

function MoneyStrip({ journey }: { journey: CustomerJourney }) {
  const m = journey.money;
  const acv = journey.attribution?.annualValueCents ?? null;
  const tiles: Array<{ label: string; value: string; sub: string; tone?: string }> = [
    { label: "Collected", value: money(m.collectedCents), sub: "successful payments − refunds", tone: "text-text" },
    { label: "Successful payments", value: money(m.paymentsCents), sub: `${count(journey.payments.filter((p) => p.status === "successful" && !p.isRefund).length)} payments` },
    { label: "Refunds", value: money(m.refundsCents), sub: `${count(journey.payments.filter((p) => p.isRefund).length)} refunds`, tone: m.refundsCents > 0 ? "text-warn" : undefined },
    { label: "Failed or voided", value: money(m.failedOrVoidedCents), sub: "never counted as collected", tone: m.failedOrVoidedCents > 0 ? "text-bad" : undefined },
    { label: "Invoiced", value: money(m.invoicedCents), sub: `${count(journey.tickets.length)} invoices · not revenue until paid` },
    { label: "First subscription value", value: acv === null ? "—" : money(acv), sub: "annual contract value (booked, not collected)" },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6" data-testid="journey-money">
      {tiles.map((t) => (
        <div key={t.label} className="rounded-lg border border-border bg-surface p-3">
          <div className="text-xs text-muted">{t.label}</div>
          <div className={`mt-1 text-xl font-semibold tabular-nums ${t.tone ?? "text-text"}`}>{t.value}</div>
          <div className="text-[11px] text-faint">{t.sub}</div>
        </div>
      ))}
    </div>
  );
}

function AttributionCard({ journey }: { journey: CustomerJourney }) {
  const a = journey.attribution;
  if (!a) {
    return (
      <Card title="Attribution">
        <p className="text-sm text-muted">No subscription has been delivered for this customer yet, so there is no acquisition to attribute.</p>
      </Card>
    );
  }
  const basis = BASIS_LABEL[a.attributionBasis];
  const branchDiffers = a.leadBranchId !== null && a.leadBranchId !== journey.overview.branchId;
  return (
    <Card
      title="Attribution"
      subtitle={
        <>
          From <span className="font-mono">v_acquisitions</span>: first touch with evidence in the 60 days before the first sale. Unknown stays unknown.{" "}
          <Link href="/definitions" className="text-accent hover:underline">Definitions</Link>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-lg font-semibold">{channelLabel(a.channelCode)}</span>
          <Badge tone={basis.tone}>{basis.text}</Badge>
        </div>
        <Facts
          items={[
            ["Evidence", a.attributionEvidence ?? <Unknown>none</Unknown>],
            [
              "Credited touch",
              a.creditedLeadSourceId ? (
                <span>
                  {a.creditedLeadSource} <span className="font-mono">{a.creditedLeadSourceId}</span>
                  <span className="block text-xs font-normal text-muted">{dateTime(a.creditedLeadAt)}</span>
                </span>
              ) : (
                <Unknown>no lead record</Unknown>
              ),
            ],
            ["Campaign", a.campaignName ? <span>{a.campaignName}<span className="block text-xs font-normal text-muted">{a.campaignPlatform}</span></span> : a.campaignExternalId ? <span className="font-mono">{a.campaignExternalId}</span> : <Unknown>not sent by source</Unknown>],
            ["Lead branch", a.leadBranchId ? <span className={branchDiffers ? "text-warn" : ""}>{a.leadBranchId}{branchDiffers ? " (differs)" : ""}</span> : <Unknown />],
            ["First sale", dateTime(a.soldAt)],
            ["Initial service", <span key="initial">{a.initialStatus}{a.initialCompletedAt ? <span className="block text-xs font-normal text-muted">{dateTime(a.initialCompletedAt)}</span> : null}</span>],
          ]}
        />
        {a.creditedLeadId !== null && !a.creditedLeadLinked && (
          <p className="rounded bg-warn-soft p-2 text-xs text-warn">
            The attribution view credits a lead that identity resolution has not linked to this customer (it is awaiting review or was attached elsewhere). See Identity below.
          </p>
        )}
        {a.channelConflict && (
          <p className="rounded bg-warn-soft p-2 text-xs text-warn">A paid touch reached this customer first and a door-to-door rep then signed them: credit stays with the first evidenced touch, flagged for commission review.</p>
        )}
      </div>
    </Card>
  );
}

function ProspectCard({ journey }: { journey: CustomerJourney }) {
  const anchor = journey.ref.anchorKey ?? "";
  return (
    <Card title="Prospect" subtitle="Leads that match no CRM customer, grouped by one phone hash (else one email hash): the same rule as the prospect counts.">
      <Facts
        items={[
          ["Grouped by", anchor.startsWith("phone:") ? "phone hash" : "email hash"],
          ["Lead records", count(journey.leads.length)],
          ["Branch (latest lead)", journey.overview.branchId ?? <Unknown />],
          ["First touch", journey.overview.firstTouch ? dateTime(journey.overview.firstTouch.at) : <Unknown />],
        ]}
      />
    </Card>
  );
}

function FreshnessCard({ journey }: { journey: CustomerJourney }) {
  return (
    <Card title="Freshness" subtitle="Latest source update and latest receipt (our clock) per entity">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-[11px] uppercase tracking-wide text-faint">
            <th className="pb-1 font-semibold">Entity</th>
            <th className="pb-1 text-right font-semibold">Records</th>
            <th className="pb-1 text-right font-semibold">Source updated</th>
            <th className="pb-1 text-right font-semibold">Received</th>
          </tr>
        </thead>
        <tbody>
          {journey.freshness.map((f) => (
            <tr key={f.entity} className="border-t border-border">
              <td className="py-1">{f.entity}</td>
              <td className="py-1 text-right tabular-nums">{count(f.records)}</td>
              <td className="py-1 text-right">{f.latestSourceUpdatedAt ? dateTime(f.latestSourceUpdatedAt) : <Unknown>none</Unknown>}</td>
              <td className="py-1 text-right">{f.latestReceivedAt ? dateTime(f.latestReceivedAt) : <Unknown>none</Unknown>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

function UnknownsCard({ journey }: { journey: CustomerJourney }) {
  const list = journey.unknowns;
  return (
    <Card title={`Not provided by the source (${count(list.length)})`} subtitle="Shown as unknown on this page, never filled in or guessed">
      {list.length === 0 ? (
        <p className="text-sm text-muted">Every field this page shows was provided by its source.</p>
      ) : (
        <ul className="max-h-56 space-y-1 overflow-y-auto text-xs">
          {list.map((u, i) => (
            <li key={`${u.subject}:${u.field}:${i}`}>
              <span className="font-medium">{u.subject}</span> · {u.field}: <span className="text-muted">{u.note}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function RecordsCard({ journey }: { journey: CustomerJourney }) {
  return (
    <Card title="CRM records" subtitle="As projected from the CRM, with the raw event each row came from">
      <div className="grid gap-6 xl:grid-cols-3">
        <section aria-labelledby="subs-h">
          <h3 id="subs-h" className="mb-1 text-xs font-semibold uppercase tracking-wide text-faint">Subscriptions ({count(journey.subscriptions.length)})</h3>
          <TableWrap>
            <thead><tr><Th>Id</Th><Th>Status</Th><Th>Sold</Th><Th align="right">Annual value</Th></tr></thead>
            <tbody>
              {journey.subscriptions.map((s) => (
                <tr key={s.id}>
                  <Td className="font-mono text-xs">{s.id}<div className="text-faint">raw #{s.rawEventId}</div></Td>
                  <Td className="text-xs"><Badge tone={s.status === "active" ? "good" : "bad"}>{s.status}</Badge>{s.cancelledAt && <div className="text-faint">{date(s.cancelledAt)}</div>}</Td>
                  <Td className="text-xs">{date(s.soldAt)}<div className="text-faint">{s.soldByRep ? `rep ${s.soldByRep}` : "no rep recorded"}</div></Td>
                  <Td align="right" className="text-xs">{money(s.annualValueCents)}</Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </section>
        <section aria-labelledby="appts-h">
          <h3 id="appts-h" className="mb-1 text-xs font-semibold uppercase tracking-wide text-faint">Appointments ({count(journey.appointments.length)})</h3>
          <TableWrap>
            <thead><tr><Th>Id</Th><Th>Kind</Th><Th>Status</Th><Th>When</Th></tr></thead>
            <tbody>
              {journey.appointments.map((a) => (
                <tr key={a.id}>
                  <Td className="font-mono text-xs">{a.id}<div className="text-faint">raw #{a.rawEventId}</div></Td>
                  <Td className="text-xs">{a.kind}</Td>
                  <Td className="text-xs"><Badge tone={a.status === "completed" ? "good" : a.status === "cancelled" ? "bad" : a.status === "pending" ? "neutral" : "warn"}>{a.status}</Badge></Td>
                  <Td className="text-xs">{dateTime(a.completedAt ?? a.scheduledFor)}<div className="text-faint">{a.completedAt ? "completed" : "scheduled"}</div></Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </section>
        <section aria-labelledby="pays-h">
          <h3 id="pays-h" className="mb-1 text-xs font-semibold uppercase tracking-wide text-faint">Payments and refunds ({count(journey.payments.length)})</h3>
          <TableWrap>
            <thead><tr><Th>Id</Th><Th>Status</Th><Th>When</Th><Th align="right">Amount</Th></tr></thead>
            <tbody>
              {journey.payments.map((p) => (
                <tr key={p.id}>
                  <Td className="font-mono text-xs">{p.id}<div className="text-faint">raw #{p.rawEventId}</div></Td>
                  <Td className="text-xs">
                    <Badge tone={p.isRefund ? "warn" : p.status === "successful" ? "good" : "bad"}>{p.isRefund ? "refund" : p.status}</Badge>
                    {p.isRefund && <div className="text-faint">of {p.originalPaymentId}</div>}
                  </Td>
                  <Td className="text-xs">{dateTime(p.paidAt)}</Td>
                  <Td align="right" className={`text-xs ${p.isRefund ? "text-warn" : p.status !== "successful" ? "text-faint line-through" : ""}`}>{money(p.amountCents)}</Td>
                </tr>
              ))}
              <tr>
                <Td className="text-xs font-semibold">Collected</Td>
                <Td />
                <Td className="text-xs text-muted">payments − refunds</Td>
                <Td align="right" className="text-xs font-semibold">{money(journey.money.collectedCents)}</Td>
              </tr>
            </tbody>
          </TableWrap>
        </section>
      </div>
    </Card>
  );
}
