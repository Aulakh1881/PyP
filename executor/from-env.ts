// The executor wired to the real sandbox and database. Routes call this, so
// the write client is still only constructed inside executor/.

import { getPool } from "@/jobs/db";
import { sharedPayPalHttp } from "@/paypal/http";
import { PayPalReadClient } from "@/paypal/read-client";
import { PayPalWriteClient } from "@/paypal/write-client";
import { approveAndExecute, type ExecuteOutcome } from "./execute";

export function approveCard(merchantId: string, cardId: string): Promise<ExecuteOutcome> {
  const http = sharedPayPalHttp();
  return approveAndExecute({ db: getPool(), read: new PayPalReadClient(http), write: new PayPalWriteClient(http) }, merchantId, cardId);
}
