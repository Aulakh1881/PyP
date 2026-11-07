// A throwaway Postgres database with the real migrations applied, for tests.
// Needs TEST_DATABASE_URL: a server where this user may create databases
// (CI runs a postgres service; locally, e.g. postgres://localhost/postgres).
// Supabase's auth schema is stubbed with just what migrations 002-003 use.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";

export const TEST_DB_URL = process.env.TEST_DATABASE_URL;

const AUTH_STUB = `
  create schema if not exists auth;
  create table if not exists auth.users (id uuid primary key);
  create or replace function auth.uid() returns uuid language sql stable as 'select null::uuid';
  do $$ begin create role authenticated; exception when duplicate_object then null; end $$;
`;

const root = join(__dirname, "..", "db");

export async function freshDatabase(): Promise<{ pool: Pool; drop: () => Promise<void> }> {
  if (!TEST_DB_URL) throw new Error("Set TEST_DATABASE_URL");
  const name = `pyp_test_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new Pool({ connectionString: TEST_DB_URL, max: 1 });
  await admin.query(`create database ${name}`);
  const url = new URL(TEST_DB_URL);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.toString(), max: 4 });
  // Dropping the database ends its connections ("57P01: terminating connection due
  // to administrator command"). A client still closing then emits that as an error;
  // with no listener it fails the whole Vitest run, so expect it here.
  pool.on("error", (err: Error & { code?: string }) => {
    if (err.code !== "57P01") throw err;
  });

  await pool.query(AUTH_STUB);
  const migrations = readdirSync(join(root, "migrations")).filter((f) => f.endsWith(".sql")).sort();
  // The order db/README.md gives: the seed goes in before migration 003.
  for (const file of migrations) {
    if (file.startsWith("003")) await pool.query(readFileSync(join(root, "seed", "001_demo_merchant.sql"), "utf8"));
    await pool.query(readFileSync(join(root, "migrations", file), "utf8"));
  }

  return {
    pool,
    drop: async () => {
      await pool.end();
      // pool.end() can return before the server has closed every connection. Wait
      // for them to go, so the forced drop below doesn't cut one off mid-close.
      for (let i = 0; i < 50; i++) {
        const open = await admin.query("select count(*)::int as n from pg_stat_activity where datname = $1", [name]);
        if (open.rows[0].n === 0) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      await admin.query(`drop database ${name} with (force)`);
      await admin.end();
    },
  };
}

export const DEMO_MERCHANT = "00000000-0000-0000-0000-000000000001";
