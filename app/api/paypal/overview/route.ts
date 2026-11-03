import { createClient } from "@/lib/supabase/server";
import { getPayPalBalances, getPayPalTransactions, PayPalReadError } from "@/paypal/read-client";
import { PayPalAuthenticationError, PayPalConfigurationError } from "@/paypal/oauth";

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });

  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 30);
  const toApiDate = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, "Z");

  try {
    const [balances, transactionData] = await Promise.all([
      getPayPalBalances(),
      getPayPalTransactions(toApiDate(start), toApiDate(end)),
    ]);
    return Response.json({
      environment: process.env.PAYPAL_ENVIRONMENT?.toLowerCase() ?? "sandbox",
      period: { start: toApiDate(start), end: toApiDate(end) },
      balances,
      transactionCount: transactionData.totalItems,
      recentTransactions: transactionData.transactions.slice(0, 10),
    });
  } catch (error) {
    if (error instanceof PayPalConfigurationError || error instanceof PayPalAuthenticationError) {
      return Response.json({ error: "PayPal is not available" }, { status: 503 });
    }
    if (error instanceof PayPalReadError) {
      return Response.json({ error: "PayPal overview data is unavailable" }, { status: 502 });
    }
    throw error;
  }
}
