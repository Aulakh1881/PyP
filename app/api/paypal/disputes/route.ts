import { createClient } from "@/lib/supabase/server";
import { getPayPalDisputes, PayPalReadError } from "@/paypal/read-client";
import { PayPalAuthenticationError, PayPalConfigurationError } from "@/paypal/oauth";

function positiveIntParam(value: string | null, fallback: number, maximum: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= maximum ? parsed : fallback;
}

function responseHeaders(request: Request): HeadersInit {
  const origin = request.headers.get("origin");
  return origin === "http://localhost:8080"
    ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true" }
    : {};
}

export async function GET(request: Request) {
  const headers = responseHeaders(request);
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401, headers });

  const params = new URL(request.url).searchParams;
  const page = positiveIntParam(params.get("page"), 1, 10000);
  const pageSize = positiveIntParam(params.get("page_size"), 25, 100);

  try {
    const result = await getPayPalDisputes({ page, pageSize });
    return Response.json({
      ...result,
      totalPages: Math.max(1, Math.ceil(result.totalItems / result.pageSize)),
    }, { headers });
  } catch (error) {
    if (error instanceof PayPalConfigurationError || error instanceof PayPalAuthenticationError) {
      return Response.json({ error: "PayPal is not available" }, { status: 503, headers });
    }
    if (error instanceof PayPalReadError) {
      console.error("PayPal dispute read failed", {
        status: error.status,
        debugId: error.debugId,
      });
      return Response.json({ error: "PayPal dispute data is unavailable" }, { status: 502, headers });
    }
    throw error;
  }
}
