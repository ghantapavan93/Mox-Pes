import type { ReactNode } from "react";
import { Bot, Compass, FileUp } from "lucide-react";
import { ButtonLink, Card, PageHeader, buttonClass } from "@/components/ui";
import { TOUR_QUESTION, TOUR_START } from "@/lib/demo/b20-tour";

export const metadata = {
  title: "Start here",
  description: "What Revenue Signal OS does, in two sentences and a one-minute captioned video, and three ways in. Synthetic data.",
};

/** The repository: source, tests and every release's check results. */
const REPOSITORY = "https://github.com/ghantapavan93/Mox-Pes";

/** The walkthrough on this page: recorded on the hosted site, as a visitor (docs/agent-work/release/recording/revenue-signal-os-walkthrough.md). */
const VIDEO = { src: "/media/revenue-signal-os-walkthrough.mp4", poster: "/media/revenue-signal-os-walkthrough.jpg", megabytes: 12.6 };

/**
 * The walkthrough's captions, in order, as text: for a reader who cannot play the video, and for
 * screen readers (the captions are part of the picture). They are the recording's own words
 * (docs/agent-work/release/harness/record-vp-walkthrough.cjs): figures of the hosted copy on the day
 * it was recorded, the visitor's file counted in their private copy.
 */
const CAPTIONS = [
  "Built before the interview: a working prototype of what I would build for your marketing and data teams. It makes sure ad spend, call tracking and CRM records agree before anyone moves marketing budget.",
  "When the systems disagree, it holds the decision, shows the evidence, and sends the fix through a test run and a separate approval.",
  "Ad platforms claimed 7,776 conversions in October. 4,753 paid prospects reached the business, and 1,386 are serviced customers so far.",
  "Where the records disagree, it stops the line: two branches' budget decisions are on hold.",
  "B09 is held until the incident behind it is resolved: no channel comparison is a safe basis for moving budget yet.",
  "B20's October cost per paid customer was reported at $490.11. A verified repair corrected it to $271.31.",
  "The cause: the call feed renamed a field. 119 calls failed validation and were held, not guessed.",
  "Replayed through the corrected mapper: the same $15,193.47 of spend and the same 109 customers. Only the attribution moved.",
  "One role proposed it, another tested it in a dry run that saved nothing, and a different role approved it. Every step is audited.",
  "Ask why a number moved. It answers from stored records with read-only tools, and every finding cites the record it rests on.",
  "Now your own data. Upload an export, or this sample: calls a feed never delivered for B01's customers.",
  "Every row is checked with the rules the live feed uses. Then count it in a private copy.",
  "Your dashboard moves with your file: B01's cost per paid customer, $392.50 to $322.73. Nobody else's numbers change.",
  "Counted through the real intake and reconciliation, in a transaction that is rolled back. Spend did not change; attribution did.",
  "Configuration changes are run through the production write path in a rolled-back transaction, then approved by someone else.",
  "Next.js and Postgres. Every source lands once per version, every metric is defined once in SQL, and over a thousand tests run before each release.",
  "Rather than only describe how I would contribute, I built it first.",
];

/** The stack, in one line a part: what an engineer would ask first. Counts are left out: they move with every release. */
const BUILT: Array<[string, string]> = [
  ["App", "Next.js App Router and TypeScript, server-rendered and streamed, deployed on Vercel."],
  ["Ledger", "Postgres. Every source lands once per record version through a versioned mapper; each metric is defined once in SQL."],
  ["Reconciliation", "Detectors written in SQL turn disagreements between ads, calls, web leads, door-to-door and the CRM into incidents with evidence."],
  ["Safe changes", "A fix is dry-run in a transaction that rolls back, approved by a different role, applied once and audited."],
  ["Investigator", "Read-only tools with role and branch scope; every finding cites a stored record."],
  ["Tests", "Over a thousand unit and integration tests on a real Postgres, and browser journeys with accessibility and layout-shift gates, run before every release."],
];

/** Four words the product uses, in plain terms. */
const WORDS: Array<[string, string]> = [
  ["CAC", "Customer acquisition cost: paid ad spend divided by the new customers those ads brought in."],
  ["Incident", "Two systems disagree about the same thing. A budget decision that depends on it is held until it is resolved."],
  ["Dry run", "The fix runs for real inside a transaction that is rolled back, so its effect is seen before anything is saved."],
  ["Approval", "A different role approves that exact dry run. The app then applies it once and checks that the ledger totals did not move."],
];

/**
 * /start — the page to send first: what the product does in two sentences, the captioned
 * walkthrough, and three ways in (sharing review, 2026-11-19: the Overview, the first page a link
 * opened, is a dense analytics screen a non-specialist cannot read alone). Static: no database read
 * before its first paint; the tour's link resolves its incident when followed (app/demo/tour).
 */
