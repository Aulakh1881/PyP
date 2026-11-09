// Workflows on a real Postgres (skipped without TEST_DATABASE_URL). PayPal reads
// are faked and the model is scripted.

import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Invoice } from "@/engine/types";
import type { WorkflowGraph } from "@/engine/workflows";
import { ScriptedAgentClient } from "@/gateway/scripted";
import { acmeInvoice, friendlyReminder, NOW } from "@/skills/collections/evals/fixtures";
import { engineDb, listCards, loadMerchant } from "./store";
import { runSweep, type SweepReads } from "./sweep-run";
import { DEMO_MERCHANT, TEST_DB_URL, freshDatabase } from "./test-db";
import { listWorkflows, runPaidWorkflows, runWorkflowLocked, saveWorkflow } from "./workflows";

// NOW is 2026-10-28 08:00 in Los Angeles. acmeInvoice ($1,200) was due Oct 21.
const small: Invoice = { ...acmeInvoice, id: "INV2-ACME-0050", number: "0050", total: "100.00", amountDue: "100.00" };
const dueSoon: Invoice = { ...acmeInvoice, id: "INV2-ACME-0060", number: "0060", dueDate: "2026-10-30" };

const bigAsks: WorkflowGraph = {
  nodes: [
    { id: "w", type: "when", trigger: "invoice_overdue" },
    { id: "c", type: "if", field: "amount", op: "gte", value: "500" },
    { id: "a", type: "then", action: "ask_me" },
    { id: "r", type: "then", action: "remind", params: { tone: "friendly" } },
  ],
  edges: [
    { from: "w", to: "c" },
    { from: "c", to: "a", branch: "yes" },
    { from: "c", to: "r", branch: "no" },
  ],
};

function ask(invoice = "0042") {
  return {
    title: `Invoice ${invoice} is overdue`,
    summary: "Your workflow says to ask you first.",
    actions: [{ command: "merchant.ask", params: { question: `Invoice ${invoice} is overdue. What should I do?`, options: ["Send a reminder", "Wait"] }, why: "The workflow asks first." }],
    confidence: "high",
    questionForMerchant: null,
  };
}

function reads(overdue: Invoice[], unpaid: Invoice[] = overdue): SweepReads {
  const all = [...overdue, ...unpaid];
  return {
    getInvoice: async (id) => all.find((i) => i.id === id) ?? null,
    recentClients: async () => [],
    overdueInvoices: async () => overdue,
    disputesDueBefore: async () => [],
    unpaidInvoices: async () => unpaid,
  };
}

