// POST /api/cards/{id}/clear: "Remove from Inbox" for a finished card (done,
// dismissed, failed, canceled). Only hides it from the Inbox; it stays in
// Activity and the audit trail. Cards still waiting on the merchant can't be cleared.

import { requireMerchant } from "@/lib/session";
import { getPool } from "@/jobs/db";
import { clearCard } from "@/jobs/store";

export async function POST(_request: Request, ctx: RouteContext<"/api/cards/[id]/clear">) {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  try {
    const ok = await clearCard(getPool(), session.merchantId, id);
    return ok ? Response.json({ ok }) : Response.json({ error: "Only finished cards can be removed from the Inbox" }, { status: 409 });
  } catch (err) {
    // 42703: undefined column, i.e. db/migrations/008_card_cleared.sql hasn't been run on this database.
    if ((err as { code?: string }).code === "42703") {
      return Response.json({ error: "The database needs migration 008_card_cleared.sql first" }, { status: 503 });
    }
    throw err;
  }
}
