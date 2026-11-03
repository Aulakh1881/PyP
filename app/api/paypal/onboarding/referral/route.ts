import { createClient } from "@/lib/supabase/server";
import {
  createPayPalPartnerReferral,
  PayPalAuthenticationError,
  PayPalConfigurationError,
} from "@/paypal/oauth";

export const runtime = "nodejs";

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
      return Response.json(
        { error: "PayPal could not create the sandbox onboarding referral" },
        { status: 502 },
      );
    }
    throw error;
  }
}
