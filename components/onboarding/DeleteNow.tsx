"use client";

import { useRouter } from "next/navigation";
import { useAction } from "@/components/actions/useAction";
import { Button } from "@/components/ui";

/**
 * "Delete it now" for a visitor's workspace upload: the server deletes the upload whole (its rows,
 * mappings and result), then the workspace list opens and says so. Only the owner's request
 * resolves the upload; anyone else's answers 404.
 */
export function DeleteNow({ uploadId }: { uploadId: number }) {
  const router = useRouter();
  const { busy, message, run } = useAction();
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        variant="danger"
        size="sm"
        busy={busy !== null}
        busyLabel="Deleting…"
        testId="delete-now"
        onClick={async () => {
          if (await run("delete", `/api/onboarding/uploads/${uploadId}`, undefined, "DELETE")) router.replace("/onboarding?deleted=1");
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
