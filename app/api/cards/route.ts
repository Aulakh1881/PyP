// GET /api/cards: the Inbox feed, newest first, with each card's buttons.

import { cardActions } from "@/engine/card";
import { requireMerchant } from "@/lib/session";
import { getPool } from "@/jobs/db";
import { listCards } from "@/jobs/store";

export async function GET() {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  const cards = await listCards(getPool(), session.merchantId);
  return Response.json({ cards: cards.map((c) => ({ ...c, actions: cardActions(c.state, c.front) })) });
}
