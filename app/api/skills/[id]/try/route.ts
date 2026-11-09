// POST /api/skills/{id}/try: "Try it". Pyp decides up to three of the invoices or
// disputes the skill would handle and says what it would do. Nothing is saved or sent.

import { requireMerchant } from "@/lib/session";
import { UUID } from "@/lib/skills-api";
import { runCustomSkillNow } from "@/lib/sweeps";

// Up to three skill runs, each a model call or two.
export const maxDuration = 120;

export async function POST(_request: Request, ctx: RouteContext<"/api/skills/[id]/try">) {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return Response.json({ error: "No such skill" }, { status: 404 });
  const out = await runCustomSkillNow(session.merchantId, id, true);
  if (!out) return Response.json({ error: "No such skill" }, { status: 404 });
  if (out.status === "busy") return Response.json({ ...out, message: "Pyp is already running a check; try again in a minute" }, { status: 409 });
  if (out.status === "paused") return Response.json(out, { status: 409 });
  return Response.json(out);
}
