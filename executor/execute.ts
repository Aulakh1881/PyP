// The executor (design §9.4): the only code that writes to PayPal. For an
// approved card it claims the proposal, re-runs the command's check() with
// fresh reads, sends the resolved values (never the model's params), and
// records every PayPal call. Request ids make a retry safe: "<proposal id>"
// for one write, "<proposal id>:create" and ":send" for createAndSend.

import { ruleFor } from "@/engine/policy";
import { getSkill } from "@/engine/registry";
import type { PayPalReads } from "@/engine/types";
import { PayPalError, type PayPalResponse } from "@/paypal/http";
import { PayPalWriteClient, type NewInvoice } from "@/paypal/write-client";
import {
  attempted,
  claimForExecution,
  engineDb,
  finish,
  loadMerchant,
  lockEdits,
  recordExecution,
  succeededStep,
  saveEdits,
  type ClaimedProposal,
  type FinishStatus,
} from "@/jobs/store";
import type { Pool } from "pg";

export interface ExecutorDeps {
  db: Pick<Pool, "query">;
  read: PayPalReads;
  write: PayPalWriteClient;
  now?: () => Date;
}

export type ExecuteOutcome =
  | { status: "executed"; message: string }
  | { status: "failed" | "obsolete" | "retry"; message: string }
  | { status: "paused" | "held" | "edit_rejected"; message: string }
  | { status: "not_waiting"; message: string };

/** An Auto action that PayPal didn't answer is retried this many times, then comes to the merchant. */
export const AUTO_ATTEMPTS = 3;
/** First retry after this many seconds, doubling each time. */
export const AUTO_BACKOFF_S = 60;

/** The merchant's rewrites of a card's text before approving: param → new words. */
export type Edits = Record<string, string>;

export async function approveAndExecute(deps: ExecutorDeps, merchantId: string, cardId: string, edits?: Edits): Promise<ExecuteOutcome> {
  const proposal = await claimForExecution(deps.db, merchantId, cardId);
  if (!proposal) return { status: "not_waiting", message: "This card isn't waiting for approval" };
  if (edits && Object.keys(edits).length) proposal.edits = edits;
  return executeProposal(deps, merchantId, proposal);
}

/**
 * Runs a proposal already claimed (status executing): by Approve, or by the
 * worker once an Auto proposal's undo window has passed (jobs/due-run.ts).
 */
export async function executeProposal(deps: ExecutorDeps, merchantId: string, proposal: ClaimedProposal): Promise<ExecuteOutcome> {
  try {
    return await executeClaimed(deps, merchantId, proposal);
  } catch (err) {
    // Anything unexpected (a database blip, a read that timed out) hands the card back
    // instead of leaving it on "Sending…"; the request ids make approving again safe.
    return retryLater(deps, merchantId, proposal, `Something went wrong (${(err as Error).message})`, `Error: ${(err as Error).message}`);
  }
}

/**
 * A failure worth retrying. Approve: back to the merchant's button. Auto: back in
 * the worker's queue with a growing wait, until AUTO_ATTEMPTS, then to the merchant.
 */
async function retryLater(deps: ExecutorDeps, merchantId: string, proposal: ClaimedProposal, why: string, label: string, detail?: unknown): Promise<ExecuteOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  if (proposal.auto && proposal.auto.attempts < AUTO_ATTEMPTS) {
    const retryAt = new Date(now.getTime() + AUTO_BACKOFF_S * 2 ** (proposal.auto.attempts - 1) * 1000);
    const reason = `${why}. Pyp tries again at ${retryAt.toISOString().slice(11, 16)} UTC; it won't send twice.`;
    await finish(deps.db, { merchantId, proposal, status: "scheduled", label, ok: false, reason, detail, retryAt });
    return { status: "retry", message: reason };
  }
  const reason = `${why}. Approve again to retry; it won't send twice.`;
  await finish(deps.db, { merchantId, proposal, status: "awaiting_approval", label, ok: false, reason, detail });
  // Once a write went out, the retry must send the same words: no more editing.
  if (await attempted(deps.db, proposal.id)) await lockEdits(deps.db, proposal.cardId);
  return { status: "retry", message: reason };
}

