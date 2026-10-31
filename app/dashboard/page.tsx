import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { Inbox } from "./inbox";
import "./dashboard.css";

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
    <main className="dash">
      <header className="dash-top">
        <h1>Inbox</h1>
        <span className="demo">DEMO DATA · PAYPAL SANDBOX</span>
        <span className="who">{user.email}</span>
      </header>
      <Inbox />
      <p className="disclaimer">Pyp is an independent hackathon project, not affiliated with or endorsed by PayPal.</p>
    </main>
  );
}
