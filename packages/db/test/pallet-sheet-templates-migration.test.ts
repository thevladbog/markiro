import { buildPalletSheetPresets } from "@markiro/domain";
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
          "SELECT spec,format,revision FROM label_templates WHERE tenant_id='historical' AND name='Historical' AND seed_key IS NULL",
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
    const presets = await pool.query<{ seed_key: string; spec: Record<string, unknown> }>(
      "SELECT seed_key,name,spec,format,revision FROM label_templates WHERE tenant_id='sheet-a' AND seed_key IS NOT NULL ORDER BY seed_key",
    );
    // Migration 0183 is immutable; current presets may evolve for new organizations.
    const historicalPresets: unknown = JSON.parse(
      await readFile(
        new URL("./support/pallet-sheet-migration-0183-presets.json", import.meta.url),
        "utf8",
      ),
    );
    expect(presets.rows).toEqual(historicalPresets);
    const portrait = presets.rows.find((p) => p.seed_key === "pallet-a4-portrait");
    if (!portrait) throw new Error("Historical portrait preset is missing");
    const editedSpec = {
      ...portrait.spec,
      custom: "preserve saved edits",
    };
    await pool.query(
      "UPDATE label_templates SET name='Custom',enabled=false,revision=2,spec=$1 WHERE tenant_id='sheet-a' AND seed_key='pallet-a4-portrait'",
      [editedSpec],
    );
    await pool.query(seedSql);
    expect(
      (
        await pool.query(
          "SELECT name,enabled,revision,spec FROM label_templates WHERE tenant_id='sheet-a' AND seed_key='pallet-a4-portrait'",
        )
      ).rows,
    ).toEqual([{ name: "Custom", enabled: false, revision: 2, spec: editedSpec }]);
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
  it("refreshes only untouched presets and provides separate standards for edited or disabled originals", async () => {
    const refresh = await readFile(
      new URL("../migrations/0191_pallet_sheet_preset_refresh.sql", import.meta.url),
      "utf8",
    );
    await pool.query(
      "INSERT INTO organization(id,name,slug,created_at) VALUES('refresh','Refresh','refresh',now())",
    );
    await pool.query(seedSql);
    const originals = await pool.query<{ id: string; seed_key: string; spec: unknown }>(
      "SELECT id,seed_key,spec FROM label_templates WHERE tenant_id='refresh'",
    );
    const portrait = originals.rows.find((r) => r.seed_key === "pallet-a4-portrait");
    if (!portrait) throw new Error("Missing portrait");
    await pool.query(
      "UPDATE label_templates SET name='My landscape',spec=jsonb_set(spec,'{custom}', 'true'::jsonb),revision=2 WHERE tenant_id='refresh' AND seed_key='pallet-a4-landscape'",
    );
    await pool.query(
      "UPDATE label_templates SET enabled=false WHERE tenant_id='refresh' AND seed_key='pallet-a4-two-a5'",
    );
    const preserved = await pool.query(
      "SELECT id,name,spec,enabled,revision FROM label_templates WHERE tenant_id='refresh' AND seed_key<>'pallet-a4-portrait' ORDER BY seed_key",
    );
    await pool.query(refresh);
    expect(
      (await pool.query("SELECT id,spec,revision FROM label_templates WHERE id=$1", [portrait.id]))
        .rows,
    ).toEqual([{ id: portrait.id, spec: buildPalletSheetPresets()[0]?.spec, revision: 2 }]);
    expect(
      (
        await pool.query(
          "SELECT id,name,spec,enabled,revision FROM label_templates WHERE tenant_id='refresh' AND seed_key IN ('pallet-a4-landscape','pallet-a4-two-a5') ORDER BY seed_key",
        )
      ).rows,
    ).toEqual(preserved.rows);
    const alternatives = await pool.query<{ seed_key: string; spec: unknown }>(
      "SELECT seed_key,spec FROM label_templates WHERE tenant_id='refresh' AND seed_key LIKE '%-2026-10' ORDER BY seed_key",
    );
    expect(alternatives.rows).toEqual(
      buildPalletSheetPresets()
        .filter((p) => p.key !== "pallet-a4-portrait")
        .map((p) => ({ seed_key: p.key + "-2026-10", spec: p.spec }))
        .sort((a, b) => a.seed_key.localeCompare(b.seed_key)),
    );
    const before = await pool.query(
      "SELECT id,name,spec,revision FROM label_templates WHERE tenant_id='refresh' ORDER BY seed_key",
    );
    await pool.query(refresh);
    expect(
      (
        await pool.query(
          "SELECT id,name,spec,revision FROM label_templates WHERE tenant_id='refresh' ORDER BY seed_key",
        )
      ).rows,
    ).toEqual(before.rows);
  });
});
