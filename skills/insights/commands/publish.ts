// insight.publish (Appendix C): a card for the merchant, nothing sent anywhere.
// Auto by default; it's read-only, so the card shows at once (no undo window).
// The check: every number in the title and body must be one the case file
// computed, written the same way. The model words the brief; it never counts.

import { z } from "zod";
import { hasLink } from "@/engine/content-checks";
import type { CommandDef } from "@/engine/types";
import { fail, ok } from "@/engine/validator";
import { numbersWithRole, type InsightsFacts } from "../case-file";

export const INSIGHT_KINDS = ["brief", "alert", "pattern"] as const;

export interface PublishParams {
  kind: (typeof INSIGHT_KINDS)[number];
  title: string;
  body: string;
  metricRefs: string[];
}

export const publishInsight: CommandDef<PublishParams, InsightsFacts> = {
  id: "insight.publish",
  description: "Show the merchant an insight card: a short title and body, citing the metrics it uses.",
  aiRule:
    "Use once per run for the weekly brief. Copy every number exactly as the case file writes it ($1,200.00, not $1.2k). Never add, subtract, round or estimate. List the metric ids you used in metricRefs.",
  params: (cf) =>
    z.object({
      kind: z.enum(INSIGHT_KINDS),
      title: z.string().max(80).describe("Under 80 characters."),
      body: z.string().max(600).describe("Two to four short sentences, under 600 characters."),
      metricRefs: z
        .array(z.enum(cf.ids.metricIds as [string, ...string[]]))
        .min(1)
        .max(cf.ids.metricIds.length)
        .describe("The metric ids the text uses."),
    }),
  available: () => true,
  risk: "read",

  check: async (p, ctx) => {
    if (!p.title.trim() || !p.body.trim()) return fail("The title and body can't be empty");
    const { allowed, names } = ctx.caseFile.facts;
    // Names come from PayPal, not the model ("Studio 54", "sam@acme.com"): read around them.
    let text = `${p.title}\n${p.body}`;
    for (const name of [...names].sort((a, b) => b.length - a.length)) text = text.split(name).join(" ");
    if (hasLink(text)) return fail("Insights can't contain links");
    // A number must be one code computed, in the same role: a count can't be written as money.
    const sets = { money: new Set(allowed.money), percent: new Set(allowed.percent), plain: new Set(allowed.plain) };
    const stray = numbersWithRole(text).find(({ n, role }) => !sets[role].has(n));
    if (stray) return fail(`"${stray.n}" isn't a ${stray.role === "plain" ? "number" : stray.role === "money" ? "money figure" : "percentage"} Pyp computed`);
    if (new Set(p.metricRefs).size !== p.metricRefs.length) return fail("A metric is cited twice");
    return ok();
  },

  resolve: (p, cf) => ({
    kind: p.kind,
    title: p.title,
    body: p.body,
    from: cf.facts.from,
    to: cf.facts.to,
    metrics: p.metricRefs.map((id) => cf.facts.metrics.find((m) => m.id === id)!).map((m) => ({ label: m.label, display: m.display })),
  }),
};
