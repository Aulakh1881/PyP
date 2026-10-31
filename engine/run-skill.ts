// One skill run: gather -> menu -> decide -> check -> policy (design §7.1).
// Only the decide step calls the model. The run returns everything it did;
// owner C's job layer stores it (runs, proposals, cards, trace_steps) and
// hands auto/approved proposals to the executor. Nothing here writes to PayPal.

import { dialAllows, decide } from "./policy";
import { buildSystemPrompt, buildTurnPrompt } from "./prompt-builder";
import { buildResponseSchema } from "./schema-builder";
import { Trace } from "./trace";
import type {
  AgentClient,
  CaseFile,
  CheckResult,
  AnyCommand,
  GatewayEvent,
  ModelResponse,
  PolicyResult,
  ProposedAction,
  SkillContext,
  SkillDef,
  StopReason,
  SubjectRef,
  TraceStep,
  Usage,
} from "./types";
import { checkActions, parseResponse } from "./validator";

export type ProposalStatus = "awaiting_approval" | "scheduled" | "blocked" | "rejected";

export interface Proposal {
  action: ProposedAction;
  /** Exact values from the command's resolve(), for the card and the executor. */
  resolved: Record<string, unknown> | null;
  check: CheckResult;
  policy: PolicyResult | null;
  status: ProposalStatus;
}

export interface RunResult<F = unknown> {
  status: "ok" | "paused" | "failed";
  failure?: string;
  caseFile: CaseFile<F> | null;
  menu: string[];
  system: string | null;
  turn: string | null;
  rawAnswers: string[];
  response: ModelResponse | null;
  proposals: Proposal[];
  usage: Usage[];
  model: string | null;
  trace: TraceStep[];
}

export interface RunInput<F> {
  skill: SkillDef<F>;
  subject: SubjectRef;
  ctx: SkillContext;
  agent: AgentClient;
  /** Where the run came from, for the trace, e.g. "sweep:overdue" or "chat". */
  trigger: string;
  /** A merchant's own words when the run came from chat. */
  instruction?: string;
  task?: string;
  signal?: AbortSignal;
}

const MAX_ATTEMPTS = 2; // the first answer, plus one retry if it doesn't parse (design §7.7)

export async function runSkill<F>(input: RunInput<F>): Promise<RunResult<F>> {
  const { skill, subject, ctx, agent } = input;
  const trace = new Trace(ctx.now);
  const result: RunResult<F> = {
    status: "ok",
    caseFile: null,
    menu: [],
    system: null,
    turn: null,
    rawAnswers: [],
    response: null,
    proposals: [],
    usage: [],
    model: null,
    trace: trace.steps,
  };
  const failed = (reason: string) => {
    trace.step("error", reason);
    return { ...result, status: "failed" as const, failure: reason };
  };

  trace.step("trigger", `${input.trigger} → ${skill.id}`, { subject });

  if (ctx.rules.killSwitch) {
    trace.step("policy", "Pyp is paused; no model call", { rule: "kill_switch" });
    return { ...result, status: "paused" };
  }

  // Gather
  let cf: CaseFile<F>;
  try {
    cf = await skill.buildCaseFile(ctx, subject, input.instruction);
  } catch (err) {
    return failed(`Couldn't build the case file: ${(err as Error).message}`);
  }
  result.caseFile = cf;
  trace.step("gather", "Case file built", { ids: cf.ids });

  // Gate 1: the menu
  const menu: AnyCommand<F>[] = skill.commands.filter(
    (c) => dialAllows(c.id, ctx.rules, skill) && c.available(cf, ctx.rules),
  );
  result.menu = menu.map((c) => c.id);
  trace.step("menu", `${menu.length} of ${skill.commands.length} actions offered`, { menu: result.menu });

  // Decide (the only model call)
  const schema = buildResponseSchema(menu, cf);
  const system = buildSystemPrompt(skill, ctx.merchant);
  const task = input.task ?? skill.task?.(subject) ?? `Decide what to do about ${subject.kind} ${subject.id} now.`;
  const turn = buildTurnPrompt(cf, menu, ctx.rules, task, cf.includesInstruction ? undefined : input.instruction);
  result.system = system;
  result.turn = turn;

  let response: ModelResponse | null = null;
  let lastProblem = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS && !response; attempt++) {
    let answer: { text: string; model: string; usage: Usage; stopReason: StopReason };
    try {
      answer = await collect(
        agent.complete({
          system,
          turn,
          schema: schema.json,
          fullSchema: schema.fullJson,
          tier: skill.model.tier,
          effort: skill.model.effort,
          maxOutputTokens: skill.model.maxOutputTokens ?? 8000,
          signal: input.signal,
          purpose: skill.id,
        }),
      );
    } catch (err) {
      return failed(`Model call failed: ${(err as Error).message}`);
    }
    result.rawAnswers.push(answer.text);
    result.usage.push(answer.usage);
    result.model = answer.model;

    if (answer.stopReason === "refusal") return failed("The model declined to answer");
    const parsed = parseResponse(answer.text, schema);
    if (parsed.ok) {
      response = parsed.response;
      trace.step("decide", response.title, { model: answer.model, confidence: response.confidence, actions: response.actions.length });
    } else {
      lastProblem = answer.stopReason === "max_tokens" ? "The answer was cut off" : parsed.reason;
      trace.step("decide", `Unusable answer (attempt ${attempt}): ${lastProblem}`);
    }
  }
  if (!response) return failed(`No usable answer: ${lastProblem}`);
  result.response = response;

  // Gate 2: the validator
  const checkCtx = { ...ctx, caseFile: cf };
  const checked = await checkActions(response.actions, menu, checkCtx);
  const askedMerchant = response.questionForMerchant !== null || response.actions.some((a) => a.command === "merchant.ask");

  // Gate 3: the policy
  for (const { action, cmd, check } of checked) {
    if (!check.ok) {
      trace.step("validate", `${action.command} rejected: ${check.reason}`);
      result.proposals.push({ action, resolved: null, check, policy: null, status: "rejected" });
      continue;
    }
    trace.step("validate", `${action.command} passed checks`);
    const policy = await decide({
      cmd,
      params: action.params,
      skill,
      rules: ctx.rules,
      confidence: response.confidence,
      askedMerchant: askedMerchant && action.command !== "merchant.ask",
      ctx: checkCtx,
    });
    trace.step("policy", `${action.command}: ${policy.decision} (${policy.reason})`, { rule: policy.rule });
    const status: ProposalStatus = policy.decision === "auto" ? "scheduled" : policy.decision === "ask" ? "awaiting_approval" : "blocked";
    const resolved = cmd.resolve ? cmd.resolve(action.params, cf) : null;
    result.proposals.push({ action, resolved, check, policy, status });
  }
  if (checked.length === 0) trace.step("policy", "Nothing to do");

  return result;
}

/** Drain a gateway stream into its final answer. */
export async function collect(events: AsyncIterable<GatewayEvent>) {
  for await (const ev of events) {
    if (ev.type === "done") return ev;
  }
  throw new Error("The model stream ended without an answer");
}
