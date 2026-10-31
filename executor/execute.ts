// The executor (design §9.4): the only code that writes to PayPal. For an
// approved card it claims the proposal, re-runs the command's check() with
// fresh reads, sends the resolved values (never the model's params), and
// records every PayPal call. Request ids make a retry safe: "<proposal id>"
// for one write, "<proposal id>:create" and ":send" for createAndSend.

import { getSkill } from "@/engine/registry";
import type { PayPalReads } from "@/engine/types";
import { PayPalError, type PayPalResponse } from "@/paypal/http";
import { PayPalWriteClient, type NewInvoice } from "@/paypal/write-client";
import {
  claimForExecution,
  engineDb,
  finish,
  loadMerchant,
  recordExecution,
  succeededStep,
  type ClaimedProposal,
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
  | { status: "not_waiting"; message: string };

export async function approveAndExecute(deps: ExecutorDeps, merchantId: string, cardId: string): Promise<ExecuteOutcome> {
  const proposal = await claimForExecution(deps.db, merchantId, cardId);
  if (!proposal) return { status: "not_waiting", message: "This card isn't waiting for approval" };

  const { merchant, rules } = await loadMerchant(deps.db, merchantId);
  const ctx = { merchant, rules, read: deps.read, db: engineDb(deps.db, merchantId), now: deps.now ?? (() => new Date()) };
  const done = (status: "executed" | "failed" | "obsolete" | "awaiting_approval", label: string, ok: boolean, reason?: string, detail?: unknown) =>
    finish(deps.db, { merchantId, proposal, status, label, ok, reason, detail });

  // The world may have changed since the card was made (paid, cancelled, client gone).
  const cmd = getSkill(proposal.skill).commands.find((c) => c.id === proposal.commandId);
  if (!cmd) {
    await done("failed", `Unknown command ${proposal.commandId}`, false, "Pyp can't run this action");
    return { status: "failed", message: "Pyp can't run this action" };
  }
  let check;
  try {
    check = await cmd.check(proposal.params, { ...ctx, caseFile: proposal.caseFile });
  } catch (err) {
    check = { ok: false, reason: `Check failed: ${(err as Error).message}` };
  }
  if (!check.ok) {
    await done("obsolete", `Re-check before sending: ${check.reason}`, false, `Not sent: ${check.reason}`);
    return { status: "obsolete", message: `Not sent: ${check.reason}` };
  }

  try {
    const label = await run(deps, proposal);
    await done("executed", label, true);
    return { status: "executed", message: label };
  } catch (err) {
    if (!(err instanceof PayPalError)) throw err;
    if (err.retryable) {
      // Same request ids next time, so approving again can't act twice.
      const reason = `PayPal didn't answer (${err.message}). Approve again to retry; it won't send twice.`;
      await done("awaiting_approval", `PayPal: ${err.message}`, false, reason, { status: err.status, debugId: err.debugId });
      return { status: "retry", message: reason };
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
    default:
      throw new PayPalError(`Pyp can't run ${p.commandId} yet`, 400, null, null);
  }
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
