// POST /api/connections/{kind}/test: post a sample card there, so the merchant
// sees what Pyp's messages look like. Nothing is proposed or sent to PayPal.

import { KINDS, sendTest, type ConnectionKind } from "@/jobs/connections";
import { getPool } from "@/jobs/db";
import { fetcher, inboxLink } from "@/lib/connections";
import { requireMerchant } from "@/lib/session";

export async function POST(_request: Request, ctx: RouteContext<"/api/connections/[kind]/test">) {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  const kind = (await ctx.params).kind;
  if (!(KINDS as readonly string[]).includes(kind)) return Response.json({ error: "No such connection" }, { status: 404 });
  const out = await sendTest(getPool(), fetcher, session.merchantId, kind as ConnectionKind, inboxLink(), new Date());
  if (!out) return Response.json({ error: "Add this connection first" }, { status: 404 });
  return out.ok ? Response.json({ ok: true, status: out.status }) : Response.json({ ok: false, error: out.status }, { status: 502 });
}
