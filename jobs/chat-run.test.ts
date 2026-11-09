import { describe, expect, it } from "vitest";
import { openQuestionCards } from "@/engine/chat";
import type { Proposal } from "@/engine/run-skill";
import { briefReply, memoryLine, nothingMade, whereItWent } from "./chat-run";

const proposal = (command: string, status: Proposal["status"]) => ({ action: { command, params: {}, why: "" }, status }) as unknown as Proposal;

describe("where the card went (chat reply)", () => {
  it("an approval card points to the Inbox", () => {
    expect(whereItWent([proposal("invoice.createAndSend", "awaiting_approval")])).toBe("It's in your Inbox, waiting for your approval.");
  });
  it("a question is answered right in the chat", () => {
    expect(whereItWent([proposal("merchant.ask", "awaiting_approval")])).toBe("Just reply here.");
  });
  it("an approval beats a question when both are made", () => {
    expect(whereItWent([proposal("merchant.ask", "awaiting_approval"), proposal("invoice.sendReminder", "awaiting_approval")])).toContain("waiting for your approval");
  });
  it("an Auto card says it runs unless you Undo", () => {
    expect(whereItWent([proposal("invoice.sendReminder", "scheduled")])).toContain("Undo");
  });
  it("no card, no line", () => {
    expect(whereItWent([])).toBe("");
  });
});

describe("the weekly brief from chat", () => {
  const ok = { status: "ok" as const, found: 1, skipped: 0, deferred: 0, ran: 1, cardIds: ["card_1"], failed: [] };
  it("a new brief is in the Inbox; one already made this week isn't made twice", () => {
    expect(briefReply(ok)).toContain("This week's brief is in your Inbox");
    expect(briefReply({ ...ok, ran: 0, cardIds: [], skipped: 1 })).toContain("already in your Inbox");
  });
  it("paused, busy or broken: says so plainly", () => {
    expect(briefReply({ status: "paused" })).toContain("paused");
    expect(briefReply({ status: "busy" })).toContain("Try again in a minute");
    expect(briefReply(null)).toContain("couldn't make the brief");
  });
});

describe("when nothing was made", () => {
  it("says the code's reason as a sentence, or Pyp's own summary", () => {
    expect(nothingMade(["A follow-up is already scheduled"])).toBe("I didn't set anything up: a follow-up is already scheduled.");
    expect(nothingMade([], "Invoice 0011 isn't due yet.")).toBe("Invoice 0011 isn't due yet.");
    expect(nothingMade([])).toBe("There's nothing to do on that right now.");
  });
});

describe("questions answered in chat", () => {
  it("the open questions are Pyp's waiting lines back to the last thing it finished", () => {
    expect(
      openQuestionCards([
        { from: "pyp", text: "Done.", waiting: false, cardIds: ["old"] },
        { from: "merchant", text: "invoice John $100" },
        { from: "pyp", text: "What's John's email?", waiting: true, cardIds: ["q1"] },
        { from: "merchant", text: "hmm" },
        { from: "pyp", text: "Which John?", waiting: true, cardIds: ["q2"] },
      ]),
    ).toEqual(["q2", "q1"]);
    expect(openQuestionCards([])).toEqual([]);
  });
});

describe("the memory line in chat", () => {
  it("says it once, and quotes a noted fact cleanly", () => {
    expect(memoryLine({ text: "x", status: "active" }, "Got it. I'll remember that PyP Test pays on the 15th.")).toBe("");
    expect(memoryLine({ text: "x", status: "active" }, "Got it.")).toBe(" I'll remember that.");
    expect(memoryLine({ text: "Maria is always net 15.", status: "proposed" }, "Drafting.")).toBe(" I noted “Maria is always net 15”. Confirm it in Pyp's memory and I'll use it from now on.");
    expect(memoryLine(undefined, "Hi")).toBe("");
  });
});
