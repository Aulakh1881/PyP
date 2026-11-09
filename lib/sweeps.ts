// Sweeps wired to the real sandbox, database and model (jobs/sweep-run.ts).

import { getPool } from "@/jobs/db";
import { runDailySweeps, runSweep, withSweepLock, type SweepName } from "@/jobs/sweep-run";
import { runDueSkills, runSkillNow } from "@/jobs/custom-skills";
import { getWorkflow, runWorkflowLocked } from "@/jobs/workflows";
import { serverAgent } from "@/lib/agent";
import { PayPalReadClient } from "@/paypal/engine-reads";
import { sharedPayPalHttp } from "@/paypal/http";

function deps() {
  return { pool: getPool(), read: new PayPalReadClient(sharedPayPalHttp()), agent: serverAgent() };
}

export const runSweepNow = (merchantId: string, name: SweepName) => runSweep(deps(), merchantId, name);
// The shared PayPal app is one merchant's account, so only that merchant is swept daily.
const sweptMerchant = process.env.PAYPAL_WEBHOOK_MERCHANT_ID;
export const runDailySweepsFromEnv = () => runDailySweeps({ ...deps(), merchantIds: sweptMerchant ? [sweptMerchant] : undefined });

/** "Run now" on one workflow: whatever its When covers today (a weekly one runs whatever the day). */
export async function runWorkflowNow(merchantId: string, workflowId: string) {
  const d = deps();
  const w = await getWorkflow(d.pool, merchantId, workflowId);
  if (!w) return null;
  return withSweepLock(d.pool, merchantId, () => runWorkflowLocked(d, merchantId, w, true));
}

/** Custom skills whose next run has come (the worker, every tick). */
export const runDueSkillsFromEnv = () => runDueSkills({ ...deps(), merchantIds: sweptMerchant ? [sweptMerchant] : undefined });

/** "Run now" (cards in the Inbox) or "Try it" (dryRun: nothing saved or sent) on one custom skill. */
export const runCustomSkillNow = (merchantId: string, skillId: string, dryRun = false) => runSkillNow(deps(), merchantId, skillId, { dryRun });
