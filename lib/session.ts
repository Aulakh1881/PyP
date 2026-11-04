// Who is calling an /api route: a signed-in Supabase user who is a member of
// a merchant (migration 002). Every route that reads or changes Pyp's records
// starts here.

import { createClient } from "@/lib/supabase/server";
import { getPool } from "@/jobs/db";
import { merchantForUser } from "@/jobs/store";

export type Session = { merchantId: string; userId: string };

export async function requireMerchant(): Promise<Session | Response> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Sign in first" }, { status: 401 });
  const merchantId = await merchantForUser(getPool(), user.id);
  if (!merchantId) return Response.json({ error: "Your account isn't connected to a business yet" }, { status: 403 });
  return { merchantId, userId: user.id };
}
