import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { connection } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { DASHBOARD_URL } from "@/lib/dashboard-url";
import {
  getPayPalAccessToken,
  PayPalAuthenticationError,
  PayPalConfigurationError,
} from "@/paypal/oauth";

export const instant = false;

export default async function DashboardPage() {
  await connection();
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { error: provisioningError } = await supabase.rpc("provision_demo_account");
  if (provisioningError) {
    throw new Error(`Could not provision the demo account: ${provisioningError.message}`);
  }

  try {
    await getPayPalAccessToken();
  } catch (error) {
    if (error instanceof PayPalConfigurationError || error instanceof PayPalAuthenticationError) {
      redirect("/paypal-setup");
    }
    throw error;
  }

  // Came through scripts/live-dashboard.mjs (:3001)? Stay on it. A fixed path, so a
  // forged header can only send you to this origin's /app/.
  const viaLive = (await headers()).get("x-pyp-live-dashboard") === "1";
  redirect(viaLive ? "/app/?authenticated=1" : DASHBOARD_URL);
}
