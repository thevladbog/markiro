import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUsProfileTestDatabase } from "./support/us-profile-database.js";

const url = process.env.US_TEST_DATABASE_URL;
const partyA = randomUUID(),
  partyB = randomUUID();
describe.skipIf(!url)("reference document additive migration", () => {
  let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let previous: unknown;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated US database");
    fixture = await createUsProfileTestDatabase(url, 119);
    await fixture.pool.query(
      "INSERT INTO organization(id,name,slug,created_at) VALUES ('a','Synthetic A','a',now()), ('b','Synthetic B','b',now())",
    );
    await fixture.pool.query(
      "INSERT INTO traceability_parties(id,tenant_id,name) VALUES ($1,'a','A'),($2,'b','B')",
      [partyA, partyB],
    );
    await fixture.pool.query(
      "INSERT INTO products(tenant_id,name) VALUES ('a','Synthetic apples')",
    );
    await fixture.pool.query(
      "INSERT INTO traceability_lots(tenant_id,product_id,tlc,assignment_basis,created_by,updated_by) SELECT 'a',id,'LOT-0001','imported','historical','historical' FROM products",
    );
    previous = await oldRows();
    await fixture.pool.query(readFileSync("migrations/0120_us_reference_documents.sql", "utf8"));
  }, 60_000);
  afterAll(async () => {
    await fixture?.close();
  });
  async function oldRows() {
    return Promise.all(
      ["products", "traceability_parties", "traceability_lots"].map(
        async (table) => (await fixture.pool.query(`SELECT * FROM ${table} ORDER BY id`)).rows,
      ),
    );
  }
  function insert(
    number: string,
    tenant = "a",
    party: string | null = null,
    type = "bol",
    label: string | null = null,
  ) {
    return fixture.pool.query(
      "INSERT INTO reference_documents(tenant_id,type,number,party_id,type_other_label,created_by) VALUES ($1,$2,$3,$4,$5,'historical-actor') RETURNING id,number,created_by",
      [tenant, type, number, party, label],
    );
  }
  it("preserves existing rows and does not invent document records", async () => {
    expect(await oldRows()).toEqual(previous);
    expect((await fixture.pool.query("SELECT * FROM reference_documents")).rows).toEqual([]);
  });
  it("keeps case-sensitive identity within tenant, type and nullable party, including archived records", async () => {
    await insert("IDENTITY");
    await insert("IDENTITY", "b");
    await insert("IDENTITY", "a", null, "po");
    await insert("IDENTITY", "a", partyA);
    await insert("identity");
    await expect(insert("IDENTITY")).rejects.toMatchObject({ code: "23505" });
    await expect(insert("IDENTITY", "a", partyA)).rejects.toMatchObject({ code: "23505" });
    await fixture.pool.query(
      "UPDATE reference_documents SET archived_at=now() WHERE number='IDENTITY'",
    );
    await expect(insert("IDENTITY")).rejects.toMatchObject({ code: "23505" });
  });
  it("rejects foreign-tenant issuer references", async () => {
    await expect(insert("FOREIGN", "a", partyB)).rejects.toMatchObject({ code: "23503" });
  });
  it.each(["", " ", " A ", "x".repeat(129), "A\nB", "A\u0085B"])(
    "rejects invalid number %j",
    async (number) => {
      await expect(insert(number)).rejects.toMatchObject({ code: "23514" });
    },
  );
  it("validates custom types and retains opaque identifiers and historical actors", async () => {
    await expect(insert("OTHER", "a", null, "other")).rejects.toMatchObject({ code: "23514" });
    await expect(insert("OTHER", "a", null, "other", " ")).rejects.toMatchObject({ code: "23514" });
    await expect(insert("OTHER", "a", null, "bol", "Unexpected")).rejects.toMatchObject({
      code: "23514",
    });
    const saved = (await insert("=000Ä🍎", "a", null, "other", "Certificate")).rows[0];
    expect(saved).toMatchObject({ number: "=000Ä🍎", created_by: "historical-actor" });
    await expect(
      fixture.pool.query("UPDATE reference_documents SET issued_on='10000-01-01' WHERE id=$1", [
        saved.id,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      fixture.pool.query("UPDATE reference_documents SET created_by='' WHERE id=$1", [saved.id]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      fixture.pool.query("UPDATE reference_documents SET notes=$1 WHERE id=$2", [
        "x".repeat(2001),
        saved.id,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
