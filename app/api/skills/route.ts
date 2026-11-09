// GET /api/skills: the merchant's custom skills and the catalog the editor offers.
// POST /api/skills { name, enabled, spec }: save a new one. A skill with problems
// is saved switched off, as a draft; the answer lists the problems.

import { SKILL_CATALOG } from "@/engine/custom-skills";
import { listSkills, missingSkillsTable, saveSkill } from "@/jobs/custom-skills";
import { getPool } from "@/jobs/db";
import { requireMerchant } from "@/lib/session";
import { merchantTimeZone, NEEDS_MIGRATION, present, SkillBody } from "@/lib/skills-api";

export async function GET() {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  try {
    const skills = await listSkills(getPool(), session.merchantId);
    return Response.json({ skills: skills.map(present), catalog: SKILL_CATALOG, timeZone: await merchantTimeZone(session.merchantId) });
  } catch (err) {
    if (missingSkillsTable(err)) return Response.json({ ...NEEDS_MIGRATION, catalog: SKILL_CATALOG }, { status: 503 });
    throw err;
  }
}

export async function POST(request: Request) {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  const body = SkillBody.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: "That skill doesn't look right. Reload and try again." }, { status: 400 });
  try {
    const timeZone = await merchantTimeZone(session.merchantId);
    const out = await saveSkill(getPool(), session.merchantId, body.data, { now: new Date(), timeZone });
    return Response.json({ skill: present(out!.skill), problems: out!.problems }, { status: 201 });
  } catch (err) {
    if (missingSkillsTable(err)) return Response.json(NEEDS_MIGRATION, { status: 503 });
    throw err;
  }
}
