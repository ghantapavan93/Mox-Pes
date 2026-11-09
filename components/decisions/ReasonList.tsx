import Link from "next/link";
import type { Reason, ReasonStatus } from "@/lib/decision/verdicts";

const DOT: Record<ReasonStatus, string> = { pass: "bg-good", warn: "bg-warn", fail: "bg-bad", info: "bg-faint" };
const WORD: Record<ReasonStatus, string> = { pass: "Pass", warn: "Caveat", fail: "Fails", info: "Note" };

/** The reasons behind a verdict, each with its status and a link to its evidence when there is one. */
export function ReasonList({ reasons }: { reasons: Reason[] }) {
  if (reasons.length === 0) return <p className="text-xs text-faint">No checks apply.</p>;
  return (
    <ul className="space-y-1.5">
      {reasons.map((r, i) => (
        <li key={`${r.code}-${i}`} className="flex gap-2 text-xs leading-snug">
          <span aria-hidden className={`mt-1 h-2 w-2 shrink-0 rounded-full ${DOT[r.status]}`} />
          <span>
            <span className="sr-only">{WORD[r.status]}: </span>
            <span className={r.status === "fail" ? "text-text" : "text-muted"}>{r.text}</span>
            {r.href && (
              <>
                {" "}
                <Link href={r.href} className="whitespace-nowrap text-accent hover:underline">
                  evidence →
                </Link>
              </>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
