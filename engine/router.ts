// The fixed-label door (design §0.2, §9.2): a PayPal event goes to the skill
// that owns its type. Events with one right answer (an invoice got paid) are
// handled by plain code with no model call (§0.14); everything else is a
// normal skill run. The job layer (owner C) applies the outcome: marking
// proposals obsolete, cancelling timers, writing the activity entry.

import { skillForTrigger } from "./registry";
import { runSkill, type RunResult } from "./run-skill";
import { Trace } from "./trace";
import type { AgentClient, EventOutcome, SkillContext, SubjectRef, TraceStep } from "./types";

export type EventResult =
  | { kind: "unrouted"; reason: string }
  | { kind: "handled"; skill: string; outcome: Exclude<EventOutcome, { kind: "run" }>; trace: TraceStep[] }
  | { kind: "run"; skill: string; result: RunResult };

export async function handleEvent(input: {
  eventType: string;
  subject: SubjectRef;
  ctx: SkillContext;
  agent: AgentClient;
  signal?: AbortSignal;
}): Promise<EventResult> {
  const { eventType, subject, ctx, agent } = input;
  const skill = skillForTrigger({ event: eventType });
  if (!skill) return { kind: "unrouted", reason: `No skill handles ${eventType}` };

  const handler = skill.eventHandlers?.[eventType];
  if (handler) {
    const trace = new Trace(ctx.now);
    trace.step("trigger", `event:${eventType} → ${skill.id}`, { subject });
    let outcome: EventOutcome;
    try {
      // Handlers re-read PayPal themselves: never trust the event payload (§9.2 step 5).
      outcome = await handler(ctx, subject);
    } catch (err) {
      // A stand-down that can't read PayPal does nothing; the nightly reconcile repairs it.
      trace.step("error", `Handler failed: ${(err as Error).message}`);
      return { kind: "handled", skill: skill.id, outcome: { kind: "ignore", reason: `Handler failed: ${(err as Error).message}` }, trace: trace.steps };
    }
    if (outcome.kind !== "run") {
      trace.step("act", outcome.kind === "stand_down" ? outcome.message : `Ignored: ${outcome.reason}`, { noModelCall: true });
      return { kind: "handled", skill: skill.id, outcome, trace: trace.steps };
    }
  }

  const result = await runSkill({ skill, subject, ctx, agent, trigger: `event:${eventType}`, signal: input.signal });
  return { kind: "run", skill: skill.id, result };
}
