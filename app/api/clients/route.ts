// GET /api/clients: the merchant's saved clients, plus people from recent PayPal
// invoices that aren't saved yet (read-only: saving one makes it editable).
// POST /api/clients { name?, businessName?, email, nicknames? }: save a client.
// Saving a client never touches PayPal (jobs/clients.ts).

import { requireMerchant } from "@/lib/session";
import { getPool } from "@/jobs/db";
import { ClientInput, createClient, listSavedClients, missingClientsTable } from "@/jobs/clients";
import { PayPalReadClient } from "@/paypal/engine-reads";
import { sharedPayPalHttp } from "@/paypal/http";

const NEEDS_MIGRATION = { error: "The database needs migration 011_clients.sql first" };

export async function GET() {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  let saved;
  try {
    saved = await listSavedClients(getPool(), session.merchantId);
  } catch (err) {
    if (missingClientsTable(err)) return Response.json(NEEDS_MIGRATION, { status: 503 });
    throw err;
  }
  // PayPal is a nice-to-have here: if it's slow or down, the saved list still shows.
  const fromPayPal = await new PayPalReadClient(sharedPayPalHttp()).recentClients().catch(() => null);
  const savedEmails = new Set(saved.map((c) => c.email.toLowerCase()));
  const unsaved = (fromPayPal ?? [])
    .filter((c) => !savedEmails.has(c.email.toLowerCase()))
    .map((c) => ({ name: c.name, businessName: c.businessName, email: c.email }));
  return Response.json({ saved, fromPayPal: unsaved, paypalOk: fromPayPal !== null });
}

export async function POST(request: Request) {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  const body = ClientInput.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: body.error.issues[0]?.message ?? "Check the client's details" }, { status: 400 });
  try {
    const client = await createClient(getPool(), session.merchantId, body.data);
    return client ? Response.json({ client }, { status: 201 }) : Response.json({ error: "A client with this email is already saved" }, { status: 409 });
  } catch (err) {
    if (missingClientsTable(err)) return Response.json(NEEDS_MIGRATION, { status: 503 });
    throw err;
  }
}
