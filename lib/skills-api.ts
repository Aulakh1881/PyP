// Shared by the /api/skills routes: the request body, how a skill is shown,
// and the merchant's time zone for its schedule.

import { z } from "zod";
import { describeSchedule, describeSkill, skillProblems, SkillSpec } from "@/engine/custom-skills";
import type { StoredSkill } from "@/jobs/custom-skills";
import { getPool } from "@/jobs/db";

export const SkillBody = z.object({ name: z.string().trim().min(1).max(60), enabled: z.boolean(), spec: SkillSpec });
export const NEEDS_MIGRATION = { error: "The database needs migration 014_custom_skills.sql first" };
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A skill with its one-line summary, its schedule in words, and what still needs fixing. */
export const present = (s: StoredSkill) => ({ ...s, summary: describeSkill(s.spec), when: describeSchedule(s.spec.schedule), problems: skillProblems(s.spec) });

export async function merchantTimeZone(merchantId: string): Promise<string> {
  const res = await getPool().query("select timezone from merchants where id = $1", [merchantId]);
  return String(res.rows[0]?.timezone ?? "UTC");
}
