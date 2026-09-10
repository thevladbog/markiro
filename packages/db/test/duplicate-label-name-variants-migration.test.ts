import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildDuplicateLabelTemplates,
  buildLegacyDuplicateLabelTemplates,
  productLabelValueDigest,
} from "@markiro/domain";

const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
const oldName = "Дубликат Data Matrix 58×40";
const shortName = `${oldName} [Краткое наименование]`;
const fullName = `${oldName} [Полное наименование]`;

describe.skipIf(!databaseUrl)("duplicate label name variants migration", () => {
  const name = `markiro_duplicate_names_${randomUUID().replaceAll("-", "_")}`;
  const url = new URL(databaseUrl ?? "postgres://invalid");
  url.pathname = `/${name}`;
  url.search = "";
  const maintenance = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: url.toString() });
  let created = false;

  beforeAll(async () => {
    await maintenance.query(`CREATE DATABASE "${name}"`);
    created = true;
    await migrate(drizzle(pool), { migrationsFolder });
  }, 120_000);
  afterAll(async () => {
    await pool.end();
    if (created) await maintenance.query(`DROP DATABASE "${name}"`);
    await maintenance.end();
  });

  it("updates untouched stock, seeds both names per tenant, and preserves edits, disabled rows and shift snapshots", async () => {
    const oldSpec = buildLegacyDuplicateLabelTemplates().find((row) => row.spec.dpi === 203)?.spec;
    if (!oldSpec) throw new Error("Missing historical duplicate preset");
    const tenants = {
      stock: randomUUID(),
      disabled: randomUUID(),
      custom: randomUUID(),
      collision: randomUUID(),
      empty: randomUUID(),
    };
    for (const tenant of Object.values(tenants))
      await pool.query("INSERT INTO organization(id,name,slug,created_at) VALUES($1,$1,$1,now())", [
        tenant,
      ]);
    const stockId = randomUUID();
    const entries = [
      {
        id: stockId,
        tenant: tenants.stock,
        name: oldName,
        purpose: "product_duplicate",
        spec: oldSpec,
        enabled: true,
      },
      {
        id: randomUUID(),
        tenant: tenants.disabled,
        name: oldName,
        purpose: "product_duplicate",
        spec: oldSpec,
        enabled: false,
      },
      {
        id: randomUUID(),
        tenant: tenants.custom,
        name: oldName,
        purpose: "product_duplicate",
        spec: { ...oldSpec, widthMm: 60 },
        enabled: false,
      },
      {
        id: randomUUID(),
        tenant: tenants.collision,
        name: oldName,
        purpose: "product_duplicate",
        spec: oldSpec,
        enabled: true,
      },
      {
        id: randomUUID(),
        tenant: tenants.collision,
        name: shortName,
        purpose: "product_duplicate",
        spec: { editedShort: true },
        enabled: false,
      },
      {
        id: randomUUID(),
        tenant: tenants.collision,
        name: fullName,
        purpose: "product_duplicate",
        spec: { editedFull: true },
        enabled: true,
      },
      {
        id: randomUUID(),
        tenant: tenants.empty,
        name: fullName,
        purpose: "box",
        spec: { box: true },
        enabled: true,
      },
    ];
    for (const entry of entries)
      await pool.query(
        "INSERT INTO label_templates(id,tenant_id,name,purpose,spec,enabled) VALUES($1,$2,$3,$4,$5::jsonb,$6)",
        [
          entry.id,
          entry.tenant,
          entry.name,
          entry.purpose,
          JSON.stringify(entry.spec),
          entry.enabled,
        ],
      );
    const product = randomUUID();
    const shift = randomUUID();
    await pool.query(
      "INSERT INTO products(id,tenant_id,gtin14,name) VALUES($1,$2,'04600000000015','Product')",
      [product, tenants.stock],
    );
    const content = { id: stockId, name: oldName, spec: oldSpec };
    const snapshot = { ...content, digest: productLabelValueDigest(content) };
    await pool.query(
      "INSERT INTO shifts(id,tenant_id,product_id,mode,status,number_month_key,number_seq,opened_at,validation_print_mode,validation_print_verification,validation_print_template_id,validation_print_snapshot,validation_print_policy_revision) VALUES($1,$2,$3,'validation','active','SEP26',1,now(),'duplicate_dm','required',$4,$5::jsonb,$6)",
      [shift, tenants.stock, product, stockId, JSON.stringify(snapshot), randomUUID()],
    );

    const sql = await readFile(
      new URL("../migrations/0125_duplicate_label_name_variants.sql", import.meta.url),
      "utf8",
    );
    await pool.query(sql);
    const readTemplates = async () =>
      (
        await pool.query<{
          id: string;
          tenant_id: string;
          name: string;
          purpose: string;
          enabled: boolean;
          spec: unknown;
        }>("SELECT id,tenant_id,name,purpose,enabled,spec FROM label_templates ORDER BY id")
      ).rows;
    const first = await readTemplates();
    const presets = buildDuplicateLabelTemplates();
    const shortSpec = presets.find((row) => row.name === shortName)?.spec;
    expect(shortSpec).toBeDefined();
    for (const entry of entries) {
      const updated = entry.tenant === tenants.stock || entry.tenant === tenants.disabled;
      expect(first.find((row) => row.id === entry.id)).toEqual({
        id: entry.id,
        tenant_id: entry.tenant,
        name: updated ? shortName : entry.name,
        purpose: entry.purpose,
        enabled: entry.enabled,
        spec: updated ? shortSpec : entry.spec,
      });
    }
    for (const tenant of Object.values(tenants)) {
      const variants = first.filter(
        (row) =>
          row.tenant_id === tenant &&
          row.purpose === "product_duplicate" &&
          [fullName, shortName].includes(row.name),
      );
      expect(variants).toHaveLength(2);
      if (tenant !== tenants.collision) {
        for (const preset of presets)
          expect(variants).toContainEqual(
            expect.objectContaining({ name: preset.name, spec: preset.spec }),
          );
      }
    }
    expect(
      (
        await pool.query(
          "SELECT validation_print_template_id,validation_print_snapshot FROM shifts WHERE id=$1",
          [shift],
        )
      ).rows,
    ).toEqual([{ validation_print_template_id: stockId, validation_print_snapshot: snapshot }]);
    await pool.query(sql);
    expect(await readTemplates()).toEqual(first);
  });
});
