// Live check against a real model (Claude or Ollama), skipped unless PYP_LIVE=1.
//
//   npm run eval:live                                                     # Claude (ANTHROPIC_API_KEY)
//   PYP_MODEL_PROVIDER=ollama OLLAMA_MODEL=qwen3:4b npm run eval:live     # a local model
//
// Reads keys from .env.local. About a cent per case on Claude; free on Ollama.
// Each case prints one RESULT line (pass/fail, time, cost) so models can be compared.

import { existsSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { runSkill, type RunResult } from "@/engine/run-skill";
import type { SubjectRef } from "@/engine/types";
import { createAgentClient } from "@/gateway";
import { collections } from "@/skills/collections/skill";
import { acmeInvoice, context, rules, type FakeWorld } from "@/skills/collections/evals/fixtures";

const live = process.env.PYP_LIVE === "1";
if (live && existsSync(".env.local")) process.loadEnvFile(".env.local");

const results: string[] = [];

async function live_run(name: string, subject: SubjectRef, world: FakeWorld, instruction?: string) {
  const agent = createAgentClient(process.env);
  const started = Date.now();
  const result = await runSkill({ skill: collections, subject, ctx: context(world, rules()), agent, trigger: "live-eval", instruction });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const cost = result.usage.reduce((s, u) => s + u.costUsd, 0);
  const summary = result.proposals.map((p) => `${p.action.command}:${p.status}${p.check.ok ? "" : `(${p.check.reason})`}`).join(", ") || "no actions";
  if (process.env.PYP_LIVE_VERBOSE) console.log(JSON.stringify({ name, response: result.response, rawAnswers: result.rawAnswers, trace: result.trace }, null, 2));
  return { result, line: `${name} | ${secs}s | attempts=${result.rawAnswers.length} | $${cost.toFixed(4)} | ${result.status}${result.failure ? ` (${result.failure})` : ""} | ${summary}` };
}

function passing(result: RunResult<unknown>, command: string) {
  return result.proposals.find((p) => p.action.command === command && p.check.ok);
}

const overdue: FakeWorld = { invoices: { [acmeInvoice.id]: acmeInvoice } };
const invoiceSubject = { kind: "invoice", id: acmeInvoice.id };
const chat = (id: string) => ({ kind: "new-invoice", id });

describe.skipIf(!live)(`Collections, live model (${process.env.PYP_MODEL_PROVIDER ?? "auto"} ${process.env.OLLAMA_MODEL ?? ""})`, () => {
  afterAll(() => console.log(`\n${results.map((r) => `RESULT ${r}`).join("\n")}\n`));

  it("overdue 7 days, never reminded → a reminder that passes every check", async () => {
    const { result, line } = await live_run("overdue-first", invoiceSubject, overdue);
    results.push(line);
    expect(passing(result, "invoice.sendReminder")).toBeTruthy();
  }, 180_000);

  it("reminded yesterday → no reminder", async () => {
    const world = { ...overdue, reminders: { [acmeInvoice.id]: { count: 1, lastSentAt: "2026-10-27T16:00:00Z" } } };
    const { result, line } = await live_run("reminded-yesterday", invoiceSubject, world);
    results.push(line);
    expect(result.failure).toBeUndefined();
    expect(result.proposals.some((p) => p.action.command === "invoice.sendReminder")).toBe(false);
  }, 180_000);

  it("third reminder due → a final reminder", async () => {
    const world = { ...overdue, reminders: { [acmeInvoice.id]: { count: 2, lastSentAt: "2026-10-20T16:00:00Z" } } };
    const { result, line } = await live_run("third-reminder", invoiceSubject, world);
    results.push(line);
    expect(passing(result, "invoice.sendReminder")?.action.params).toMatchObject({ tone: "final" });
  }, 180_000);

  it('"Invoice Acme $1,200, net 30" → createAndSend for Acme, $1,200, NET_30', async () => {
    const { result, line } = await live_run("new-acme", chat("live_1"), { invoices: {} }, "Invoice Acme $1,200, net 30");
    results.push(line);
    expect(passing(result, "invoice.createAndSend")?.resolved).toMatchObject({ client: { email: "sam@acme.example" }, total: "1200.00", termType: "NET_30" });
  }, 180_000);

  it("two lines, due on receipt → two items, $950 total", async () => {
    const instruction = "Invoice Beta LLC $800 for the website and $150 for hosting, due on receipt";
    const { result, line } = await live_run("new-two-lines", chat("live_2"), { invoices: {} }, instruction);
    results.push(line);
    expect(passing(result, "invoice.createAndSend")?.resolved).toMatchObject({ total: "950.00", termType: "DUE_ON_RECEIPT" });
  }, 180_000);

  it('"Invoice NewCo $450" (not a known client) → asks, never invoices someone else', async () => {
    const { result, line } = await live_run("new-unknown-client", chat("live_3"), { invoices: {} }, "Invoice NewCo $450");
    results.push(line);
    expect(passing(result, "invoice.createAndSend")).toBeUndefined();
    expect(result.proposals.some((p) => p.action.command === "merchant.ask")).toBe(true);
  }, 180_000);

  it("invoice paid before the check → nothing goes out", async () => {
    const world = { ...overdue, freshInvoices: { [acmeInvoice.id]: { ...acmeInvoice, status: "PAID" as const } } };
    const { result, line } = await live_run("paid-meanwhile", invoiceSubject, world);
    results.push(line);
    expect(passing(result, "invoice.sendReminder")).toBeUndefined();
  }, 180_000);
});
