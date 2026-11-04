// POST /api/holds: the merchant says "hold off" on an invoice or dispute
// (e.g. "Sam replied, paying Friday"). While it's active, code stops
// reminders on that subject. DELETE /api/holds lifts it.

import { z } from "zod";
import { requireMerchant } from "@/lib/session";
import { getPool } from "@/jobs/db";
import { liftHolds, setHold } from "@/jobs/store";

const Subject = z.object({ kind: z.enum(["invoice", "dispute"]), id: z.string().trim().min(1).max(100) });
const SetBody = z.object({
  subject: Subject,
  reason: z.string().trim().min(1).max(500),
  until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
});

export async function POST(request: Request) {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  const body = SetBody.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: "Send { subject: { kind, id }, reason, until? (YYYY-MM-DD) }" }, { status: 400 });
  const id = await setHold(getPool(), session.merchantId, body.data.subject, body.data.reason, body.data.until);
  return Response.json({ id });
}

export async function DELETE(request: Request) {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  const body = z.object({ subject: Subject }).safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: "Send { subject: { kind, id } }" }, { status: 400 });
  const lifted = await liftHolds(getPool(), session.merchantId, body.data.subject);
  return Response.json({ lifted });
}
