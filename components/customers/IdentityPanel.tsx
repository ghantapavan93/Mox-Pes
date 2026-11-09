import Link from "next/link";
import { Badge, Card, TableWrap, Td, Th } from "@/components/ui";
import { dateTime } from "@/lib/format";
import type { IdentityConflict } from "@/lib/identity/conflicts";
import type { CustomerJourney, JourneyLink, UnresolvedMatch } from "@/lib/identity/journey";
import { CONFLICT_KIND_LABEL, RULE_LABEL, type ConflictStatus, type IdentityRule } from "@/lib/identity/types";
import { VIEWERS, type Viewer } from "@/lib/viewer";
import { ConflictDecision } from "./ConflictDecision";

const RULE_TONE: Record<IdentityRule, "neutral" | "good" | "accent" | "warn"> = {
  crm_customer_anchor: "neutral",
  exact_phone_hash: "good",
  exact_email_hash: "good",
  prospect_phone_hash: "neutral",
  prospect_email_hash: "neutral",
  reviewer_accepted: "accent",
};

const STATUS_TONE: Record<ConflictStatus, "warn" | "good" | "bad" | "neutral"> = {
  pending: "warn",
  accepted: "good",
  rejected: "bad",
  superseded: "neutral",
};

const SOURCE_LABEL: Record<string, string> = { crm: "CRM", calls: "Call", web: "Web form", d2d: "D2D sale" };

/** The roles that may decide, named from the permission table rather than hardcoded. */
const REVIEWERS = Object.values(VIEWERS)
  .filter((v) => v.can.reviewIdentity)
  .map((v) => v.label.split(" · ")[0].toLowerCase())
  .join(" or ");

/** A hash is shown as a short prefix: enough to compare by eye, never the contact detail. */
const shortHash = (h: unknown) => (typeof h === "string" && h.length > 10 ? `${h.slice(0, 10)}…` : String(h ?? "—"));

function LinkEvidence({ link }: { link: JourneyLink }) {
  const ev = link.evidence;
  if (link.rule === "crm_customer_anchor") return <span className="text-faint">the CRM record itself</span>;
  if (link.rule === "reviewer_accepted") {
    return (
      <span>
        conflict #{String(ev.conflictId)} accepted by <span className="font-medium">{String(ev.decidedBy)}</span>
        {typeof ev.decidedAt === "string" ? ` · ${dateTime(ev.decidedAt)}` : ""}
        {typeof ev.reason === "string" && <span className="block text-faint">“{ev.reason}”</span>}
      </span>
    );
  }
  const rejected = Array.isArray(ev.rejectedCandidates) ? ev.rejectedCandidates.length : 0;
  return (
    <span>
      {String(ev.matchedKey).replace("_", " ")} <span className="font-mono text-faint">{shortHash(ev.hash)}</span>
      {ev.alsoMatchedEmail === true && <span className="text-faint"> · email agrees</span>}
      {rejected > 0 && <span className="block text-warn">kept as prospect: {rejected} CRM candidate{rejected === 1 ? "" : "s"} rejected by a reviewer</span>}
    </span>
  );
}

const UNRESOLVED_LABEL: Record<UnresolvedMatch["state"], { text: string; tone: "warn" | "neutral" | "bad" }> = {
  pending_review: { text: "awaiting review", tone: "warn" },
  linked_elsewhere: { text: "linked elsewhere", tone: "neutral" },
  not_yet_resolved: { text: "arrived after last resolution run", tone: "bad" },
};

