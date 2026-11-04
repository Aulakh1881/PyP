import { redirect } from "next/navigation";
import { connection } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { getPayPalAccessToken, PayPalAuthenticationError, PayPalConfigurationError } from "@/paypal/oauth";
import { Inbox } from "./inbox";
import "./inbox.css";

// The engine's Inbox: cards from /api/cards, chat to /api/chat, Approve,
// Dismiss and the trace flip. The main dashboard (/dashboard) is the
// prototype app; this page is the working Next.js view of the same cards.

export const instant = false;

export default async function InboxPage() {
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

  // Same gate as /dashboard: no PayPal connection, no inbox.
  try {
    await getPayPalAccessToken();
  } catch (error) {
    if (error instanceof PayPalConfigurationError || error instanceof PayPalAuthenticationError) {
      redirect("/paypal-setup");
    }
    throw error;
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
