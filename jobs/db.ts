// The server's one Postgres connection pool (Supabase Postgres over
// DATABASE_URL). Server-only: it connects as the table owner, which bypasses
// Row Level Security, so only route handlers and jobs may import it.

import { Pool } from "pg";

let pool: Pool | null = null;

export function getPool(): Pool {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("Set DATABASE_URL (Supabase: Connect, Session pooler URI)");
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  // TODO: pin Supabase's CA certificate instead of accepting any certificate.
  pool = new Pool({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false }, max: 5 });
  return pool;
}