export function IdentityPanel({ journey, viewer }: { journey: CustomerJourney; viewer: Viewer }) {
  const pending = journey.conflicts.filter((c) => c.status === "pending");
  const history = journey.conflicts.filter((c) => c.status !== "pending");
  return (
    <Card
      title="Identity"
      subtitle="Deterministic rules only: an exact phone hash, else an exact email hash, that points at exactly one CRM customer. Never a name, an address or a fuzzy match."
      action={
        journey.ref.identityId !== null ? (
          <span className="font-mono text-[11px] text-faint">identity {journey.ref.identityId} · anchor {shortHash(journey.ref.anchorKey)}</span>
        ) : (
          <Badge tone="warn">not yet resolved</Badge>
        )
      }
    >
      <div className="space-y-5">
        {!journey.resolution.identityResolved && (
          <p className="rounded bg-warn-soft p-2 text-xs text-warn">
            This CRM customer arrived after the last identity resolution run{journey.resolution.lastRunAt ? ` (${dateTime(journey.resolution.lastRunAt)})` : ""}. Its CRM records are shown; lead records attach on the next run.
          </p>
        )}
        <section aria-labelledby="links-heading">
          <h3 id="links-heading" className="mb-1 text-xs font-semibold uppercase tracking-wide text-faint">
            Linked source records ({journey.links.length})
          </h3>
          {journey.links.length === 0 ? (
            <p className="text-sm text-muted">No records linked yet.</p>
          ) : (
            <TableWrap>
              <thead>
                <tr>
                  <Th>Source record (original id)</Th>
                  <Th>Rule</Th>
                  <Th align="right">Confidence</Th>
                  <Th>Evidence</Th>
                  <Th>Link last changed</Th>
                </tr>
              </thead>
              <tbody data-testid="identity-links">
                {journey.links.map((l) => (
                  <tr key={l.id}>
                    <Td className="text-xs">
                      <span className="text-muted">{SOURCE_LABEL[l.source]}</span> <span className="font-mono">{l.sourceRecordId}</span>
                    </Td>
                    <Td className="text-xs"><Badge tone={RULE_TONE[l.rule]}>{RULE_LABEL[l.rule]}</Badge></Td>
                    <Td align="right" className="text-xs">{l.confidence.toFixed(2)}</Td>
                    <Td className="text-xs"><LinkEvidence link={l} /></Td>
                    <Td className="text-xs text-muted">{dateTime(l.linkedAt)}</Td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </section>

        {journey.ref.kind === "customer" && (
          <section aria-labelledby="unresolved-heading">
            <h3 id="unresolved-heading" className="mb-1 text-xs font-semibold uppercase tracking-wide text-faint">
              Share this customer&apos;s phone or email hash but are not linked ({journey.unresolvedMatches.length})
            </h3>
            {journey.unresolvedMatches.length === 0 ? (
              <p className="text-sm text-muted">None: every lead with this customer&apos;s phone or email hash is linked above.</p>
            ) : (
              <ul className="space-y-1 text-xs">
                {journey.unresolvedMatches.map((m) => (
                  <li key={m.leadId} className="flex flex-wrap items-center gap-2">
                    <Badge tone={UNRESOLVED_LABEL[m.state].tone}>{UNRESOLVED_LABEL[m.state].text}</Badge>
                    <span>{SOURCE_LABEL[m.source]} <span className="font-mono">{m.sourceLeadId}</span></span>
                    <span className="text-muted">{dateTime(m.occurredAt)} · matched on {m.matchedOn.join(" + ").replaceAll("_", " ")}</span>
                    {m.linkedTo && (
                      <Link className="text-accent hover:underline" href={m.linkedTo.crmCustomerId !== null ? `/customers/${m.linkedTo.crmCustomerId}` : `/customers/P-${m.linkedTo.identityId}`}>
                        → {m.linkedTo.crmCustomerId !== null ? `customer ${m.linkedTo.crmCustomerId}` : `prospect P-${m.linkedTo.identityId}`} ({RULE_LABEL[m.linkedTo.rule].toLowerCase()})
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        <section aria-labelledby="conflicts-heading">
          <h3 id="conflicts-heading" className="mb-1 text-xs font-semibold uppercase tracking-wide text-faint">
            Ambiguous matches ({pending.length} pending · {history.length} decided or superseded)
          </h3>
          {journey.conflicts.length === 0 ? (
            <p className="text-sm text-muted">No ambiguous matches involve this {journey.ref.kind === "customer" ? "customer" : "prospect"}.</p>
          ) : (
            <ConflictList conflicts={[...pending, ...history]} viewer={viewer} />
          )}
          {pending.length > 0 && !viewer.can.reviewIdentity && (
            <p className="mt-2 text-xs text-muted">Your role is read-only here. A {REVIEWERS} decides identity matches.</p>
          )}
        </section>
      </div>
    </Card>
  );
}

export function ConflictList({ conflicts, viewer, showCustomer = true }: { conflicts: IdentityConflict[]; viewer: Viewer; showCustomer?: boolean }) {
  return (
    <TableWrap>
      <thead>
        <tr>
          <Th>Lead</Th>
          {showCustomer && <Th>Candidate CRM customer</Th>}
          <Th>Why it is ambiguous</Th>
          <Th>Status</Th>
          <Th>Decision</Th>
        </tr>
      </thead>
      <tbody data-testid="identity-conflicts">
        {conflicts.map((c) => (
          <tr key={c.id}>
            <Td className="text-xs">
              <span className="text-muted">{SOURCE_LABEL[c.leadSource]}</span> <span className="font-mono">{c.leadSourceRecordId}</span>
              <div className="text-faint">conflict #{c.id} · {c.leadBranchId ?? "branch unknown"}</div>
            </Td>
            {showCustomer && (
              <Td className="text-xs">
                <Link href={`/customers/${c.crmCustomerId}`} className="font-medium text-accent hover:underline">{c.crmCustomerId}</Link>
                <div className="text-faint">{c.customerBranchId ?? "branch unknown"}</div>
              </Td>
            )}
            <Td className="text-xs">
              {CONFLICT_KIND_LABEL[c.kind]}
              <div className="text-faint">
                matched on {c.evidence.matchedOn.join(" + ").replaceAll("_", " ")} · {c.evidence.candidateCount} candidate{c.evidence.candidateCount === 1 ? "" : "s"}:{" "}
                {c.evidence.candidates.map((x) => x.crmCustomerId).join(", ")}
              </div>
              {c.priorDecision && (
                <div className="text-warn">
                  evidence changed since #{c.priorDecision.id} was {c.priorDecision.status} by {c.priorDecision.decidedBy}
                </div>
              )}
            </Td>
            <Td className="text-xs">
              <Badge tone={STATUS_TONE[c.status]}>{c.status}</Badge>
              <div className="text-faint">detected {dateTime(c.detectedAt)}</div>
            </Td>
            <Td className="min-w-64 text-xs">
              {c.status === "pending" ? (
                viewer.can.reviewIdentity ? (
                  <ConflictDecision conflictId={c.id} leadLabel={`${SOURCE_LABEL[c.leadSource]} ${c.leadSourceRecordId}`} customerId={c.crmCustomerId} />
                ) : (
                  <span className="text-muted">Awaiting a reviewer</span>
                )
              ) : (
                <span>
                  {c.decidedBy} · {dateTime(c.decidedAt)}
                  <span className="block text-faint">“{c.decisionReason}”</span>
                </span>
              )}
            </Td>
          </tr>
        ))}
      </tbody>
    </TableWrap>
  );
}
