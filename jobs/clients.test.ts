// The merchant's client list on a real Postgres (skipped without TEST_DATABASE_URL).

import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClient, deleteClient, listSavedClients, savedClientsForEngine, updateClient } from "./clients";
import { engineDb } from "./store";
import { DEMO_MERCHANT, TEST_DB_URL, freshDatabase } from "./test-db";

describe.skipIf(!TEST_DB_URL)("clients (Postgres)", () => {
  let pool: Pool;
  let drop: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, drop } = await freshDatabase());
  });
  afterAll(async () => drop?.());

  it("saves, lists, edits and removes a client; one per email, whatever its case", async () => {
    const john = await createClient(pool, DEMO_MERCHANT, { name: "John", email: "john@new.example", nicknames: ["Johnny"] }, "chat");
    expect(john).toMatchObject({ name: "John", businessName: null, email: "john@new.example", nicknames: ["Johnny"], source: "chat" });
    expect(await createClient(pool, DEMO_MERCHANT, { name: "Other John", email: "JOHN@new.example" })).toBeNull();

    const acme = await createClient(pool, DEMO_MERCHANT, { businessName: "Acme Studio", email: "sam@acme.example" });
    expect((await listSavedClients(pool, DEMO_MERCHANT)).map((c) => c.email)).toEqual(["sam@acme.example", "john@new.example"]);
    expect(await updateClient(pool, DEMO_MERCHANT, john!.id, { name: "John Park", email: "sam@acme.example" })).toBe("duplicate");
    expect(await updateClient(pool, DEMO_MERCHANT, john!.id, { name: "John Park", email: "jp@new.example", nicknames: ["JP"] })).toMatchObject({ name: "John Park", nicknames: ["JP"] });

    // The engine reads them as Collections clients.
    expect(await engineDb(pool, DEMO_MERCHANT).savedClients!()).toEqual([
      { id: "saved_1", name: null, businessName: "Acme Studio", email: "sam@acme.example", nicknames: [] },
      { id: "saved_2", name: "John Park", businessName: null, email: "jp@new.example", nicknames: ["JP"] },
    ]);

    expect(await deleteClient(pool, DEMO_MERCHANT, acme!.id)).toBe(true);
    expect(await deleteClient(pool, DEMO_MERCHANT, acme!.id)).toBe(false);
    expect(await savedClientsForEngine(pool, DEMO_MERCHANT)).toHaveLength(1);
  });

  it("the database refuses a bad email", async () => {
    await expect(pool.query("insert into clients (merchant_id, name, email) values ($1, 'X', 'not an email')", [DEMO_MERCHANT])).rejects.toThrow();
  });
});
