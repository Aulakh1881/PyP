// The list of skills. Adding a skill = a new folder in skills/ + one line here.

import { collections } from "@/skills/collections/skill";
import type { AnySkill, SkillId } from "./types";

export const SKILLS: Record<string, AnySkill> = {
  collections,
};

export function getSkill(id: SkillId): AnySkill {
  const skill = SKILLS[id];
  if (!skill) throw new Error(`Unknown skill: ${id}`);
  return skill;
}

/** Which skill handles a PayPal event type or sweep name (the fixed-label door, design §0.2). */
export function skillForTrigger(trigger: { event?: string; sweep?: string }): AnySkill | null {
  return (
    Object.values(SKILLS).find(
      (s) =>
        (trigger.event && s.triggers.events?.includes(trigger.event)) ||
        (trigger.sweep && s.triggers.sweeps?.includes(trigger.sweep)),
    ) ?? null
  );
}
