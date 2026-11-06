import { createClient } from "@/lib/supabase/server";
import { syncPayPalReporting } from "@/lib/paypal/reporting-sync";
import { PayPalAuthenticationError, PayPalConfigurationError } from "@/paypal/oauth";
import { PayPalReadError } from "@/paypal/read-client";

function responseHeaders(request: Request): HeadersInit {
  const origin = request.headers.get("origin");
  return origin === "http://localhost:8080"
    ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true" }
    : {};
}

export async function POST(request: Request) {
  const headers = responseHeaders(request);
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401, headers });

  const { data: membership, error: membershipError } = await supabase
    .from("merchant_members")
    .select("merchant_id")
    .eq("user_id", user.id)
    .eq("merchant_id", "00000000-0000-0000-0000-000000000001")
    .maybeSingle();
  if (membershipError) throw membershipError;
  if (!membership) return Response.json({ error: "Merchant access required" }, { status: 403, headers });

  try {
    return Response.json({
      ok: true,
      synced: await syncPayPalReporting(supabase),
      note: "This initial sync imports the current 31-day transaction window and first invoice/dispute page.",
    }, { headers });
  } catch (error) {
    if (error instanceof PayPalConfigurationError || error instanceof PayPalAuthenticationError) {
      return Response.json({ error: "PayPal is not available" }, { status: 503, headers });
    }
    if (error instanceof PayPalReadError) {
      console.error("PayPal reporting cache sync failed", { status: error.status, debugId: error.debugId });
      return Response.json({ error: "PayPal data could not be synchronized" }, { status: 502, headers });
    }
    throw error;
  }
}
