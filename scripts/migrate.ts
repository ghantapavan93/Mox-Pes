import { createPool, DEFAULT_DATABASE_URL } from "@/lib/db";
import { migrate } from "@/lib/migrate";

/**
 * Applies pending migrations to an existing database without resetting it:
 * `npm run db:migrate` (DATABASE_URL overrides the demo database). Append-only: an edited
 * migration that was already applied is an error.
 */
async function main() {
  const pool = createPool(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  const ran = await migrate(pool, (line) => console.log(line));
  console.log(ran.length ? `Applied ${ran.length} migration(s).` : "Up to date.");
  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
