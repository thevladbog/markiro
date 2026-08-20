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
 * 0051 is the third and current force-overwrite of the five stock templates
 * (0049 seeded them, 0050 reseeded them). Its one change over 0050 is
 * `val-sscc` gaining `"align":"center"` — the second physical print's finding
 * that the barcode was centred but its human-readable digit line was not.
 *
 * The force-overwrite semantics are unchanged and re-asserted here rather than
 * inherited from 0050's test: a migration that stopped reaching hand-edited
 * rows, or started touching a tenant's own template, would be a production
 * behaviour change nobody asked for.
 */
describe.skipIf(!databaseUrl)("center SSCC digits label templates migration", () => {
  const databaseName = `markiro_center_sscc_digits_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenancePool = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: scratchUrl.toString() });
  let created = false;

  // `migrate()` runs 0051 against a database with no organizations, so it
  // updates nothing; the rows the assertions need are created afterwards and
  // the migration's SQL is replayed directly, exactly as the 0049/0050 tests
  // do.
  async function runReseed(): Promise<void> {
    const sql = await readFile(
      join(migrationsFolder, "0051_center_sscc_digits_label_templates.sql"),
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

  it("centres the SSCC digit line in every tenant's seed-named templates, and nothing else", async () => {
    await pool.query(
      "INSERT INTO organization (id, name, slug, created_at) VALUES ('cs-a','A','cs-a',now()), ('cs-b','B','cs-b',now())",
    );
    // Tenant A carries the 0050-era spec (correct in every respect EXCEPT the
    // left-flush digit line); tenant B's is a hand-edited one, the case the
    // owner accepted losing; plus a template whose name is not a seed name and
    // must survive untouched.
    const previous = JSON.stringify({
      widthMm: 58,
      heightMm: 40,
      dpi: 203,
      language: "zpl",
      elements: [
        {
          kind: "barcode",
          id: "bc-sscc",
          xMm: 9.5,
          yMm: 32,
          format: "code128",
          data: "sscc",
          sizeMm: 4.8,
          moduleWidthMm: 0.2502,
        },
        {
          kind: "field",
          id: "val-sscc",
          xMm: 2,
          yMm: 37,
          field: "sscc",
          fontSizePt: 5,
          maxWidthMm: 54,
        },
      ],
    });
    await pool.query(
      `INSERT INTO label_templates (id, tenant_id, name, spec, updated_at) VALUES
         ('00000000-0000-4000-8000-000000000901', 'cs-a', $1, $3::jsonb, '2020-01-01T00:00:00Z'),
         ('00000000-0000-4000-8000-000000000902', 'cs-b', $1, '{"hand-edited":true}'::jsonb, '2020-01-01T00:00:00Z'),
         ('00000000-0000-4000-8000-000000000903', 'cs-b', $2, '{"stale":true}'::jsonb, '2020-01-01T00:00:00Z'),
         ('00000000-0000-4000-8000-000000000904', 'cs-b', 'Моя этикетка', '{"mine":true}'::jsonb, '2020-01-01T00:00:00Z')`,
      [SEED_NAME, OTHER_SEED_NAME, previous],
    );

    await runReseed();
    await runReseed(); // idempotency: a second pass writes the same spec

    const rows = await pool.query<{ id: string; spec: Record<string, unknown> }>(
      "SELECT id, spec FROM label_templates",
    );
    const specs = new Map(rows.rows.map((r) => [r.id.slice(-3), r.spec]));

    for (const suffix of ["901", "902"]) {
      const spec = specs.get(suffix) as { elements: Array<Record<string, unknown>> };
      const digits = spec.elements.find((el) => el.id === "val-sscc");
      // The fix itself.
      expect(digits?.align, `${suffix}: SSCC digit-line alignment`).toBe("center");
      expect(digits?.maxWidthMm, `${suffix}: digit-line box`).toBe(54);
      // ...and everything 0050 established is still there.
      const barcode = spec.elements.find((el) => el.id === "bc-sscc");
      expect(barcode?.xMm, `${suffix}: centred barcode x`).toBe(9.5);
      expect(barcode?.moduleWidthMm, `${suffix}: module width`).toBe(0.2502);
      expect(spec.elements.find((el) => el.id === "name")?.maxLines, `${suffix}: name lines`).toBe(
        3,
      );
    }

    // A different seed name is reseeded too, and its digit line is centred as
    // well — the fix is applied to all five templates, not just the 58×40.
    const other = specs.get("903") as {
      widthMm: number;
      elements: Array<Record<string, unknown>>;
    };
    expect(other.widthMm).toBe(100);
    expect(other.elements.find((el) => el.id === "val-sscc")?.align).toBe("center");

    // ...but a tenant's own template is not touched at all.
    expect(specs.get("904")).toEqual({ mine: true });
  });
});
