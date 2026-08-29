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

/**
 * Runtime coverage for 0099: the metadata test (chz-product-groups.test.ts)
 * only proves the Drizzle schema objects look right, which cannot catch a
 * failed seed, a dropped-then-forgotten legacy column, a missing FK, or a
 * wrong draft-status backfill. This applies the real migration chain against
 * a scratch database and asserts on the actual rows.
 */
describe.skipIf(!databaseUrl)("chz product groups migration", () => {
  const databaseName = `markiro_chz_groups_migration_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenancePool = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: scratchUrl.toString() });
  let temporaryRoot = "";
  let created = false;

  const tenantId = "chz-groups-migration";
  const staleActiveProductId = "00000000-0000-4000-8000-000000009901";

  beforeAll(async () => {
    await maintenancePool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-chz-groups-migration-"));
    const migrationsThrough0098 = join(temporaryRoot, "migrations");
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: migrationsThrough0098,
      lastIncludedIndex: 98,
    });
    await migrate(drizzle(pool), { migrationsFolder: migrationsThrough0098 });

    await pool.query(
      `INSERT INTO organization (id, name, slug, created_at)
       VALUES ('${tenantId}', 'ChZ groups migration', '${tenantId}', now())`,
    );
    // A pre-existing row that was active under the old free-text group and
    // has both capacities set -- the exact shape the new "active requires
    // a dictionary code" rule can no longer keep active once the free-text
    // column is gone and no code has taken its place.
    await pool.query(
      `INSERT INTO products
         (id, tenant_id, gtin14, name, product_group, box_capacity, pallet_capacity, status)
       VALUES
         ('${staleActiveProductId}', '${tenantId}', '00000000000001', 'Stale active product',
          'Молочная продукция', 10, 5, 'active')`,
    );

    await migrate(drizzle(pool), { migrationsFolder });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (created) await maintenancePool.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`);
    await maintenancePool.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("seeds the full 51-row dictionary with the known anchors", async () => {
    const count = await pool.query(`SELECT count(*)::int AS count FROM chz_product_groups`);
    expect(count.rows).toEqual([{ count: 51 }]);

    const anchors = await pool.query(
      `SELECT code, alias, name FROM chz_product_groups WHERE code IN (8, 13, 15) ORDER BY code`,
    );
    expect(anchors.rows).toEqual([
      { code: 8, alias: "milk", name: "Молочная продукция" },
      { code: 13, alias: "water", name: "Упакованная вода" },
      {
        code: 15,
        alias: "beer",
        name: "Пиво, напитки, изготавливаемые на основе пива, слабоалкогольные напитки",
      },
    ]);
  });

  it("replaces the free-text product_group column with chz_product_group_code", async () => {
    const columns = await pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'products' AND column_name IN ('product_group', 'chz_product_group_code')`,
    );
    expect(columns.rows.map((row) => row.column_name).sort()).toEqual(["chz_product_group_code"]);
  });

  it("rejects a product group code that is not in the dictionary", async () => {
    await expect(
      pool.query(
        `INSERT INTO products (tenant_id, gtin14, name, chz_product_group_code)
         VALUES ('${tenantId}', '00000000000002', 'Bad group product', 9999)`,
      ),
    ).rejects.toThrow(/chz_product_group_code_chz_product_groups_code_fk/);
  });

  it("backfills a stale active product with no dictionary code to draft", async () => {
    const rows = await pool.query(
      `SELECT status, chz_product_group_code FROM products WHERE id = '${staleActiveProductId}'`,
    );
    expect(rows.rows).toEqual([{ status: "draft", chz_product_group_code: null }]);
  });
});

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
