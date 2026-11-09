// GET /api/workflows: the merchant's workflows (each with its problems and a
// one-line summary) and the catalog of blocks the editor offers.
// POST /api/workflows { name, enabled, graph }: save a new one. A workflow with
// problems is saved switched off, as a draft; the answer lists the problems.

import { CATALOG } from "@/engine/workflows";
import { requireMerchant } from "@/lib/session";
import { getPool } from "@/jobs/db";
import { listWorkflows, missingWorkflowsTable, saveWorkflow } from "@/jobs/workflows";
import { NEEDS_MIGRATION, present, WorkflowBody } from "@/lib/workflows-api";

export async function GET() {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  try {
    const workflows = await listWorkflows(getPool(), session.merchantId);
    return Response.json({ workflows: workflows.map(present), catalog: CATALOG });
  } catch (err) {
    if (missingWorkflowsTable(err)) return Response.json({ ...NEEDS_MIGRATION, catalog: CATALOG }, { status: 503 });
    throw err;
  }
}

export async function POST(request: Request) {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  const body = WorkflowBody.safeParse(await request.json().catch(() => null));
  if (!body.success) return Response.json({ error: "That workflow doesn't look right. Reload and try again." }, { status: 400 });
  try {
    const out = await saveWorkflow(getPool(), session.merchantId, body.data);
    return Response.json({ workflow: present(out!.workflow), problems: out!.problems }, { status: 201 });
  } catch (err) {
    if (missingWorkflowsTable(err)) return Response.json(NEEDS_MIGRATION, { status: 503 });
    throw err;
  }
}
