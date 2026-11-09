// PUT /api/skills/{id} { name, enabled, spec }: save changes (a skill with
// problems is kept as a switched-off draft). DELETE: remove it.

import { deleteSkill, saveSkill } from "@/jobs/custom-skills";
import { getPool } from "@/jobs/db";
import { requireMerchant } from "@/lib/session";
import { merchantTimeZone, present, SkillBody, UUID } from "@/lib/skills-api";

export async function PUT(request: Request, ctx: RouteContext<"/api/skills/[id]">) {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return Response.json({ error: "No such skill" }, { status: 404 });
  const body = SkillBody.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: "That skill doesn't look right. Reload and try again." }, { status: 400 });
  const timeZone = await merchantTimeZone(session.merchantId);
  const out = await saveSkill(getPool(), session.merchantId, body.data, { id, now: new Date(), timeZone });
  return out ? Response.json({ skill: present(out.skill), problems: out.problems }) : Response.json({ error: "No such skill" }, { status: 404 });
}

export async function DELETE(_request: Request, ctx: RouteContext<"/api/skills/[id]">) {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  const { id } = await ctx.params;
  if (!UUID.test(id)) return Response.json({ error: "No such skill" }, { status: 404 });
  const ok = await deleteSkill(getPool(), session.merchantId, id);
  return ok ? Response.json({ ok }) : Response.json({ error: "No such skill" }, { status: 404 });
}
