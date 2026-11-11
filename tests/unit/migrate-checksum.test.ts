import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { migrationChecksums } from "@/lib/migrate";

/**
 * A migration applied from an LF working copy must not count as edited once git (core.autocrlf)
 * checks the same file out with CRLF line endings, and the reverse. A real edit still does.
 */
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const lf = "create table t (\n  id int\n);\n";
const crlf = lf.replace(/\n/g, "\r\n");

describe("migration checksums", () => {
  it("records the LF checksum whatever the checkout's line endings", () => {
    expect(migrationChecksums(lf).record).toBe(sha(lf));
    expect(migrationChecksums(crlf).record).toBe(sha(lf));
  });

  it("accepts a checksum recorded from either line-ending form (older databases recorded raw bytes)", () => {
    for (const recordedFrom of [lf, crlf]) {
      for (const checkout of [lf, crlf]) expect(migrationChecksums(checkout).accepted.has(sha(recordedFrom))).toBe(true);
    }
  });

  it("still refuses a real edit", () => {
    const edited = lf.replace("id int", "id bigint");
    for (const recordedFrom of [lf, crlf]) expect(migrationChecksums(edited).accepted.has(sha(recordedFrom))).toBe(false);
  });
});
