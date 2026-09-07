import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createUsProfileTestDatabase } from "./support/us-profile-database.js";

const url = process.env.US_TEST_DATABASE_URL;
type Fixture = Awaited<ReturnType<typeof createUsProfileTestDatabase>>;

function legacyIndex() {
  const journal: unknown = JSON.parse(readFileSync("migrations/meta/_journal.json", "utf8"));
  if (!journal || typeof journal !== "object" || !("entries" in journal))
    throw new Error("Missing migration journal");
  if (!Array.isArray(journal.entries)) throw new Error("Missing migration entries");
  const entries: unknown[] = journal.entries;
  for (const entry of entries) {
    if (
      entry &&
      typeof entry === "object" &&
      "tag" in entry &&
      entry.tag === "0123_us_receiving_exemption" &&
      "idx" in entry &&
      typeof entry.idx === "number"
    )
      return entry.idx;
  }
  throw new Error("Missing pre-lifecycle migration");
}

describe.skipIf(!url)("additive receiving basis version migration", () => {
  let fixture: Fixture;
  let lot: string;
  let before: { exact: string }[];
  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated database");
    fixture = await createUsProfileTestDatabase(url, legacyIndex());
    const tenant = randomUUID(),
      product = randomUUID(),
      party = randomUUID(),
      location = randomUUID();
    await fixture.pool.query(
      "INSERT INTO organization(id,name,slug,created_at) VALUES ($1,'Synthetic',$1,now())",
      [tenant],
    );
    await fixture.pool.query("INSERT INTO products(id,tenant_id,name) VALUES ($1,$2,'Synthetic')", [
      product,
      tenant,
    ]);
    await fixture.pool.query(
      "INSERT INTO traceability_parties(id,tenant_id,name) VALUES ($1,$2,'Synthetic')",
      [party, tenant],
    );
    await fixture.pool.query(
      "INSERT INTO traceability_locations(id,tenant_id,party_id,name,business_name) VALUES ($1,$2,$3,'Dock','Synthetic')",
      [location, tenant, party],
    );
    for (const [index, status] of [
      "active",
      "consumed",
      "shipped",
      "quarantined",
      "recalled",
      "archived",
    ].entries()) {
      lot = randomUUID();
      await fixture.pool.query(
        `INSERT INTO traceability_lots(id,tenant_id,product_id,tlc,assignment_basis,status,revision,
          source_location_id,source_locked_at,last_status_reason,last_source_reason,
          created_by,updated_by,created_at,updated_at)
         VALUES ($1,$2,$3,$4,'imported',$5,7,$6,$7,'  exact status  ','  exact source  ',
          'original-actor','historical-actor','2026-09-01T12:00:00.000Z','2026-09-07T10:00:00.000Z')`,
        [
          lot,
          tenant,
          product,
          `=Case/Ä-${index}`,
          status,
          location,
          index % 2 ? "2026-09-07T10:00:00.000Z" : null,
        ],
      );
    }
    before = (
      await fixture.pool.query<{ exact: string }>(
        "SELECT to_jsonb(l)::text AS exact FROM traceability_lots l ORDER BY id",
      )
    ).rows;
    await migrate(fixture.db, { migrationsFolder: resolve("migrations") });
  }, 60_000);
  afterAll(async () => {
    await fixture?.close();
  });

  it("initializes every old lot to one without rewriting any existing field", async () => {
    expect(
      (
        await fixture.pool.query(
          "SELECT (to_jsonb(l)-'receiving_basis_version')::text AS exact FROM traceability_lots l ORDER BY id",
        )
      ).rows,
    ).toEqual(before);
    // to_jsonb makes the RED an absent-field assertion, not an invalid SQL query.
    expect(
      (
        await fixture.pool.query(
          "SELECT to_jsonb(l)->'receiving_basis_version' AS version FROM traceability_lots l ORDER BY id",
        )
      ).rows,
    ).toEqual(Array.from({ length: 6 }, () => ({ version: 1 })));
  });

  it.each([0, -1, null])("rejects an invalid internal version %s", async (version) => {
    await expect(
      fixture.pool.query("UPDATE traceability_lots SET receiving_basis_version=$1 WHERE id=$2", [
        version,
        lot,
      ]),
    ).rejects.toMatchObject({ code: version === null ? "23502" : "23514" });
  });
});
