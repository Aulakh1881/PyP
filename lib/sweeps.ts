// Sweeps wired to the real sandbox, database and model (jobs/sweep-run.ts).

import { getPool } from "@/jobs/db";
import { runDailySweeps, runSweep, type SweepName } from "@/jobs/sweep-run";
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
