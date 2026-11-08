// Insights lite (Appendix B.3): a weekly brief on Fridays. Code computes every
// number from Transaction Search and unpaid invoices; the fast tier words it.

import { merchantAsk } from "@/engine/commands/merchant-ask";
import type { SkillDef } from "@/engine/types";
import { buildInsightsCaseFile, type InsightsFacts } from "./case-file";
import { publishInsight } from "./commands/publish";
import { insightsPolicy } from "./policy";
import { insightsSystemPrompt } from "./prompt";

export const insights: SkillDef<InsightsFacts> = {
  id: "insights",
  triggers: { sweeps: ["weekly-brief"] },
  model: { tier: "fast", maxOutputTokens: 1500 },
  buildCaseFile: buildInsightsCaseFile,
  task: () => "Write this week's brief.",
  commands: [publishInsight, merchantAsk],
  prompt: { system: insightsSystemPrompt },
  policy: insightsPolicy,
};
