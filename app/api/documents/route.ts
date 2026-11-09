// POST /api/documents (multipart: file, optional subject "dispute:<id>" or
// "invoice:<id>"): Pyp reads the file once and keeps what it shows. On a
// subject, that becomes a note Pyp can cite in that case file. Attach it to a
// chat message with its id. Nothing is sent anywhere.
// GET /api/documents[?subject=dispute:<id>]: the merchant's files and what Pyp read.

import { fileProblem, IMAGE_TYPES } from "@/engine/document-reader";
import { listDocuments, missingDocumentsTable, present, saveDocument } from "@/jobs/documents";
import { getPool } from "@/jobs/db";
import { serverAgent } from "@/lib/agent";
import { requireMerchant } from "@/lib/session";

// Reading a long PDF is one model call; give it room.
export const maxDuration = 120;

const SUBJECT = /^(dispute|invoice):([A-Za-z0-9-]{1,80})$/;
const TYPES = new Set<string>(["application/pdf", ...IMAGE_TYPES]);
const NEEDS_MIGRATION = { error: "The database needs migration 017_documents.sql first" };

export async function GET(request: Request) {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  const subject = new URL(request.url).searchParams.get("subject");
  if (subject && !SUBJECT.test(subject)) return Response.json({ error: "Unknown subject" }, { status: 400 });
  try {
    const docs = await listDocuments(getPool(), session.merchantId, subject);
    return Response.json({ documents: docs.map(present) });
  } catch (err) {
    if (missingDocumentsTable(err)) return Response.json(NEEDS_MIGRATION, { status: 503 });
    throw err;
  }
}

export async function POST(request: Request) {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  // Refuse a too-big upload before reading it (the proxy would cut it off anyway).
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > 8.5 * 1024 * 1024) return Response.json({ error: "That file is over 8 MB." }, { status: 413 });
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!form || !(file instanceof File)) return Response.json({ error: "Attach a file." }, { status: 400 });
  const subjectRaw = String(form.get("subject") ?? "").trim();
  const m = subjectRaw ? SUBJECT.exec(subjectRaw) : null;
  if (subjectRaw && !m) return Response.json({ error: "Unknown subject" }, { status: 400 });
  // The browser's type, checked against the bytes below (fileProblem sniffs them).
  const mediaType = file.type === "image/jpg" ? "image/jpeg" : file.type;
  if (!TYPES.has(mediaType)) return Response.json({ error: "Pyp reads PDFs and images (PNG, JPEG, WebP, GIF)." }, { status: 415 });
  if (file.size > 8 * 1024 * 1024) return Response.json({ error: "That file is over 8 MB." }, { status: 413 });
  const bytes = Buffer.from(await file.arrayBuffer());
  const problem = fileProblem(bytes, mediaType);
  if (problem) return Response.json({ error: problem }, { status: 422 });
  try {
    const doc = await saveDocument(
      { pool: getPool(), agent: serverAgent(), signal: request.signal },
      session.merchantId,
      { name: file.name, mediaType, bytes, subject: m ? { kind: m[1], id: m[2] } : null },
    );
    return Response.json({ document: present(doc) }, { status: doc.status === "failed" ? 422 : 201 });
  } catch (err) {
    if (missingDocumentsTable(err)) return Response.json(NEEDS_MIGRATION, { status: 503 });
    throw err;
  }
}
