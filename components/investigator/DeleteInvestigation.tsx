"use client";

import { useRouter } from "next/navigation";
import { useAction } from "@/components/actions/useAction";
import { Button } from "@/components/ui";

/**
 * "Delete it now" for a visitor's own investigation on the public demo: the server deletes it and
 * its steps, then the investigator opens. Only the owner's request resolves it; anyone else's is 404.
 */
export function DeleteInvestigation({ investigationId }: { investigationId: number }) {
  const router = useRouter();
  const { busy, message, run } = useAction();
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        variant="danger"
        size="sm"
        busy={busy !== null}
        busyLabel="Deleting…"
        testId="delete-investigation"
        onClick={async () => {
          if (await run("delete", `/api/investigations/${investigationId}`, undefined, "DELETE")) router.replace("/investigator");
        }}
      >
        Delete it now
      </Button>
      {message && !message.ok && (
        <span role="alert" className="text-xs text-bad">
          {message.text}
        </span>
      )}
    </span>
  );
}
