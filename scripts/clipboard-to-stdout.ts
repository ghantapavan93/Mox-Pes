import { readClipboard } from "./clipboard";

/**
 * Writes the clipboard's database URL to stdout with no trailing newline, so it can be piped into
 * the Vercel CLI without being shown (docs/deploy.md, "The app, on Vercel"):
 *
 *   npx tsx scripts/clipboard-to-stdout.ts | npx vercel env add DATABASE_URL preview <git branch>
 *
 * Anything that is not a postgres:// URL is refused, and nothing is written.
 */
async function main() {
  const value = await readClipboard();
  if (!/^postgres(ql)?:\/\/\S+$/.test(value)) {
    console.error("The clipboard does not hold a database URL; nothing was written.");
    process.exit(1);
  }
  process.stdout.write(value);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Reading the clipboard failed.");
  process.exit(1);
});
