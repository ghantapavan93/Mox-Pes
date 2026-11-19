import { createPool } from "@/lib/db";
import { applyHostedExamples } from "@/lib/demo/hosted-examples";
import { readClipboard } from "./clipboard";

/**
 * Gives a loaded and corrected copy of the demo world its worked examples
 * (lib/demo/hosted-examples.ts): two recorded answer checks, a ChangeGuard change in review and a
 * fix awaiting approval, each made through the product's own paths as the demo roles would. None
 * moves a shared figure, and a second run changes nothing.
 *
 *   npm run db:examples-hosted -- --from-clipboard     the serving branch's URL on the clipboard
 *   DATABASE_URL=… npm run db:examples-hosted          a local rehearsal copy
 *
 * The URL is never printed. Refuses the local demo, release-candidate, test and deploy databases.
 */

const PROTECTED = new Set(["revenue_signal", "revenue_signal_rc", "revenue_signal_test", "revenue_signal_deploy"]);

async function targetUrl(): Promise<string> {
  const raw = process.argv.includes("--from-clipboard") ? await readClipboard() : (process.env.DATABASE_URL ?? "");
  if (!/^postgres(ql)?:\/\/\S+$/.test(raw)) throw new Error("No database URL: put the branch's URL on the clipboard (--from-clipboard) or set DATABASE_URL.");
  const name = decodeURIComponent(new URL(raw).pathname.slice(1));
  if (PROTECTED.has(name)) throw new Error(`Refusing to change the local ${name} database.`);
  return raw;
}

async function main() {
  const pool = createPool(await targetUrl());
  try {
    const done = await applyHostedExamples(pool);
    console.log(done.length ? done.join("\n") : "Every example is already there: nothing to do.");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
