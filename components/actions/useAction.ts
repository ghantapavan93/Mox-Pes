"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export interface ActionMessage {
  ok: boolean;
  text: string;
  /** The page was refreshed so it shows what the server stored (a 409, or a dropped connection). */
  refreshed?: boolean;
}

/** Shown beside the server's words when the page was refreshed to show the stored state. */
export const REFRESHED_NOTE = "The page now shows what the server stored.";
/** Shown when no response arrived: the request may or may not have been applied, so the page is refreshed. */
export const DROPPED_CONNECTION = "The connection dropped before the server answered. The page now shows what the server stored.";

/**
 * Sends one action request and refreshes the server components, so the page shows the state the
 * server now holds. The server re-checks permission and scope; its error message (403 / 409 / 400)
 * is shown as is. Nothing is shown as a success without a 2xx answer.
 *
 * - A 2xx whose body says `outcome: "failed"` (a dry run that did not verify, an execution that
 *   rolled back) is a failure; the page still refreshes to show it.
 * - A 409 is always an error in the server's words, and the page refreshes, so it shows the stored
 *   state behind the conflict ("This upload is published", "A newer dry run replaced the one you
 *   reviewed").
 * - A dropped connection (no answer) refreshes the page too, with words that say so: the request
 *   may have been applied.
 */
export function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<ActionMessage | null>(null);

  async function run(label: string, url: string, body: unknown, method: "POST" | "DELETE" = "POST"): Promise<boolean> {
    setBusy(label);
    setMessage(null);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      setMessage({ ok: false, text: DROPPED_CONNECTION, refreshed: true });
      router.refresh();
      setBusy(null);
      return false;
    }
    try {
      const json = (await res.json().catch(() => ({}))) as { message?: string; error?: string; issues?: string[]; outcome?: string };
      if (res.status === 409) {
        setMessage({ ok: false, text: `${json.error ?? json.message ?? "This changed since the page was loaded."} ${REFRESHED_NOTE}`, refreshed: true });
        router.refresh();
        return false;
      }
      if (!res.ok) {
        setMessage({ ok: false, text: [json.error ?? `HTTP ${res.status}`, ...(json.issues ?? [])].join(" — ") });
        return false;
      }
      setMessage({ ok: json.outcome !== "failed", text: json.message ?? "Done." });
      router.refresh();
      // True means the server answered 2xx: the request was handled, even when the action it ran
      // failed. Callers use it to move focus to the stored result (ProposalControls).
      return true;
    } finally {
      setBusy(null);
    }
  }

  return { busy, message, run };
}
