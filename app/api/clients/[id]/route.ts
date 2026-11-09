// PATCH /api/clients/{id}: edit a saved client. DELETE: remove it from Pyp
// (PayPal and past invoices are untouched).

import { requireMerchant } from "@/lib/session";
import { getPool } from "@/jobs/db";
import { ClientInput, deleteClient, updateClient } from "@/jobs/clients";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(request: Request, ctx: RouteContext<"/api/clients/[id]">) {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return Response.json({ error: "No such client" }, { status: 404 });
  const body = ClientInput.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: body.error.issues[0]?.message ?? "Check the client's details" }, { status: 400 });
  const out = await updateClient(getPool(), session.merchantId, id, body.data);
  if (out === "duplicate") return Response.json({ error: "Another saved client has this email" }, { status: 409 });
  return out ? Response.json({ client: out }) : Response.json({ error: "No such client" }, { status: 404 });
}

export async function DELETE(_request: Request, ctx: RouteContext<"/api/clients/[id]">) {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return Response.json({ error: "No such client" }, { status: 404 });
  const ok = await deleteClient(getPool(), session.merchantId, id);
  return ok ? Response.json({ ok }) : Response.json({ error: "No such client" }, { status: 404 });
}
