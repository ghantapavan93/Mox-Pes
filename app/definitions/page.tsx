import { Callout, Card, PageHeader, metricAnchor } from "@/components/ui";
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

/**
 * The dictionary: the attribution policy every number obeys, then one entry per metric
 * (formula, source, caveat) from lib/metrics/definitions.ts, the same object every KPI tile
 * opens. Static; nothing here depends on the viewer.
 */
export default function DefinitionsPage() {
  const metrics = Object.values(METRICS);
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Understand · reference"
        title="Definitions"
        description={
          <p className="max-w-3xl">
            One definition per number, implemented once in SQL (<code className="font-mono text-xs">database/migrations/0002_attribution_views.sql</code> and{" "}
            <code className="font-mono text-xs">lib/metrics/scorecard.ts</code>) and tested to the cent against generated ground truth. Every KPI tile in the app opens
            the same entry shown here.
          </p>
        }
      />

      <nav aria-label="On this page" className="rounded-lg border border-border bg-surface p-4 shadow-raised" data-testid="definitions-index">
        <p className="mb-2 text-xs font-medium text-muted">On this page</p>
        <ul className="flex flex-wrap gap-1.5 text-xs">
          {[
            ["#policy", "Attribution policy"],
            ...metrics.map((m) => [`#${metricAnchor(m.key)}`, m.label]),
            ["#not-attribution", "What attribution is not"],
          ].map(([href, label]) => (
            <li key={href}>
              <a href={href} className="inline-block rounded-md border border-border px-2 py-1 font-medium text-text hover:border-accent hover:text-accent">
                {label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <Card id="policy" title="Attribution policy" subtitle="The rules every metric below obeys">
        <dl className="divide-y divide-border text-sm">
          {POLICY.map(([k, v]) => (
            <div key={k} className="grid gap-1 py-2.5 first:pt-0 last:pb-0 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-4">
              <dt className="font-semibold text-text">{k}</dt>
              <dd className="text-muted">{v}</dd>
            </div>
          ))}
        </dl>
      </Card>

      <section aria-labelledby="metrics-heading" className="space-y-3">
        <h2 id="metrics-heading" className="text-[13px] font-semibold text-text">
          Metrics ({metrics.length})
        </h2>
        <div className="grid gap-4 lg:grid-cols-2">
          {metrics.map((m) => (
            <article key={m.key} id={metricAnchor(m.key)} className="scroll-mt-20 rounded-lg border border-border bg-surface p-4 shadow-raised">
              <h3 className="text-sm font-semibold text-text">{m.label}</h3>
              <dl className="mt-2 space-y-2 text-sm">
                <div>
                  <dt className="text-xs font-medium text-muted">Formula</dt>
                  <dd className="text-text">{m.formula}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-muted">Source</dt>
                  <dd className="text-text [overflow-wrap:anywhere]">{m.sources}</dd>
                </div>
                <div>
                  <dt className="text-xs font-medium text-muted">Caveat</dt>
                  <dd className="text-text">{m.caveat}</dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      </section>

      <div id="not-attribution" className="scroll-mt-20">
        <Callout tone="warn" title="What attribution is not">
          Attributed revenue says which recorded touch preceded a sale. It does not say the sale would not have happened without the ad. Incremental lift
          needs a holdout (geo split or platform lift study); this system makes such tests possible by providing clean, branch-level outcomes, but does not
          claim them.
        </Callout>
      </div>
    </div>
  );
}
