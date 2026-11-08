// POST /api/cards/{id}/answer: body { optionIndex }. Answers a question card; the
// skill runs again with the answer and any new cards come back as usual.
// Free-text answers (typing an email) aren't supported yet (design B.1a).

import { getPool } from "@/jobs/db";
import { answerCard } from "@/jobs/answer-run";
import { serverAgent } from "@/lib/agent";
import { requireMerchant } from "@/lib/session";
import { PayPalReadClient } from "@/paypal/engine-reads";
import { sharedPayPalHttp } from "@/paypal/http";

// The follow-up run is a model call.
export const maxDuration = 300;

// retry: the follow-up run failed; the question is waiting again.
const STATUS = { answered: 200, not_waiting: 409, bad_option: 422, retry: 503 } as const;

export async function POST(request: Request, ctx: RouteContext<"/api/cards/[id]/answer">) {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  const body = (await request.json().catch(() => null)) as { optionIndex?: unknown } | null;
  if (!Number.isInteger(body?.optionIndex)) return Response.json({ error: "Send { optionIndex: 0 }" }, { status: 400 });
  const outcome = await answerCard(
    { pool: getPool(), read: new PayPalReadClient(sharedPayPalHttp()), agent: serverAgent() },
    session.merchantId,
    id,
    body!.optionIndex as number,
  );
  return Response.json(outcome, { status: STATUS[outcome.status] });
}
