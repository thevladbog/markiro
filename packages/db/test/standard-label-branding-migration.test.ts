import { randomUUID } from "node:crypto";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildDefaultLabelTemplates,
  buildLegacyDatedBoxLabelTemplates,
  buildLegacyDateFreeBoxLabelTemplates,
  buildLegacyPrintNameBoxLabelTemplates,
  buildPalletLabelTemplates,
} from "@markiro/domain";
import { copyMigrationsThroughIndex } from "./support/legacy-migrations.js";
const connectionString = process.env.DATABASE_URL;
const folder = fileURLToPath(new URL("../migrations", import.meta.url));
describe.skipIf(!connectionString)("standard label migration", () => {
  const dbName = `standard_labels_${randomUUID().replaceAll("-", "_")}`;
  const maintenance = new pg.Pool({ connectionString });
  const url = new URL(connectionString ?? "postgres://invalid");
  url.pathname = `/${dbName}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  let historical = "",
    sql = "",
    oldId = "",
    smallId = "",
    editedId = "",
    palletId = "";
  const stockIds = new Map<string, string>();
  beforeAll(async () => {
    await maintenance.query(`CREATE DATABASE "${dbName}"`);
    historical = await mkdtemp(join(tmpdir(), "standard-label-migrations-"));
    await copyMigrationsThroughIndex({
      sourceFolder: folder,
      targetFolder: historical,
      lastIncludedIndex: 184,
    });
    await migrate(drizzle(pool), { migrationsFolder: historical });
    await pool.query(
      "INSERT INTO organization(id,name,slug,created_at) VALUES('labels','Labels','labels',now())",
    );
    const old = buildLegacyDatedBoxLabelTemplates().find((t) => t.spec.widthMm === 75)!;
    oldId = randomUUID();
    smallId = randomUUID();
    editedId = randomUUID();
    const small = buildDefaultLabelTemplates()[0]!;
    await pool.query(
      "INSERT INTO label_templates(id,tenant_id,name,spec,purpose,enabled) VALUES($1,'labels','Коробка 75×120',$2,'box',false),($3,'labels',$4,$5,'box',true),($6,'labels','Коробка 100×100',$7,'box',true)",
      [oldId, old.spec, smallId, small.name, small.spec, editedId, { ...old.spec, elements: [] }],
    );
    await pool.query(
      "INSERT INTO organization(id,name,slug,created_at) VALUES('stock','Stock','stock',now())",
    );
    for (const template of [
      ...buildLegacyDatedBoxLabelTemplates(),
      ...buildLegacyDateFreeBoxLabelTemplates(),
      ...buildLegacyPrintNameBoxLabelTemplates(),
    ].filter((t) => t.spec.dpi === 203 && t.spec.widthMm !== 58)) {
      const id = randomUUID();
      if (!template.renamedTo) throw new Error("Historical stock identity missing");
      stockIds.set(template.renamedTo, id);
      await pool.query(
        "INSERT INTO label_templates(id,tenant_id,name,spec,purpose) VALUES($1,'stock',$2,$3,'box')",
        [id, template.renamedTo, template.spec],
      );
    }
    const oldPalletMigration = await readFile(
      new URL("../migrations/0137_pallets.sql", import.meta.url),
      "utf8",
    );
    const palletSeed = oldPalletMigration.slice(
      oldPalletMigration.indexOf("INSERT INTO label_templates"),
      oldPalletMigration.indexOf(
        "--> statement-breakpoint",
        oldPalletMigration.indexOf("INSERT INTO label_templates"),
      ),
    );
    await pool.query(palletSeed);
    palletId = (
      await pool.query(
        "SELECT id FROM label_templates WHERE tenant_id='stock' AND name='Паллета 100×150'",
      )
    ).rows[0].id;
    await pool.query(
      "INSERT INTO org_profiles(tenant_id,default_pallet_label_template_id) VALUES('stock',$1)",
      [palletId],
    );
    sql = await readFile(
      new URL("../migrations/0185_standard_label_branding.sql", import.meta.url),
      "utf8",
    );
    await migrate(drizzle(pool), { migrationsFolder: folder });
  }, 120_000);
  afterAll(async () => {
    await pool.end();
    await maintenance.query(`DROP DATABASE IF EXISTS "${dbName}"`);
    await maintenance.end();
    if (historical) await rm(historical, { recursive: true, force: true });
  });
  it("updates stock in place while preserving disabled status, 58×40 and edited specs", async () => {
    const rows = (
      await pool.query(
        "SELECT id,spec,enabled FROM label_templates WHERE tenant_id='labels' ORDER BY name",
      )
    ).rows;
    expect(rows.find((r) => r.id === oldId)).toMatchObject({
      enabled: false,
      spec: buildDefaultLabelTemplates().find((t) => t.name === "Коробка 75×120")!.spec,
    });
    expect(rows.find((r) => r.id === smallId)?.spec).toEqual(buildDefaultLabelTemplates()[0]!.spec);
    expect(rows.find((r) => r.id === editedId)?.spec.elements).toEqual([]);
    expect(rows.filter((r) => r.spec.gs1Constraint)).toHaveLength(2);
  });
  it("updates all twelve box variants and preserves the renamed pallet default reference", async () => {
    expect(stockIds.size).toBe(12);
    for (const [name, id] of stockIds) {
      const row = (
        await pool.query("SELECT name,spec,revision FROM label_templates WHERE id=$1", [id])
      ).rows[0];
      expect(row).toMatchObject({
        name,
        spec: buildDefaultLabelTemplates().find((t) => t.name === name)!.spec,
        revision: 2,
      });
    }
    expect(
      (await pool.query("SELECT name,spec FROM label_templates WHERE id=$1", [palletId])).rows[0],
    ).toEqual({ name: "Палет 100×150", spec: buildPalletLabelTemplates()[0]!.spec });
    expect(
      (
        await pool.query(
          "SELECT default_pallet_label_template_id FROM org_profiles WHERE tenant_id='stock'",
        )
      ).rows[0].default_pallet_label_template_id,
    ).toBe(palletId);
  });
  it("adds 75×120 once and never overwrites a subsequent edit", async () => {
    const [pallet] = (
      await pool.query(
        "SELECT id,spec FROM label_templates WHERE tenant_id='labels' AND name='Палет 75×120'",
      )
    ).rows;
    expect(pallet.spec).toEqual(buildPalletLabelTemplates()[2]!.spec);
    await pool.query(sql);
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM label_templates WHERE tenant_id='labels' AND name='Палет 75×120'",
        )
      ).rows[0].n,
    ).toBe(1);
    await pool.query(
      "UPDATE label_templates SET spec=jsonb_set(spec,'{elements}','[]') WHERE id=$1",
      [pallet.id],
    );
    await pool.query(sql);
    expect(
      (await pool.query("SELECT spec FROM label_templates WHERE id=$1", [pallet.id])).rows[0].spec
        .elements,
    ).toEqual([]);
  });
});
