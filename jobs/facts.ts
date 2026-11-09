// What Pyp knows about the merchant's business (db/migrations/013_merchant_facts.sql).
// Active facts reach case files as merchant notes (EngineDb.merchantNotes): for
// Pyp's judgment only, never quoted to clients, and never above code's checks.

import type { Pool } from "pg";
import { z } from "zod";

type Db = Pick<Pool, "query">;

export interface Fact {
  id: string;
  text: string;
  clientEmail: string | null;
  subjectRef: string | null;
  status: "active" | "proposed";
  source: "merchant" | "chat";
  createdAt: string;
}

/** At most this many facts go into one case file, newest first. */
export const MAX_FACTS_IN_CASE_FILE = 12;

export const FactInput = z.object({
  text: z.string().trim().min(1, "Write the fact").max(300, "Keep it under 300 characters"),
  clientEmail: z
    .string()
    .trim()
    .max(254)
    .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Pick a client")
    .nullable()
    .optional(),
});
export type FactInput = z.infer<typeof FactInput>;

const COLUMNS = "id, text, client_email, subject_ref, status, source, created_at";

function toFact(r: Record<string, unknown>): Fact {
  return {
    id: String(r.id),
    text: String(r.text),
    clientEmail: (r.client_email as string | null) ?? null,
    subjectRef: (r.subject_ref as string | null) ?? null,
    status: r.status === "proposed" ? "proposed" : "active",
    source: r.source === "chat" ? "chat" : "merchant",
    createdAt: new Date(r.created_at as string).toISOString(),
  };
}

/** True when migration 013 hasn't been run on this database yet. */
export function missingFactsTable(err: unknown): boolean {
  return (err as { code?: string }).code === "42P01";
}

export async function listFacts(db: Db, merchantId: string): Promise<Fact[]> {
  const res = await db.query(`select ${COLUMNS} from merchant_facts where merchant_id = $1 order by created_at desc`, [merchantId]);
  return res.rows.map(toFact);
}

export async function addFact(
  db: Db,
  merchantId: string,
  input: { text: string; clientEmail?: string | null; subjectRef?: string | null; status?: Fact["status"]; source?: Fact["source"] },
): Promise<Fact> {
  const res = await db.query(
    `insert into merchant_facts (merchant_id, text, client_email, subject_ref, status, source)
     values ($1, $2, $3, $4, $5, $6) returning ${COLUMNS}`,
    [merchantId, input.text.trim(), input.clientEmail ?? null, input.subjectRef ?? null, input.status ?? "active", input.source ?? "merchant"],
  );
  return toFact(res.rows[0]);
}

/** Edit a fact, or confirm one Pyp proposed. Null when there's no such fact. */
export async function updateFact(db: Db, merchantId: string, id: string, input: FactInput & { confirm?: boolean }): Promise<Fact | null> {
  const res = await db.query(
    `update merchant_facts set text = $3, client_email = $4, status = case when $5 then 'active' else status end, updated_at = now()
      where merchant_id = $1 and id = $2 returning ${COLUMNS}`,
    [merchantId, id, input.text.trim(), input.clientEmail ?? null, input.confirm === true],
  );
  return res.rows[0] ? toFact(res.rows[0]) : null;
}

export async function deleteFact(db: Db, merchantId: string, id: string): Promise<boolean> {
  const res = await db.query("delete from merchant_facts where merchant_id = $1 and id = $2", [merchantId, id]);
  return res.rowCount === 1;
}

/**
 * The active facts for one case file: about the whole business, about this
 * subject, and about these clients (by email). Newest first, capped.
 */
export async function factsFor(db: Db, merchantId: string, subjectRef: string, clientEmails: string[] = []): Promise<string[]> {
  try {
    const res = await db.query(
      `select text, client_email from merchant_facts
        where merchant_id = $1 and status = 'active'
          and ((client_email is null and subject_ref is null)
               or subject_ref = $2
               or lower(client_email) = any($3::text[]))
        order by created_at desc limit $4`,
      [merchantId, subjectRef, clientEmails.map((e) => e.toLowerCase()), MAX_FACTS_IN_CASE_FILE],
    );
    return res.rows.map((r) => (r.client_email ? `About ${r.client_email}: ${r.text}` : String(r.text)));
  } catch (err) {
    if (missingFactsTable(err)) return []; // before migration 013: nothing remembered yet
    throw err;
  }
}
