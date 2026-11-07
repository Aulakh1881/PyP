// Collections' default dial settings and limits (design §8.1). The merchant's
// own rules override these; the never-Auto list can't be overridden.

import type { SkillDef } from "@/engine/types";
import { DEFAULT_LIMITS } from "./case-file";

export const collectionsPolicy: SkillDef["policy"] = {
  defaults: {
    "invoice.sendReminder": { dial: "ask", limits: DEFAULT_LIMITS },
    "invoice.scheduleFollowUp": { dial: "auto" },
    "invoice.createAndSend": { dial: "ask" },
    "invoice.cancel": { dial: "ask" },
    "invoice.suggestAutoReminders": { dial: "ask" },
    "merchant.ask": { dial: "ask" },
  },
  // suggestAutoReminders is a card with nothing to execute, so Auto would mean nothing.
  neverAuto: ["invoice.cancel", "invoice.createAndSend", "invoice.suggestAutoReminders"],
};
