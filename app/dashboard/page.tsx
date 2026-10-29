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

  return (
    <main className="placeholder">
      <h1>Welcome to Pyp</h1>
      <p>You are signed in as {user.email}.</p>
      <p className="disclaimer">
        Your profile is connected to the Pyp Demo Business.
      </p>
    </main>
  );
}
