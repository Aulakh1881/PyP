// POST /api/cards/{id}/approve: re-checks, then the executor writes to PayPal.
// Optional body { edits: { note: "..." } }: the merchant's rewrites of the card's
// text, checked like the model's words before anything is sent.

import { approveCard } from "@/executor/from-env";
import { requireMerchant } from "@/lib/session";

const STATUS = { executed: 200, not_waiting: 409, obsolete: 409, paused: 409, held: 409, edit_rejected: 422, retry: 503, failed: 422 } as const;
const MAX_EDIT_CHARS = 5000;

export async function POST(request: Request, ctx: RouteContext<"/api/cards/[id]/approve">) {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  const { id } = await ctx.params;

  let edits: Record<string, string> | undefined;
  const text = await request.text();
  if (text.trim()) {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return Response.json({ error: "The body must be JSON" }, { status: 400 });
    }
    const e = (body as { edits?: unknown })?.edits;
    if (e !== undefined) {
      const ok = e && typeof e === "object" && !Array.isArray(e) && Object.values(e).every((v) => typeof v === "string" && v.length <= MAX_EDIT_CHARS);
      if (!ok) return Response.json({ error: "edits must map field names to text" }, { status: 400 });
      edits = e as Record<string, string>;
    }
  }

  const outcome = await approveCard(session.merchantId, id, edits);
  return Response.json(outcome, { status: STATUS[outcome.status] });
}
