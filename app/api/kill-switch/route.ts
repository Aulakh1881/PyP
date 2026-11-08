// POST /api/kill-switch: body { on: true | false }. On pauses every write at once:
// Approve, Auto actions waiting out their undo window, and the daily sweeps.

import { getPool } from "@/jobs/db";
import { updateControls } from "@/jobs/controls";
import { requireMerchant } from "@/lib/session";

export async function POST(request: Request) {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  const body = (await request.json().catch(() => null)) as { on?: unknown } | null;
  if (typeof body?.on !== "boolean") return Response.json({ error: "Send { on: true } or { on: false }" }, { status: 400 });
  const out = await updateControls(getPool(), session.merchantId, { killSwitch: body.on });
  return out.ok ? Response.json(out.controls) : Response.json({ error: out.error }, { status: 422 });
}