async function executeClaimed(deps: ExecutorDeps, merchantId: string, proposal: ClaimedProposal): Promise<ExecuteOutcome> {
  const { merchant, rules } = await loadMerchant(deps.db, merchantId);
  const ctx = { merchant, rules, read: deps.read, db: engineDb(deps.db, merchantId, proposal.id), now: deps.now ?? (() => new Date()) };
  const done = (status: FinishStatus, label: string, ok: boolean, reason?: string, detail?: unknown) =>
    finish(deps.db, { merchantId, proposal, status, label, ok, reason, detail });

  // The kill switch pauses every write, including one already claimed (design §8.2 rule 1).
  if (rules.killSwitch) {
    const reason = proposal.auto ? "Pyp is paused; this runs when you turn the kill switch off" : "Pyp is paused. Turn the kill switch off, then approve again";
    await done(proposal.auto ? "scheduled" : "awaiting_approval", "Kill switch on: not sent", false, reason);
    return { status: "paused", message: reason };
  }

  const skill = getSkill(proposal.skill);
  const cmd = skill.commands.find((c) => c.id === proposal.commandId);
  if (!cmd) {
    await done("failed", `Unknown command ${proposal.commandId}`, false, "Pyp can't run this action");
    return { status: "failed", message: "Pyp can't run this action" };
  }

  // Auto was the dial when this was scheduled. If the merchant has changed it since, follow the new setting.
  if (proposal.auto) {
    const dial = ruleFor(cmd.id, rules, skill).dial;
    if (dial === "off") {
      await done("obsolete", "Dial is Off now: not sent", false, "Not sent: you switched this action off");
      return { status: "obsolete", message: "Not sent: you switched this action off" };
    }
    if (dial === "ask") {
      await done("awaiting_approval", "Dial is Ask me now: waiting for you", true, "You changed this to Ask me. Approve to send.");
      return { status: "held", message: "You changed this to Ask me. Approve to send." };
    }
  }

  // The world may have changed since the card was made (paid, cancelled, client gone).
  const check = await cmd.check(proposal.params, { ...ctx, caseFile: proposal.caseFile });
  if (!check.ok) {
    await done("obsolete", `Re-check before sending: ${check.reason}`, false, `Not sent: ${check.reason}`);
    return { status: "obsolete", message: `Not sent: ${check.reason}` };
  }

  // The merchant's edits get the same gates as the model's words: the schema, then check().
  // A rejected edit hands the card back with the reason, so it can be fixed and approved.
  // The reason goes back to the merchant's open edit box; the card keeps its own.
  if (proposal.edits) {
    const rejected = async (why: string) => {
      await done("awaiting_approval", `Your edit: ${why}`, false);
      return { status: "edit_rejected" as const, message: `Not sent. Your edit: ${why}` };
    };
    // A write already reached PayPal with the original words (a timeout, then a retry).
    // Its request id would replay the old text, so the words can't change now.
    if (await attempted(deps.db, proposal.id)) {
      await lockEdits(deps.db, proposal.cardId);
      return rejected("Pyp already tried sending this once, so it can't be changed now. Approve to send it as it was, or dismiss it");
    }
    const fields = Object.keys(proposal.edits);
    const allowed = cmd.editable ?? [];
    const wrong = fields.find((f) => !allowed.includes(f) || typeof proposal.edits![f] !== "string");
    if (wrong) return rejected(`${wrong} can't be edited`);
    const params = { ...(proposal.params as Record<string, unknown>), ...proposal.edits };
    const parsed = cmd.params(proposal.caseFile).safeParse(params);
    if (!parsed.success) return rejected(parsed.error.issues[0]?.message ?? "not valid");
    const edited = await cmd.check(parsed.data, { ...ctx, caseFile: proposal.caseFile });
    if (!edited.ok) return rejected(edited.reason ?? "it didn't pass the checks");
    const diff = Object.fromEntries(fields.map((f) => [f, { from: (proposal.params as Record<string, unknown>)[f], to: proposal.edits![f] }]));
    proposal.params = parsed.data as Record<string, unknown>;
    proposal.resolved = cmd.resolve ? cmd.resolve(parsed.data, proposal.caseFile) : proposal.resolved;
    await saveEdits(deps.db, proposal, diff);
  }

  try {
    const label = await run(deps, proposal);
    await done("executed", label, true);
    return { status: "executed", message: label };
  } catch (err) {
    if (!(err instanceof PayPalError)) throw err;
    if (err.retryable) {
      // Same request ids next time, so trying again can't act twice.
      return retryLater(deps, merchantId, proposal, `PayPal didn't answer (${err.message})`, `PayPal: ${err.message}`, { status: err.status, debugId: err.debugId });
    }
    await done("failed", `PayPal refused: ${err.message}`, false, `PayPal refused: ${err.message}`, { status: err.status, debugId: err.debugId });
    return { status: "failed", message: `PayPal refused: ${err.message}` };
  }
}

