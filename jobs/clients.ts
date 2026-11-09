// The merchant's client list in Pyp (db/migrations/011_clients.sql). PayPal has no
// contacts list to write to, so saving a client never touches PayPal: it only lets
// Collections invoice someone who hasn't been invoiced before, and match nicknames.

import type { Pool } from "pg";
import { z } from "zod";
import type { Client } from "@/engine/types";

type Db = Pick<Pool, "query">;

export interface SavedClient {
  id: string;
  name: string | null;
  businessName: string | null;
  email: string;
  nicknames: string[];
  source: "merchant" | "chat";
  createdAt: string;
}

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => s || null)
    .nullable()
    .optional();

/** What the Clients page (or the chat) may save. Name or business, and an email. */
export const ClientInput = z
  .object({
    name: text(120),
    businessName: text(120),
    email: z.string().trim().max(254).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Enter a valid email"),
    nicknames: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
  })
  .refine((c) => c.name || c.businessName, { message: "Give a name or a business name" });
export type ClientInput = z.infer<typeof ClientInput>;

const COLUMNS = "id, name, business_name, email, nicknames, source, created_at";

function toSaved(row: Record<string, unknown>): SavedClient {
  return {
    id: String(row.id),
    name: (row.name as string | null) ?? null,
    businessName: (row.business_name as string | null) ?? null,
    email: String(row.email),
    nicknames: (row.nicknames as string[] | null) ?? [],
    source: row.source === "chat" ? "chat" : "merchant",
    createdAt: new Date(row.created_at as string).toISOString(),
  };
}

/** True when migration 011 hasn't been run on this database yet. */
export function missingClientsTable(err: unknown): boolean {
  return (err as { code?: string }).code === "42P01";
}

export async function listSavedClients(db: Db, merchantId: string): Promise<SavedClient[]> {
  const res = await db.query(`select ${COLUMNS} from clients where merchant_id = $1 order by lower(coalesce(business_name, name, email))`, [merchantId]);
  return res.rows.map(toSaved);
}

/** For the engine: saved clients as Collections reads them. No table yet = none saved. */
export async function savedClientsForEngine(db: Db, merchantId: string): Promise<Client[]> {
  try {
    return (await listSavedClients(db, merchantId)).map((c, i) => ({
      id: `saved_${i + 1}`,
      name: c.name,
      businessName: c.businessName,
      email: c.email,
      nicknames: c.nicknames,
    }));
  } catch (err) {
    if (missingClientsTable(err)) return [];
    throw err;
  }
}

/** Adds a client. Null when one with this email is already saved. */
export async function createClient(db: Db, merchantId: string, input: ClientInput, source: SavedClient["source"] = "merchant"): Promise<SavedClient | null> {
  const res = await db.query(
    `insert into clients (merchant_id, name, business_name, email, nicknames, source)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (merchant_id, lower(email)) do nothing
     returning ${COLUMNS}`,
    [merchantId, input.name ?? null, input.businessName ?? null, input.email, input.nicknames ?? [], source],
  );
  return res.rows[0] ? toSaved(res.rows[0]) : null;
}

/** Null when there's no such client, or the new email belongs to another saved client. */
export async function updateClient(db: Db, merchantId: string, id: string, input: ClientInput): Promise<SavedClient | null | "duplicate"> {
  try {
    const res = await db.query(
      `update clients set name = $3, business_name = $4, email = $5, nicknames = $6, updated_at = now()
        where merchant_id = $1 and id = $2
        returning ${COLUMNS}`,
      [merchantId, id, input.name ?? null, input.businessName ?? null, input.email, input.nicknames ?? []],
    );
    return res.rows[0] ? toSaved(res.rows[0]) : null;
  } catch (err) {
    if ((err as { code?: string }).code === "23505") return "duplicate";
    throw err;
  }
}

export async function deleteClient(db: Db, merchantId: string, id: string): Promise<boolean> {
  const res = await db.query("delete from clients where merchant_id = $1 and id = $2", [merchantId, id]);
  return res.rowCount === 1;
}
