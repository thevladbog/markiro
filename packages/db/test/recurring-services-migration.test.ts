import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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
function readMigration(name: string) {
  return readFileSync(join(migrationsFolder, name), "utf8");
}

describe("recurring service migrations", () => {
  it("adds overlap protection and defers the populated catalog check", () => {
    const migration = readMigration("0157_recurring_services.sql");
    expect(migration).toContain('CREATE EXTENSION IF NOT EXISTS "btree_gist"');
    expect(migration).toContain(
      'EXCLUDE USING gist ("tenant_id" WITH =, "catalog_item_id" WITH =, tstzrange("starts_at", "ends_at", \'[)\') WITH &&)',
    );
    expect(migration).toContain('ADD CONSTRAINT "catalog_item_versions_kind_billing_check" CHECK');
    expect(migration).toContain("NOT VALID");
  });

  it("validates the widened catalog constraint only after the additive migration", () => {
    expect(readMigration("0158_validate_recurring_services.sql")).toContain(
      'VALIDATE CONSTRAINT "catalog_item_versions_kind_billing_check"',
    );
  });

  it("widens commercial snapshots without validating populated tables in the same migration", () => {
    const migration = readMigration("0159_recurring_commercial_terms.sql");
    expect(migration).toContain("\"commercial_terms\"->'version' = '2'::jsonb");
    expect(migration.match(/NOT VALID/g)).toHaveLength(2);
    const validation = readMigration("0160_validate_recurring_commercial_terms.sql");
    expect(validation).toContain(
      'VALIDATE CONSTRAINT "commercial_offer_lines_commercial_terms_check"',
    );
    expect(validation).toContain('VALIDATE CONSTRAINT "invoice_lines_commercial_terms_check"');
  });
});

describe.skipIf(!databaseUrl)("recurring service forward migration", () => {
  const databaseName = `markiro_recurring_services_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenancePool = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: scratchUrl.toString() });
  const itemId = randomUUID();
  const versionId = randomUUID();
  let created = false;
  let temporaryRoot = "";
  let historicalRow: unknown;

  beforeAll(async () => {
    await maintenancePool.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-recurring-services-"));
    const legacyMigrations = join(temporaryRoot, "legacy");
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: legacyMigrations,
      lastIncludedIndex: 156,
    });
    await migrate(drizzle(pool), { migrationsFolder: legacyMigrations });
    await pool.query(
      "INSERT INTO catalog_items (id,code,kind,name_ru,name_en) VALUES ($1,'legacy-service','service','Разовая услуга','One-time service')",
      [itemId],
    );
    await pool.query(
      "INSERT INTO catalog_item_versions (id,catalog_item_id,kind,version,name_ru,name_en,unit,billing_mode,billing_period,unit_price,vat_included) VALUES ($1,$2,'service',1,'Разовая услуга','One-time service','service','one_time',null,'1000',false)",
      [versionId, itemId],
    );
    historicalRow = (
      await pool.query("SELECT to_jsonb(v) AS row FROM catalog_item_versions v WHERE id=$1", [
        versionId,
      ])
    ).rows[0]?.row;
    await migrate(drizzle(pool), { migrationsFolder });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (created) await maintenancePool.query(`DROP DATABASE "${databaseName}"`);
    await maintenancePool.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("preserves historical one-time services and adds empty ledgers", async () => {
    const migrated = await pool.query(
      "SELECT to_jsonb(v) - 'service_terms' AS row, service_terms FROM catalog_item_versions v WHERE id=$1",
      [versionId],
    );
    expect(migrated.rows[0]?.row).toEqual(historicalRow);
    expect(migrated.rows[0]?.service_terms).toBeNull();
    for (const table of ["service_periods", "service_usage_entries", "service_excess_approvals"]) {
      expect((await pool.query(`SELECT * FROM ${table}`)).rows).toEqual([]);
    }
  });

  it("accepts a monthly service policy and rejects unsupported recurring periods", async () => {
    const recurringItemId = randomUUID();
    await pool.query(
      "INSERT INTO catalog_items (id,code,kind,name_ru,name_en) VALUES ($1,'monthly-service','service','Поддержка','Support')",
      [recurringItemId],
    );
    const terms = {
      cadence: "month",
      includedMinutes: 120,
      carryover: "none",
      excessPolicy: "external_approval",
      scopeRu: "Поддержка",
      scopeEn: "Support",
      operatingHoursRu: null,
      operatingHoursEn: null,
      schedulingTermsRu: null,
      schedulingTermsEn: null,
    };
    await expect(
      pool.query(
        "INSERT INTO catalog_item_versions (catalog_item_id,kind,version,name_ru,name_en,unit,billing_mode,billing_period,service_terms,unit_price,vat_included) VALUES ($1,'service',1,'Поддержка','Support','month','recurring','month',$2,'2000',false)",
        [recurringItemId, terms],
      ),
    ).resolves.toBeDefined();
    await expect(
      pool.query(
        "INSERT INTO catalog_item_versions (catalog_item_id,kind,version,name_ru,name_en,unit,billing_mode,billing_period,service_terms,unit_price,vat_included) VALUES ($1,'service',2,'Поддержка','Support','year','recurring','year',$2,'20000',false)",
        [recurringItemId, terms],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("installs the tenant/catalog overlap exclusion", async () => {
    const result = await pool.query<{ definition: string }>(
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname='service_periods_no_overlap'",
    );
    expect(result.rows[0]?.definition).toContain("EXCLUDE USING gist");
    expect(result.rows[0]?.definition).toContain(
      "tstzrange(starts_at, ends_at, '[)'::text) WITH &&",
    );
  });
});
