import { redirect } from "next/navigation";
import { connection } from "next/server";
import { createClient } from "@/lib/supabase/server";
import SetupClient from "./SetupClient";

export default async function PayPalSetupPage() {
  await connection();
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
