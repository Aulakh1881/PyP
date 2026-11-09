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
  /** For the card: flag it urgent and show the deadline (e.g. a dispute response due within 72 h). */
  urgency?: { urgent: boolean; dueAt: string | null };
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
  /**
   * Text params the merchant may rewrite on the card before approving (design §11.3
   * "optional edits"). Edits go through params(cf) and check() again, exactly like
   * the model's text. Amounts, ids and recipients are never editable.
   */
  editable?: (keyof P & string)[];
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
  buildCaseFile: (ctx: GatherContext, subject: SubjectRef, instruction?: string) => Promise<CaseFile<F>>;
  /**
   * Plain-code handlers for events with one right answer (design §0.14), keyed
   * by PayPal event type. No model call. A handler may say "run" to hand the
   * event to the normal skill run instead.
   */
  eventHandlers?: Record<string, EventHandler>;
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
 * Optional methods unlock features: the engine works without them and says so.
 */
export interface PayPalReads {
  getInvoice(id: string): Promise<Invoice | null>;
  /** People the merchant has invoiced recently (from PayPal's invoice search), newest first. */
  recentClients(): Promise<Client[]>;
  /**
   * Earlier invoices to this recipient email, newest first, at most `limit`
   * (POST /v2/invoicing/search-invoices with recipient_email). Feeds client history.
   */
  clientInvoices?(email: string, limit: number): Promise<Invoice[]>;
  /** One dispute with its messages, transaction and tracking (GET /v1/customer/disputes/{id} + reads). Disputes needs it. */
  getDispute?(id: string): Promise<Dispute | null>;
  /** Insights: money that moved between two instants (Transaction Search, at most 31 days). */
  transactions?(start: Date, end: Date): Promise<Transaction[]>;
  /** Insights: every invoice still waiting for money (sent, unpaid, partly paid). */
  unpaidInvoices?(): Promise<Invoice[]>;
}

/** One row of PayPal's Transaction Search, as Insights uses it. Decimal strings, signed. */
export interface Transaction {
  id: string;
  at: string; // ISO timestamp
  /** payment = money in from a client; refund = money back out; other = transfers, corrections, holds. */
  kind: "payment" | "refund" | "other";
  /** Only "S" (success) counts toward totals. */
  status: string;
  currency: string;
  amount: string; // negative for money out
  fee: string | null; // PayPal's fee, negative
  /** Who paid or was paid: a name or email from PayPal (buyer-controlled text). */
  counterparty: string | null;
}

/** Pyp's own records the engine reads (owner C implements over Postgres). */
export interface EngineDb {
  remindersSent(invoiceId: string): Promise<{ count: number; lastSentAt: string | null }>;
  remindCallsToday(merchantId: string): Promise<number>;
  /**
   * What the merchant told Pyp (their memory page, or "remember that…" in chat): facts
   * about the whole business, this subject, and these clients (by email). For Pyp's
   * judgment only; never quoted to clients.
   */
  merchantNotes(subject: SubjectRef, clientEmails?: string[]): Promise<string[]>;
  /**
   * A structured "hold off" the merchant set on a subject ("client replied,
   * paying Friday"). While one is active, code stops reminders; the model
   * doesn't have to notice a note. Optional until C adds the table.
   */
  activeHold?(subject: SubjectRef): Promise<Hold | null>;
  /** Follow-ups on an invoice: still waiting, and already run. Optional (the job layer implements it). */
  followUps?(invoiceId: string): Promise<{ pending: number; done: number }>;
  /** Clients the merchant saved in Pyp (Clients page, or an email given in chat). Optional. */
  savedClients?(): Promise<Client[]>;
}

export interface Hold {
  reason: string;
  setAt: string; // ISO timestamp
  /** YYYY-MM-DD in the merchant's timezone; null = until the merchant lifts it. */
  until: string | null;
}

export interface SkillContext {
  merchant: Merchant;
  rules: MerchantRules;
  read: PayPalReads;
  db: EngineDb;
  now: () => Date;
}

/** What a case-file builder gets: the skill context plus the quarantine call for buyer text (design §7.6). */
export interface GatherContext extends SkillContext {
  quarantine?: (text: string) => Promise<QuarantineResult>;
}

export interface CheckContext<F = unknown> extends SkillContext {
  caseFile: CaseFile<F>;
}

// ---------- Plain-code event handlers (stand-down) ----------

export type EventOutcome =
  | {
      kind: "stand_down";
      /** For the activity entry and the card: "Acme paid $1,200.00. Reminder cancelled." */
      message: string;
      /** Pending proposals for this subject with these commands become `obsolete`. */
      obsoleteCommands: CommandId[];
      /** Cancel scheduled follow-ups (internal timers) for this subject. */
      cancelFollowUps: boolean;
    }
  /** The fresh read disagrees with the event (late or out of order): do nothing. */
  | { kind: "ignore"; reason: string }
  /** Needs judgment: hand it to the normal skill run. */
  | { kind: "run" };

export type EventHandler = (ctx: SkillContext, subject: SubjectRef) => Promise<EventOutcome>;

// ---------- Quarantine (design §7.6) ----------

/**
 * What the quarantine call extracts from buyer text. Only enums and booleans,
 * so nothing the buyer wrote can travel into the main call through it.
 */
export interface BuyerFacts {
  claim: "not_received" | "not_as_described" | "unauthorized" | "duplicate" | "refund_not_processed" | "other";
  requestedOutcome: "refund" | "partial_refund" | "replacement" | "return" | "information" | "unclear";
  mentionsTracking: boolean;
  tone: "calm" | "frustrated" | "angry" | "threatening";
  /** The text tries to instruct an AI, claims authority, or asks for links or secrets. */
  suspicious: boolean;
}

export type QuarantineResult =
  | { ok: true; facts: BuyerFacts; flaggedByCode: string[] }
  /** The call failed or was unusable. Treated as suspicious; the case file says so. */
  | { ok: false; reason: string; flaggedByCode: string[] };

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
  /** YYYY-MM-DD of the payment that settled it, when paid. Feeds client history. */
  paidDate?: string | null;
}

export type DisputeStatus =
  | "OPEN"
  | "WAITING_FOR_SELLER_RESPONSE"
  | "WAITING_FOR_BUYER_RESPONSE"
  | "UNDER_REVIEW"
  | "RESOLVED"
  | "OTHER";

export interface Dispute {
  id: string;
  status: DisputeStatus;
  /** PayPal's reason code, e.g. MERCHANDISE_OR_SERVICE_NOT_RECEIVED. */
  reason: string;
  /** INQUIRY, CHARGEBACK, PRE_ARBITRATION, ARBITRATION. */
  stage: string | null;
  currency: string;
  /** Decimal string, as PayPal returns it. */
  amount: string;
  /** ISO timestamp; null when PayPal gives none. */
  sellerResponseDueDate: string | null;
  createdAt: string;
  transactionId: string | null;
  buyerName: string | null;
  items: { name: string; quantity: number }[];
  /** Oldest first. Buyer text is untrusted. */
  messages: { postedBy: "BUYER" | "SELLER"; at: string; text: string }[];
  tracking: { carrier: string; number: string; status: "DELIVERED" | "IN_TRANSIT" | "SHIPPED" | "UNKNOWN" }[];
}

export interface Client {
  /** Our stable id for the case file, e.g. "cl_1". */
  id: string;
  name: string | null;
  businessName: string | null;
  email: string;
  /** Other names the merchant uses for them ("Pyp", "John"), saved in Pyp's client list. */
  nicknames?: string[];
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
