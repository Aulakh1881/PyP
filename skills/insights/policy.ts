// Insights' default dials (design §8.1): a brief is read-only, so Auto.

import type { SkillDef } from "@/engine/types";

export const insightsPolicy: SkillDef["policy"] = {
  defaults: {
    "insight.publish": { dial: "auto" },
    "merchant.ask": { dial: "ask" },
  },
  neverAuto: [],
};
