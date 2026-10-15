import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runRuntimeMigrations } from "../src/runtime-migrate.js";
import { copyMigrationsThroughIndex } from "./support/legacy-migrations.js";

const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

// Migration 0193: the custom-branding feature (`customLogo`) of «Markiro Автоном».
describe.skipIf(!databaseUrl)("custom logo entitlement migration", () => {
  const databaseName = `markiro_custom_logo_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenance = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: scratchUrl.toString() });
  let temporaryRoot = "";
  let created = false;
  const planId = randomUUID();
  const addonId = randomUUID();

  beforeAll(async () => {
    await maintenance.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-custom-logo-migration-"));
    const before = join(temporaryRoot, "migrations");
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: before,
      lastIncludedIndex: 186,
    });
    await migrate(drizzle(pool), { migrationsFolder: before });
    for (const [id, kind] of [
      [planId, "plan"],
      [addonId, "addon"],
    ]) {
      await pool.query(
        "INSERT INTO catalog_items (id,code,kind,name_ru,name_en) VALUES ($1::uuid,$1::text,$2,'Тест','Test')",
        [id, kind],
      );
      await pool.query(
        "INSERT INTO catalog_item_versions (id,catalog_item_id,kind,version,name_ru,name_en,unit,billing_mode,billing_period,unit_price,vat_included) VALUES ($1,$1,$2,1,'Тест','Test','month','recurring','month','12.34',false)",
        [id, kind],
      );
    }
    await pool.query(
      "INSERT INTO plan_entitlements (catalog_version_id,max_lines,label_editor_enabled,handheld_enabled) VALUES ($1,1,true,true)",
      [planId],
    );
    const applied = await runRuntimeMigrations({
      databaseUrl: scratchUrl.toString(),
      migrationsFolder,
      log: () => undefined,
    });
    expect(applied.packaged).toContain("0193_custom_logo_entitlement");
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (created) await maintenance.query(`DROP DATABASE "${databaseName}"`);
    await maintenance.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("leaves an existing plan unmapped (null), so a file issued from it carries the feature off", async () => {
    const row = (
      await pool.query(
        "SELECT custom_logo_enabled, handheld_enabled, label_editor_enabled FROM plan_entitlements WHERE catalog_version_id=$1",
        [planId],
      )
    ).rows[0];
    expect(row).toEqual({
      custom_logo_enabled: null,
      handheld_enabled: true,
      label_editor_enabled: true,
    });
  });

  it("grants the feature in a plan and as an add-on, and rejects a quota-shaped add-on", async () => {
    await pool.query(
      "UPDATE plan_entitlements SET custom_logo_enabled = true WHERE catalog_version_id=$1",
      [planId],
    );
    await pool.query(
      "INSERT INTO addon_entitlements (catalog_version_id,entitlement_key,feature_enabled) VALUES ($1,'customLogo',true)",
      [addonId],
    );
    await expect(
      pool.query(
        "INSERT INTO addon_entitlements (catalog_version_id,entitlement_key,quota_increment,feature_enabled) VALUES ($1,'customLogo',2,false)",
        [addonId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
