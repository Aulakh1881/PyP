import { createClient } from "@/lib/supabase/server";
import { getPayPalBalances, getPayPalTransactions, PayPalReadError } from "@/paypal/read-client";
import { PayPalAuthenticationError, PayPalConfigurationError } from "@/paypal/oauth";

function responseHeaders(request: Request): HeadersInit {
  const origin = request.headers.get("origin");
  return origin === "http://localhost:8080"
    ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true" }
    : {};
}

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return Response.json({ error: "Authentication required" }, {
      status: 401,
      headers: responseHeaders(request),
    });
  }

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
    }, { headers: responseHeaders(request) });
  } catch (error) {
    if (error instanceof PayPalConfigurationError || error instanceof PayPalAuthenticationError) {
      return Response.json({ error: "PayPal is not available" }, {
        status: 503,
        headers: responseHeaders(request),
      });
    }
    if (error instanceof PayPalReadError) {
      console.error("PayPal overview read failed", {
        status: error.status,
        debugId: error.debugId,
      });
      return Response.json({ error: "PayPal overview data is unavailable" }, {
        status: 502,
        headers: responseHeaders(request),
      });
    }
    throw error;
  }
}
