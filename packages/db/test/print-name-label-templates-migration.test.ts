import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

/** The print-name duplicates — the names 0058 keys its insert-if-absent on. */
const PRINT_NAME_NAMES = [
  "Коробка 58×40 (203 dpi) [Назв. для печати]",
  "Коробка 58×40 (300 dpi) [Назв. для печати]",
  "Коробка 75×120 (203 dpi) [Назв. для печати]",
  "Коробка 100×100 (203 dpi) [Назв. для печати]",
  "Коробка 100×150 (203 dpi) [Назв. для печати]",
  "Коробка 58×40 без дат (203 dpi) [Назв. для печати]",
  "Коробка 58×40 без дат (300 dpi) [Назв. для печати]",
  "Коробка 75×120 без дат (203 dpi) [Назв. для печати]",
  "Коробка 100×100 без дат (203 dpi) [Назв. для печати]",
  "Коробка 100×150 без дат (203 dpi) [Назв. для печати]",
];

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error("Unsafe temporary database identifier");
  }
  return `"${identifier}"`;
}

describe.skipIf(!databaseUrl)("print-name label templates migration", () => {
  // Short prefix on purpose — see date-free-label-templates-migration.test.ts.
  const databaseName = `markiro_print_nm_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenancePool = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: scratchUrl.toString() });
  let created = false;

  // Same shape as the 0053 test: migrate() sees no organizations, the test
  // creates them afterward and re-runs 0058's SQL directly as the backfill.
  async function runBackfill(): Promise<void> {
    const sql = await readFile(
      join(migrationsFolder, "0058_print_name_label_templates.sql"),
      "utf8",
    );
    for (const stmt of sql.split("--> statement-breakpoint")) {
      if (stmt.trim()) await pool.query(stmt);
    }
  }

  beforeAll(async () => {
    await maintenancePool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    created = true;
    await migrate(drizzle(pool), { migrationsFolder });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (created) {
      await maintenancePool.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`);
    }
    await maintenancePool.end();
  });

  it("adds the ten print-name duplicates per tenant, changes nothing else, and is idempotent", async () => {
    await pool.query(
      "INSERT INTO organization (id, name, slug, created_at) VALUES ('pn-a','A','pn-a',now()), ('pn-b','B','pn-b',now())",
    );
    // Tenant A owns an original plus its own template — neither may change.
    await pool.query(
      `INSERT INTO label_templates (id, tenant_id, name, spec)
       VALUES
         ('00000000-0000-4000-8000-000000000921', 'pn-a', 'Коробка 58×40 (203 dpi)', '{"dated":true}'::jsonb),
         ('00000000-0000-4000-8000-000000000922', 'pn-a', 'Своя этикетка', '{"custom":true}'::jsonb)`,
    );
    // Tenant B already created something under one of the NEW names.
    await pool.query(
      `INSERT INTO label_templates (id, tenant_id, name, spec)
       VALUES ('00000000-0000-4000-8000-000000000923', 'pn-b', 'Коробка 58×40 (203 dpi) [Назв. для печати]', '{"marker":true}'::jsonb)`,
    );
    await pool.query(
      `INSERT INTO org_profiles (tenant_id, default_box_label_template_id)
       VALUES ('pn-a', '00000000-0000-4000-8000-000000000921')`,
    );

    await runBackfill();
    await runBackfill(); // idempotency

    const a = await pool.query<{ name: string; spec: unknown }>(
      "SELECT name, spec FROM label_templates WHERE tenant_id = 'pn-a' ORDER BY name",
    );
    expect(a.rows.map((r) => r.name).sort()).toEqual(
      [...PRINT_NAME_NAMES, "Коробка 58×40 (203 dpi)", "Своя этикетка"].sort(),
    );
    expect(a.rows.find((r) => r.name === "Коробка 58×40 (203 dpi)")?.spec).toEqual({ dated: true });
    expect(a.rows.find((r) => r.name === "Своя этикетка")?.spec).toEqual({ custom: true });

    const b = await pool.query<{ name: string; spec: unknown }>(
      "SELECT name, spec FROM label_templates WHERE tenant_id = 'pn-b' ORDER BY name",
    );
    expect(b.rows).toHaveLength(10); // 1 pre-existing marker + 9 seeded
    expect(b.rows.find((r) => r.name === "Коробка 58×40 (203 dpi) [Назв. для печати]")?.spec).toEqual(
      { marker: true },
    );

    // The seeded specs bind the headline to product.printName.
    const seeded = a.rows.find((r) => r.name === "Коробка 58×40 (203 dpi) [Назв. для печати]")
      ?.spec as Record<string, unknown>;
    expect(seeded.widthMm).toBe(58);
    const headline = (seeded.elements as Array<{ id: string; field?: string }>).find(
      (el) => el.id === "name",
    );
    expect(headline?.field).toBe("product.printName");

    // org_profiles untouched.
    const profile = await pool.query<{ default_box_label_template_id: string | null }>(
      "SELECT default_box_label_template_id FROM org_profiles WHERE tenant_id = 'pn-a'",
    );
    expect(profile.rows[0]?.default_box_label_template_id).toBe(
      "00000000-0000-4000-8000-000000000921",
    );
  });
});
