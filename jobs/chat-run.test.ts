import { describe, expect, it } from "vitest";
import type { Proposal } from "@/engine/run-skill";
import { whereItWent } from "./chat-run";

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
