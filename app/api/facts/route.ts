// GET /api/facts: what Pyp knows about the merchant's business ("Pyp's memory"),
// newest first, including facts Pyp noticed in chat that wait to be confirmed.
// POST /api/facts { text, clientEmail? }: add one. Facts never touch PayPal; they
// reach case files as merchant-only notes.

import { requireMerchant } from "@/lib/session";
import { getPool } from "@/jobs/db";
import { addFact, FactInput, listFacts, missingFactsTable } from "@/jobs/facts";

const NEEDS_MIGRATION = { error: "The database needs migration 013_merchant_facts.sql first" };

export async function GET() {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  try {
    return Response.json({ facts: await listFacts(getPool(), session.merchantId) });
  } catch (err) {
    if (missingFactsTable(err)) return Response.json(NEEDS_MIGRATION, { status: 503 });
    throw err;
  }
}

export async function POST(request: Request) {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  const body = FactInput.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: body.error.issues[0]?.message ?? "Check the fact" }, { status: 400 });
  try {
    const fact = await addFact(getPool(), session.merchantId, { text: body.data.text, clientEmail: body.data.clientEmail ?? null });
    return Response.json({ fact }, { status: 201 });
  } catch (err) {
    if (missingFactsTable(err)) return Response.json(NEEDS_MIGRATION, { status: 503 });
    throw err;
  }
}
