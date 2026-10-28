// The policy engine (design §8). Plain, deterministic code; the model never
// sees it. Rules run in order and the first one that fires wins (§8.2).

import type { AnySkill, CheckContext, CommandDef, CommandId, CommandRule, Confidence, MerchantRules, PolicyResult, SkillDef } from "./types";

/** Commands that are always a card, whatever the dial says. */
export const ALWAYS_ASK: CommandId[] = ["merchant.ask"];

/** The dial for a command: the merchant's rule, else the skill default, else Ask me. */
export function ruleFor(cmdId: CommandId, rules: MerchantRules, skill: AnySkill): CommandRule {
  return rules.commands[cmdId] ?? skill.policy.defaults[cmdId] ?? { dial: "ask" };
}

/** Gate 1 helper: a command switched Off never reaches the menu. merchant.ask can't be Off. */
export function dialAllows(cmdId: CommandId, rules: MerchantRules, skill: AnySkill): boolean {
  if (ALWAYS_ASK.includes(cmdId)) return true;
  return ruleFor(cmdId, rules, skill).dial !== "off";
}

export async function decide<P, F>(input: {
  cmd: CommandDef<P, F>;
  params: P;
  skill: SkillDef<F>;
  rules: MerchantRules;
  confidence: Confidence;
  askedMerchant: boolean;
  ctx: CheckContext<F>;
}): Promise<PolicyResult> {
  const { cmd, params, skill, rules, confidence, askedMerchant, ctx } = input;
  const rule = ruleFor(cmd.id, rules, skill);

  if (rules.killSwitch) return { decision: "block", rule: "kill_switch", reason: "Pyp is paused" };
  if (ALWAYS_ASK.includes(cmd.id)) return { decision: "ask", rule: "question", reason: "Questions always come to you" };
  if (rule.dial === "off") return { decision: "block", rule: "dial_off", reason: "You switched this action off" };
  if (skill.policy.neverAuto.includes(cmd.id)) {
    return { decision: "ask", rule: "never_auto", reason: "This action always needs your approval" };
  }
  const limit = cmd.overLimit ? await cmd.overLimit(params, rule, ctx) : null;
  if (limit) return { decision: "ask", rule: "limit", reason: limit };
  if (confidence === "low") return { decision: "ask", rule: "low_confidence", reason: "Pyp wasn't sure" };
  if (askedMerchant) return { decision: "ask", rule: "has_question", reason: "Pyp has a question for you" };
  if (rule.dial === "ask") return { decision: "ask", rule: "dial_ask", reason: "You asked to approve these" };
  return { decision: "auto", rule: "dial_auto", reason: `Runs on Auto after ${rules.undoSeconds}s unless you tap Undo` };
}
