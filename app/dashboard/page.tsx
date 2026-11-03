import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import {
  getPayPalAccessToken,
  PayPalAuthenticationError,
  PayPalConfigurationError,
} from "@/paypal/oauth";

export const instant = false;

export default async function DashboardPage() {
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

  redirect("http://localhost:8080/app/?authenticated=1");
}