/** Does the PayPal writes for one proposal and returns what happened, in a sentence. */
async function run(deps: ExecutorDeps, p: ClaimedProposal): Promise<string> {
  const r = p.resolved as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  switch (p.commandId) {
    case "invoice.createAndSend": {
      // A retry after a successful create resumes at send, so there is never a second draft.
      const made =
        ((await succeededStep(deps.db, p.id, "create")) as { invoiceId: string; invoiceNumber: string | null } | null) ??
        (await step(deps, p.id, "create", `${p.id}:create`, async () => {
          const res = await deps.write.createDraftInvoice(r as NewInvoice, `${p.id}:create`);
          return { res: res.response, keep: { invoiceId: res.invoiceId, invoiceNumber: res.invoiceNumber } };
        }));
      await step(deps, p.id, "send", `${p.id}:send`, async () => ({ res: await deps.write.sendInvoice(made.invoiceId, `${p.id}:send`), keep: {} }));
      return `Invoice ${made.invoiceNumber ?? made.invoiceId} for ${r.totalDisplay} created and sent to ${r.client.email}`;
    }
    case "invoice.sendReminder":
      await step(deps, p.id, "single", p.id, async () => ({
        res: await deps.write.remindInvoice(r.invoiceId, { subject: r.subject, note: r.note }, p.id),
        keep: {},
      }));
      return `Reminder ${r.reminderNumber} sent for invoice ${r.invoiceNumber} (${r.amountDueDisplay})`;
    case "invoice.cancel":
      await single(deps, p.id, () => deps.write.cancelInvoice(r.invoiceId, { note: r.note, sendToRecipient: r.sendToRecipient }, p.id));
      return `Invoice ${r.invoiceNumber} (${r.totalDisplay}) cancelled; PayPal emailed ${r.recipientEmail}`;
    case "dispute.provideEvidence":
      await single(deps, p.id, () => deps.write.provideEvidence(r.disputeId, { evidenceType: r.evidenceType, tracking: r.tracking, note: r.note }, p.id));
      return r.tracking
        ? `Evidence submitted for dispute ${r.disputeId}: ${r.tracking.carrier} tracking ${r.tracking.number}`
        : `Evidence submitted for dispute ${r.disputeId}`;
    case "dispute.makeOffer":
      await single(deps, p.id, () =>
        deps.write.makeOffer(r.disputeId, { offerType: r.offerType, amount: r.amount, currency: r.currency, note: r.note }, p.id),
      );
      return `Offered a ${r.amountDisplay} refund on dispute ${r.disputeId}`;
    case "dispute.sendMessage": {
      // PayPal accepts the same message twice, and the request id may not stop a
      // repeat. So if a timeout hid a send that worked, the thread already shows
      // it: read the thread first and don't post it again.
      const thread = (await deps.read.getDispute?.(r.disputeId))?.messages ?? [];
      if (thread.some((m) => m.postedBy === "SELLER" && m.text.trim() === String(r.message).trim())) {
        return `Message to ${r.buyerName ?? "the buyer"} was already on dispute ${r.disputeId}; not sent again`;
      }
      await single(deps, p.id, () => deps.write.sendDisputeMessage(r.disputeId, r.message, p.id));
      return `Message sent to ${r.buyerName ?? "the buyer"} on dispute ${r.disputeId}`;
    }
    case "dispute.acceptClaim":
      await single(deps, p.id, () =>
        deps.write.acceptClaim(r.disputeId, { note: r.note, refundAmount: r.refundAmount, currency: r.currency }, p.id),
      );
      return `Claim accepted on dispute ${r.disputeId}; PayPal refunds the buyer ${r.refundDisplay}`;
    case "insight.publish":
      // Read-only: approving a brief shows it. Nothing goes to PayPal.
      return `Brief shown: ${r.title}`;
    default:
      throw new PayPalError(`Pyp can't run ${p.commandId} yet`, 400, null, null);
  }
}

/** A command with one write: request id = proposal id. */
function single(deps: ExecutorDeps, proposalId: string, call: () => Promise<PayPalResponse<unknown>>): Promise<object> {
  return step(deps, proposalId, "single", proposalId, async () => ({ res: await call(), keep: {} }));
}

/** One PayPal call, recorded in executions whether it worked or not. */
async function step<K>(
  deps: ExecutorDeps,
  proposalId: string,
  name: string,
  requestId: string,
  call: () => Promise<{ res: PayPalResponse<unknown>; keep: K }>,
): Promise<K> {
  try {
    const { res, keep } = await call();
    await recordExecution(deps.db, { proposalId, step: name, requestId, httpStatus: res.status, debugId: res.debugId, response: keep });
    return keep;
  } catch (err) {
    if (err instanceof PayPalError) {
      await recordExecution(deps.db, { proposalId, step: name, requestId, httpStatus: err.status, debugId: err.debugId, response: err.body });
    }
    throw err;
  }
}
