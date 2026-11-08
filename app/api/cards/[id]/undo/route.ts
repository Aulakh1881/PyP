// POST /api/cards/{id}/undo: cancels an Auto action still in its undo window,
// or a follow-up that hasn't come due. Nothing has left Pyp (design §8.3).

import { requireMerchant } from "@/lib/session";
import { getPool } from "@/jobs/db";
import { undo } from "@/jobs/store";

export async function POST(_request: Request, ctx: RouteContext<"/api/cards/[id]/undo">) {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const ok = await undo(getPool(), session.merchantId, id);
  return ok ? Response.json({ ok, message: "Undone. Nothing was sent." }) : Response.json({ error: "Too late to undo: this already ran" }, { status: 409 });
}
