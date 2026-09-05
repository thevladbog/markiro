import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUsProfileTestDatabase } from "./support/us-profile-database.js";
const url = process.env.US_TEST_DATABASE_URL;
const product = "00000000-0000-4000-8000-000000000118";
const location = "00000000-0000-4000-8000-000000000119";
const otherLocation = "00000000-0000-4000-8000-000000000120";
describe.skipIf(!url)("lot additive migration on isolated PostgreSQL", () => {
  let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let existing: unknown;
  let existingProfiles: unknown;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated database");
    fixture = await createUsProfileTestDatabase(url, 117);
    await fixture.pool.query(
      "INSERT INTO organization(id,name,slug,created_at) VALUES ('a','Synthetic A','a',now()), ('b','Synthetic B','b',now())",
    );
    await fixture.pool.query(
      "INSERT INTO products(id,tenant_id,name) VALUES ($1,'a','Synthetic apples')",
      [product],
    );
    await fixture.pool.query(
      "INSERT INTO product_traceability_profiles(tenant_id,product_id,product_name,packaging_size_value,packaging_size_uom,coverage_status,reviewed_by,reviewed_at) VALUES ('a',$1,'Synthetic apples',2.500,'lb','covered','historical-reviewer','2026-09-06T00:00:00Z')",
      [product],
    );
    const party = randomUUID();
    await fixture.pool.query(
      "INSERT INTO traceability_parties(id,tenant_id,name) VALUES ($1,'a','Synthetic supplier')",
      [party],
    );
    await fixture.pool.query(
      "INSERT INTO traceability_locations(id,tenant_id,party_id,name,business_name) VALUES ($1,'a',$3,'A','A'),($2,'a',$3,'B','B')",
      [location, otherLocation, party],
    );
    existing = (await fixture.pool.query("SELECT * FROM products")).rows;
    existingProfiles = (await fixture.pool.query("SELECT * FROM product_traceability_profiles"))
      .rows;
    await fixture.pool.query(readFileSync("migrations/0118_us_lots.sql", "utf8"));
  }, 60_000);
  afterAll(async () => {
    await fixture?.close();
  });
  function insert(
    tlc: string,
    fields: {
      tenant?: string;
      location?: string;
      reference?: string;
      referenceLocation?: string;
    } = {},
  ) {
    return fixture.pool.query(
      "INSERT INTO traceability_lots(tenant_id,product_id,tlc,source_location_id,source_reference_kind,source_reference_value,source_reference_location_id,created_by,updated_by,assignment_basis) VALUES ($1,$2,$3,$4,$5,$6,$7,'historical-actor','historical-actor','imported') RETURNING id,tlc,revision",
      [
        fields.tenant ?? "a",
        product,
        tlc,
        fields.location ?? null,
        fields.reference ? "web_url" : null,
        fields.reference ?? null,
        fields.referenceLocation ?? null,
      ],
    );
  }
  it("preserves catalog and profile rows without inventing lots", async () => {
    expect((await fixture.pool.query("SELECT * FROM products")).rows).toEqual(existing);
    expect((await fixture.pool.query("SELECT * FROM product_traceability_profiles")).rows).toEqual(
      existingProfiles,
    );
    expect((await fixture.pool.query("SELECT * FROM traceability_lots")).rows).toEqual([]);
  });
  it("allows the same TLC only in different source identities and never releases archived identity", async () => {
    await insert("SHARED", { location });
    await insert("SHARED", { location: otherLocation });
    await insert("SHARED");
    await insert("SHARED", { reference: "https://example.test/a", referenceLocation: location });
    await insert("SHARED", { reference: "https://example.test/b", referenceLocation: location });
    await expect(insert("SHARED", { location })).rejects.toMatchObject({ code: "23505" });
    await expect(insert("SHARED")).rejects.toMatchObject({ code: "23505" });
    await expect(
      insert("SHARED", { reference: "https://example.test/a", referenceLocation: otherLocation }),
    ).rejects.toMatchObject({ code: "23505" });
    await fixture.pool.query("UPDATE traceability_lots SET status='archived' WHERE tlc='SHARED'");
    await expect(insert("SHARED", { location })).rejects.toMatchObject({ code: "23505" });
  });
  it("blocks cross-tenant product and source foreign keys", async () => {
    await expect(insert("FOREIGN", { tenant: "b" })).rejects.toMatchObject({ code: "23503" });
    const foreignParty = randomUUID(),
      foreignLocation = randomUUID();
    await fixture.pool.query(
      "INSERT INTO traceability_parties(id,tenant_id,name) VALUES ($1,'b','Foreign')",
      [foreignParty],
    );
    await fixture.pool.query(
      "INSERT INTO traceability_locations(id,tenant_id,party_id,name,business_name) VALUES ($1,'b',$2,'Foreign','Foreign')",
      [foreignLocation, foreignParty],
    );
    await expect(insert("FOREIGN", { location: foreignLocation })).rejects.toMatchObject({
      code: "23503",
    });
    await expect(
      insert("FOREIGN", {
        reference: "https://example.test/f",
        referenceLocation: foreignLocation,
      }),
    ).rejects.toMatchObject({ code: "23503" });
  });
  it.each(["", " A ", "a".repeat(121), "A\u001dB", "A\u0085B"])(
    "rejects invalid TLC %j at storage",
    async (tlc) => {
      await expect(insert(tlc)).rejects.toMatchObject({ code: "23514" });
    },
  );
  it("preserves Unicode at the code-point boundary and historical actors", async () => {
    const result = await insert("🍎".repeat(120));
    expect(result.rows[0]).toMatchObject({ tlc: "🍎".repeat(120), revision: 1 });
    await expect(
      fixture.pool.query("UPDATE traceability_lots SET revision=0 WHERE id=$1", [
        result.rows[0]?.id,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("rejects partial or competing source forms", async () => {
    await expect(
      insert("INVALID", { reference: "https://example.test/none" }),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      insert("INVALID", {
        location,
        reference: "https://example.test/both",
        referenceLocation: location,
      }),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(insert("INVALID", { referenceLocation: location })).rejects.toMatchObject({
      code: "23514",
    });
  });
});
