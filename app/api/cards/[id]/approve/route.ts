// POST /api/cards/{id}/approve: re-checks, then the executor writes to PayPal.

import { approveCard } from "@/executor/from-env";
import { requireMerchant } from "@/lib/session";

const STATUS = { executed: 200, not_waiting: 409, obsolete: 409, paused: 409, held: 409, retry: 503, failed: 422 } as const;

export async function POST(_request: Request, ctx: RouteContext<"/api/cards/[id]/approve">) {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const outcome = await approveCard(session.merchantId, id);
  return Response.json(outcome, { status: STATUS[outcome.status] });
}
