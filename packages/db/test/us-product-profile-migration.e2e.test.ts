import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUsProfileTestDatabase } from "./support/us-profile-database.js";

const url = process.env.US_TEST_DATABASE_URL;
const productId = "00000000-0000-4000-8000-000000000117";
describe.skipIf(!url)("US product profile additive migration", () => {
  let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let before: unknown;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated database");
    fixture = await createUsProfileTestDatabase(url, 116);
    await fixture.pool.query(
      `INSERT INTO organization (id, name, slug, created_at) VALUES ('a', 'Synthetic A', 'a', now()), ('b', 'Synthetic B', 'b', now())`,
    );
    await fixture.pool.query(
      `INSERT INTO products (id, tenant_id, name) VALUES ($1, 'a', 'Existing catalog item')`,
      [productId],
    );
    before = (await fixture.pool.query("SELECT * FROM products WHERE id = $1", [productId])).rows;
    await fixture.pool.query(readFileSync("migrations/0117_us_product_profiles.sql", "utf8"));
  }, 60_000);
  afterAll(async () => {
    await fixture?.close();
  });

  it("preserves catalog data and creates no inferred profiles", async () => {
    expect(
      (await fixture.pool.query("SELECT * FROM products WHERE id = $1", [productId])).rows,
    ).toEqual(before);
    expect((await fixture.pool.query("SELECT * FROM product_traceability_profiles")).rows).toEqual(
      [],
    );
  });
  it("rejects foreign-tenant product references", async () => {
    await expect(
      fixture.pool.query(
        `INSERT INTO product_traceability_profiles (tenant_id, product_id, product_name) VALUES ('b', $1, 'Wrong tenant')`,
        [productId],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
  it.each([
    ["revision", "0"],
    ["product_name", " "],
    ["packaging_size_value", "0"],
    ["packaging_size_value", "-1"],
    ["packaging_size_value", "NaN"],
    ["packaging_size_value", "1"],
    ["packaging_size_uom", "oz"],
    ["default_quantity_uom", "pounds"],
    ["reviewed_by", "actor"],
    ["coverage_status", "covered"],
  ])("rejects invalid %s=%s at the storage boundary", async (column, value) => {
    // Column names come only from the literal test cases above.
    const names =
      column === "product_name"
        ? "tenant_id, product_id, product_name"
        : `tenant_id, product_id, product_name, ${column}`;
    const values = column === "product_name" ? "'a', $1, $2" : "'a', $1, 'Synthetic', $2";
    await expect(
      fixture.pool.query(
        `INSERT INTO product_traceability_profiles (${names}) VALUES (${values})`,
        [productId, value],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("stores exact decimal scale, retains actor snapshots and rejects duplicate profiles", async () => {
    await fixture.pool.query(
      `INSERT INTO product_traceability_profiles (tenant_id, product_id, product_name, packaging_size_value, packaging_size_uom, reviewed_by, reviewed_at) VALUES ('a', $1, 'Synthetic', '0.001', 'oz', 'historical-actor', now())`,
      [productId],
    );
    expect(
      (
        await fixture.pool.query(
          "SELECT packaging_size_value, revision, reviewed_by FROM product_traceability_profiles",
        )
      ).rows,
    ).toEqual([{ packaging_size_value: "0.001", revision: 1, reviewed_by: "historical-actor" }]);
    await expect(
      fixture.pool.query(
        `INSERT INTO product_traceability_profiles (tenant_id, product_id, product_name) VALUES ('a', $1, 'Duplicate')`,
        [productId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });
});
