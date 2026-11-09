import { Card } from "@/components/ui";
import { METRICS } from "@/lib/metrics/definitions";

const POLICY: Array<[string, string]> = [
  ["New customer", "A CRM customer's first subscription. An existing customer adding a service is never an acquisition."],
  ["Acquired", "The first subscription's initial service was completed. Sold-but-cancelled customers are not acquired."],
  ["Credited touch", "The earliest lead record with attribution evidence (click id, UTM, tracking number, LSA lead, rep signature) in the 60 days before the sale, matched by hashed phone or email."],
  ["Unknown", "No evidenced touch. Unknown is a channel of its own and is never reassigned to paid media."],
  ["Door-to-door vs paid", "If a paid touch came first and a rep signed later, credit stays with the paid touch and the sale is flagged for commission review."],
  ["Revenue", "Successful payments minus refunds. Booked contract value and invoice totals are shown only where labelled as booked."],
  ["Branch", "Revenue belongs to the CRM office that services the customer. Lead credit belongs to the capturing system's branch unless a person overrides it, with a reason."],
  ["Time", "Spend by spend date; acquisitions by initial-service date; revenue by payment date. Periods are calendar periods, not cohorts."],
];

export default function DefinitionsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Definitions</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          One definition per number, implemented once in SQL (database/migrations/0002_attribution_views.sql and lib/metrics/scorecard.ts) and
          tested to the cent against generated ground truth.
        </p>
      </div>
      <Card title="Attribution policy">
        <dl className="space-y-3 text-sm">
          {POLICY.map(([k, v]) => (
            <div key={k} className="grid gap-1 sm:grid-cols-[12rem_1fr]">
              <dt className="font-semibold">{k}</dt>
              <dd className="text-muted">{v}</dd>
            </div>
          ))}
        </dl>
      </Card>
      <Card title="Metrics">
        <div className="space-y-4">
          {Object.values(METRICS).map((m) => (
            <div key={m.key} className="border-b border-dashed border-border pb-3 text-sm">
              <h3 className="font-semibold">{m.label}</h3>
              <p className="mt-1"><span className="text-muted">Formula:</span> {m.formula}</p>
              <p><span className="text-muted">Source:</span> {m.sources}</p>
              <p><span className="text-muted">Caveat:</span> {m.caveat}</p>
            </div>
          ))}
        </div>
      </Card>
      <Card title="What attribution is not">
        <p className="text-sm text-muted">
          Attributed revenue says which recorded touch preceded a sale. It does not say the sale would not have happened without the ad.
          Incremental lift needs a holdout (geo split or platform lift study); this system makes such tests possible by providing clean,
          branch-level outcomes, but does not claim them.
        </p>
      </Card>
    </div>
  );
}
