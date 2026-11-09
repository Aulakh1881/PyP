// Pyp's memory on a real Postgres (skipped without TEST_DATABASE_URL).

import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runSkill } from "@/engine/run-skill";
import { ScriptedAgentClient } from "@/gateway/scripted";
import { collections } from "@/skills/collections/skill";
import { acmeInvoice, friendlyReminder, NOW } from "@/skills/collections/evals/fixtures";
import { addFact, deleteFact, factsFor, listFacts, updateFact } from "./facts";
import { engineDb, loadMerchant } from "./store";
import { DEMO_MERCHANT, TEST_DB_URL, freshDatabase } from "./test-db";

describe.skipIf(!TEST_DB_URL)("Pyp's memory (Postgres)", () => {
  let pool: Pool;
  let drop: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, drop } = await freshDatabase());
  });
  afterAll(async () => drop?.());

  it("a case file gets the business's facts, this subject's and this client's; not other clients', not unconfirmed ones", async () => {
    await addFact(pool, DEMO_MERCHANT, { text: "I never charge late fees." });
    await addFact(pool, DEMO_MERCHANT, { text: "Always pays on the 15th.", clientEmail: "SAM@acme.example" });
    await addFact(pool, DEMO_MERCHANT, { text: "Prefers a call.", clientEmail: "priya@beta.example" });
    await addFact(pool, DEMO_MERCHANT, { text: "Waiting on their accountant.", subjectRef: "invoice:INV2-ACME-0042" });
    const proposed = await addFact(pool, DEMO_MERCHANT, { text: "Acme is slow in December.", status: "proposed", source: "chat" });

    const notes = await factsFor(pool, DEMO_MERCHANT, "invoice:INV2-ACME-0042", ["sam@acme.example"]);
    expect(notes.sort()).toEqual(["About SAM@acme.example: Always pays on the 15th.", "I never charge late fees.", "Waiting on their accountant."].sort());

    // Confirming a proposed fact puts it to work.
    await updateFact(pool, DEMO_MERCHANT, proposed.id, { text: "Acme is slow in December.", confirm: true });
    expect(await factsFor(pool, DEMO_MERCHANT, "invoice:OTHER")).toContain("Acme is slow in December.");
    expect(await deleteFact(pool, DEMO_MERCHANT, proposed.id)).toBe(true);
    expect((await listFacts(pool, DEMO_MERCHANT)).map((f) => f.status)).toEqual(["active", "active", "active", "active"]);
  });

  it("the overdue case file carries the facts as merchant-only notes", async () => {
    const { merchant, rules } = await loadMerchant(pool, DEMO_MERCHANT);
    const read = { getInvoice: async () => acmeInvoice, recentClients: async () => [] };
    const agent = new ScriptedAgentClient([friendlyReminder()]);
    const ctx = { merchant, rules, read, db: engineDb(pool, DEMO_MERCHANT), now: () => NOW };
    await runSkill({ skill: collections, subject: { kind: "invoice", id: acmeInvoice.id }, ctx, agent, trigger: "test" });
    const turn = agent.requests[0].turn;
    expect(turn).toContain('<merchant-notes visibility="merchant-only">');
    expect(turn).toContain("Always pays on the 15th.");
    expect(turn).not.toContain("Prefers a call.");
  });
});
