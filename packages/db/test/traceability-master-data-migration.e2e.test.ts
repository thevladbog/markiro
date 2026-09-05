import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createUsProfileTestDatabase } from "./support/us-profile-database.js";

const url = process.env.US_TEST_DATABASE_URL;

describe.skipIf(!url)("US traceability master-data additive migration", () => {
  let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let ruColumnsBefore: unknown[];
  let ruRowsBefore: unknown[];

  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated test database");
    fixture = await createUsProfileTestDatabase(url, 114);
    await fixture.pool.query(
      `INSERT INTO organization (id, name, slug, created_at) VALUES ('tenant-a', 'Synthetic A', 'tenant-a', now()), ('tenant-b', 'Synthetic B', 'tenant-b', now())`,
    );
    await fixture.pool.query(
      `INSERT INTO counterparties (id, tenant_id, name, gln) VALUES ('00000000-0000-4000-8000-000000000001', 'tenant-a', 'Legacy RU counterparty', '4600000000000')`,
    );
    ruColumnsBefore = (
      await fixture.pool.query(
        `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'counterparties'
         ORDER BY ordinal_position`,
      )
    ).rows;
    ruRowsBefore = (
      await fixture.pool.query(
        `SELECT id, tenant_id, name, gln, inn, gs1_prefixes, created_at
         FROM counterparties
         ORDER BY id`,
      )
    ).rows;

    await fixture.pool.query(readFileSync("migrations/0115_traceability_master_data.sql", "utf8"));
  }, 60000);

  afterAll(async () => {
    await fixture?.close();
  });

  it("adds empty US relations without altering or backfilling RU counterparties", async () => {
    const ruColumnsAfter = (
      await fixture.pool.query(
        `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'counterparties'
         ORDER BY ordinal_position`,
      )
    ).rows;
    const ruRowsAfter = (
      await fixture.pool.query(
        `SELECT id, tenant_id, name, gln, inn, gs1_prefixes, created_at
         FROM counterparties
         ORDER BY id`,
      )
    ).rows;
    expect(ruColumnsAfter).toEqual(ruColumnsBefore);
    expect(ruRowsAfter).toEqual(ruRowsBefore);
    expect(
      (
        await fixture.pool.query(
          `SELECT
             (SELECT count(*)::int FROM traceability_parties) AS parties,
             (SELECT count(*)::int FROM traceability_locations) AS locations`,
        )
      ).rows,
    ).toEqual([{ parties: 0, locations: 0 }]);
  });

  it("enforces tenant-scoped party identity and archive-safe active names", async () => {
    const first = await fixture.pool.query<{ id: string }>(
      `INSERT INTO traceability_parties (tenant_id, name)
       VALUES ('tenant-a', 'Acme Foods') RETURNING id`,
    );
    const firstId = first.rows[0]?.id;
    expect(firstId).toMatch(/^[0-9a-f-]{36}$/);

    await expect(
      fixture.pool.query(
        `INSERT INTO traceability_parties (tenant_id, name)
         VALUES ('tenant-a', 'aCmE fOoDs')`,
      ),
    ).rejects.toMatchObject({ code: "23505" });

    const archived = await fixture.pool.query<{ id: string }>(
      `INSERT INTO traceability_parties (tenant_id, name, archived)
       VALUES ('tenant-a', 'ACME FOODS', true) RETURNING id`,
    );
    await expect(
      fixture.pool.query(`UPDATE traceability_parties SET archived = false WHERE id = $1`, [
        archived.rows[0]?.id,
      ]),
    ).rejects.toMatchObject({ code: "23505" });

    await fixture.pool.query(
      `INSERT INTO traceability_parties (tenant_id, name)
       VALUES ('tenant-b', 'Acme Foods')`,
    );
    await expect(
      fixture.pool.query(
        `INSERT INTO traceability_locations (tenant_id, party_id, name, business_name)
         VALUES ('tenant-b', $1, 'Wrong tenant', 'Wrong tenant')`,
        [firstId],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("accepts incomplete drafts while rejecting malformed address variants", async () => {
    const party = await fixture.pool.query<{ id: string }>(
      `INSERT INTO traceability_parties (tenant_id, name)
       VALUES ('tenant-a', 'Draft owner') RETURNING id`,
    );
    const partyId = party.rows[0]?.id;

    await fixture.pool.query(
      `INSERT INTO traceability_locations (tenant_id, party_id, name, business_name)
       VALUES ('tenant-a', $1, 'Empty street draft', 'Draft business')`,
      [partyId],
    );
    const coordinateDraft = await fixture.pool.query<{
      latitude: string;
      longitude: string | null;
      roles: string[];
    }>(
      `INSERT INTO traceability_locations
         (tenant_id, party_id, name, business_name, address_kind, latitude, roles)
       VALUES
         ('tenant-a', $1, 'Partial coordinate draft', 'Coordinate business', 'coordinates', '45.123456', ARRAY['processor']::traceability_location_role[])
       RETURNING latitude, longitude, roles::text[] AS roles`,
      [partyId],
    );
    expect(coordinateDraft.rows).toEqual([
      { latitude: "45.123456", longitude: null, roles: ["processor"] },
    ]);

    const invalidStatements = [
      {
        sql: `INSERT INTO traceability_locations
                (tenant_id, party_id, name, business_name, address_kind, latitude)
              VALUES ('tenant-a', $1, 'Bad latitude', 'Business', 'coordinates', 90.000001)`,
        code: "23514",
      },
      {
        sql: `INSERT INTO traceability_locations
                (tenant_id, party_id, name, business_name, address_kind, longitude)
              VALUES ('tenant-a', $1, 'Bad longitude', 'Business', 'coordinates', -180.000001)`,
        code: "23514",
      },
      {
        sql: `INSERT INTO traceability_locations
                (tenant_id, party_id, name, business_name, address_kind, latitude)
              VALUES ('tenant-a', $1, 'Mixed street', 'Business', 'street', 10)`,
        code: "23514",
      },
      {
        sql: `INSERT INTO traceability_locations
                (tenant_id, party_id, name, business_name, address_kind, street_address)
              VALUES ('tenant-a', $1, 'Mixed coordinates', 'Business', 'coordinates', '1 Main St')`,
        code: "23514",
      },
      {
        sql: `INSERT INTO traceability_locations
                (tenant_id, party_id, name, business_name, country_code)
              VALUES ('tenant-a', $1, 'Lowercase country', 'Business', 'us')`,
        code: "23514",
      },
    ];
    for (const invalid of invalidStatements) {
      await expect(fixture.pool.query(invalid.sql, [partyId])).rejects.toMatchObject({
        code: invalid.code,
      });
    }
  });

  it("rejects blank identities and unsafe role arrays", async () => {
    const party = await fixture.pool.query<{ id: string }>(
      `INSERT INTO traceability_parties (tenant_id, name)
       VALUES ('tenant-a', 'Roles owner') RETURNING id`,
    );
    const partyId = party.rows[0]?.id;

    await expect(
      fixture.pool.query(
        `INSERT INTO traceability_parties (tenant_id, name) VALUES ('tenant-a', '   ')`,
      ),
    ).rejects.toMatchObject({ code: "23514" });
    for (const [name, businessName] of [
      ["   ", "Business"],
      ["Location", "   "],
    ]) {
      await expect(
        fixture.pool.query(
          `INSERT INTO traceability_locations (tenant_id, party_id, name, business_name)
           VALUES ('tenant-a', $1, $2, $3)`,
          [partyId, name, businessName],
        ),
      ).rejects.toMatchObject({ code: "23514" });
    }
    await expect(
      fixture.pool.query(
        `INSERT INTO traceability_locations
           (tenant_id, party_id, name, business_name, roles)
         VALUES
           ('tenant-a', $1, 'Too many roles', 'Business', ARRAY['supplier', 'processor', 'ship_from', 'receive_at', 'recipient', 'tlc_source', 'supplier']::traceability_location_role[])`,
        [partyId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      fixture.pool.query(
        `INSERT INTO traceability_locations
           (tenant_id, party_id, name, business_name, roles)
         VALUES
           ('tenant-a', $1, 'Null role', 'Business', ARRAY['supplier', NULL]::traceability_location_role[])`,
        [partyId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("retains locations when their party is archived and prevents party deletion", async () => {
    const party = await fixture.pool.query<{ id: string }>(
      `INSERT INTO traceability_parties (tenant_id, name)
       VALUES ('tenant-a', 'Archive owner') RETURNING id`,
    );
    const partyId = party.rows[0]?.id;
    await fixture.pool.query(
      `INSERT INTO traceability_locations (tenant_id, party_id, name, business_name)
       VALUES ('tenant-a', $1, 'Archive location', 'Business')`,
      [partyId],
    );
    await fixture.pool.query(`UPDATE traceability_parties SET archived = true WHERE id = $1`, [
      partyId,
    ]);
    expect(
      (
        await fixture.pool.query(
          `SELECT party.archived AS party_archived, location.archived AS location_archived
           FROM traceability_parties party
           JOIN traceability_locations location
             ON location.tenant_id = party.tenant_id AND location.party_id = party.id
           WHERE party.id = $1`,
          [partyId],
        )
      ).rows,
    ).toEqual([{ party_archived: true, location_archived: false }]);
    await expect(
      fixture.pool.query(`DELETE FROM traceability_parties WHERE id = $1`, [partyId]),
    ).rejects.toMatchObject({ code: "23503" });
  });
});
