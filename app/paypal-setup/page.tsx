import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import SetupClient from "./SetupClient";

export const instant = false;

export default async function PayPalSetupPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  return (
    <main className="setup-page">
      <SetupClient />
      <p className="disclaimer">
        Sandbox only · Independent concept · Not affiliated with PayPal
      </p>
    </main>
  );
}
