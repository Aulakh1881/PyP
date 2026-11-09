// DELETE /api/documents/{id}: forget a file and the notes it added.

import { deleteDocument } from "@/jobs/documents";
import { getPool } from "@/jobs/db";
import { requireMerchant } from "@/lib/session";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function DELETE(_request: Request, ctx: RouteContext<"/api/documents/[id]">) {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return Response.json({ error: "No such file" }, { status: 404 });
  const ok = await deleteDocument(getPool(), session.merchantId, id);
  return ok ? Response.json({ ok }) : Response.json({ error: "No such file" }, { status: 404 });
}
