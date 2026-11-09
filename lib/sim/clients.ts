import type { FetchWindow, RawRecord, SourceClient, SourceName } from "@/lib/adapters/contract";
import type { SourceRecordVersion } from "./world";

/**
 * In-memory stand-ins for the source APIs. They behave like a polling API: a call returns
 * each record that changed inside the window ONCE, in its CURRENT state as of the window's
 * end — not its history. (Returning every historical version would let a stale version be
 * re-delivered after a newer one, which no current-state API does.)
 * Swapping in a real FieldRoutes client means implementing SourceClient over HTTP —
 * the mapper, ingestion and reconciliation code do not change.
 */

/** The record identity each stream's API uses. */
const RECORD_KEY: Record<string, (p: Record<string, unknown>) => string> = {
  ads: (p) => `${p.platform}:${p.campaignId}:${p.date}`,
  "crm.customer": (p) => String(p.customerID),
  "crm.subscription": (p) => String(p.subscriptionID),
  "crm.appointment": (p) => String(p.appointmentID),
  "crm.ticket": (p) => String(p.ticketID),
  "crm.payment": (p) => String(p.paymentID),
  calls: (p) => String(p.id),
  web: (p) => String(p.messageId),
  d2d: (p) => String(p.saleId),
};

export interface StreamSpec {
  stream: string;
  source: SourceName;
  /** How far behind the cursor each run re-reads. Payments have no dateUpdated filter
   *  in FieldRoutes, so they need a wide trailing window; ad platforms restate days. */
  overlapMs: number;
}

const MIN = 60_000;
const HOUR = 60 * MIN;

export const STREAMS: StreamSpec[] = [
  { stream: "ads", source: "ads", overlapMs: 72 * HOUR },
  { stream: "crm.customer", source: "crm", overlapMs: 30 * MIN },
  { stream: "crm.subscription", source: "crm", overlapMs: 30 * MIN },
  { stream: "crm.appointment", source: "crm", overlapMs: 30 * MIN },
  { stream: "crm.ticket", source: "crm", overlapMs: 30 * MIN },
  { stream: "crm.payment", source: "crm", overlapMs: 72 * HOUR },
  { stream: "calls", source: "calls", overlapMs: 10 * MIN },
  { stream: "web", source: "web", overlapMs: 10 * MIN },
  { stream: "d2d", source: "d2d", overlapMs: 10 * MIN },
];

export class InMemorySourceClient implements SourceClient {
  private readonly versions: SourceRecordVersion[];
  constructor(
    readonly stream: string,
    readonly source: SourceName,
    all: SourceRecordVersion[],
    private readonly failWhen: (window: FetchWindow) => string | null = () => null,
  ) {
    this.versions = all.filter((r) => r.stream === stream).sort((a, b) => a.visibleAt - b.visibleAt);
  }

  async fetchChanges(window: FetchWindow): Promise<RawRecord[]> {
    const failure = this.failWhen(window);
    if (failure) throw new Error(failure);
    const from = window.from.getTime();
    const to = window.to.getTime();
    let lo = 0;
    let hi = this.versions.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.versions[mid].visibleAt < from) lo = mid + 1;
      else hi = mid;
    }
    // Latest version per record within the window; versions are sorted by visibleAt.
    const keyOf = RECORD_KEY[this.stream] ?? ((p: Record<string, unknown>) => JSON.stringify(p));
    const latest = new Map<string, SourceRecordVersion>();
    for (let i = lo; i < this.versions.length && this.versions[i].visibleAt < to; i++) {
      const v = this.versions[i];
      const key = keyOf(v.payload);
      latest.delete(key); // re-insert so iteration order follows the latest change
      latest.set(key, v);
    }
    // Deep copy: callers must never be able to mutate the "remote" system.
    return [...latest.values()].map((v) => ({ entity: v.entity, payload: structuredClone(v.payload) }));
  }
}
