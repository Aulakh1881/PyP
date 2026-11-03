import { createClient } from "@/lib/supabase/server";
import { getPayPalOrder, PayPalReadError } from "@/paypal/read-client";
import { PayPalAuthenticationError, PayPalConfigurationError } from "@/paypal/oauth";

function responseHeaders(request: Request): HeadersInit {
  const origin = request.headers.get("origin");
  return origin === "http://localhost:8080"
    ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true" }
    : {};
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const headers = responseHeaders(request);
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401, headers });

  const { id } = await context.params;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    return Response.json({ error: "Invalid PayPal order ID" }, { status: 400, headers });
  }

  try {
    return Response.json(await getPayPalOrder(id), { headers });
  } catch (error) {
    if (error instanceof PayPalConfigurationError || error instanceof PayPalAuthenticationError) {
      return Response.json({ error: "PayPal is not available" }, { status: 503, headers });
    }
    if (error instanceof PayPalReadError) {
      console.error("PayPal order read failed", { status: error.status, debugId: error.debugId });
      return Response.json({ error: "PayPal order data is unavailable" }, { status: 502, headers });
    }
    throw error;
  }
}
