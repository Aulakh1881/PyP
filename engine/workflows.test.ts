import { describe, expect, it } from "vitest";
import { describeWorkflow, disputeReason, evaluate, moneyToCents, planFor, workflowProblems, type WorkflowGraph } from "./workflows";

/** When an invoice is overdue → If amount ≥ $500 → yes: ask me / otherwise: a friendly reminder. */
const bigAsks: WorkflowGraph = {
  nodes: [
    { id: "w", type: "when", trigger: "invoice_overdue" },
    { id: "c", type: "if", field: "amount", op: "gte", value: "500" },
    { id: "a", type: "then", action: "ask_me" },
    { id: "r", type: "then", action: "remind", params: { tone: "friendly" }, note: "Mention the project name." },
  ],
  edges: [
    { from: "w", to: "c" },
    { from: "c", to: "a", branch: "yes" },
    { from: "c", to: "r", branch: "no" },
  ],
};

describe("workflows: is the diagram complete?", () => {
  it("a complete workflow has no problems, and reads as one line", () => {
    expect(workflowProblems(bigAsks)).toEqual([]);
    expect(describeWorkflow(bigAsks)).toBe("An invoice is overdue, 1 check → Ask me what to do / Send a reminder");
  });

  it("says what's missing in plain words", () => {
    expect(workflowProblems({ nodes: [], edges: [] })).toEqual(["Add a When block to say when this runs"]);
    const loose: WorkflowGraph = { ...bigAsks, edges: bigAsks.edges.slice(0, 2) };
    expect(workflowProblems(loose)).toContain("Connect this block: Send a reminder");
    const noBranch: WorkflowGraph = { ...bigAsks, edges: [{ from: "w", to: "c" }, { from: "c", to: "a" }, { from: "c", to: "r", branch: "no" }] };
    expect(workflowProblems(noBranch)).toContain("An arrow from an If block must be Yes or Otherwise");
    const twoIn: WorkflowGraph = { ...bigAsks, edges: [...bigAsks.edges, { from: "w", to: "a" }] };
    expect(workflowProblems(twoIn)).toContain("Ask me what to do has more than one arrow coming in");
  });

  it("an action has to fit the When, and a check has to fit the subject", () => {
    const wrong: WorkflowGraph = {
      nodes: [
        { id: "w", type: "when", trigger: "dispute_opened" },
        { id: "c", type: "if", field: "reminders_sent", op: "gte", value: 1 },
        { id: "t", type: "then", action: "remind", params: { tone: "friendly" } },
      ],
      edges: [
        { from: "w", to: "c" },
        { from: "c", to: "t", branch: "yes" },
      ],
    };
    expect(workflowProblems(wrong)).toEqual(expect.arrayContaining(['"Send a reminder" doesn\'t go with "A dispute needs a response"', "If: pick something to check for a dispute needs a response"]));
  });

  it("a weekly workflow needs its day; due soon needs its days", () => {
    const weekly: WorkflowGraph = { nodes: [{ id: "w", type: "when", trigger: "weekly", params: {} }, { id: "t", type: "then", action: "weekly_brief" }], edges: [{ from: "w", to: "t" }] };
    expect(workflowProblems(weekly)).toEqual(["When: pick on"]);
    weekly.nodes[0] = { id: "w", type: "when", trigger: "weekly", params: { weekday: "Mon" } };
    expect(workflowProblems(weekly)).toEqual([]);
  });

  it("a circle of arrows is refused", () => {
    const loop: WorkflowGraph = {
      nodes: [
        { id: "w", type: "when", trigger: "invoice_overdue" },
        { id: "c", type: "if", field: "amount", op: "gte", value: "1" },
        { id: "d", type: "if", field: "amount", op: "gte", value: "2" },
      ],
      edges: [
        { from: "w", to: "c" },
        { from: "c", to: "d", branch: "yes" },
        { from: "d", to: "c", branch: "yes" },
      ],
    };
    expect(workflowProblems(loop)).toContain("Arrows go round in a circle");
  });
});

describe("workflows: code walks the diagram", () => {
  it("follows Yes or Otherwise on code's numbers, in whole cents", () => {
    expect(evaluate(bigAsks, { amountCents: 50_000 }).map((t) => t.action)).toEqual(["ask_me"]);
    expect(evaluate(bigAsks, { amountCents: 49_999 }).map((t) => t.action)).toEqual(["remind"]);
    // A fact code doesn't have counts as "no".
    expect(evaluate(bigAsks, {}).map((t) => t.action)).toEqual(["remind"]);
    expect(moneyToCents("500")).toBe(50_000);
    expect(moneyToCents("12.5")).toBe(1_250);
    expect(moneyToCents("1,000")).toBeNull();
  });

  it("text, choices and yes/no checks", () => {
    const g: WorkflowGraph = {
      nodes: [
        { id: "w", type: "when", trigger: "dispute_opened" },
        { id: "c", type: "if", field: "has_tracking", op: "is", value: "yes" },
        { id: "p", type: "then", action: "send_proof" },
        { id: "r", type: "if", field: "reason", op: "is", value: "not_received" },
        { id: "o", type: "then", action: "offer_refund" },
      ],
      edges: [
        { from: "w", to: "c" },
        { from: "c", to: "p", branch: "yes" },
        { from: "c", to: "r", branch: "no" },
        { from: "r", to: "o", branch: "yes" },
      ],
    };
    expect(evaluate(g, { hasTracking: true }).map((t) => t.action)).toEqual(["send_proof"]);
    expect(evaluate(g, { hasTracking: false, reason: "not_received" }).map((t) => t.action)).toEqual(["offer_refund"]);
    expect(evaluate(g, { hasTracking: false, reason: "other" })).toEqual([]);
    expect(disputeReason("MERCHANDISE_OR_SERVICE_NOT_RECEIVED")).toBe("not_received");
  });

  it("the plan: the merchant's workflow as an instruction, limited to its actions plus asking", () => {
    const plan = planFor("Big invoices", "invoice", evaluate(bigAsks, { amountCents: 100 }));
    expect(plan).toEqual({
      skill: "collections",
      instruction: 'My workflow "Big invoices" applies here. It says:\n- Send a friendly reminder. My note: Mention the project name.',
      commands: ["merchant.ask", "invoice.sendReminder"],
    });
    expect(planFor("Big invoices", "invoice", evaluate(bigAsks, { amountCents: 90_000 }))?.commands).toEqual(["merchant.ask"]);
    // "Let Pyp decide" on a dispute: the Disputes skill, any of its commands.
    expect(planFor("x", "dispute", [{ id: "t", type: "then", action: "pyp_decides" }])).toMatchObject({ skill: "disputes", commands: null });
    // A heads-up or a sweep isn't a skill run.
    expect(planFor("x", "invoice", [{ id: "t", type: "then", action: "tell_me" }])).toBeNull();
  });
});
