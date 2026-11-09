// PUT /api/workflows/{id} { name, enabled, graph }: save changes (a workflow
// with problems is kept as a switched-off draft). DELETE: remove it.

import { requireMerchant } from "@/lib/session";
import { getPool } from "@/jobs/db";
import { deleteWorkflow, saveWorkflow } from "@/jobs/workflows";
import { present, WorkflowBody } from "@/lib/workflows-api";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PUT(request: Request, ctx: RouteContext<"/api/workflows/[id]">) {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return Response.json({ error: "No such workflow" }, { status: 404 });
  const body = WorkflowBody.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: "That workflow doesn't look right. Reload and try again." }, { status: 400 });
  const out = await saveWorkflow(getPool(), session.merchantId, body.data, id);
  return out ? Response.json({ workflow: present(out.workflow), problems: out.problems }) : Response.json({ error: "No such workflow" }, { status: 404 });
}

export async function DELETE(_request: Request, ctx: RouteContext<"/api/workflows/[id]">) {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return Response.json({ error: "No such workflow" }, { status: 404 });
  const ok = await deleteWorkflow(getPool(), session.merchantId, id);
  return ok ? Response.json({ ok }) : Response.json({ error: "No such workflow" }, { status: 404 });
}
