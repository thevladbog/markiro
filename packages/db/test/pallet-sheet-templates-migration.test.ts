import { randomUUID } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyMigrationsThroughIndex } from "./support/legacy-migrations.js";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPalletSheetPresets } from "@markiro/domain";
const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
describe.skipIf(!databaseUrl)("pallet sheet migration", () => {
  const name = `markiro_pallet_sheets_${randomUUID().replaceAll("-", "_")}`;
  const url = new URL(databaseUrl ?? "postgres://invalid");
  url.pathname = `/${name}`;
  url.search = "";
  const maintenance = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: url.toString() });
  let created = false;
  let seedSql: string;
  let historicalFolder: string;
  beforeAll(async () => {
    await maintenance.query(`CREATE DATABASE "${name}"`);
    created = true;
    historicalFolder = await mkdtemp(join(tmpdir(), "pallet-sheet-migrations-"));
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: historicalFolder,
      lastIncludedIndex: 182,
    });
    await migrate(drizzle(pool), { migrationsFolder: historicalFolder });
    await pool.query(
      "INSERT INTO organization(id,name,slug,created_at) VALUES('historical','Historical','historical',now())",
    );
    await pool.query(
      "INSERT INTO label_templates(tenant_id,name,purpose,spec) VALUES('historical','Historical','pallet','{\"preserved\":true}'::jsonb)",
    );
    await migrate(drizzle(pool), { migrationsFolder });
    expect(
      (
        await pool.query(
          "SELECT spec,format,revision FROM label_templates WHERE tenant_id='historical' AND seed_key IS NULL",
        )
      ).rows,
    ).toEqual([{ spec: { preserved: true }, format: "label_v1", revision: 1 }]);
    const sql = await readFile(
      new URL("../migrations/0183_chunky_valkyrie.sql", import.meta.url),
      "utf8",
    );
    seedSql = sql.slice(sql.indexOf("INSERT INTO label_templates(tenant_id"));
  }, 120_000);
  afterAll(async () => {
    await pool.end();
    if (created) await maintenance.query(`DROP DATABASE "${name}"`);
    await maintenance.end();
    if (historicalFolder) await rm(historicalFolder, { recursive: true, force: true });
  });
  it("rejects incomplete or string-valued V2 discriminators at the database boundary", async () => {
    for (const spec of [
      {},
      { schemaVersion: 2 },
      { kind: "pallet_sheet" },
      { schemaVersion: "2", kind: "pallet_sheet" },
    ]) {
      await expect(
        pool.query(
          "INSERT INTO label_templates(tenant_id,name,purpose,format,spec) VALUES('historical','Invalid','pallet','pallet_sheet_v2',$1)",
          [spec],
        ),
      ).rejects.toMatchObject({ code: "23514", constraint: "label_templates_sheet_purpose_check" });
    }
  });
  it("seeds once and preserves edited presets, legacy specs and defaults", async () => {
    await pool.query(
      "INSERT INTO organization(id,name,slug,created_at) VALUES('sheet-a','A','sheet-a',now()),('sheet-b','B','sheet-b',now())",
    );
    const legacyId = randomUUID(),
      legacy = { historical: "unchanged", language: "tspl" };
    await pool.query(
      "INSERT INTO label_templates(id,tenant_id,name,purpose,spec) VALUES($1,'sheet-a','Legacy','pallet',$2)",
      [legacyId, legacy],
    );
    await pool.query(
      "INSERT INTO org_profiles(tenant_id,default_pallet_label_template_id) VALUES('sheet-a',$1)",
      [legacyId],
    );
    await pool.query(seedSql);
    const presets = await pool.query(
      "SELECT seed_key,name,spec,format,revision FROM label_templates WHERE tenant_id='sheet-a' AND seed_key IS NOT NULL ORDER BY seed_key",
    );
    expect(presets.rows).toEqual(
      buildPalletSheetPresets()
        .map((p) => ({
          seed_key: p.key,
          name: p.name,
          spec: p.spec,
          format: "pallet_sheet_v2",
          revision: 1,
        }))
        .sort((a, b) => a.seed_key.localeCompare(b.seed_key)),
    );
    await pool.query(
      "UPDATE label_templates SET name='Custom',enabled=false,revision=2 WHERE tenant_id='sheet-a' AND seed_key='pallet-a4-portrait'",
    );
    await pool.query(seedSql);
    expect(
      (
        await pool.query(
          "SELECT name,enabled,revision FROM label_templates WHERE tenant_id='sheet-a' AND seed_key='pallet-a4-portrait'",
        )
      ).rows,
    ).toEqual([{ name: "Custom", enabled: false, revision: 2 }]);
    expect(
      (await pool.query("SELECT spec,format,revision FROM label_templates WHERE id=$1", [legacyId]))
        .rows,
    ).toEqual([{ spec: legacy, format: "label_v1", revision: 1 }]);
    expect(
      (
        await pool.query(
          "SELECT default_pallet_label_template_id,default_pallet_sheet_template_id FROM org_profiles WHERE tenant_id='sheet-a'",
        )
      ).rows,
    ).toEqual([
      { default_pallet_label_template_id: legacyId, default_pallet_sheet_template_id: null },
    ]);
  });
  it("rejects cross-tenant profile, category and shift sheet references", async () => {
    const result = await pool.query<{ id: string }>(
      "SELECT id FROM label_templates WHERE tenant_id='sheet-b' AND format='pallet_sheet_v2' LIMIT 1",
    );
    const id = result.rows[0]?.id;
    expect(id).toBeTruthy();
    await expect(
      pool.query(
        "UPDATE org_profiles SET default_pallet_sheet_template_id=$1 WHERE tenant_id='sheet-a'",
        [id],
      ),
    ).rejects.toMatchObject({
      code: "23503",
      constraint: "org_profiles_pallet_sheet_template_tenant_fk",
    });
    await expect(
      pool.query(
        "INSERT INTO org_pallet_sheet_template_defaults(tenant_id,chz_product_group_code,template_id) VALUES('sheet-a',15,$1)",
        [id],
      ),
    ).rejects.toMatchObject({
      code: "23503",
      constraint: "org_pallet_sheet_template_defaults_template_tenant_fk",
    });
    const productId = randomUUID();
    await pool.query(
      "INSERT INTO products(id,tenant_id,gtin14,name) VALUES($1,'sheet-a','04601234567893','Product')",
      [productId],
    );
    await expect(
      pool.query(
        "INSERT INTO shifts(id,tenant_id,product_id,mode,number_month_key,number_seq,pallet_sheet_template_id) VALUES($1,'sheet-a',$2,'aggregation','OCT26',1,$3)",
        [randomUUID(), productId, id],
      ),
    ).rejects.toMatchObject({
      code: "23503",
      constraint: "shifts_tenant_pallet_sheet_template_fk",
    });
  });
});
