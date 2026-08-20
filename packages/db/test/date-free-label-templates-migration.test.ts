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

/** The second stock family — the names 0053 keys its insert-if-absent on. */
const DATE_FREE_NAMES = [
  "Коробка 58×40 без дат (203 dpi)",
  "Коробка 58×40 без дат (300 dpi)",
  "Коробка 75×120 без дат (203 dpi)",
  "Коробка 100×100 без дат (203 dpi)",
  "Коробка 100×150 без дат (203 dpi)",
];

/** The first family. 0053 must not create, touch or re-spec any of these. */
const DATED_NAMES = [
  "Коробка 58×40 (203 dpi)",
  "Коробка 58×40 (300 dpi)",
  "Коробка 75×120 (203 dpi)",
  "Коробка 100×100 (203 dpi)",
  "Коробка 100×150 (203 dpi)",
];

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error("Unsafe temporary database identifier");
  }
  return `"${identifier}"`;
}

describe.skipIf(!databaseUrl)("date-free label templates migration", () => {
  const databaseName = `markiro_date_free_label_templates_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenancePool = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: scratchUrl.toString() });
  let created = false;

  // 0053's own pass (run inside migrate() below) sees no organizations, so it
  // seeds nothing; the orgs the test needs are created afterward and
  // backfilled by re-running the migration's SQL directly — the same shape as
  // `default-label-templates-migration.test.ts`.
  async function runBackfill(): Promise<void> {
    const sql = await readFile(
      join(migrationsFolder, "0053_date_free_label_templates.sql"),
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

  it("adds the five date-free templates per tenant, changes nothing else, and is idempotent", async () => {
    await pool.query(
      "INSERT INTO organization (id, name, slug, created_at) VALUES ('df-a','A','df-a',now()), ('df-b','B','df-b',now())",
    );
    // Tenant A already owns the DATED family (as every real tenant does) plus
    // an unrelated template of its own — none of it may be disturbed.
    await pool.query(
      `INSERT INTO label_templates (id, tenant_id, name, spec)
       VALUES
         ('00000000-0000-4000-8000-000000000911', 'df-a', 'Коробка 58×40 (203 dpi)', '{"dated":true}'::jsonb),
         ('00000000-0000-4000-8000-000000000912', 'df-a', 'Своя этикетка', '{"custom":true}'::jsonb)`,
    );
    // Tenant B has already created something under one of the NEW names.
    await pool.query(
      `INSERT INTO label_templates (id, tenant_id, name, spec)
       VALUES ('00000000-0000-4000-8000-000000000913', 'df-b', 'Коробка 58×40 без дат (203 dpi)', '{"marker":true}'::jsonb)`,
    );
    // A tenant default, to prove the migration leaves org_profiles alone.
    await pool.query(
      `INSERT INTO org_profiles (tenant_id, default_box_label_template_id)
       VALUES ('df-a', '00000000-0000-4000-8000-000000000911')`,
    );

    await runBackfill();
    await runBackfill(); // idempotency

    const a = await pool.query<{ name: string; spec: unknown }>(
      "SELECT name, spec FROM label_templates WHERE tenant_id = 'df-a' ORDER BY name",
    );
    expect(a.rows.map((r) => r.name).sort()).toEqual(
      [...DATE_FREE_NAMES, "Коробка 58×40 (203 dpi)", "Своя этикетка"].sort(),
    );
    // The pre-existing rows are byte-identical: nothing existing was modified.
    expect(a.rows.find((r) => r.name === "Коробка 58×40 (203 dpi)")?.spec).toEqual({ dated: true });
    expect(a.rows.find((r) => r.name === "Своя этикетка")?.spec).toEqual({ custom: true });
    // ...and the migration did NOT seed the dated family for a tenant missing
    // four of the five: that is 0049's job, not this one's.
    for (const name of DATED_NAMES.slice(1)) {
      expect(
        a.rows.some((r) => r.name === name),
        `${name} must not be seeded here`,
      ).toBe(false);
    }

    const b = await pool.query<{ name: string; spec: unknown }>(
      "SELECT name, spec FROM label_templates WHERE tenant_id = 'df-b' ORDER BY name",
    );
    expect(b.rows).toHaveLength(5); // 1 pre-existing + 4 seeded
    expect(b.rows.find((r) => r.name === "Коробка 58×40 без дат (203 dpi)")?.spec).toEqual({
      marker: true,
    });

    // The seeded specs are real templates, not the collision marker.
    const seeded = a.rows.find((r) => r.name === "Коробка 58×40 без дат (203 dpi)")?.spec as Record<
      string,
      unknown
    >;
    expect(seeded.widthMm).toBe(58);
    expect(seeded.heightMm).toBe(40);
    const ids = (seeded.elements as Array<{ id: string }>).map((el) => el.id);
    expect(ids).not.toContain("val-date");
    expect(ids).not.toContain("val-expiry");

    // org_profiles untouched.
    const profile = await pool.query<{ default_box_label_template_id: string | null }>(
      "SELECT default_box_label_template_id FROM org_profiles WHERE tenant_id = 'df-a'",
    );
    expect(profile.rows[0]?.default_box_label_template_id).toBe(
      "00000000-0000-4000-8000-000000000911",
    );
  });
});