export default function StartPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="Start here"
        title="Revenue Signal OS"
        description={
          <p className="max-w-3xl text-[15px] leading-7 text-text" data-testid="start-summary">
            It checks that ad spend, call tracking and CRM records agree before anyone moves marketing budget. When they disagree, it holds the decision,
            shows the evidence, and sends the fix through a test run and a separate approval.
          </p>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <figure className="min-w-0 space-y-2" data-testid="start-video">
          <video
            controls
            playsInline
            preload="metadata"
            poster={VIDEO.poster}
            width={1920}
            height={1200}
            aria-label="The prototype in two minutes: a captioned walkthrough with no sound"
            className="aspect-[8/5] h-auto w-full rounded-xl bg-sunken ring-1 ring-text/10"
          >
            <source src={VIDEO.src} type="video/mp4" />
            <a href={VIDEO.src}>Download the walkthrough (MP4, {VIDEO.megabytes} MB)</a>
          </video>
          <figcaption className="text-xs leading-5 text-muted">
            Two minutes, no sound needed: the captions tell the story. Recorded on this site, as a visitor.
          </figcaption>
          <details className="rounded-lg bg-surface px-3 py-2 text-sm ring-1 ring-text/10" data-testid="start-transcript">
            <summary className="inline-flex min-h-6 items-center font-medium text-accent">Read the video as text</summary>
            <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted">
              {CAPTIONS.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ol>
          </details>
        </figure>

        <section aria-labelledby="start-ways" className="min-w-0 space-y-3">
          <h2 id="start-ways" className="text-[15px] font-semibold leading-6 tracking-tight text-text">
            Three ways in
          </h2>
          <ul className="space-y-3">
            <WayIn
              icon={<Compass aria-hidden className="size-5" />}
              title="Take the guided tour"
              text="Seven short steps through one finished repair: the wrong number, the evidence, who approved the fix, and why it is not a budget decision. About two minutes, read-only."
              action={
                // A plain link: the tour's start is a redirect (app/demo/tour/route.ts), not a page to prefetch.
                <a href={TOUR_START} data-variant="primary" data-testid="start-tour" className={buttonClass({ variant: "primary" })}>
                  Start the tour →
                </a>
              }
            />
            <WayIn
              icon={<Bot aria-hidden className="size-5" />}
              title="Ask the AI investigator"
              text="Ask why a number looks wrong. It reads stored records with read-only tools and cites each one. For a visitor it follows fixed, rule-based plans: no model reads the question, and only their browser can open the answer, for 24 hours."
              action={
                <ButtonLink href={`/investigator?q=${encodeURIComponent(TOUR_QUESTION)}`} testId="start-investigator">
                  Ask a question
                </ButtonLink>
              }
            />
            <WayIn
              icon={<FileUp aria-hidden className="size-5" />}
              title="Try your own file"
              text="Upload an export (CSV, XLSX or JSON), or start with the sample of calls the feed missed. Read what was understood, counted and held back, then count it in a private copy: your own dashboard shows the figures with your file in them. Nobody else's numbers move, and the file is deleted after 24 hours."
              action={
                <ButtonLink href="/onboarding" testId="start-upload">
                  Upload a file
                </ButtonLink>
              }
            />
          </ul>
        </section>
      </div>

      <Card title="How it is built" subtitle="For engineers: the whole stack is in this site, and every part of it is tested" testId="start-built">
        <ul className="grid gap-x-6 gap-y-2 text-sm leading-6 text-muted md:grid-cols-2">
          {BUILT.map(([what, how]) => (
            <li key={what}>
              <span className="font-medium text-text">{what}.</span> {how}
            </li>
          ))}
        </ul>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Words you will see">
          <dl className="space-y-3 text-sm leading-6" data-testid="start-words">
            {WORDS.map(([word, meaning]) => (
              <div key={word}>
                <dt className="font-medium text-text">{word}</dt>
                <dd className="text-muted">{meaning}</dd>
              </div>
            ))}
          </dl>
        </Card>
        <Card title="What is real">
          <div className="space-y-3 text-sm leading-6 text-muted" data-testid="start-real">
            <p>
              All data is synthetic: the branches, customers, calls and amounts are invented. This is an independent interview project by Pavankalyan
              Ghanta, not affiliated with or built from any company&apos;s systems.
            </p>
            <p>
              For engineers: the source, the tests and each release&apos;s check results are{" "}
              <a href={REPOSITORY} className="font-medium text-accent">
                on GitHub
              </a>
              .
            </p>
          </div>
        </Card>
      </div>
    </div>
  );
}

function WayIn({ icon, title, text, action }: { icon: ReactNode; title: string; text: string; action: ReactNode }) {
  return (
    <li className="flex gap-3 rounded-xl bg-surface p-4 ring-1 ring-text/10">
      <span aria-hidden className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
        {icon}
      </span>
      <div className="min-w-0 space-y-2">
        <h3 className="text-sm font-semibold text-text">{title}</h3>
        <p className="text-sm leading-6 text-muted">{text}</p>
        {action}
      </div>
    </li>
  );
}