describe.skipIf(!TEST_DB_URL)("workflows (Postgres)", () => {
  let pool: Pool;
  let drop: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, drop } = await freshDatabase());
  });
  afterAll(async () => drop?.());
  beforeEach(async () => {
    await pool.query("delete from workflows");
    await pool.query("update proposals set status = 'obsolete' where status in ('awaiting_approval', 'scheduled', 'executing', 'executed')");
    await pool.query("update merchants set kill_switch = false where id = $1", [DEMO_MERCHANT]);
  });

  it("an unfinished workflow is saved as a switched-off draft, with what's missing", async () => {
    const draft = { nodes: [bigAsks.nodes[0]], edges: [] } as WorkflowGraph;
    const out = await saveWorkflow(pool, DEMO_MERCHANT, { name: "Draft", enabled: true, graph: draft });
    expect(out).toMatchObject({ workflow: { name: "Draft", enabled: false }, problems: ["Add a Then block: what should Pyp do?"] });
    const done = await saveWorkflow(pool, DEMO_MERCHANT, { name: "Big invoices", enabled: true, graph: bigAsks }, out!.workflow.id);
    expect(done).toMatchObject({ workflow: { enabled: true }, problems: [] });
    expect(await listWorkflows(pool, DEMO_MERCHANT)).toHaveLength(1);
  });

  it("the overdue sweep: a matching workflow decides, code picks the branch, and Pyp is limited to its actions", async () => {
    await saveWorkflow(pool, DEMO_MERCHANT, { name: "Big invoices", enabled: true, graph: bigAsks });
    const agent = new ScriptedAgentClient([ask(), friendlyReminder({ invoiceId: small.id, note: "Hi Sam, a friendly nudge on invoice 0050 for $100.00. Thanks so much. Maya Ortiz Design" })]);
    const out = await runSweep({ pool, read: reads([acmeInvoice, small]), agent, now: () => NOW }, DEMO_MERCHANT, "overdue-invoices");
    expect(out).toMatchObject({ status: "ok", found: 2, failed: [] });

    // $1,200 ≥ $500 → "Ask me": only merchant.ask on the menu.
    const big = agent.requests.find((r) => r.turn.includes("INV2-ACME-0042"))!;
    expect(big.turn).toContain('My workflow &quot;Big invoices&quot; applies here');
    expect(big.turn).toContain('<command id="merchant.ask"');
    expect(big.turn).not.toContain('<command id="invoice.sendReminder"');
    // $100 → "Send a friendly reminder".
    const little = agent.requests.find((r) => r.turn.includes("INV2-ACME-0050"))!;
    expect(little.turn).toContain("Send a friendly reminder.");
    expect(little.turn).toContain('<command id="invoice.sendReminder"');

    const runs = await pool.query("select subject_ref, trigger from runs where trigger like 'workflow:%' order by subject_ref");
    expect(runs.rows).toEqual([
      { subject_ref: "invoice:INV2-ACME-0042", trigger: "workflow:Big invoices" },
      { subject_ref: "invoice:INV2-ACME-0050", trigger: "workflow:Big invoices" },
    ]);
  });

  it("a workflow that's off changes nothing: the usual run", async () => {
    await saveWorkflow(pool, DEMO_MERCHANT, { name: "Big invoices", enabled: false, graph: bigAsks });
    const agent = new ScriptedAgentClient([friendlyReminder()]);
    await runSweep({ pool, read: reads([acmeInvoice]), agent, now: () => NOW }, DEMO_MERCHANT, "overdue-invoices");
    expect(agent.requests[0].turn).not.toContain("My workflow");
  });

  it("due soon: Run now finds invoices due within the days picked, and skips the rest", async () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: "w", type: "when", trigger: "invoice_due_soon", params: { days: 3 } },
        { id: "a", type: "then", action: "ask_me", note: "This client prefers a call." },
      ],
      edges: [{ from: "w", to: "a" }],
    };
    const { workflow } = (await saveWorkflow(pool, DEMO_MERCHANT, { name: "Heads-up", enabled: true, graph }))!;
    const agent = new ScriptedAgentClient([ask("0060")]);
    const later: Invoice = { ...dueSoon, id: "INV2-LATER", dueDate: "2026-12-01" };
    const out = await runWorkflowLocked({ pool, read: reads([], [dueSoon, later]), agent, now: () => NOW }, DEMO_MERCHANT, workflow, true);
    expect(out).toMatchObject({ status: "ok", found: 1, matched: 1, ran: 1 });
    expect(agent.requests).toHaveLength(1);
    expect(agent.requests[0].turn).toContain("My note: This client prefers a call.");
  });

  it("a weekly workflow waits for its day unless run now; a paid-invoice workflow waits for PayPal", async () => {
    const weekly: WorkflowGraph = { nodes: [{ id: "w", type: "when", trigger: "weekly", params: { weekday: "Mon" } }, { id: "t", type: "then", action: "check_overdue" }], edges: [{ from: "w", to: "t" }] };
    const { workflow } = (await saveWorkflow(pool, DEMO_MERCHANT, { name: "Monday", enabled: true, graph: weekly }))!;
    const deps = { pool, read: reads([]), agent: new ScriptedAgentClient([]), now: () => NOW }; // NOW is a Wednesday
    expect(await runWorkflowLocked(deps, DEMO_MERCHANT, workflow)).toMatchObject({ status: "waiting", message: "Runs on Mon" });
    expect(await runWorkflowLocked(deps, DEMO_MERCHANT, workflow, true)).toMatchObject({ status: "ok", found: 1, matched: 1 });
  });

  it("an invoice is paid: a heads-up card in the Inbox, with no model call", async () => {
    const graph: WorkflowGraph = {
      nodes: [
        { id: "w", type: "when", trigger: "invoice_paid" },
        { id: "c", type: "if", field: "amount", op: "gte", value: "1000" },
        { id: "t", type: "then", action: "tell_me" },
      ],
      edges: [
        { from: "w", to: "c" },
        { from: "c", to: "t", branch: "yes" },
      ],
    };
    await saveWorkflow(pool, DEMO_MERCHANT, { name: "Big payments", enabled: true, graph });
    const { merchant, rules } = await loadMerchant(pool, DEMO_MERCHANT);
    const ctx = { merchant, rules, read: reads([]), db: engineDb(pool, DEMO_MERCHANT), now: () => NOW };
    expect(await runPaidWorkflows(pool, DEMO_MERCHANT, small, ctx)).toEqual([]); // $100: under $1,000
    const [id] = await runPaidWorkflows(pool, DEMO_MERCHANT, acmeInvoice, ctx);
    const card = (await listCards(pool, DEMO_MERCHANT)).find((c) => c.id === id)!;
    expect(card).toMatchObject({ state: "executed", front: { title: "Invoice 0042 is paid", notice: true, reason: "From your workflow “Big payments”." } });
  });
});
