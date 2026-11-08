// The executor wired to the real sandbox and database. Routes call this, so
// the write client is still only constructed inside executor/.

import { getPool } from "@/jobs/db";
import { sharedPayPalHttp } from "@/paypal/http";
import { PayPalReadClient } from "@/paypal/engine-reads";
import { PayPalWriteClient } from "@/paypal/write-client";
import { runDueWork, type DueRunResult } from "@/jobs/due-run";
import { serverAgent } from "@/lib/agent";
import { approveAndExecute, executeProposal, type ExecuteOutcome } from "./execute";

export function approveCard(merchantId: string, cardId: string): Promise<ExecuteOutcome> {
  const http = sharedPayPalHttp();
  return approveAndExecute({ db: getPool(), read: new PayPalReadClient(http), write: new PayPalWriteClient(http) }, merchantId, cardId);
}

/** One worker tick against the real sandbox and database (instrumentation.ts runs it on a timer). */
export function runDueWorkFromEnv(): Promise<DueRunResult[]> {
  const http = sharedPayPalHttp();
  const deps = { db: getPool(), read: new PayPalReadClient(http), write: new PayPalWriteClient(http) };
  return runDueWork({ pool: getPool(), read: deps.read, agent: serverAgent(), execute: (merchantId, p) => executeProposal(deps, merchantId, p) });
}
