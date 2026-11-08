// POST /api/sweeps/{name}: run a sweep now for the signed-in merchant
// (overdue-invoices or dispute-deadlines). The worker also runs both daily
// from 08:00 merchant-local; this is the dashboard's "check now".

import { requireMerchant } from "@/lib/session";
import { runSweepNow } from "@/lib/sweeps";
import { SWEEP_NAMES, type SweepName } from "@/jobs/sweep-run";

// Up to ten skill runs, each a model call or two.
export const maxDuration = 300;

export async function POST(_request: Request, ctx: RouteContext<"/api/sweeps/[name]">) {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  const { name } = await ctx.params;
  if (!SWEEP_NAMES.includes(name as SweepName)) return Response.json({ error: `Unknown sweep: ${name}` }, { status: 404 });
  const outcome = await runSweepNow(session.merchantId, name as SweepName);
  if (outcome.status === "paused") return Response.json({ ...outcome, message: "Pyp is paused (kill switch on)" }, { status: 409 });
  return Response.json(outcome);
}
