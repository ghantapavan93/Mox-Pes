import { createPool, DEFAULT_DATABASE_URL } from "../../lib/db";
import { seed } from "../../lib/sim/seed";

export default async function globalSetup() {
  if (process.env.SKIP_SEED) return;
  const pool = createPool(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  try {
    await seed(pool, { log: (line) => console.log(`[seed] ${line}`) });
  } finally {
    await pool.end();
  }
}
