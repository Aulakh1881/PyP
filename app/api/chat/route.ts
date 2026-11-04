// POST /api/chat: the receptionist routes one sentence from the merchant to
// the right skill (a new invoice, an open invoice or dispute), and any
// proposal that needs them becomes a card (design §11.3). Not streamed yet:
// the reply comes when the run ends.

import { z } from "zod";
import { serverAgent } from "@/lib/agent";
import { requireMerchant } from "@/lib/session";
import { getPool } from "@/jobs/db";
import { runChatMessage } from "@/jobs/chat-run";
import { sharedPayPalHttp } from "@/paypal/http";
import { PayPalReadClient } from "@/paypal/engine-reads";

const Body = z.object({ message: z.string().trim().min(1).max(1000) });

export async function POST(request: Request) {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  const body = Body.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: "Send { message } with 1 to 1000 characters" }, { status: 400 });

  const read = new PayPalReadClient(sharedPayPalHttp());
  const outcome = await runChatMessage(
    { pool: getPool(), read, agent: serverAgent(), subjects: () => read.openSubjects() },
    session.merchantId,
    body.data.message,
    request.signal,
  );
  return Response.json(outcome);
}
