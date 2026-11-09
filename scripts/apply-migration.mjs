// Applies one SQL migration to the database in .env.local (DATABASE_URL), for
// machines without psql. Prints only the file name and the result, never the URL.
//
//   node scripts/apply-migration.mjs db/migrations/011_clients.sql

import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const file = process.argv[2];
if (!file || !file.endsWith(".sql")) {
  console.error("Usage: node scripts/apply-migration.mjs db/migrations/<file>.sql");
  process.exit(1);
}
process.loadEnvFile(join(root, ".env.local"));
if (!process.env.DATABASE_URL) {
  console.error("Set DATABASE_URL in .env.local");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 1 });
try {
  await pool.query(readFileSync(join(root, file), "utf8"));
  console.log(`Applied ${relative(root, join(root, file))}`);
} catch (err) {
  console.error(`Failed: ${err.code ?? ""} ${err.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
