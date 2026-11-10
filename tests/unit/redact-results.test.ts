import { describe, expect, it } from "vitest";
import { redactResultsText } from "../../scripts/audit-report";

describe("redactResultsText (committed test results carry no machine details)", () => {
  const home = "C:\Users\Someone Example";
  const raw = JSON.stringify({
    config: {
      rootDir: `${home}\repo`,
      webServer: { command: "npm run start", env: { DEMO_MODE: "1", CLAUDE_CODE_MESSAGING_TOKEN: "tok_123", USER_EMAIL: "a@b.example", PATH: `${home}\bin` } },
    },
    suites: [{ file: "tests/e2e/x.spec.ts", specs: [{ title: "t", file: `${home}/repo/tests/e2e/x.spec.ts` }] }],
  });

  it("keeps only the variables the repo sets and drops the rest of the environment", () => {
    const out = JSON.parse(redactResultsText(raw, home));
    expect(out.config.webServer.env).toEqual({ DEMO_MODE: "1" });
    expect(redactResultsText(raw, home)).not.toMatch(/tok_123|a@b\.example/);
  });

  it("replaces the home directory in every path form", () => {
    const out = redactResultsText(raw, home);
    expect(out).not.toContain("Someone Example");
    expect(JSON.parse(out).config.rootDir).toBe("~\repo");
    expect(JSON.parse(out).suites[0].specs[0].file).toBe("~/repo/tests/e2e/x.spec.ts");
  });

  it("leaves results without a webServer untouched apart from formatting", () => {
    const plain = JSON.stringify({ testResults: [{ name: "tests/unit/a.test.ts", status: "passed" }] });
    expect(JSON.parse(redactResultsText(plain, home))).toEqual(JSON.parse(plain));
  });
});
