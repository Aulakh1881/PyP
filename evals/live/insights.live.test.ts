// Live Insights check against a real model (Claude or Ollama), skipped unless
// PYP_LIVE=1. One fast-tier call per case (Haiku 5.5 on Claude), so it's cheap.
// What matters: the brief copies code's numbers exactly, so its check passes.
//
//   npm run eval:live

import { existsSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { runSkill } from "@/engine/run-skill";
import { createAgentClient } from "@/gateway";
import { insights } from "@/skills/insights/skill";
import { insightsContext, subject } from "@/skills/insights/evals/fixtures";

const live = process.env.PYP_LIVE === "1";
if (live && existsSync(".env.local")) process.loadEnvFile(".env.local");

const results: string[] = [];

async function liveRun(name: string, ctx = insightsContext()) {
  const agent = createAgentClient(process.env);
  const started = Date.now();
  const result = await runSkill({ skill: insights, subject, ctx, agent, trigger: "live-eval" });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const cost = result.usage.reduce((s, u) => s + u.costUsd, 0);
  const summary = result.proposals.map((p) => `${p.action.command}:${p.status}${p.check.ok ? "" : `(${p.check.reason})`}`).join(", ") || "no actions";
  results.push(`${name} | ${secs}s | $${cost.toFixed(4)} | ${result.status}${result.failure ? ` (${result.failure})` : ""} | ${summary}`);
  if (process.env.PYP_LIVE_VERBOSE) console.log(JSON.stringify({ name, response: result.response, raw: result.rawAnswers }, null, 2));
  return result;
}

describe.skipIf(!live)("Insights, live model", () => {
  afterAll(() => console.log(`\n${results.map((r) => `RESULT ${r}`).join("\n")}\n`));

  it("a busy week → one brief whose every number is code's", async () => {
    const r = await liveRun("busy-week");
    const brief = r.proposals.find((p) => p.action.command === "insight.publish");
    expect(brief?.check.ok).toBe(true);
    expect(brief?.status).toBe("scheduled");
  }, 120_000);

  it("a quiet week → still one brief, and it passes", async () => {
    const r = await liveRun("quiet-week", insightsContext([], []));
    expect(r.proposals.find((p) => p.action.command === "insight.publish")?.check.ok).toBe(true);
  }, 120_000);
});
