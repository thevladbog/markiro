import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createUsProfileTestDatabase } from "./support/us-profile-database.js";

const url = process.env.US_TEST_DATABASE_URL;
const LEGACY_PRODUCT_ID = "00000000-0000-4000-8000-000000000101";
const CURRENT_PRODUCT_ID = "00000000-0000-4000-8000-000000000102";
const COUNTERPARTY_ID = "00000000-0000-4000-8000-000000000103";
const LABEL_TEMPLATE_ID = "00000000-0000-4000-8000-000000000104";

describe.skipIf(!url)("US catalog migration on isolated PostgreSQL", () => {
  let fixture: Awaited<ReturnType<typeof createUsProfileTestDatabase>>;
  let legacyBefore: Record<string, unknown>;
  let migrationStartedAt: Date;

  beforeAll(async () => {
    if (!url) throw new Error("Missing isolated test database");
    fixture = await createUsProfileTestDatabase(url, 115);
    await fixture.pool.query(
      `INSERT INTO organization (id, name, slug, created_at)
       VALUES ('tenant-a', 'Synthetic A', 'synthetic-a', '2026-01-02T03:04:05Z'),
              ('tenant-b', 'Synthetic B', 'synthetic-b', '2026-01-03T03:04:05Z')`,
    );
    await fixture.pool.query(
      `INSERT INTO counterparties (id, tenant_id, name, gln, inn, gs1_prefixes, notes, created_at)
       VALUES ($1, 'tenant-a', 'Legacy counterparty', '4600000000000', '7700000000',
               ARRAY['4600000'], 'Legacy note', '2026-01-04T03:04:05Z')`,
      [COUNTERPARTY_ID],
    );
    await fixture.pool.query(
      `INSERT INTO label_templates (id, tenant_id, name, spec, created_at, updated_at, enabled,
                                    chz_product_group_codes)
       VALUES ($1, 'tenant-a', 'Legacy label', '{"version":1}'::jsonb,
               '2026-01-05T03:04:05Z', '2026-01-06T03:04:05Z', true, ARRAY[8])`,
      [LABEL_TEMPLATE_ID],
    );
    await fixture.pool.query(
      `INSERT INTO products
         (id, tenant_id, gtin14, name, print_name, chz_product_group_code, box_capacity,
          pallet_capacity, status, archived, default_counterparty_id, default_label_template_id,
          unit_price, egais_code, shelf_life_days, external_ref, created_at)
       VALUES
         ($1, 'tenant-a', '04600682000013', 'Legacy RU product', 'Legacy', 8, 12,
          720, 'active', false, $2, $3, '42.50', 'legacy-egais', 45,
          'legacy-ref', '2026-02-03T04:05:06Z')`,
      [LEGACY_PRODUCT_ID, COUNTERPARTY_ID, LABEL_TEMPLATE_ID],
    );
    const before = await fixture.pool.query("SELECT * FROM products WHERE id = $1", [
      LEGACY_PRODUCT_ID,
    ]);
    legacyBefore = before.rows[0] as Record<string, unknown>;
    migrationStartedAt = new Date();
    await fixture.pool.query(readFileSync("migrations/0116_us_catalog_gtin.sql", "utf8"));
  }, 60_000);

  afterAll(async () => {
    await fixture?.close();
  });

  it("preserves every legacy RU product value and stamps the new update clock", async () => {
    const result = await fixture.pool.query("SELECT * FROM products WHERE id = $1", [
      LEGACY_PRODUCT_ID,
    ]);
    const row = result.rows[0] as Record<string, unknown>;
    const { updated_at: updatedAt, ...legacyAfter } = row;

    expect(legacyAfter).toEqual(legacyBefore);
    expect(updatedAt).toBeInstanceOf(Date);
    expect((updatedAt as Date).getTime()).toBeGreaterThanOrEqual(migrationStartedAt.getTime());
  });

  it("allows multiple active null GTINs without weakening non-null active uniqueness", async () => {
    await fixture.pool.query(
      `INSERT INTO products (tenant_id, gtin14, name, status)
       VALUES ('tenant-a', null, 'US product one', 'active'),
              ('tenant-a', null, 'US product two', 'active')`,
    );
    await fixture.pool.query(
      `INSERT INTO products (id, tenant_id, gtin14, name, status)
       VALUES ($1, 'tenant-a', '04680089900253', 'Current product', 'active')`,
      [CURRENT_PRODUCT_ID],
    );

    await expect(
      fixture.pool.query(
        `INSERT INTO products (tenant_id, gtin14, name, status)
         VALUES ('tenant-a', '04680089900253', 'Duplicate current product', 'active')`,
      ),
    ).rejects.toMatchObject({ code: "23505" });

    const nullRows = await fixture.pool.query(
      "SELECT count(*)::int AS count FROM products WHERE tenant_id = 'tenant-a' AND gtin14 IS NULL",
    );
    expect(nullRows.rows).toEqual([{ count: 2 }]);
  });

  it("retains archived reuse, conflicting restore rejection, and cross-tenant reuse", async () => {
    const archived = await fixture.pool.query(
      `INSERT INTO products (tenant_id, gtin14, name, status, archived)
       VALUES ('tenant-a', '04600511789539', 'Retired', 'active', true)
       RETURNING id`,
    );
    await fixture.pool.query(
      `INSERT INTO products (tenant_id, gtin14, name, status)
       VALUES ('tenant-a', '04600511789539', 'Replacement', 'active'),
              ('tenant-b', '04600511789539', 'Other tenant product', 'active')`,
    );

    await expect(
      fixture.pool.query("UPDATE products SET archived = false WHERE id = $1", [
        archived.rows[0]?.id,
      ]),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("keeps product ownership and shift product references tenant-composite", async () => {
    await expect(
      fixture.pool.query(
        `INSERT INTO products (tenant_id, gtin14, name, default_counterparty_id)
         VALUES ('tenant-b', null, 'Cross-tenant counterparty product', $1)`,
        [COUNTERPARTY_ID],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      fixture.pool.query(
        `INSERT INTO shifts (tenant_id, product_id, mode, number_month_key, number_seq)
         VALUES ('tenant-b', $1, 'validation', 'SEP26', 1)`,
        [CURRENT_PRODUCT_ID],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
});
