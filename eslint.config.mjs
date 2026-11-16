import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Evidence harnesses: the exact scripts an acceptance run used, kept as records, not as code.
    "docs/agent-work/**/harness/**",
    // Private research, git-ignored: never part of a checkout, so never part of its lint.
    "research/**",
  ]),
]);

export default eslintConfig;
