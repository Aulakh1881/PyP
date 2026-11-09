// POST /api/skills/draft { description }: "Describe it, Pyp drafts it". One
// sentence becomes a custom skill's form for the merchant to review. Nothing is
// saved: the page shows the draft, and Save goes through POST /api/skills.

import { z } from "zod";
import { describeSchedule, describeSkill } from "@/engine/custom-skills";
import { draftSkill, MAX_DESCRIPTION_CHARS } from "@/engine/skill-draft";
import { serverAgent } from "@/lib/agent";
import { requireMerchant } from "@/lib/session";

export const maxDuration = 60;

const Body = z.object({ description: z.string().trim().min(1).max(MAX_DESCRIPTION_CHARS) });

export async function POST(request: Request) {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  const body = Body.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: `Describe the skill in up to ${MAX_DESCRIPTION_CHARS} characters.` }, { status: 400 });
  const out = await draftSkill(serverAgent(), body.data.description, { signal: request.signal });
  if ("error" in out) return Response.json({ error: out.error }, { status: 422 });
  const { name, spec, problems, notes } = out;
  return Response.json({ name, spec, problems, notes, summary: describeSkill(spec), when: describeSchedule(spec.schedule) });
}
