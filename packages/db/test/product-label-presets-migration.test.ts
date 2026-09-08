import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDuplicateLabelTemplate } from "../../domain/dist/index.js";

const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
const name203 = "Дубликат Data Matrix 58×40 (203 dpi)";
const name300 = "Дубликат Data Matrix 58×40 (300 dpi)";

describe.skipIf(!databaseUrl)("duplicate preset resolution migration", () => {
  const name = `markiro_duplicate_presets_${randomUUID().replaceAll("-", "_")}`;
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

  it("seeds both resolutions once per tenant, preserving existing presets and a colliding box", async () => {
    const tenantA = randomUUID();
    const tenantB = randomUUID();
    for (const tenant of [tenantA, tenantB]) {
      await pool.query("INSERT INTO organization(id,name,slug,created_at) VALUES($1,$1,$1,now())", [
        tenant,
      ]);
    }
    const old203 = buildDuplicateLabelTemplate();
    const custom300 = { ...old203, dpi: 300, widthMm: 60 };
    const boxId = randomUUID();
    await pool.query(
      "INSERT INTO label_templates(id,tenant_id,name,purpose,spec,enabled) VALUES($1,$2,$3,'box',$4::jsonb,true),($5,$6,$7,'product_duplicate',$8::jsonb,false),($9,$6,$3,'product_duplicate',$10::jsonb,false)",
      [
        boxId,
        tenantA,
        name300,
        JSON.stringify({ customBox: true }),
        randomUUID(),
        tenantB,
        name203,
        JSON.stringify(old203),
        randomUUID(),
        JSON.stringify(custom300),
      ],
    );
    await pool.query(
      "INSERT INTO org_profiles(tenant_id,default_box_label_template_id) VALUES($1,$2)",
      [tenantA, boxId],
    );
    const sql = await readFile(
      new URL("../migrations/0115_duplicate_label_resolutions.sql", import.meta.url),
      "utf8",
    );
    await pool.query(sql);
    await pool.query(sql);
    const { rows } = await pool.query<{
      tenant_id: string;
      name: string;
      spec: unknown;
      enabled: boolean;
    }>(
      "SELECT tenant_id,name,spec,enabled FROM label_templates WHERE tenant_id=ANY($1::text[]) AND purpose='product_duplicate' ORDER BY name",
      [[tenantA, tenantB]],
    );
    expect(rows.filter((row) => row.tenant_id === tenantA)).toEqual([
      { tenant_id: tenantA, name: name203, spec: old203, enabled: true },
      { tenant_id: tenantA, name: name300, spec: { ...old203, dpi: 300 }, enabled: true },
    ]);
    expect(rows.filter((row) => row.tenant_id === tenantB)).toEqual([
      { tenant_id: tenantB, name: name203, spec: old203, enabled: false },
      { tenant_id: tenantB, name: name300, spec: custom300, enabled: false },
    ]);
    const boxes = await pool.query(
      "SELECT id,spec FROM label_templates WHERE tenant_id=$1 AND purpose='box'",
      [tenantA],
    );
    expect(boxes.rows).toEqual([{ id: boxId, spec: { customBox: true } }]);
    const profile = await pool.query(
      "SELECT default_box_label_template_id FROM org_profiles WHERE tenant_id=$1",
      [tenantA],
    );
    expect(profile.rows).toEqual([{ default_box_label_template_id: boxId }]);
  });
});
