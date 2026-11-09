// POST /api/workflows/{id}/run: "Run now". Runs the workflow for whatever its
// When block covers today; any card it makes waits in the Inbox like any other.

import { requireMerchant } from "@/lib/session";
import { runWorkflowNow } from "@/lib/sweeps";

// Up to ten skill runs, each a model call or two.
export const maxDuration = 300;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(_request: Request, ctx: RouteContext<"/api/workflows/[id]/run">) {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return Response.json({ error: "No such workflow" }, { status: 404 });
  const out = await runWorkflowNow(session.merchantId, id);
  if (!out) return Response.json({ error: "No such workflow" }, { status: 404 });
  if (out.status === "busy") return Response.json({ ...out, message: "Pyp is already running a check; try again in a minute" }, { status: 409 });
  if (out.status === "paused") return Response.json({ ...out, message: "Pyp is paused. Turn it back on in Settings." }, { status: 409 });
  return Response.json(out);
}
