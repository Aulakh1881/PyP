// PATCH /api/facts/{id} { text, clientEmail?, confirm? }: edit a fact, or confirm
// one Pyp proposed. DELETE: forget it.

import { requireMerchant } from "@/lib/session";
import { getPool } from "@/jobs/db";
import { deleteFact, FactInput, updateFact } from "@/jobs/facts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(request: Request, ctx: RouteContext<"/api/facts/[id]">) {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return Response.json({ error: "No such fact" }, { status: 404 });
  const raw = (await request.json().catch(() => null)) as { confirm?: unknown } | null;
  const body = FactInput.safeParse(raw);
  if (!body.success) return Response.json({ error: body.error.issues[0]?.message ?? "Check the fact" }, { status: 400 });
  const fact = await updateFact(getPool(), session.merchantId, id, { ...body.data, confirm: raw?.confirm === true });
  return fact ? Response.json({ fact }) : Response.json({ error: "No such fact" }, { status: 404 });
}

export async function DELETE(_request: Request, ctx: RouteContext<"/api/facts/[id]">) {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return Response.json({ error: "No such fact" }, { status: 404 });
  const ok = await deleteFact(getPool(), session.merchantId, id);
  return ok ? Response.json({ ok }) : Response.json({ error: "No such fact" }, { status: 404 });
}
