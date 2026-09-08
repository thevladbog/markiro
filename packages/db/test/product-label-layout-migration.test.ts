import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDuplicateLabelTemplate, productLabelValueDigest } from "@markiro/domain";
const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
const seedName = "Дубликат Data Matrix 58×40 (203 dpi)";
describe.skipIf(!databaseUrl)("duplicate label stock layout update", () => {
  const name = `markiro_duplicate_layout_${randomUUID().replaceAll("-", "_")}`;
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
  }, 120000);
  afterAll(async () => {
    await pool.end();
    if (created) await maintenance.query(`DROP DATABASE "${name}"`);
    await maintenance.end();
  });
  it("updates only the original stock layout, keeps tenant edits and disabled state, and never rewrites shift snapshots", async () => {
    const oldSql = await readFile(
      join(migrationsFolder, "0113_validation_dm_duplicate.sql"),
      "utf8",
    );
    const match = /'(\{[\s\S]*?\})'::jsonb/.exec(oldSql);
    if (!match?.[1]) throw new Error("legacy seed missing");
    const oldSpec: unknown = JSON.parse(match[1]);
    const ids = Array.from({ length: 5 }, () => randomUUID());
    const tenantA = randomUUID(),
      tenantB = randomUUID(),
      product = randomUUID(),
      shift = randomUUID();
    for (const tenant of [tenantA, tenantB])
      await pool.query("INSERT INTO organization(id,name,slug,created_at) VALUES($1,$1,$1,now())", [
        tenant,
      ]);
    const entries = [
      {
        id: ids[0],
        tenant: tenantA,
        name: seedName,
        purpose: "product_duplicate",
        spec: oldSpec,
        enabled: true,
      },
      {
        id: ids[1],
        tenant: tenantB,
        name: seedName,
        purpose: "product_duplicate",
        spec: oldSpec,
        enabled: false,
      },
      {
        id: ids[2],
        tenant: tenantA,
        name: seedName,
        purpose: "product_duplicate",
        spec: { custom: true },
        enabled: true,
      },
      {
        id: ids[3],
        tenant: tenantB,
        name: "Своя этикетка",
        purpose: "product_duplicate",
        spec: oldSpec,
        enabled: true,
      },
      { id: ids[4], tenant: tenantA, name: seedName, purpose: "box", spec: oldSpec, enabled: true },
    ];
    for (const e of entries)
      await pool.query(
        "INSERT INTO label_templates(id,tenant_id,name,purpose,spec,enabled) VALUES($1,$2,$3,$4,$5::jsonb,$6)",
        [e.id, e.tenant, e.name, e.purpose, JSON.stringify(e.spec), e.enabled],
      );
    await pool.query(
      "INSERT INTO products(id,tenant_id,gtin14,name) VALUES($1,$2,'04600000000015','Product')",
      [product, tenantA],
    );
    const content = { id: ids[0], name: seedName, spec: oldSpec };
    const snapshot = { ...content, digest: productLabelValueDigest(content) };
    await pool.query(
      `INSERT INTO shifts(id,tenant_id,product_id,mode,status,number_month_key,number_seq,opened_at,validation_print_mode,validation_print_verification,validation_print_template_id,validation_print_snapshot,validation_print_policy_revision) VALUES($1,$2,$3,'validation','active','SEP26',1,now(),'duplicate_dm','required',$4,$5::jsonb,$6)`,
      [shift, tenantA, product, ids[0], JSON.stringify(snapshot), randomUUID()],
    );
    const sql = await readFile(
      join(migrationsFolder, "0114_duplicate_label_stock_layout.sql"),
      "utf8",
    );
    await pool.query(sql);
    await pool.query(sql);
    const rows = await pool.query<{ id: string; spec: unknown; enabled: boolean }>(
      "SELECT id,spec,enabled FROM label_templates WHERE id=ANY($1::uuid[])",
      [ids],
    );
    for (const [index, e] of entries.entries())
      expect(rows.rows.find((r) => r.id === e.id)).toEqual({
        id: e.id,
        enabled: e.enabled,
        spec: index < 2 ? buildDuplicateLabelTemplate() : e.spec,
      });
    const saved = await pool.query("SELECT validation_print_snapshot FROM shifts WHERE id=$1", [
      shift,
    ]);
    expect(saved.rows[0].validation_print_snapshot).toEqual(snapshot);
  });
});
