// A card is data (design §11.1). The front is built from the run's title and
// summary, the proposal's resolved values and the policy's reason, so it shows
// exactly what the executor will send. The buttons depend on the card's state.

import { shortDate } from "./format";
import type { Proposal } from "./run-skill";
import type { ModelResponse, SkillId } from "./types";

export type CardState =
  | "awaiting_approval"
  | "scheduled"
  | "executing"
  | "executed"
  | "failed"
  | "blocked"
  | "obsolete"
  | "rejected"
  | "undone";

export interface CardFront {
  eyebrow: string;
  title: string;
  subtitle?: string;
  body?: string;
  lines?: { description: string; amount: string }[];
  amount?: { value: string; currency: string };
  reason?: string;
  /** merchant.ask: the answer buttons. */
  options?: string[];
  /** The primary button's words: says the action and the amount. */
  approveLabel?: string;
  /** Text the merchant may rewrite before approving: the param, its label, the current words, the limit. */
  edit?: { field: string; label: string; value: string; max?: number }[];
  /** A scheduled card: when it runs unless the merchant taps Undo (set by jobs/store.ts). */
  scheduledFor?: string;
  demoData: boolean;
}

export interface CardAction {
  id: "approve" | "dismiss" | "undo" | "answer";
  label: string;
  style: "primary" | "secondary" | "danger";
}

/** Proposals that become cards; invalid and blocked ones only live in the trace. */
export function needsCard(p: Proposal): boolean {
  return p.status === "awaiting_approval" || p.status === "scheduled";
}

const FIELD_LABEL: Record<string, string> = { subject: "Subject", note: "Note", reason: "Reason", message: "Message" };

/** The card's editable text, from the command's `editable` list and the proposal's params. */
export function editFields(editable: string[] | undefined, params: unknown): CardFront["edit"] {
  if (!editable?.length) return undefined;
  const values = params as Record<string, unknown>;
  const fields = editable.filter((f) => typeof values[f] === "string").map((f) => ({ field: f, label: FIELD_LABEL[f] ?? f, value: values[f] as string }));
  return fields.length ? fields : undefined;
}

export function cardFor(skill: SkillId, p: Proposal, response: ModelResponse, editable?: string[]): CardFront {
  const front = baseFront(skill, p, response);
  const edit = editFields(editable, p.action.params);
  return edit ? { ...front, edit } : front;
}

function baseFront(skill: SkillId, p: Proposal, response: ModelResponse): CardFront {
  const r = (p.resolved ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const mode = p.status === "scheduled" ? "AUTO" : "NEEDS YOU";
  const base = {
    eyebrow: `${skill.toUpperCase()} · ${mode}`,
    title: response.title,
    reason: p.policy ? `Asked you because: ${p.policy.reason.toLowerCase()}` : undefined,
    demoData: true,
  };

  switch (p.action.command) {
    case "invoice.createAndSend": {
      const to = r.client.businessName ?? r.client.name ?? r.client.email;
      return {
        ...base,
        subtitle: `${to} · ${r.totalDisplay} · due ${r.dueDate}`,
        body: r.note || undefined,
        lines: r.items.map((i: { description: string; display: string }) => ({ description: i.description, amount: i.display })),
        amount: { value: r.total, currency: r.currency },
        approveLabel: `Create and send to ${to} (${r.totalDisplay})`,
      };
    }
    case "invoice.sendReminder":
      return {
        ...base,
        subtitle: `Invoice ${r.invoiceNumber} · ${r.amountDueDisplay} · reminder ${r.reminderNumber}`,
        body: r.note,
        approveLabel: `Send reminder to ${r.recipientName ?? r.recipientEmail} (${r.amountDueDisplay})`,
      };
    case "invoice.cancel":
      return {
        ...base,
        subtitle: `Invoice ${r.invoiceNumber} · ${r.totalDisplay} · ${r.recipientName ?? r.recipientEmail}`,
        body: r.note,
        approveLabel: `Cancel invoice ${r.invoiceNumber} (${r.totalDisplay})`,
      };
    case "dispute.provideEvidence":
      return {
        ...base,
        subtitle: [`Dispute ${r.disputeId}`, r.responseDue ? `respond by ${String(r.responseDue).slice(0, 10)}` : null].filter(Boolean).join(" · "),
        body: r.note,
        lines: r.tracking ? [{ description: `${r.tracking.carrier} tracking ${r.tracking.number}`, amount: r.tracking.status }] : undefined,
        approveLabel: "Submit this evidence to PayPal",
      };
    case "dispute.makeOffer":
      return {
        ...base,
        subtitle: `Dispute ${r.disputeId} · disputed ${r.disputedDisplay}`,
        body: r.note,
        amount: { value: r.amount, currency: r.currency },
        approveLabel: `Offer a ${r.amountDisplay} refund`,
      };
    case "dispute.sendMessage":
      return { ...base, subtitle: `Dispute ${r.disputeId}`, body: r.message, approveLabel: `Send to ${r.buyerName ?? "the buyer"}` };
    case "dispute.acceptClaim":
      return {
        ...base,
        subtitle: `Dispute ${r.disputeId}`,
        body: r.note,
        amount: { value: r.refundAmount, currency: r.currency },
        approveLabel: `Accept the claim and refund ${r.refundDisplay}`,
      };
    case "insight.publish":
      return {
        ...base,
        eyebrow: `INSIGHTS · ${String(r.kind).toUpperCase() === "BRIEF" ? "WEEKLY BRIEF" : String(r.kind).toUpperCase()}`,
        title: r.title,
        subtitle: `${shortDate(r.from)} to ${shortDate(r.to)}`,
        body: r.body,
        lines: r.metrics.map((m: { label: string; display: string }) => ({ description: m.label, amount: m.display })),
        reason: "Numbers computed by code from PayPal; Pyp only wrote the words.",
      };
    case "merchant.ask": {
      const ask = p.action.params as { question: string; options: string[] };
      return { ...base, title: ask.question, body: response.summary, options: ask.options };
    }
    default:
      return { ...base, body: response.summary, approveLabel: "Approve" };
  }
}

export function cardActions(state: CardState, front: CardFront): CardAction[] {
  if (state === "awaiting_approval") {
    const main: CardAction[] = front.options?.length
      ? front.options.map((o) => ({ id: "answer", label: o, style: "secondary" }))
      : [{ id: "approve", label: front.approveLabel ?? "Approve", style: "primary" }];
    return [...main, { id: "dismiss", label: "Dismiss", style: "secondary" }];
  }
  if (state === "scheduled") return [{ id: "undo", label: "Undo", style: "danger" }];
  return [];
}
