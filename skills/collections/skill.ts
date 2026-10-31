// Collections: gets the merchant paid (Appendix B.1). The hero demo.

import { merchantAsk } from "@/engine/commands/merchant-ask";
import type { SkillDef } from "@/engine/types";
import { buildCollectionsCaseFile, type CollectionsFacts } from "./case-file";
import { createAndSend } from "./commands/create-and-send";
import { scheduleFollowUp } from "./commands/schedule-follow-up";
import { sendReminder } from "./commands/send-reminder";
import { collectionsPolicy } from "./policy";
import { collectionsSystemPrompt } from "./prompt";

export const collections: SkillDef<CollectionsFacts> = {
  id: "collections",
  triggers: {
    events: ["INVOICING.INVOICE.PAID", "INVOICING.INVOICE.CANCELLED"], // stand down
    sweeps: ["overdue-invoices"],
    chat: true,
  },
  model: { tier: "main", effort: "low", maxOutputTokens: 8000 },
  buildCaseFile: buildCollectionsCaseFile,
  task: (subject) =>
    subject.kind === "new-invoice"
      ? "Turn the merchant's request into one invoice, or ask them what's missing."
      : `Decide what to do about invoice ${subject.id} now.`,
  // Still to add: invoice.cancel (never Auto), invoice.suggestAutoReminders (Could).
  commands: [sendReminder, scheduleFollowUp, createAndSend, merchantAsk],
  prompt: { system: collectionsSystemPrompt },
  policy: collectionsPolicy,
};
