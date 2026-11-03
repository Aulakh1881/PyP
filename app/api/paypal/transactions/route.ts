import { createClient } from "@/lib/supabase/server";
import { getPayPalTransactions, PayPalReadError } from "@/paypal/read-client";
import { PayPalAuthenticationError, PayPalConfigurationError } from "@/paypal/oauth";

function dateParam(value: string | null, fallback: string): string {
  return value && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) ? value : fallback;
}

function validDateParam(value: string | null): boolean {
  return value === null || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value);
}

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
  const params = new URL(request.url).searchParams;
  const startDate = dateParam(params.get("start_date"), start.toISOString().replace(/\.\d{3}Z$/, "Z"));
  const endDate = dateParam(params.get("end_date"), end.toISOString().replace(/\.\d{3}Z$/, "Z"));
  const page = positiveIntParam(params.get("page"), 1, 10000);
  const pageSize = positiveIntParam(params.get("page_size"), 25, 100);
  const rangeMs = Date.parse(endDate) - Date.parse(startDate);
  if (
    !validDateParam(params.get("start_date"))
    || !validDateParam(params.get("end_date"))
    || !Number.isFinite(rangeMs)
    || rangeMs <= 0
    || rangeMs > 31 * 24 * 60 * 60 * 1000
  ) {
    return Response.json({ error: "Transaction dates must form a valid range of 31 days or less" }, {
      status: 400,
      headers: responseHeaders(request),
    });
  }

  try {
    const result = await getPayPalTransactions(startDate, endDate, { page, pageSize });
    return Response.json({
      ...result,
      totalPages: Math.max(1, Math.ceil(result.totalItems / result.pageSize)),
    }, { headers: responseHeaders(request) });
  } catch (error) {
    if (error instanceof PayPalConfigurationError || error instanceof PayPalAuthenticationError) {
      return Response.json({ error: "PayPal is not available" }, {
        status: 503,
        headers: responseHeaders(request),
      });
    }
    if (error instanceof PayPalReadError) {
      console.error("PayPal transaction read failed", {
        status: error.status,
        debugId: error.debugId,
      });
      return Response.json({ error: "PayPal transaction data is unavailable" }, {
        status: 502,
        headers: responseHeaders(request),
      });
    }
    throw error;
  }
}
