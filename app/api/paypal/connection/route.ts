import { createClient } from "@/lib/supabase/server";
import {
  getPayPalAccessToken,
  getPayPalEnvironment,
  PayPalAuthenticationError,
  PayPalConfigurationError,
} from "@/paypal/oauth";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  try {
    await getPayPalAccessToken();
    return Response.json({
      connected: true,
      environment: getPayPalEnvironment(),
    });
  } catch (error) {
    if (error instanceof PayPalConfigurationError) {
      return Response.json(
        { connected: false, error: "PayPal is not configured" },
        { status: 503 },
      );
    }
    if (error instanceof PayPalAuthenticationError) {
      return Response.json(
        { connected: false, error: "PayPal authentication failed" },
        { status: 502 },
      );
    }
    throw error;
  }
}
