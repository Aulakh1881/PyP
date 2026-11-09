// POST /api/skills/{id}/run: "Run now". Pyp handles everything the skill watches
// that passes its checks; any card it makes waits in the Inbox like any other.

import { requireMerchant } from "@/lib/session";
import { UUID } from "@/lib/skills-api";
import { runCustomSkillNow } from "@/lib/sweeps";

// Up to ten skill runs, each a model call or two.
export const maxDuration = 300;

export async function POST(_request: Request, ctx: RouteContext<"/api/skills/[id]/run">) {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return Response.json({ error: "No such skill" }, { status: 404 });
  const out = await runCustomSkillNow(session.merchantId, id, false);
  if (!out) return Response.json({ error: "No such skill" }, { status: 404 });
  if (out.status === "busy") return Response.json({ ...out, message: "Pyp is already running a check; try again in a minute" }, { status: 409 });
  if (out.status === "paused") return Response.json(out, { status: 409 });
  return Response.json(out);
}
