"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams, type ReadonlyURLSearchParams } from "next/navigation";
import { useState } from "react";
import { B09_STEPS, GUIDE_ID, PATH_SECONDS, ROLE_LABEL, stepAt, stepHref } from "@/lib/demo/b09-path";
import { B20_TOUR, TOUR_ID, tourHref, tourPlace, tourStepAt } from "@/lib/demo/b20-tour";
import { buttonClass } from "@/components/ui";

/**
 * The guided paths' bars. Each is shown only when the URL names its path, which every link into
 * it does, so they cost nothing on ordinary pages:
 *
 *   - `?guide=b20&step=N&incident=ID`: the visitor tour (lib/demo/b20-tour.ts), read-only;
 *   - `?guide=b09&step=N&gap=ID`: the presenter's rail for the B09 path (lib/demo/b09-path.ts).
 *
 * `roleSwitch` says whether this deployment switches roles (demo mode, read per request by the
 * layout). Without it the B09 bar names each step's role and offers no "Use this role" button:
 * POST /api/role answers 404 there, so the button did nothing (sharing review, 2026-11-19).
 */
export function GuideBar({ roleSwitch }: { roleSwitch: boolean }) {
  const params = useSearchParams();
  const guide = params.get("guide");
  if (guide === TOUR_ID) return <TourBar params={params} />;
  if (guide === GUIDE_ID) return <PresenterBar params={params} roleSwitch={roleSwitch} />;
  return null;
}

/**
 * The visitor tour's bar: where the visitor is, what to look at, what it means, and the way on.
 * Fixed to the bottom of the content column (app/globals.css, `[data-tour-bar]`): a step that
 * opens a section further down the page (Evidence, Records, Audit) scrolls to it, and a bar at
 * the top would scroll away with the page, taking the way on with it. It never covers the
 * sidebar, whose footer says the data is synthetic. Its links carry no `data-variant`: they are the
 * tour's way on, not the page's one primary action, which the page keeps.
 */
function TourBar({ params }: { params: ReadonlyURLSearchParams }) {
  const pathname = usePathname();
  const place = tourPlace({ guide: params.get("guide"), step: params.get("step") ?? undefined, incident: params.get("incident") ?? undefined });
  if (!place) return null;
  const { step, incidentId } = place;
  const prev = tourStepAt(step.n - 1);
  const next = tourStepAt(step.n + 1);
  // The investigator step, once its answer is open: the question has been asked.
  const words = step.answered && /^\/investigator\/\d+$/.test(pathname ?? "") ? step.answered : step;
  return (
    <nav
      aria-label="Guided tour"
      data-testid="tour-bar"
      data-tour-bar
      className="fixed inset-x-0 bottom-0 z-40 border-t border-accent/30 bg-surface/95 px-4 py-3 shadow-[0_-8px_24px_rgb(15_23_42/0.08)] backdrop-blur lg:px-6"
    >
      <div className="mx-auto flex max-w-[1440px] flex-col gap-2 lg:flex-row lg:items-center lg:gap-6">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-text" data-testid="tour-step">
            Step {step.n} of {B20_TOUR.length} · {step.title}
          </p>
          <p className="mt-0.5 text-[13px] leading-5 text-muted" data-testid="tour-say">
            <span className="font-medium text-text">{words.look}</span> {words.says}
          </p>
        </div>
        {/* A button's parts are flex items with a gap between them: each label is one item, the arrow another. */}
        <div className="flex shrink-0 items-center gap-2 text-sm">
          {prev && (
            <Link href={tourHref(prev, incidentId)} className={buttonClass({ variant: "secondary" })} data-testid="tour-back">
              <span aria-hidden>←</span>
              <span>Back</span>
            </Link>
          )}
          {next ? (
            <Link href={tourHref(next, incidentId)} className={buttonClass({ variant: "primary" })} data-testid="tour-next">
              <span>
                Next<span className="hidden sm:inline">: {next.title}</span>
              </span>
              <span aria-hidden>→</span>
            </Link>
          ) : (
            <Link href="/start" className={buttonClass({ variant: "primary" })} data-testid="tour-done">
              Done
            </Link>
          )}
          <Link href="/start" className={buttonClass({ variant: "ghost" })} data-testid="tour-exit">
            Exit
          </Link>
        </div>
      </div>
    </nav>
  );
}

/** The presenter's rail for the four-minute B09 path. The role button is the demo role switch (POST /api/role). */
function PresenterBar({ params, roleSwitch }: { params: ReadonlyURLSearchParams; roleSwitch: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const step = stepAt(Number(params.get("step")));
  const gapId = Number(params.get("gap"));
  if (!step || !Number.isInteger(gapId) || gapId <= 0) return null;
  const prev = stepAt(step.n - 1);
  const next = stepAt(step.n + 1);
  const elapsed = B09_STEPS.filter((s) => s.n < step.n).reduce((t, s) => t + s.seconds, 0);
  const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

  async function switchRole() {
    if (busy) return;
    setBusy(true);
    try {
      await fetch("/api/role", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: step!.role }) });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <nav aria-label="Guided path" data-testid="guide-bar" className="border-b border-accent/30 bg-accent-soft px-4 py-2 text-sm lg:px-6">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="font-medium text-text" data-testid="guide-step">
          Step {step.n} of {B09_STEPS.length} · {step.title}
        </span>
        <span className="text-xs text-muted tabular-nums">
          {clock(elapsed)} → {clock(elapsed + step.seconds)} of {clock(PATH_SECONDS)}
        </span>
        <span className="text-xs text-muted">
          As <strong className="text-text">{ROLE_LABEL[step.role]}</strong>{" "}
          {roleSwitch ? (
            <button type="button" onClick={switchRole} aria-disabled={busy} data-testid="guide-use-role" className="ml-1 rounded border border-border bg-surface px-2 py-0.5 text-xs hover:bg-surface-2 aria-disabled:opacity-50">
              {busy ? "Switching…" : "Use this role"}
            </button>
          ) : (
            <span data-testid="guide-role-off">(roles switch only on a local copy)</span>
          )}
        </span>
        <span className="ml-auto flex items-center gap-3 text-xs">
          {prev && <Link href={stepHref(prev, gapId)} className="text-accent hover:underline">← {prev.title}</Link>}
          {next ? (
            <Link href={stepHref(next, gapId)} className="rounded bg-accent px-2.5 py-1 font-medium text-white hover:opacity-90" data-testid="guide-next">
              Next: {next.title} →
            </Link>
          ) : (
            <Link href="/demo" className="rounded bg-accent px-2.5 py-1 font-medium text-white hover:opacity-90" data-testid="guide-done">
              Done: back to the path
            </Link>
          )}
          <Link href="/demo" className="text-muted hover:underline">Exit</Link>
        </span>
      </div>
      <p className="mt-1 text-xs text-muted" data-testid="guide-say">
        <span className="text-faint">Show:</span> {step.show.join(" · ")} <span className="text-faint">· Say:</span> “{step.say}”
      </p>
    </nav>
  );
}
