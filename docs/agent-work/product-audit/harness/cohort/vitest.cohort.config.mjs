// Audit-only vitest config for the cohort fixture (BUSINESS-FIT.md §3). Reads product code from the
// repository and writes only the evidence file (COHORT_OUT, default: this folder) and caches in the
// OS temp folder. It refuses any database but revenue_signal_audit_cohort_test (cohort-lib.ts).
// Run from the repository root:
//   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:54333/revenue_signal_audit_cohort_test \
//     npx vitest run --config docs/agent-work/product-audit/harness/cohort/vitest.cohort.config.mjs
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url)).replace(/\\/g, "/").replace(/\/$/, "");
const REPO = HERE.replace(/\/docs\/agent-work\/product-audit\/harness\/cohort$/, "");
const CACHE = `${tmpdir().replace(/\\/g, "/")}/revenue-signal-cohort-cache`;

export default {
  root: REPO,
  cacheDir: `${CACHE}/.vite`,
  resolve: {
    alias: [
      { find: /^@\//, replacement: `${REPO}/` },
      { find: /^server-only$/, replacement: `${HERE}/empty-module.mjs` },
      // One id for these, whoever imports them, so a vi.mock in an audit file matches the product's import.
      { find: /^next\/server$/, replacement: `${REPO}/node_modules/next/server.js` },
      { find: /^next\/headers$/, replacement: `${REPO}/node_modules/next/headers.js` },
      { find: /^next\/navigation$/, replacement: `${REPO}/node_modules/next/navigation.js` },
    ],
  },
  test: {
    // Vitest 5 keeps a transform cache in <root>/node_modules/.vitest-cache by default, whatever
    // cacheDir says: off, so a run writes nothing under the repository's node_modules.
    fsModuleCache: false,
    fsModuleCachePath: `${CACHE}/.vitest-cache`,
    globals: true,
    dir: HERE,
    include: ["**/*.audit.ts"],
    fileParallelism: false,
    testTimeout: 900_000,
    hookTimeout: 900_000,
    reporters: ["default"],
  },
};
