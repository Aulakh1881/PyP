// POST /api/chat: the receptionist routes one sentence from the merchant to
// the right skill (a new invoice, an open invoice or dispute), and any
// proposal that needs them becomes a card (design §11.3). Not streamed yet:
// the reply comes when the run ends.

import { z } from "zod";
import { serverAgent } from "@/lib/agent";
import { requireMerchant } from "@/lib/session";
import { getPool } from "@/jobs/db";
import { runChatMessage } from "@/jobs/chat-run";
import { chatContext, getDocuments, MAX_CHAT_FILES } from "@/jobs/documents";
import { runSweepNow } from "@/lib/sweeps";
import { sharedPayPalHttp } from "@/paypal/http";
import { PayPalReadClient } from "@/paypal/engine-reads";

const Turn = z.object({
  from: z.enum(["merchant", "pyp"]),
  text: z.string().max(1000),
  waiting: z.boolean().optional(),
  // Cards this Pyp line made; a question among them is closed when the merchant answers in chat.
  cardIds: z.array(z.string().uuid()).max(5).optional(),
});
// history: the last few lines of this chat, oldest first, so follow-ups make sense (engine/chat.ts).
// documentIds: files attached to this message (POST /api/documents first); what Pyp read in them rides along.
const Body = z.object({
  message: z.string().trim().min(1).max(1000),
  history: z.array(Turn).max(20).optional(),
  documentIds: z.array(z.string().uuid()).max(MAX_CHAT_FILES).optional(),
});

export async function POST(request: Request) {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  const body = Body.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: "Send { message } with 1 to 1000 characters (and at most 20 lines of history)" }, { status: 400 });

  const files = await getDocuments(getPool(), session.merchantId, body.data.documentIds ?? []).catch(() => []);
  const message = body.data.message + chatContext(files);

  const read = new PayPalReadClient(sharedPayPalHttp());
  const outcome = await runChatMessage(
    {
      pool: getPool(),
      read,
      agent: serverAgent(),
      subjects: () => read.openSubjects(),
      weeklyBrief: () => runSweepNow(session.merchantId, "weekly-brief"),
    },
    session.merchantId,
    message,
    request.signal,
    body.data.history ?? [],
  );
  return Response.json(outcome);
}
