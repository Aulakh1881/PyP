// Engine-owned contracts (technical design Appendix B.0). Every other folder
// builds against these types, so change them deliberately and tell the team.

import type { ZodType } from "zod";

// ---------- Skills and commands ----------

export type SkillId = "collections" | "disputes" | "insights" | (string & {});
export type CommandId = `${string}.${string}`;
export type Tier = "fast" | "main" | "deep";
export type Effort = "low" | "medium" | "high";
export type Risk = "read" | "internal" | "config" | "message" | "money";
export type Dial = "off" | "ask" | "auto";
export type Confidence = "low" | "medium" | "high";

/** What one run is about: an invoice id, a dispute id, "new-invoice:<chat id>", ... */
export interface SubjectRef {
  kind: string;
  id: string;
}

/**
 * The case file: everything needed for one decision, rendered as XML for the
 * model. `ids` lists every id the model may point at, grouped by kind
 * (e.g. `invoiceIds`); command schemas turn these into enums.
 */
export interface CaseFile<F = unknown> {
  skill: SkillId;
  subject: SubjectRef;
  generatedAt: string;
  xml: string;
  ids: Record<string, string[]>;
  /** The facts behind the XML, for menus, checks and tests. Never sent raw. */
  facts: F;
  /** True when the merchant's own words are already in the XML, so the turn doesn't repeat them. */
  includesInstruction?: boolean;
}

export interface CheckResult {
  ok: boolean;
  reason?: string;
}

export interface CommandDef<P = unknown, F = unknown> {
  id: CommandId;
  /** Shown to the model in <commands>. */
  description: string;
  /** When to use it, in one or two sentences. Shown to the model. */
  aiRule: string;
  /** Built per case so real ids become enums. */
  params: (cf: CaseFile<F>) => ZodType<P>;
  /** Gate 1 (the menu): is this command offered right now? */
  available: (cf: CaseFile<F>, rules: MerchantRules) => boolean;
  /** Optional one-line state shown next to the command, e.g. "sent=1 of max 3". */
  state?: (cf: CaseFile<F>, rules: MerchantRules) => string | undefined;
  risk: Risk;
  /** Gate 2 (the validator): re-check against fresh PayPal data. */
  check: (p: P, ctx: CheckContext<F>) => Promise<CheckResult>;
  /** Policy limit check: returns the limit that was hit, or null. */
  overLimit?: (p: P, rule: CommandRule, ctx: CheckContext<F>) => Promise<string | null>;
  /**
   * The exact values this action will use: amounts, recipients, dates, text.
   * Computed in code from the case file. The card shows them and the executor
   * sends them, so nothing is re-derived later (design §7.1 step 5).
   */
  resolve?: (p: P, cf: CaseFile<F>) => Record<string, unknown>;
  // execute() and undo() belong to the executor (owner C) and are added there.
}

/**
 * A command whose params type we don't track: a menu mixes commands with
 * different params, and CommandDef is invariant in P. Zod re-checks params at
 * runtime, so this is the one place `any` is allowed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyCommand<F = unknown> = CommandDef<any, F>;

export interface SkillDef<F = unknown> {
  id: SkillId;
  triggers: { events?: string[]; sweeps?: string[]; chat?: boolean };
  model: { tier: Tier; effort?: Effort; maxOutputTokens?: number };
  /** `instruction` is the merchant's own words when the run came from chat. */
  buildCaseFile: (ctx: SkillContext, subject: SubjectRef, instruction?: string) => Promise<CaseFile<F>>;
  /** The <task> line for a subject; defaults to "Decide what to do about <kind> <id> now." */
  task?: (subject: SubjectRef) => string;
  /** The full menu; filtered per run by available() and the dial. */
  commands: AnyCommand<F>[];
  /** The cached part of the prompt: role, playbook, tone guide, guardrails. */
  prompt: { system: (merchant: Merchant) => string };
  policy: { defaults: Record<CommandId, CommandRule>; neverAuto: CommandId[] };
}

/** A skill whose facts type we don't track (the registry holds several). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnySkill = SkillDef<any>;

// ---------- The merchant and their rules ----------

export interface Merchant {
  id: string;
  name: string;
  currency: string;
  timezone: string;
  toneGuide: string;
}

export interface CommandRule {
  dial: Dial;
  /** Command-specific limits, e.g. { maxPerInvoice: 3, minDaysBetween: 3 }. */
  limits?: Record<string, number>;
}

