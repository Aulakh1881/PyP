import { createClient } from "@/lib/supabase/server";

// Ends the Supabase session: clears the sign-in cookies for this browser.
// The dashboard's Sign out button calls this before going to /login.
export async function POST() {
  const supabase = await createClient();
  const { error } = await supabase.auth.signOut();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ ok: true });
}
