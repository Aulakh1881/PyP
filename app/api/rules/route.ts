// GET /api/rules: the merchant's controls (kill switch, undo window, one dial per command).
// PUT /api/rules: body { dials?: { "invoice.sendReminder": "auto" }, undoSeconds?: 60 }.
// What a dial may be is checked in code (jobs/controls.ts), never trusted from the browser.

import { getPool } from "@/jobs/db";
import { getControls, updateControls } from "@/jobs/controls";
import { requireMerchant } from "@/lib/session";

export async function GET() {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  return Response.json(await getControls(getPool(), session.merchantId));
}

export async function PUT(request: Request) {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  const body = (await request.json().catch(() => null)) as { dials?: unknown; undoSeconds?: unknown } | null;
  if (!body || typeof body !== "object") return Response.json({ error: "The body must be JSON" }, { status: 400 });
  if (body.dials !== undefined && (typeof body.dials !== "object" || body.dials === null || Array.isArray(body.dials))) {
    return Response.json({ error: "dials must map command ids to off, ask or auto" }, { status: 400 });
  }
  if (body.undoSeconds !== undefined && typeof body.undoSeconds !== "number") {
    return Response.json({ error: "undoSeconds must be a number" }, { status: 400 });
  }
  const out = await updateControls(getPool(), session.merchantId, {
    dials: body.dials as Record<string, "off" | "ask" | "auto"> | undefined,
    undoSeconds: body.undoSeconds as number | undefined,
  });
  return out.ok ? Response.json(out.controls) : Response.json({ error: out.error }, { status: 422 });
}