export interface MerchantRules {
  killSwitch: boolean;
  undoSeconds: number;
  commands: Record<CommandId, CommandRule>;
}

// ---------- What a run needs from the outside world ----------

/**
 * Read helpers the engine uses for case files and checks. Owner C implements
 * these over PayPal's MCP server and REST reads; tests pass fakes.
 */
export interface PayPalReads {
  getInvoice(id: string): Promise<Invoice | null>;
  /** People the merchant has invoiced recently (from PayPal's invoice search), newest first. */
  recentClients(): Promise<Client[]>;
}

/** Pyp's own records the engine reads (owner C implements over Postgres). */
export interface EngineDb {
  remindersSent(invoiceId: string): Promise<{ count: number; lastSentAt: string | null }>;
  remindCallsToday(merchantId: string): Promise<number>;
  merchantNotes(subject: SubjectRef): Promise<string[]>;
}

export interface SkillContext {
  merchant: Merchant;
  rules: MerchantRules;
  read: PayPalReads;
  db: EngineDb;
  now: () => Date;
}

export interface CheckContext<F = unknown> extends SkillContext {
  caseFile: CaseFile<F>;
}

// ---------- PayPal shapes the engine relies on (the subset we use) ----------

export type InvoiceStatus =
  | "DRAFT"
  | "SENT"
  | "SCHEDULED"
  | "UNPAID"
  | "PARTIALLY_PAID"
  | "PAID"
  | "MARKED_AS_PAID"
  | "CANCELLED"
  | "REFUNDED"
  | "PARTIALLY_REFUNDED"
  | "MARKED_AS_REFUNDED"
  | "PAYMENT_PENDING";

export interface Invoice {
  id: string;
  number: string;
  status: InvoiceStatus;
  currency: string;
  /** Decimal strings, exactly as PayPal returns them. Code never uses floats for money. */
  total: string;
  amountDue: string;
  dueDate: string | null; // YYYY-MM-DD
  recipientName: string | null;
  recipientEmail: string | null;
  disputed?: boolean;
}

export interface Client {
  /** Our stable id for the case file, e.g. "cl_1". */
  id: string;
  name: string | null;
  businessName: string | null;
  email: string;
}

// ---------- The model's answer ----------

export interface ProposedAction<P = Record<string, unknown>> {
  command: CommandId;
  params: P;
  why: string;
}

export interface ModelResponse {
  title: string;
  summary: string;
  actions: ProposedAction[];
  confidence: Confidence;
  questionForMerchant: string | null;
}

// ---------- Policy ----------

export type Decision = "auto" | "ask" | "block";

export interface PolicyResult {
  decision: Decision;
  /** Stored as policy_rule so the card can say why. */
  rule: string;
  reason: string;
}

// ---------- Trace ----------

export type TraceStage =
  | "trigger"
  | "gather"
  | "menu"
  | "decide"
  | "validate"
  | "policy"
  | "act"
  | "error";

export interface TraceStep {
  at: string;
  stage: TraceStage;
  label: string;
  detail?: Record<string, unknown>;
}

// ---------- The model gateway port (ADR-007) ----------

export type JSONSchema = Record<string, unknown>;

export interface CompletionRequest {
  /** The cached part. Must not contain timestamps or run ids. */
  system: string;
  /** The per-run part: case file, menu, task. */
  turn: string;
  /** The response schema in the subset the Claude API accepts. */
  schema: JSONSchema;
  /** The same schema with length and size limits, for providers that enforce them. */
  fullSchema?: JSONSchema;
  tier: Tier;
  effort?: Effort;
  maxOutputTokens: number;
  signal?: AbortSignal;
  /** Label for logs, scripted replays and the spend ledger, e.g. "collections". */
  purpose: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export type StopReason = "end" | "max_tokens" | "refusal" | "other";

export type GatewayEvent =
  | { type: "chunk"; text: string }
  | { type: "done"; text: string; model: string; usage: Usage; stopReason: StopReason };

export interface AgentClient {
  readonly name: string;
  complete(req: CompletionRequest): AsyncIterable<GatewayEvent>;
}
