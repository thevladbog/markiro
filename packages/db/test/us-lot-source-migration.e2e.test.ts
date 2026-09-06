import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUsProfileTestDatabase } from "./support/us-profile-database.js";

const url = process.env.US_TEST_DATABASE_URL;
const product = "00000000-0000-4000-8000-000000000119";
const location = "00000000-0000-4000-8000-000000000120";
const lot = "00000000-0000-4000-8000-000000000121";
describe.skipIf(!url)("lot source correction migration", () => {
  let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let before: Record<string, unknown>;
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated database");
    fixture = await createUsProfileTestDatabase(url, 118);
    await fixture.pool.query(
      "INSERT INTO organization(id,name,slug,created_at) VALUES ('a','Synthetic','a',now())",
    );
    await fixture.pool.query(
      "INSERT INTO products(id,tenant_id,name) VALUES ($1,'a','Synthetic')",
      [product],
    );
    await fixture.pool.query(
      "INSERT INTO traceability_parties(id,tenant_id,name) VALUES ($1,'a','Synthetic')",
      [product],
    );
    await fixture.pool.query(
      "INSERT INTO traceability_locations(id,tenant_id,party_id,name,business_name) VALUES ($1,'a',$2,'Site','Site')",
      [location, product],
    );
    await fixture.pool.query(
      "INSERT INTO traceability_lots(id,tenant_id,product_id,tlc,assignment_basis,created_by,updated_by) VALUES ($1,'a',$2,'A-1','imported','historical','historical')",
      [lot, product],
    );
    [before] = (
      await fixture.pool.query("SELECT * FROM traceability_lots WHERE id=$1", [lot])
    ).rows;
    await fixture.pool.query(readFileSync("migrations/0119_us_lot_source_corrections.sql", "utf8"));
  }, 60_000);
  afterAll(async () => {
    await fixture?.close();
  });
  it("preserves existing records without inventing finalization or a reason", async () => {
    expect(
      (await fixture.pool.query("SELECT * FROM traceability_lots WHERE id=$1", [lot])).rows,
    ).toEqual([{ ...before, source_locked_at: null, last_source_reason: null }]);
  });
  it("permits correcting a source before the lock", async () => {
    await fixture.pool.query(
      "UPDATE traceability_lots SET source_location_id=$2,last_source_reason='Correct supplier site' WHERE id=$1",
      [lot, location],
    );
    expect(
      (
        await fixture.pool.query("SELECT source_location_id FROM traceability_lots WHERE id=$1", [
          lot,
        ])
      ).rows,
    ).toEqual([{ source_location_id: location }]);
  });
  it("rejects identity replacement combined with the first source lock", async () => {
    const candidate = "00000000-0000-4000-8000-000000000122";
    await fixture.pool.query(
      "INSERT INTO traceability_lots(id,tenant_id,product_id,tlc,assignment_basis,created_by,updated_by) VALUES ($1,'a',$2,'LATCH','imported','historical','historical')",
      [candidate, product],
    );
    for (const mutation of [
      `source_location_id='${location}'`,
      "tlc='LATCH-REPLACED'",
      "assignment_basis='transformation'",
      `product_id='${location}'`,
      `id='${location}'`,
      "tenant_id='foreign'",
    ]) {
      await expect(
        fixture.pool.query(
          `UPDATE traceability_lots SET source_locked_at=now(),${mutation} WHERE id=$1`,
          [candidate],
        ),
      ).rejects.toMatchObject({ code: "23514", constraint: "traceability_lots_source_locked" });
    }
    expect(
      (
        await fixture.pool.query(
          "SELECT tlc,source_location_id,source_locked_at FROM traceability_lots WHERE id=$1",
          [candidate],
        )
      ).rows,
    ).toEqual([{ tlc: "LATCH", source_location_id: null, source_locked_at: null }]);
  });
  it("freezes identity irreversibly while still permitting lifecycle updates", async () => {
    await fixture.pool.query(
      "UPDATE traceability_lots SET source_locked_at='2026-09-06T00:00:00Z' WHERE id=$1",
      [lot],
    );
    for (const mutation of [
      "source_location_id=NULL",
      "source_locked_at=NULL",
      "source_locked_at=now()",
      "tlc='changed'",
      "source_location_id=NULL,source_reference_kind='web_url',source_reference_value='https://example.test',source_reference_location_id='" +
        location +
        "'",
    ])
      await expect(
        fixture.pool.query(`UPDATE traceability_lots SET ${mutation} WHERE id=$1`, [lot]),
      ).rejects.toMatchObject({ code: "23514", constraint: "traceability_lots_source_locked" });
    await fixture.pool.query(
      "UPDATE traceability_lots SET status='recalled',revision=revision+1 WHERE id=$1",
      [lot],
    );
    expect(
      (
        await fixture.pool.query(
          "SELECT status,source_locked_at FROM traceability_lots WHERE id=$1",
          [lot],
        )
      ).rows,
    ).toEqual([{ status: "recalled", source_locked_at: new Date("2026-09-06T00:00:00Z") }]);
  });
  it("rejects empty source correction reasons at storage", async () => {
    await expect(
      fixture.pool.query("UPDATE traceability_lots SET last_source_reason=' ' WHERE id=$1", [lot]),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
