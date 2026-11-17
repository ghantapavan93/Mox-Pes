"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export interface ActionMessage {
  ok: boolean;
  text: string;
}

/**
 * POSTs JSON to an Action Center route and refreshes the server components on success, so
 * the page shows the state the server now holds. The server re-checks permission and scope;
 * its error message (403 / 409 / 400) is shown as is.
 */
export function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<ActionMessage | null>(null);

  async function run(label: string, url: string, body: unknown): Promise<boolean> {
    setBusy(label);
    setMessage(null);
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const json = (await res.json().catch(() => ({}))) as { message?: string; error?: string; issues?: string[]; outcome?: string };
      if (!res.ok) throw new Error([json.error ?? `HTTP ${res.status}`, ...(json.issues ?? [])].join(" — "));
      // The request can succeed while the action it ran failed (a dry run that did not verify, an
      // execution that rolled back): shown as a failure, and the page still refreshes to show it.
      setMessage({ ok: json.outcome !== "failed", text: json.message ?? "Done." });
      router.refresh();
      return true;
    } catch (error) {
      setMessage({ ok: false, text: (error as Error).message });
      return false;
    } finally {
      setBusy(null);
    }
  }

  return { busy, message, run };
}
