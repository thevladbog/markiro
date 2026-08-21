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

const BASE_DATED_NAME = "Коробка 58×40 (203 dpi)";
const LARGE_DATED_NAME = "Коробка 100×150 (203 dpi)";
const DATE_FREE_NAME = "Коробка 58×40 без дат (203 dpi)";

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error("Unsafe temporary database identifier");
  }
  return `"${identifier}"`;
}

describe.skipIf(!databaseUrl)("align dated label quantity migration", () => {
  const databaseName = `markiro_align_label_qty_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenancePool = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: scratchUrl.toString() });
  let created = false;

  async function runAlignment(): Promise<void> {
    const sql = await readFile(
      join(migrationsFolder, "0056_align_dated_label_quantity.sql"),
      "utf8",
    );
    for (const statement of sql.split("--> statement-breakpoint")) {
      if (statement.trim()) await pool.query(statement);
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

  it("raises the raster quantity at base and largest scale and leaves other names untouched", async () => {
    await pool.query(
      "INSERT INTO organization (id, name, slug, created_at) VALUES ('aq-a','A','aq-a',now()), ('aq-b','B','aq-b',now())",
    );
    await pool.query(
      `INSERT INTO label_templates (id, tenant_id, name, spec, updated_at) VALUES
         ('00000000-0000-4000-8000-000000000901', 'aq-a', $1, '{"hand-edited":true}'::jsonb, '2020-01-01T00:00:00Z'),
         ('00000000-0000-4000-8000-000000000902', 'aq-b', $2, '{"hand-edited":true}'::jsonb, '2020-01-01T00:00:00Z'),
         ('00000000-0000-4000-8000-000000000903', 'aq-a', $3, '{"date-free":true}'::jsonb, '2020-01-01T00:00:00Z'),
         ('00000000-0000-4000-8000-000000000904', 'aq-b', 'Моя этикетка', '{"mine":true}'::jsonb, '2020-01-01T00:00:00Z')`,
      [BASE_DATED_NAME, LARGE_DATED_NAME, DATE_FREE_NAME],
    );

    await runAlignment();
    await runAlignment();

    const result = await pool.query<{ id: string; spec: Record<string, unknown> }>(
      "SELECT id, spec FROM label_templates ORDER BY id",
    );
    const specs = new Map(result.rows.map((row) => [row.id.slice(-3), row.spec]));

    const base = specs.get("901") as { elements: Array<Record<string, unknown>> };
    expect(base.elements.find((element) => element.id === "val-date")?.yMm).toBe(21.6);
    expect(base.elements.find((element) => element.id === "val-expiry")?.yMm).toBe(21.6);
    expect(base.elements.find((element) => element.id === "val-qty")?.yMm).toBe(20.9);

    const large = specs.get("902") as { elements: Array<Record<string, unknown>> };
    expect(large.elements.find((element) => element.id === "val-date")?.yMm).toBe(36.6);
    expect(large.elements.find((element) => element.id === "val-expiry")?.yMm).toBe(36.6);
    expect(large.elements.find((element) => element.id === "val-qty")?.yMm).toBe(35.4);

    expect(specs.get("903")).toEqual({ "date-free": true });
    expect(specs.get("904")).toEqual({ mine: true });
  });
});
