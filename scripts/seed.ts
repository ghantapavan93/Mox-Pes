import { createPool, DEFAULT_DATABASE_URL } from "@/lib/db";
import { seed } from "@/lib/sim/seed";

async function main() {
  const pool = createPool(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  try {
    await seed(pool, { log: (line) => console.log(line) });
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
