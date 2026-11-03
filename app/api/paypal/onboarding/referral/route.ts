import { createClient } from "@/lib/supabase/server";
import {
  createPayPalPartnerReferral,
  PayPalAuthenticationError,
  PayPalConfigurationError,
} from "@/paypal/oauth";

export async function POST() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: "Authentication required" }, { status: 401 });
  }

  try {
    const referral = await createPayPalPartnerReferral(`pyp:${user.id}`);
    return Response.json(referral);
  } catch (error) {
    if (error instanceof PayPalConfigurationError) {
      return Response.json(
        { error: "PayPal onboarding is not configured" },
        { status: 503 },
      );
    }
    if (error instanceof PayPalAuthenticationError) {
      console.error("PayPal partner referral failed", {
        status: error.paypalStatus,
        name: error.paypalName,
        debugId: error.paypalDebugId,
      });
      return Response.json(
        { error: "PayPal could not create the sandbox onboarding referral" },
        { status: 502 },
      );
    }
    throw error;
  }
}
