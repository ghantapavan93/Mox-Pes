import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Uploaded rows never reach a model (release design §5.2, threat model). The model-facing code
 * (lib/ai) reads no onboarding table and imports nothing from onboarding; onboarding (whose mapping
 * assistant is deterministic) imports nothing from lib/ai. Either import would be the first step of
 * a path from a visitor's cells to a provider, so each is refused here, by source.
 */

const root = process.cwd();

function sources(dir: string): string[] {
  return readdirSync(path.join(root, dir), { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && /\.(ts|tsx|mts)$/.test(e.name))
    .map((e) => path.join(e.parentPath, e.name));
}

describe("uploaded rows never reach a model", () => {
  it("lib/ai neither reads onboarding tables nor imports onboarding code", () => {
    const offenders = sources("lib/ai").filter((file) => /onboarding/i.test(readFileSync(file, "utf8")));
    expect(offenders.map((f) => path.relative(root, f))).toEqual([]);
  });

  it("onboarding imports nothing from lib/ai but the local injection scanner", () => {
    const imports = sources("lib/onboarding").flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/from\s+["'](@\/lib\/ai(?:\/[^"']*)?)["']/g)].map((m) => `${path.relative(root, file)} → ${m[1]}`),
    );
    // The mapping assistant flags headers that read like instructions with lib/ai/injection.ts: a
    // set of regular expressions that runs here and calls nothing.
    expect(imports.filter((i) => !i.endsWith("→ @/lib/ai/injection"))).toEqual([]);
    const scanner = readFileSync(path.join(root, "lib/ai/injection.ts"), "utf8");
    expect([...scanner.matchAll(/^import\s.*$/gm)].map((m) => m[0])).toEqual(['import type { InjectionWarning } from "./contract";']);
  });
});
