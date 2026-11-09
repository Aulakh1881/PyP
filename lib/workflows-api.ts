// Shared by the /api/workflows routes: the request body and how a workflow is shown.

import { z } from "zod";
import { describeWorkflow, workflowProblems, WorkflowGraph } from "@/engine/workflows";
import type { StoredWorkflow } from "@/jobs/workflows";

export const WorkflowBody = z.object({ name: z.string().trim().min(1).max(80), enabled: z.boolean(), graph: WorkflowGraph });
export const NEEDS_MIGRATION = { error: "The database needs migration 012_workflows.sql first" };

/** A workflow with its one-line summary and what still needs fixing. */
export const present = (w: StoredWorkflow) => ({ ...w, summary: describeWorkflow(w.graph), problems: workflowProblems(w.graph) });
