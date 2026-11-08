// A card is data (design §11.1). The front is built from the run's title and
// summary, the proposal's resolved values and the policy's reason, so it shows
// exactly what the executor will send. The buttons depend on the card's state.

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

export function cardFor(skill: SkillId, p: Proposal, response: ModelResponse): CardFront {
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
