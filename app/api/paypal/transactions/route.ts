import { createClient } from "@/lib/supabase/server";
import { getPayPalTransactions, PayPalReadError } from "@/paypal/read-client";
import { PayPalAuthenticationError, PayPalConfigurationError } from "@/paypal/oauth";

function dateParam(value: string | null, fallback: string): string {
  return value && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) ? value : fallback;
}

export async function GET(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });

  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 30);
  const params = new URL(request.url).searchParams;
  const startDate = dateParam(params.get("start_date"), start.toISOString().replace(/\.\d{3}Z$/, "Z"));
  const endDate = dateParam(params.get("end_date"), end.toISOString().replace(/\.\d{3}Z$/, "Z"));

  try {
    return Response.json(await getPayPalTransactions(startDate, endDate));
  } catch (error) {
    if (error instanceof PayPalConfigurationError || error instanceof PayPalAuthenticationError) {
      return Response.json({ error: "PayPal is not available" }, { status: 503 });
    }
    if (error instanceof PayPalReadError) {
      return Response.json({ error: "PayPal transaction data is unavailable" }, { status: 502 });
    }
    throw error;
  }
}
