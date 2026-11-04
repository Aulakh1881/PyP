// POST /api/cards/{id}/dismiss: the proposal is rejected; nothing is sent.

import { requireMerchant } from "@/lib/session";
import { getPool } from "@/jobs/db";
import { dismiss } from "@/jobs/store";

export async function POST(_request: Request, ctx: RouteContext<"/api/cards/[id]/dismiss">) {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const ok = await dismiss(getPool(), session.merchantId, id);
  return ok ? Response.json({ ok }) : Response.json({ error: "This card isn't waiting for you" }, { status: 409 });
}
