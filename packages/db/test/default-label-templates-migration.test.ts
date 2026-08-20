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

const SEED_NAMES = [
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

describe.skipIf(!databaseUrl)("default label templates migration", () => {
  const databaseName = `markiro_default_label_templates_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenancePool = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: scratchUrl.toString() });
  let created = false;

  // 0049's own pass (run inside migrate() below) sees no orgs, so it seeds
  // nothing; the orgs used by the test are created afterward and backfilled
  // by re-running the migration's SQL directly.
  async function runBackfill(): Promise<void> {
    const sql = await readFile(join(migrationsFolder, "0049_default_label_templates.sql"), "utf8");
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

  it("seeds five templates per tenant, skips name collisions, and is idempotent", async () => {
    // Orgs created AFTER migrate() ran, so 0049's original pass saw nothing.
    await pool.query(
      "INSERT INTO organization (id, name, slug, created_at) VALUES ('lt-a','A','lt-a',now()), ('lt-b','B','lt-b',now())",
    );
    // Tenant B already owns a template with a colliding seed name.
    await pool.query(
      `INSERT INTO label_templates (id, tenant_id, name, spec)
       VALUES ('00000000-0000-4000-8000-000000000901', 'lt-b', 'Коробка 58×40 (203 dpi)', '{"marker":true}'::jsonb)`,
    );

    await runBackfill();
    await runBackfill(); // idempotency

    const a = await pool.query(
      "SELECT name FROM label_templates WHERE tenant_id = 'lt-a' ORDER BY name",
    );
    expect(a.rows.map((r) => r.name).sort()).toEqual([...SEED_NAMES].sort());

    const b = await pool.query(
      "SELECT name, spec FROM label_templates WHERE tenant_id = 'lt-b' ORDER BY name",
    );
    expect(b.rows).toHaveLength(5); // 1 pre-existing + 4 seeded
    const kept = b.rows.find((r) => r.name === "Коробка 58×40 (203 dpi)");
    expect(kept.spec).toEqual({ marker: true }); // never overwritten
  });
});
