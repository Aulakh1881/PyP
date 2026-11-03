import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

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

  redirect("http://localhost:8080/app/?authenticated=1");
}
