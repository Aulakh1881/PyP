// Files the merchant gives Pyp (db/migrations/017_documents.sql). Each is read
// once (engine/document-reader.ts) and kept with what it shows. Two uses:
//
//   In chat     attached to a message ("invoice this"): its facts ride along
//               with the merchant's words to the receptionist (chatContext).
//   On a case   attached to a dispute or invoice: its facts become a note in
//               that case file (merchant_facts, source 'document'), which the
//               evidence can cite. Pyp still only proposes; every write is a card.
//
// A file that tries to instruct Pyp is kept as "suspicious" and used for nothing.

import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { factsLine, filesBlock, KIND_LABEL, readDocument, type DocumentFacts } from "@/engine/document-reader";
import type { AgentClient, SubjectRef } from "@/engine/types";
import { subjectRef } from "./store";

type Db = Pick<Pool, "query">;

export interface StoredDocument {
  id: string;
  name: string;
  mediaType: string;
  sizeBytes: number;
  subjectRef: string | null;
  status: "read" | "suspicious" | "failed";
  facts: DocumentFacts | null;
  reason: string | null;
  createdAt: string;
}

/** Files that can ride along with one chat message. */
export const MAX_CHAT_FILES = 2;

export function missingDocumentsTable(err: unknown): boolean {
  return (err as { code?: string }).code === "42P01";
}

const COLUMNS = "id, name, media_type, size_bytes, subject_ref, status, facts, reason, created_at";
function toDoc(r: Record<string, unknown>): StoredDocument {
  return {
    id: String(r.id),
    name: String(r.name),
    mediaType: String(r.media_type),
    sizeBytes: Number(r.size_bytes),
    subjectRef: (r.subject_ref as string | null) ?? null,
    status: r.status as StoredDocument["status"],
    facts: (r.facts as DocumentFacts | null) ?? null,
    reason: (r.reason as string | null) ?? null,
    createdAt: new Date(r.created_at as string).toISOString(),
  };
}

/** What the merchant sees about a file: what it is and what Pyp read, in a line. */
export function present(d: StoredDocument) {
  return {
    id: d.id,
    name: d.name,
    mediaType: d.mediaType,
    sizeBytes: d.sizeBytes,
    subjectRef: d.subjectRef,
    status: d.status,
    kind: d.facts ? KIND_LABEL[d.facts.kind] : null,
    summary: d.facts?.summary ?? null,
    line: d.facts && d.status === "read" ? factsLine(d.name, d.facts) : null,
    facts: d.status === "read" ? d.facts : null,
    reason: d.reason,
    createdAt: d.createdAt,
  };
}

/** A safe file name: no paths, no control characters. */
export function cleanName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  return base.replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 200) || "file";
}

/**
 * Saves and reads one file. The same file (same bytes) already read for this
 * merchant isn't read again. On a subject, a readable file adds its note.
 */
export async function saveDocument(
  deps: { pool: Pool; agent: AgentClient; signal?: AbortSignal },
  merchantId: string,
  input: { name: string; mediaType: string; bytes: Buffer; subject?: SubjectRef | null },
): Promise<StoredDocument> {
  const name = cleanName(input.name);
  const sha = createHash("sha256").update(input.bytes).digest("hex");
  const subject = input.subject ? subjectRef(input.subject) : null;

  const prior = (await deps.pool.query(`select ${COLUMNS} from documents where merchant_id = $1 and sha256 = $2 and status <> 'failed' order by created_at desc limit 1`, [merchantId, sha])).rows[0];
  let status: StoredDocument["status"];
  let facts: DocumentFacts | null = null;
  let reason: string | null = null;
  if (prior) {
    status = prior.status;
    facts = prior.facts;
    reason = prior.reason ?? null;
  } else {
    const read = await readDocument(deps.agent, { bytes: input.bytes, mediaType: input.mediaType, name }, { signal: deps.signal });
    if (read.ok) {
      facts = read.facts;
      status = read.suspicious ? "suspicious" : "read";
      if (read.suspicious) reason = "This file seems to give instructions to an assistant, so Pyp won't use what it says.";
    } else {
      status = "failed";
      reason = read.reason;
    }
  }

  const client = await deps.pool.connect();
  try {
    await client.query("begin");
    const row = (
      await client.query(
        `insert into documents (merchant_id, name, media_type, size_bytes, sha256, data, subject_ref, status, facts, reason)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning ${COLUMNS}`,
        [merchantId, name, input.mediaType, input.bytes.length, sha, input.bytes, subject, status, facts ? JSON.stringify(facts) : null, reason],
      )
    ).rows[0];
    const doc = toDoc(row);
    // On a dispute or invoice: what it shows becomes a note Pyp can cite there.
    if (subject && doc.status === "read" && doc.facts) {
      await client.query(
        `insert into merchant_facts (merchant_id, text, subject_ref, status, source, document_id) values ($1, $2, $3, 'active', 'document', $4)`,
        [merchantId, factsLine(name, doc.facts), subject, doc.id],
      );
    }
    await client.query("commit");
    return doc;
  } catch (err) {
    await client.query("rollback").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function listDocuments(db: Db, merchantId: string, subject?: string | null): Promise<StoredDocument[]> {
  const res = subject
    ? await db.query(`select ${COLUMNS} from documents where merchant_id = $1 and subject_ref = $2 order by created_at desc limit 50`, [merchantId, subject])
    : await db.query(`select ${COLUMNS} from documents where merchant_id = $1 order by created_at desc limit 50`, [merchantId]);
  return res.rows.map(toDoc);
}

export async function getDocuments(db: Db, merchantId: string, ids: string[]): Promise<StoredDocument[]> {
  if (!ids.length) return [];
  const res = await db.query(`select ${COLUMNS} from documents where merchant_id = $1 and id = any($2::uuid[])`, [merchantId, ids]);
  return res.rows.map(toDoc);
}

/** Deletes a file and the notes it added. */
export async function deleteDocument(db: Db, merchantId: string, id: string): Promise<boolean> {
  const res = await db.query("delete from documents where merchant_id = $1 and id = $2", [merchantId, id]);
  return res.rowCount === 1;
}

/**
 * What attached files add to a chat message: one line per readable file, built
 * by code from checked facts. Suspicious or unreadable files say so and add nothing.
 */
export function chatContext(docs: StoredDocument[]): string {
  // Only files Pyp could read and trust; the merchant was already told about the rest.
  return filesBlock(docs.filter((d) => d.status === "read" && d.facts).map((d) => `- ${factsLine(d.name, d.facts!, 400)}`));
}
