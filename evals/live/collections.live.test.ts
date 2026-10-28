// Live check against a real model (Claude or Ollama), skipped unless PYP_LIVE=1.
// Run with `npm run eval:live`. Reads keys from .env.local. Costs about a cent
// per case on Claude; free on Ollama.

import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { runSkill } from "@/engine/run-skill";
import { createAgentClient } from "@/gateway";
import { collections } from "@/skills/collections/skill";
import { acmeInvoice, context, rules } from "@/skills/collections/evals/fixtures";

const live = process.env.PYP_LIVE === "1";
if (live && existsSync(".env.local")) process.loadEnvFile(".env.local");

describe.skipIf(!live)("Collections, live model", () => {
  const subject = { kind: "invoice", id: acmeInvoice.id };

  it("7 days overdue, never reminded: proposes a reminder that passes every check", async () => {
    const agent = createAgentClient(process.env);
    const ctx = context({ invoices: { [acmeInvoice.id]: acmeInvoice } }, rules());
    const result = await runSkill({ skill: collections, subject, ctx, agent, trigger: "live-eval" });

    console.log(JSON.stringify({ model: result.model, response: result.response, proposals: result.proposals, usage: result.usage, trace: result.trace }, null, 2));
    expect(result.failure).toBeUndefined();
    const reminder = result.proposals.find((p) => p.action.command === "invoice.sendReminder");
    expect(reminder?.check).toEqual({ ok: true });
    expect(reminder?.status).toBe("awaiting_approval");
  }, 120_000);

  it("reminded yesterday: proposes no reminder", async () => {
    const agent = createAgentClient(process.env);
    const world = { invoices: { [acmeInvoice.id]: acmeInvoice }, reminders: { [acmeInvoice.id]: { count: 1, lastSentAt: "2026-10-27T16:00:00Z" } } };
    const result = await runSkill({ skill: collections, subject, ctx: context(world), agent, trigger: "live-eval" });

    expect(result.failure).toBeUndefined();
    expect(result.proposals.some((p) => p.action.command === "invoice.sendReminder")).toBe(false);
  }, 120_000);
});
