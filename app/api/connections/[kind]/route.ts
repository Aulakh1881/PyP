// PUT /api/connections/{slack|discord|webhook} { url }: add or replace it. For
// "webhook" (any app) the answer carries the signing secret, this once.
// PATCH { enabled }: switch it on or off. DELETE: remove it.

import { z } from "zod";
import { deleteConnection, KINDS, masked, saveConnection, setConnectionEnabled, type ConnectionKind } from "@/jobs/connections";
import { getPool } from "@/jobs/db";
import { requireMerchant } from "@/lib/session";

const kindOf = (k: string): ConnectionKind | null => ((KINDS as readonly string[]).includes(k) ? (k as ConnectionKind) : null);

export async function PUT(request: Request, ctx: RouteContext<"/api/connections/[kind]">) {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  const kind = kindOf((await ctx.params).kind);
  if (!kind) return Response.json({ error: "No such connection" }, { status: 404 });
  const body = z.object({ url: z.string().trim().min(1).max(500) }).safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: "Paste the webhook URL." }, { status: 400 });
  const out = await saveConnection(getPool(), session.merchantId, kind, body.data.url);
  if ("error" in out) return Response.json({ error: out.error }, { status: 422 });
  return Response.json({ connection: masked(out.connection), secret: out.secret });
}

export async function PATCH(request: Request, ctx: RouteContext<"/api/connections/[kind]">) {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  const kind = kindOf((await ctx.params).kind);
  const body = z.object({ enabled: z.boolean() }).safeParse(await request.json().catch(() => null));
  if (!kind || !body.success) return Response.json({ error: "Send { enabled: true | false }" }, { status: 400 });
  const c = await setConnectionEnabled(getPool(), session.merchantId, kind, body.data.enabled);
  return c ? Response.json({ connection: masked(c) }) : Response.json({ error: "No such connection" }, { status: 404 });
}

export async function DELETE(_request: Request, ctx: RouteContext<"/api/connections/[kind]">) {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  const kind = kindOf((await ctx.params).kind);
  if (!kind) return Response.json({ error: "No such connection" }, { status: 404 });
  const ok = await deleteConnection(getPool(), session.merchantId, kind);
  return ok ? Response.json({ ok }) : Response.json({ error: "No such connection" }, { status: 404 });
}
