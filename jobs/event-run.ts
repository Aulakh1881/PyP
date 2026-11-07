// A stored PayPal webhook event becomes engine work (design §9.2 steps 4-5).
// The engine's router decides: a plain-code stand-down (no model call) or a
// full skill run. This file applies the result to the database. The event
// payload only says WHICH invoice or dispute; the engine re-reads PayPal.

import type { Pool } from "pg";
import { handleEvent } from "@/engine/router";
import type { AgentClient, PayPalReads, SubjectRef } from "@/engine/types";
import { applyStandDown, engineDb, loadMerchant, markEvent, saveRun } from "./store";

export interface PayPalEvent {
  id: string;
  event_type: string;
  resource?: Record<string, unknown>;
}

/** Which invoice or dispute an event is about, or null if Pyp doesn't act on it. */
export function subjectFor(event: PayPalEvent): SubjectRef | null {
  const r = event.resource ?? {};
  if (event.event_type.startsWith("INVOICING.INVOICE.")) {
    // Invoicing events wrap the invoice: resource.invoice.id (some versions put it at resource.id).
    const inv = (r.invoice as { id?: unknown } | undefined)?.id ?? r.id;
    return typeof inv === "string" && inv ? { kind: "invoice", id: inv } : null;
  }
  if (event.event_type.startsWith("CUSTOMER.DISPUTE.")) {
    const id = r.dispute_id;
    return typeof id === "string" && id ? { kind: "dispute", id } : null;
  }
  return null;
}

export interface EventRunDeps {
  pool: Pool;
  read: PayPalReads;
  agent: AgentClient;
  now?: () => Date;
}

export type EventRunOutcome =
  | { status: "ignored"; reason: string }
  | { status: "stood_down"; obsoleted: string[] }
  | { status: "ran"; runId: string; cardIds: string[] }
  | { status: "failed"; reason: string };

/** Process one stored event. Never throws: the outcome is written to the event row too. */
export async function processEvent(deps: EventRunDeps, merchantId: string, event: PayPalEvent, signal?: AbortSignal): Promise<EventRunOutcome> {
  const finish = async (o: EventRunOutcome) => {
    const status = o.status === "failed" ? "failed" : o.status === "ignored" ? "ignored" : "done";
    const note = o.status === "ignored" || o.status === "failed" ? o.reason : o.status;
    await markEvent(deps.pool, event.id, status, note).catch(() => undefined);
    return o;
  };
  try {
    const subject = subjectFor(event);
    if (!subject) return finish({ status: "ignored", reason: `Pyp doesn't act on ${event.event_type}` });

    const { merchant, rules } = await loadMerchant(deps.pool, merchantId);
    const ctx = { merchant, rules, read: deps.read, db: engineDb(deps.pool, merchantId), now: deps.now ?? (() => new Date()) };
    const res = await handleEvent({ eventType: event.event_type, subject, ctx, agent: deps.agent, signal });

    if (res.kind === "unrouted") return finish({ status: "ignored", reason: res.reason });
    if (res.kind === "handled") {
      if (res.outcome.kind === "ignore") return finish({ status: "ignored", reason: res.outcome.reason });
      const obsoleted = await applyStandDown(deps.pool, {
        merchantId,
        subject,
        obsoleteCommands: res.outcome.obsoleteCommands,
        message: res.outcome.message,
        eventId: event.id,
      });
      return finish({ status: "stood_down", obsoleted });
    }
    const { runId, cardIds } = await saveRun(deps.pool, {
      merchantId,
      skill: res.skill,
      subject,
      trigger: `event:${event.event_type}`,
      result: res.result,
      triggerEventId: event.id,
    });
    return finish({ status: "ran", runId, cardIds });
  } catch (err) {
    return finish({ status: "failed", reason: (err as Error).message });
  }
}
