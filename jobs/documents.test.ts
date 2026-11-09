// Files Pyp reads, on a real Postgres (skipped without TEST_DATABASE_URL). The model is scripted.

import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FILES_END, FILES_START, type DocumentFacts } from "@/engine/document-reader";
import { ScriptedAgentClient } from "@/gateway/scripted";
import { chatContext, deleteDocument, listDocuments, saveDocument } from "./documents";
import { factsFor } from "./facts";
import { DEMO_MERCHANT, TEST_DB_URL, freshDatabase } from "./test-db";

const PNG = (seed: number) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, seed, 0, 0, 0]);
const proof: DocumentFacts = {
  kind: "shipping_proof",
  summary: "A UPS receipt showing a parcel delivered to Jane Doe.",
  from: { name: "Maya Ortiz Design", email: null },
  to: { name: "Jane Doe", email: null },
  amounts: [],
  lineItems: [],
  dates: [{ label: "Delivered", date: "2026-11-03" }],
  tracking: [{ carrier: "UPS", number: "1Z999AA10123456784", status: "Delivered" }],
  references: [],
  asksSomething: false,
};

describe.skipIf(!TEST_DB_URL)("documents (Postgres)", () => {
  let pool: Pool;
  let drop: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    ({ pool, drop } = await freshDatabase());
  });
  afterAll(async () => drop?.());
  beforeEach(async () => {
    await pool.query("delete from documents");
  });

  it("on a dispute, what a file shows becomes a note in that case file; removing the file removes it", async () => {
    const agent = new ScriptedAgentClient([proof]);
    const doc = await saveDocument({ pool, agent }, DEMO_MERCHANT, { name: "ups-receipt.png", mediaType: "image/png", bytes: PNG(1), subject: { kind: "dispute", id: "PP-D-1" } });
    expect(doc).toMatchObject({ status: "read", subjectRef: "dispute:PP-D-1", facts: { kind: "shipping_proof" } });

    const notes = await factsFor(pool, DEMO_MERCHANT, "dispute:PP-D-1");
    expect(notes).toContain("From ups-receipt.png (shipping proof): for Jane Doe · from Maya Ortiz Design · UPS tracking 1Z999AA10123456784 (Delivered) · Delivered 2026-11-03");
    expect(await factsFor(pool, DEMO_MERCHANT, "dispute:PP-D-2")).not.toContainEqual(expect.stringContaining("ups-receipt"));

    expect(await deleteDocument(pool, DEMO_MERCHANT, doc.id)).toBe(true);
    expect(await factsFor(pool, DEMO_MERCHANT, "dispute:PP-D-1")).not.toContainEqual(expect.stringContaining("ups-receipt"));
  });

  it("the same file again isn't read twice; a suspicious file is kept but adds nothing", async () => {
    const agent = new ScriptedAgentClient([proof, { ...proof, asksSomething: true }]);
    await saveDocument({ pool, agent }, DEMO_MERCHANT, { name: "a.png", mediaType: "image/png", bytes: PNG(2) });
    const again = await saveDocument({ pool, agent }, DEMO_MERCHANT, { name: "a-copy.png", mediaType: "image/png", bytes: PNG(2) });
    expect(again.status).toBe("read");
    expect(agent.requests).toHaveLength(1);

    const bad = await saveDocument({ pool, agent }, DEMO_MERCHANT, { name: "../../evil.png", mediaType: "image/png", bytes: PNG(3), subject: { kind: "dispute", id: "PP-D-9" } });
    expect(bad).toMatchObject({ status: "suspicious", name: "evil.png", reason: expect.stringMatching(/instructions/) });
    expect(await factsFor(pool, DEMO_MERCHANT, "dispute:PP-D-9")).not.toContainEqual(expect.stringContaining("evil.png"));
    expect((await listDocuments(pool, DEMO_MERCHANT)).map((d) => d.name).sort()).toEqual(["a-copy.png", "a.png", "evil.png"]);
    const badAgain = await saveDocument({ pool, agent }, DEMO_MERCHANT, { name: "evil2.png", mediaType: "image/png", bytes: PNG(3) });
    expect(badAgain).toMatchObject({ status: "suspicious", reason: expect.stringMatching(/instructions/) });
  });

  it("in chat, readable files ride along as a labelled block; others add nothing", async () => {
    const agent = new ScriptedAgentClient([proof, "not json"]);
    const good = await saveDocument({ pool, agent }, DEMO_MERCHANT, { name: "receipt.png", mediaType: "image/png", bytes: PNG(4) });
    const unreadable = await saveDocument({ pool, agent }, DEMO_MERCHANT, { name: "blurry.png", mediaType: "image/png", bytes: PNG(5) });
    expect(unreadable.status).toBe("failed");
    const ctx = chatContext([good, unreadable]);
    expect(ctx.startsWith(FILES_START)).toBe(true);
    expect(ctx.endsWith(FILES_END)).toBe(true);
    expect(ctx).toContain("- From receipt.png (shipping proof):");
    expect(ctx).not.toContain("blurry.png"); // only files Pyp could read and trust
    expect(chatContext([unreadable])).toBe("");
  });
});
