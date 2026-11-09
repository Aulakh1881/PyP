// One skill run: gather -> menu -> decide -> check -> policy (design §7.1).
// Only the decide step calls the model. The run returns everything it did;
// owner C's job layer stores it (runs, proposals, cards, trace_steps) and
// hands auto/approved proposals to the executor. Nothing here writes to PayPal.

import { dialAllows, decide } from "./policy";
import { buildSystemPrompt, buildTurnPrompt } from "./prompt-builder";
import { quarantine } from "./quarantine";
import { buildResponseSchema } from "./schema-builder";
import { collect, partialSummary } from "./stream";
import { Trace } from "./trace";
import type {
  AgentClient,
  CaseFile,
  CheckResult,
  CommandId,
  AnyCommand,
  GatherContext,
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
import { esc } from "./xml";

/**
 * awaiting_approval: a card for the merchant. scheduled: runs on Auto after the
 * undo window. blocked: the policy said no. invalid: the action failed its
 * check, so it never reaches the merchant or PayPal. (The merchant dismissing a
 * card is "rejected", a later state owned by the job layer; design §11.)
 */
export type ProposalStatus = "awaiting_approval" | "scheduled" | "blocked" | "invalid";

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
  /** A merchant's workflow can limit the run to these commands (its Then blocks). Unset: the whole menu. */
  onlyCommands?: CommandId[];
  signal?: AbortSignal;
}

const MAX_ATTEMPTS = 2; // the first answer, plus one retry if it doesn't parse (design §7.7)

/** A cut-off answer is retried with this much more room, up to the cap. */
const RETRY_TOKEN_FACTOR = 2;
const MAX_OUTPUT_TOKENS_CAP = 16_000;

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

  // Gather. Buyer text goes through the quarantine call first (design §7.6);
  // its cost counts toward the run and it leaves a trace step.
  const gatherCtx: GatherContext = {
    ...ctx,
    quarantine: async (text) => {
      const q = await quarantine(agent, text, {
        signal: input.signal,
        onUsage: (u) => result.usage.push(u),
      });
      const suspicious = q.ok ? q.facts.suspicious : true;
      trace.step("gather", q.ok ? `Buyer text quarantined${suspicious ? " (flagged suspicious)" : ""}` : `Quarantine failed: ${q.reason}`, {
        suspicious,
        ...(q.flaggedByCode.length ? { flaggedByCode: q.flaggedByCode } : {}),
      });
      return q;
    },
  };
  let cf: CaseFile<F>;
  try {
    cf = await skill.buildCaseFile(gatherCtx, subject, input.instruction);
  } catch (err) {
    return failed(`Couldn't build the case file: ${(err as Error).message}`);
  }
  result.caseFile = cf;
  trace.step("gather", "Case file built", { ids: cf.ids });

  // Gate 1: the menu
  const menu: AnyCommand<F>[] = skill.commands.filter(
    (c) => dialAllows(c.id, ctx.rules, skill) && c.available(cf, ctx.rules) && (!input.onlyCommands || input.onlyCommands.includes(c.id)),
  );
  result.menu = menu.map((c) => c.id);
  trace.step("menu", `${menu.length} of ${skill.commands.length} actions offered`, { menu: result.menu });

  // Decide (the only model call)
  const schema = buildResponseSchema(menu, cf);
  const system = buildSystemPrompt(skill, ctx.merchant);
  const task = input.task ?? skill.task?.(subject) ?? `Decide what to do about ${subject.kind} ${subject.id} now.`;
  let turn: string;
  try {
    turn = buildTurnPrompt(cf, menu, ctx.rules, task, cf.includesInstruction ? undefined : input.instruction);
  } catch (err) {
    return failed(`Couldn't build the prompt: ${(err as Error).message}`);
  }
  result.system = system;
  result.turn = turn;

  let response: ModelResponse | null = null;
  let lastProblem = "";
  let maxOutputTokens = skill.model.maxOutputTokens ?? 8000;
  let attemptTurn = turn;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS && !response; attempt++) {
    let answer: { text: string; model: string; usage: Usage; stopReason: StopReason };
    try {
      answer = await collect(
        agent.complete({
          system,
          turn: attemptTurn,
          schema: schema.json,
          fullSchema: schema.fullJson,
          tier: skill.model.tier,
          effort: skill.model.effort,
          maxOutputTokens,
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
      const cutOff = answer.stopReason === "max_tokens";
      lastProblem = cutOff ? "The answer was cut off" : parsed.reason;
      // Keep what the model was going to say, for the back of the card (§7.7). Trace only.
      const partial = partialSummary(answer.text);
      trace.step("decide", `Unusable answer (attempt ${attempt}): ${lastProblem}`, partial ? { partialSummary: partial } : undefined);
      // Don't retry the same way: give a cut-off answer more room, and tell the model what was wrong.
      if (cutOff) maxOutputTokens = Math.min(maxOutputTokens * RETRY_TOKEN_FACTOR, MAX_OUTPUT_TOKENS_CAP);
      else attemptTurn = `${turn}\n<retry-note>Your previous answer was unusable: ${esc(parsed.reason)}. Answer again with one JSON object matching the schema.</retry-note>`;
    }
  }
  if (!response) return failed(`No usable answer: ${lastProblem}`);
  result.response = response;

  // Gate 2: the validator
  const checkCtx = { ...ctx, caseFile: cf };
  const checked = await checkActions(response.actions, menu, checkCtx);
  // One action per command per run. Duplicates are checked against the same
  // state, so two reminders in one answer would each pass the limits (§8.1).
  const seen = new Set<string>();
  for (const c of checked) {
    if (seen.has(c.action.command)) c.check = { ok: false, reason: `Only one ${c.action.command} per run` };
    seen.add(c.action.command);
  }
  const askedMerchant = response.questionForMerchant !== null || response.actions.some((a) => a.command === "merchant.ask");

  // Gate 3: the policy
  for (const { action, cmd, check } of checked) {
    if (!check.ok) {
      trace.step("validate", `${action.command} invalid: ${check.reason}`);
      result.proposals.push({ action, resolved: null, check, policy: null, status: "invalid" });
      continue;
    }
    let resolved: Record<string, unknown> | null;
    try {
      resolved = cmd.resolve ? cmd.resolve(action.params, cf) : null;
    } catch (err) {
      const failedCheck = { ok: false, reason: `Couldn't resolve exact values: ${(err as Error).message}` };
      trace.step("validate", `${action.command} invalid: ${failedCheck.reason}`);
      result.proposals.push({ action, resolved: null, check: failedCheck, policy: null, status: "invalid" });
      continue;
    }
    trace.step("validate", `${action.command} passed checks`);
    let policy: PolicyResult;
    try {
      policy = await decide({
        cmd,
        params: action.params,
        skill,
        rules: ctx.rules,
        confidence: response.confidence,
        askedMerchant: askedMerchant && action.command !== "merchant.ask",
        ctx: checkCtx,
      });
    } catch (err) {
      // Fail toward the merchant: if a limit can't be checked, it's a card, never Auto.
      policy = { decision: "ask", rule: "limit_error", reason: `Couldn't check limits: ${(err as Error).message}` };
    }
    trace.step("policy", `${action.command}: ${policy.decision} (${policy.reason})`, { rule: policy.rule });
    const status: ProposalStatus = policy.decision === "auto" ? "scheduled" : policy.decision === "ask" ? "awaiting_approval" : "blocked";
    result.proposals.push({ action, resolved, check, policy, status });
  }
  if (checked.length === 0) trace.step("policy", "Nothing to do");

  return result;
}

export { collect } from "./stream";
