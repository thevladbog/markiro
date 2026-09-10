import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildLegacyDatedBoxLabelTemplates,
  buildLegacyDateFreeBoxLabelTemplates,
  buildLegacyDuplicateLabelTemplates,
  buildLegacyPrintNameBoxLabelTemplates,
} from "@markiro/domain";

const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
const MIGRATION = "0123_dpi_neutral_stock_label_templates.sql";

function legacySpec(name: string): unknown {
  const row = [
    ...buildLegacyDatedBoxLabelTemplates(),
    ...buildLegacyDateFreeBoxLabelTemplates(),
    ...buildLegacyPrintNameBoxLabelTemplates(),
    ...buildLegacyDuplicateLabelTemplates(),
  ].find((t) => t.name === name);
  if (!row) throw new Error(`no legacy stock template named ${name}`);
  return row.spec;
}

describe.skipIf(!databaseUrl)("dpi-neutral stock label templates migration", () => {
  const name = `markiro_dpi_neutral_${randomUUID().replaceAll("-", "_")}`;
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

  it("renames the 203 stock rows, disables only untouched and unreferenced 300 twins, and is idempotent", async () => {
    const tenant = randomUUID();
    await pool.query("INSERT INTO organization(id,name,slug,created_at) VALUES($1,$1,$1,now())", [
      tenant,
    ]);
    const ids = {
      dated203: randomUUID(),
      dated300: randomUUID(),
      dateFree300OrgDefault: randomUUID(),
      printName300ProductDefault: randomUUID(),
      printNameDateFree300CategoryDefault: randomUUID(),
      duplicate203: randomUUID(),
      duplicate300Custom: randomUUID(),
      custom: randomUUID(),
    };
    const rows: Array<[string, string, string, unknown]> = [
      [ids.dated203, "Коробка 58×40 (203 dpi)", "box", { edited: true }],
      [ids.dated300, "Коробка 58×40 (300 dpi)", "box", legacySpec("Коробка 58×40 (300 dpi)")],
      [
        ids.dateFree300OrgDefault,
        "Коробка 58×40 без дат (300 dpi)",
        "box",
        legacySpec("Коробка 58×40 без дат (300 dpi)"),
      ],
      [
        ids.printName300ProductDefault,
        "Коробка 58×40 (300 dpi) [Назв. для печати]",
        "box",
        legacySpec("Коробка 58×40 (300 dpi) [Назв. для печати]"),
      ],
      [
        ids.printNameDateFree300CategoryDefault,
        "Коробка 58×40 без дат (300 dpi) [Назв. для печати]",
        "box",
        legacySpec("Коробка 58×40 без дат (300 dpi) [Назв. для печати]"),
      ],
      [
        ids.duplicate203,
        "Дубликат Data Matrix 58×40 (203 dpi)",
        "product_duplicate",
        legacySpec("Дубликат Data Matrix 58×40 (203 dpi)"),
      ],
      [
        ids.duplicate300Custom,
        "Дубликат Data Matrix 58×40 (300 dpi)",
        "product_duplicate",
        { ...(legacySpec("Дубликат Data Matrix 58×40 (300 dpi)") as object), widthMm: 60 },
      ],
      [ids.custom, "Своя этикетка", "box", { custom: true }],
    ];
    for (const [id, rowName, purpose, spec] of rows) {
      await pool.query(
        "INSERT INTO label_templates(id,tenant_id,name,purpose,spec,enabled) VALUES($1,$2,$3,$4,$5::jsonb,true)",
        [id, tenant, rowName, purpose, JSON.stringify(spec)],
      );
    }
    await pool.query(
      "INSERT INTO org_profiles(tenant_id,default_box_label_template_id) VALUES($1,$2)",
      [tenant, ids.dateFree300OrgDefault],
    );
    await pool.query(
      "INSERT INTO products(id,tenant_id,gtin14,name,default_label_template_id) VALUES($1,$2,'04600000000015','Пиво',$3)",
      [randomUUID(), tenant, ids.printName300ProductDefault],
    );
    await pool.query(
      "INSERT INTO org_box_label_template_defaults(tenant_id,chz_product_group_code,template_id) VALUES($1,15,$2)",
      [tenant, ids.printNameDateFree300CategoryDefault],
    );

    const sql = await readFile(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8");
    await pool.query(sql);
    const snapshot = async () =>
      (
        await pool.query<{ id: string; name: string; enabled: boolean; spec: unknown }>(
          "SELECT id,name,enabled,spec FROM label_templates WHERE tenant_id=$1 ORDER BY name",
          [tenant],
        )
      ).rows;
    const first = await snapshot();
    const byId = new Map(first.map((row) => [row.id, row]));

    expect(byId.get(ids.dated203)).toMatchObject({
      name: "Коробка 58×40",
      enabled: true,
      spec: { edited: true },
    });
    expect(byId.get(ids.duplicate203)).toMatchObject({
      name: "Дубликат Data Matrix 58×40",
      enabled: true,
    });
    expect(byId.get(ids.dated300)).toMatchObject({
      name: "Коробка 58×40 (300 dpi)",
      enabled: false,
    });
    expect(byId.get(ids.dateFree300OrgDefault)).toMatchObject({
      name: "Коробка 58×40 без дат (300 dpi)",
      enabled: true,
    });
    expect(byId.get(ids.printName300ProductDefault)).toMatchObject({
      name: "Коробка 58×40 (300 dpi) [Назв. для печати]",
      enabled: true,
    });
    expect(byId.get(ids.printNameDateFree300CategoryDefault)).toMatchObject({
      name: "Коробка 58×40 без дат (300 dpi) [Назв. для печати]",
      enabled: true,
    });
    expect(byId.get(ids.duplicate300Custom)).toMatchObject({
      name: "Дубликат Data Matrix 58×40 (300 dpi)",
      enabled: true,
      spec: expect.objectContaining({ widthMm: 60 }),
    });
    expect(byId.get(ids.custom)).toMatchObject({
      name: "Своя этикетка",
      enabled: true,
      spec: { custom: true },
    });

    await pool.query(sql);
    expect(await snapshot()).toEqual(first);
  });
});
