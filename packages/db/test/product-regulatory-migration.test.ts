import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { copyMigrationsThroughIndex } from "./support/legacy-migrations.js";

const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

describe.skipIf(!databaseUrl)("product regulatory migration", () => {
  const databaseName = `markiro_product_regulatory_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenancePool = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: scratchUrl.toString() });
  let temporaryRoot = "";
  let created = false;

  const tenantId = "product-regulatory-migration";
  const validProductId = "00000000-0000-4000-8000-000000010301";
  const invalidProductId = "00000000-0000-4000-8000-000000010302";
  const validCode = "1234567890123456789";
  const invalidCode = "legacy-invalid-code";

  beforeAll(async () => {
    await maintenancePool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-product-regulatory-"));
    const migrationsThrough0102 = join(temporaryRoot, "migrations");
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: migrationsThrough0102,
      lastIncludedIndex: 102,
    });
    await migrate(drizzle(pool), { migrationsFolder: migrationsThrough0102 });

    await pool.query(
      `INSERT INTO organization (id, name, slug, created_at)
       VALUES ('${tenantId}', 'Product regulatory migration', '${tenantId}', now())`,
    );
    await pool.query(
      `INSERT INTO products
         (id, tenant_id, gtin14, name, chz_product_group_code, egais_code)
       VALUES
         ('${validProductId}', '${tenantId}', '00000000010301', 'Valid AP product', 15,
          '${validCode}'),
         ('${invalidProductId}', '${tenantId}', '00000000010302', 'Invalid AP product', 15,
          '${invalidCode}')`,
    );

    await migrate(drizzle(pool), { migrationsFolder });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (created) await maintenancePool.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`);
    await maintenancePool.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("backfills only the valid legacy AP code as primary migration data", async () => {
    const rows = await pool.query(
      `SELECT product_id, code, is_primary, source
       FROM product_egais_codes
       ORDER BY product_id`,
    );
    expect(rows.rows).toEqual([
      {
        product_id: validProductId,
        code: validCode,
        is_primary: true,
        source: "migration",
      },
    ]);
  });

  it("retains both valid and invalid compatibility values on products", async () => {
    const rows = await pool.query(
      `SELECT id, egais_code FROM products
       WHERE id IN ('${validProductId}', '${invalidProductId}')
       ORDER BY id`,
    );
    expect(rows.rows).toEqual([
      { id: validProductId, egais_code: validCode },
      { id: invalidProductId, egais_code: invalidCode },
    ]);
  });

  it("installs the composite tenant/product foreign keys", async () => {
    const rows = await pool.query<{ constraint_name: string }>(
      `SELECT constraint_name
       FROM information_schema.table_constraints
       WHERE constraint_type = 'FOREIGN KEY'
         AND constraint_name IN (
           'product_regulatory_profiles_tenant_product_fk',
           'product_regulatory_attribute_values_tenant_product_fk',
           'product_egais_codes_tenant_product_fk',
           'national_catalog_card_snapshots_tenant_product_fk',
           'product_regulatory_proposals_tenant_product_fk'
         )
       ORDER BY constraint_name`,
    );
    expect(rows.rows.map((row) => row.constraint_name)).toEqual([
      "national_catalog_card_snapshots_tenant_product_fk",
      "product_egais_codes_tenant_product_fk",
      "product_regulatory_attribute_values_tenant_product_fk",
      "product_regulatory_profiles_tenant_product_fk",
      "product_regulatory_proposals_tenant_product_fk",
    ]);
  });
});

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
