import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WORKSPACE } from "@/lib/workspace";

/**
 * The built-in sample is exempt from the workspace's row caps, recognised by its hash, so "Try the
 * sample" keeps working after a flood (release design §5.2). The hash has the form
 * onboarding_uploads.file_sha256 uses: sha256 of the file's base64 text. .gitattributes keeps the
 * file's bytes as committed on every checkout (no line-end conversion), so the hash holds on Linux
 * CI and Windows alike; editing the sample means updating WORKSPACE.sampleSha256.
 */
describe("the built-in sample's hash", () => {
  it("matches public/samples/demo-calls.csv", () => {
    const bytes = readFileSync(path.join(process.cwd(), "public", "samples", "demo-calls.csv"));
    expect(createHash("sha256").update(bytes.toString("base64")).digest("hex")).toBe(WORKSPACE.sampleSha256);
  });

  it("is protected from line-end conversion", () => {
    const attributes = readFileSync(path.join(process.cwd(), ".gitattributes"), "utf8");
    expect(attributes).toMatch(/^public\/samples\/demo-calls\.csv\s+-text\s*$/m);
  });
});
