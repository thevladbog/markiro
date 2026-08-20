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

const SEED_NAME = "Коробка 58×40 (203 dpi)";
const OTHER_SEED_NAME = "Коробка 100×150 (203 dpi)";

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error("Unsafe temporary database identifier");
  }
  return `"${identifier}"`;
}

/**
 * 0050 is the FORCE-OVERWRITE half of the default-template story: 0049 seeds
 * the five stock templates into tenants that lack them and deliberately skips
 * name collisions, while this one replaces the spec of every row carrying a
 * seed name, in every tenant, whatever is currently in it. The product owner
 * chose that explicitly, so the discarded-edit case is asserted here rather
 * than left to be discovered in production.
 */
describe.skipIf(!databaseUrl)("reseed default label templates migration", () => {
  const databaseName = `markiro_reseed_label_templates_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenancePool = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: scratchUrl.toString() });
  let created = false;

  // `migrate()` runs 0050 against a database with no organizations, so it
  // updates nothing; the rows the assertions need are created afterwards and
  // the migration's SQL is replayed directly, exactly as the 0049 test does.
  async function runReseed(): Promise<void> {
    const sql = await readFile(
      join(migrationsFolder, "0050_reseed_default_label_templates.sql"),
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

  it("overwrites every seed-named template in every tenant, and nothing else", async () => {
    await pool.query(
      "INSERT INTO organization (id, name, slug, created_at) VALUES ('rs-a','A','rs-a',now()), ('rs-b','B','rs-b',now())",
    );
    // Two tenants with a stale seed-named template — tenant B's is a MANUALLY
    // EDITED one, the case the owner accepted losing — plus a template whose
    // name is not a seed name and must survive untouched.
    await pool.query(
      `INSERT INTO label_templates (id, tenant_id, name, spec, updated_at) VALUES
         ('00000000-0000-4000-8000-000000000801', 'rs-a', $1, '{"stale":true}'::jsonb, '2020-01-01T00:00:00Z'),
         ('00000000-0000-4000-8000-000000000802', 'rs-b', $1, '{"hand-edited":true}'::jsonb, '2020-01-01T00:00:00Z'),
         ('00000000-0000-4000-8000-000000000803', 'rs-b', $2, '{"stale":true}'::jsonb, '2020-01-01T00:00:00Z'),
         ('00000000-0000-4000-8000-000000000804', 'rs-b', 'Моя этикетка', '{"mine":true}'::jsonb, '2020-01-01T00:00:00Z')`,
      [SEED_NAME, OTHER_SEED_NAME],
    );

    await runReseed();
    await runReseed(); // idempotency: a second pass writes the same spec

    const rows = await pool.query<{ id: string; spec: Record<string, unknown> }>(
      "SELECT id, spec FROM label_templates",
    );
    const specs = new Map(rows.rows.map((r) => [r.id.slice(-3), r.spec]));

    // Both tenants' 58×40 rows now carry the CURRENT spec — including the
    // three corrections the first physical print asked for.
    for (const suffix of ["801", "802"]) {
      const spec = specs.get(suffix) as { elements: Array<Record<string, unknown>> };
      const name = spec.elements.find((el) => el.id === "name");
      expect(name?.maxLines, `${suffix}: product name lines`).toBe(3);
      const barcode = spec.elements.find((el) => el.id === "bc-sscc");
      expect(barcode?.moduleWidthMm, `${suffix}: module width`).toBe(0.2502);
      expect(barcode?.xMm, `${suffix}: centred x`).toBe(9.5);
      expect(
        spec.elements.some((el) => el.id === "cap-sscc"),
        `${suffix}: the SSCC caption is back`,
      ).toBe(false);
    }

    // A different seed name is reseeded too...
    expect((specs.get("803") as { widthMm: number }).widthMm).toBe(100);
    // ...but a tenant's own template is not touched at all.
    expect(specs.get("804")).toEqual({ mine: true });
  });
});
