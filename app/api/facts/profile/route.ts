// PUT /api/facts/profile { key, value }: one answer in the business profile on
// About my business (what you do, usual terms, reminder tone, late fees). Every
// answer is optional; null clears it. Saved as a fact Pyp reads in every case file.

import { requireMerchant } from "@/lib/session";
import { getPool } from "@/jobs/db";
import { missingFactsTable, ProfileInput, setProfile } from "@/jobs/facts";

export async function PUT(request: Request) {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  const body = ProfileInput.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: "That isn't one of the choices" }, { status: 400 });
  try {
    return Response.json({ fact: await setProfile(getPool(), session.merchantId, body.data) });
  } catch (err) {
    if (missingFactsTable(err)) return Response.json({ error: "The database needs migration 013_merchant_facts.sql first" }, { status: 503 });
    throw err;
  }
}
