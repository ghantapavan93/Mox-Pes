import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname) } },
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/integration/**/*.test.ts"],
    // Integration tests share one test database; run files one at a time.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 300_000,
  },
});
