// GET /api/cards/{id}/trace: the back of the card (design §11.2).

import { requireMerchant } from "@/lib/session";
import { getPool } from "@/jobs/db";
import { getTrace } from "@/jobs/store";

export async function GET(_request: Request, ctx: RouteContext<"/api/cards/[id]/trace">) {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const steps = await getTrace(getPool(), session.merchantId, id);
  return steps ? Response.json({ steps }) : Response.json({ error: "Card not found" }, { status: 404 });
}
