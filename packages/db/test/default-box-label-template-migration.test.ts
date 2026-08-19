import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
const stableUpdatedAt = new Date("2024-01-02T03:04:05.000Z");

type TenantFixture = {
  readonly tenantId: string;
  readonly templateIds: readonly string[];
  readonly expectedDefaultTemplateId: string | null;
};

const fixtures: readonly TenantFixture[] = [
  {
    tenantId: "default-box-label-sole",
    templateIds: ["00000000-0000-4000-8000-000000000101"],
    expectedDefaultTemplateId: "00000000-0000-4000-8000-000000000101",
  },
  {
    tenantId: "default-box-label-none",
    templateIds: [],
    expectedDefaultTemplateId: null,
  },
  {
    tenantId: "default-box-label-many",
    templateIds: ["00000000-0000-4000-8000-000000000301", "00000000-0000-4000-8000-000000000302"],
    expectedDefaultTemplateId: null,
  },
  {
    tenantId: "default-box-label-foreign",
    templateIds: ["00000000-0000-4000-8000-000000000401"],
    expectedDefaultTemplateId: "00000000-0000-4000-8000-000000000401",
  },
];

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error("Unsafe temporary database identifier");
  }
  return `"${identifier}"`;
}

describe.skipIf(!databaseUrl)("default box label template migration", () => {
  const databaseName = `markiro_default_box_label_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenancePool = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: scratchUrl.toString() });
  let legacyMigrationsFolder = "";
  let created = false;

  async function seedTenant(fixture: TenantFixture, index: number): Promise<void> {
    await pool.query(
      "INSERT INTO organization (id, name, slug, created_at) VALUES ($1, $2, $3, $4)",
      [fixture.tenantId, fixture.tenantId, `${fixture.tenantId}-${index}`, stableUpdatedAt],
    );
    for (const [templateIndex, templateId] of fixture.templateIds.entries()) {
      await pool.query(
        "INSERT INTO label_templates (id, tenant_id, name, spec) VALUES ($1, $2, $3, '{}'::jsonb)",
        [templateId, fixture.tenantId, `Template ${templateIndex + 1}`],
      );
    }

    if (fixture.tenantId === "default-box-label-sole") {
      const logoAssetId = "00000000-0000-4000-8000-000000000001";
      await pool.query(
        `INSERT INTO organization_logo_assets
          (id, tenant_id, object_key, content_type, byte_size, checksum, width, height)
         VALUES ($1, $2, $3, 'image/webp', 1, 'sole-logo-checksum', 1, 1)`,
        [logoAssetId, fixture.tenantId, `tenants/${fixture.tenantId}/branding/${logoAssetId}.webp`],
      );
      await pool.query(
        `INSERT INTO org_profiles
          (tenant_id, gln, gs1_prefixes, inn, logo_asset_id, updated_at)
         VALUES ($1, '4601234567890', ARRAY['46012', '46013'], '7701234567', $2, $3)`,
        [fixture.tenantId, logoAssetId, stableUpdatedAt],
      );
    } else if (fixture.tenantId !== "default-box-label-foreign") {
      await pool.query("INSERT INTO org_profiles (tenant_id) VALUES ($1)", [fixture.tenantId]);
    }

    const productId = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    await pool.query("INSERT INTO products (id, tenant_id, gtin14, name) VALUES ($1, $2, $3, $4)", [
      productId,
      fixture.tenantId,
      `04600000000${String(index).padStart(3, "0")}`,
      "Migration product",
    ]);

    const shiftRows =
      fixture.tenantId === "default-box-label-sole"
        ? [
            ["00000000-0000-4000-8000-000000000111", "aggregation", "planned", null],
            ["00000000-0000-4000-8000-000000000112", "aggregation", "active", null],
            ["00000000-0000-4000-8000-000000000113", "validation", "active", null],
            ["00000000-0000-4000-8000-000000000114", "aggregation", "closed", null],
            [
              "00000000-0000-4000-8000-000000000115",
              "aggregation",
              "planned",
              fixture.templateIds[0],
            ],
          ]
        : [
            [
              `00000000-0000-4000-8000-${String(index + 101).padStart(12, "0")}`,
              "aggregation",
              "active",
              null,
            ],
          ];

    for (const [shiftId, mode, status, boxLabelTemplateId] of shiftRows) {
      await pool.query(
        `INSERT INTO shifts (id, tenant_id, product_id, mode, status, box_label_template_id)
         VALUES ($1, $2, $3, $4::shift_mode, $5::shift_status, $6::uuid)`,
        [shiftId, fixture.tenantId, productId, mode, status, boxLabelTemplateId],
      );
    }
  }

  async function snapshot(): Promise<unknown> {
    const result = await pool.query(
      `SELECT p.tenant_id, p.default_box_label_template_id, p.gln, p.gs1_prefixes, p.inn,
              p.logo_asset_id, p.updated_at,
              coalesce(
                json_agg(
                  json_build_object(
                    'id', s.id,
                    'mode', s.mode,
                    'status', s.status,
                    'boxLabelTemplateId', s.box_label_template_id
                  ) ORDER BY s.id
                ) FILTER (WHERE s.id IS NOT NULL),
                '[]'::json
              ) AS shifts
       FROM org_profiles AS p
       LEFT JOIN shifts AS s ON s.tenant_id = p.tenant_id
       WHERE p.tenant_id LIKE 'default-box-label-%'
       GROUP BY p.tenant_id, p.default_box_label_template_id, p.gln, p.gs1_prefixes, p.inn,
                p.logo_asset_id, p.updated_at
       ORDER BY p.tenant_id`,
    );
    return result.rows;
  }

  beforeAll(async () => {
    await maintenancePool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    created = true;
    legacyMigrationsFolder = await mkdtemp(join(tmpdir(), "markiro-default-box-label-migration-"));
    await cp(migrationsFolder, legacyMigrationsFolder, { recursive: true });
    await rm(join(legacyMigrationsFolder, "0042_default_box_label_template.sql"), { force: true });
    await rm(join(legacyMigrationsFolder, "0043_station_shift_close_presence.sql"), {
      force: true,
    });
    await rm(join(legacyMigrationsFolder, "0044_landing_demo_email.sql"), { force: true });
    await rm(join(legacyMigrationsFolder, "0045_flawless_overlord.sql"), { force: true });
    await rm(join(legacyMigrationsFolder, "0046_product_shelf_life_days.sql"), { force: true });
    await rm(join(legacyMigrationsFolder, "0047_default_label_templates.sql"), { force: true });
    await rm(join(legacyMigrationsFolder, "meta", "0042_snapshot.json"), { force: true });
    await rm(join(legacyMigrationsFolder, "meta", "0043_snapshot.json"), { force: true });
    await rm(join(legacyMigrationsFolder, "meta", "0044_snapshot.json"), { force: true });
    await rm(join(legacyMigrationsFolder, "meta", "0045_snapshot.json"), { force: true });
    await rm(join(legacyMigrationsFolder, "meta", "0046_snapshot.json"), { force: true });
    await rm(join(legacyMigrationsFolder, "meta", "0047_snapshot.json"), { force: true });
    const journalPath = join(legacyMigrationsFolder, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
      entries: Array<{ tag: string }>;
    };
    journal.entries = journal.entries.filter(
      (entry) =>
        entry.tag !== "0042_default_box_label_template" &&
        entry.tag !== "0043_station_shift_close_presence" &&
        entry.tag !== "0044_landing_demo_email" &&
        entry.tag !== "0045_flawless_overlord" &&
        entry.tag !== "0046_product_shelf_life_days" &&
        entry.tag !== "0047_default_label_templates",
    );
    expect(journal.entries.at(-1)?.tag).toBe("0041_product_images");
    await writeFile(journalPath, JSON.stringify(journal));

    await migrate(drizzle(pool), { migrationsFolder: legacyMigrationsFolder });
    for (const [index, fixture] of fixtures.entries()) {
      await seedTenant(fixture, index);
    }
    await migrate(drizzle(pool), { migrationsFolder });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (created) {
      await maintenancePool.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`);
    }
    await maintenancePool.end();
    if (legacyMigrationsFolder) {
      await rm(legacyMigrationsFolder, { recursive: true, force: true });
    }
  });

  it("selects only sole tenant templates, preserves profile data, and is idempotent", async () => {
    const firstSnapshot = await snapshot();
    expect(firstSnapshot).toEqual([
      {
        tenant_id: "default-box-label-foreign",
        default_box_label_template_id: "00000000-0000-4000-8000-000000000401",
        gln: null,
        gs1_prefixes: [],
        inn: null,
        logo_asset_id: null,
        updated_at: expect.any(Date),
        shifts: [
          {
            id: "00000000-0000-4000-8000-000000000104",
            mode: "aggregation",
            status: "active",
            boxLabelTemplateId: "00000000-0000-4000-8000-000000000401",
          },
        ],
      },
      {
        tenant_id: "default-box-label-many",
        default_box_label_template_id: null,
        gln: null,
        gs1_prefixes: [],
        inn: null,
        logo_asset_id: null,
        updated_at: expect.any(Date),
        shifts: [
          {
            id: "00000000-0000-4000-8000-000000000103",
            mode: "aggregation",
            status: "active",
            boxLabelTemplateId: null,
          },
        ],
      },
      {
        tenant_id: "default-box-label-none",
        default_box_label_template_id: null,
        gln: null,
        gs1_prefixes: [],
        inn: null,
        logo_asset_id: null,
        updated_at: expect.any(Date),
        shifts: [
          {
            id: "00000000-0000-4000-8000-000000000102",
            mode: "aggregation",
            status: "active",
            boxLabelTemplateId: null,
          },
        ],
      },
      {
        tenant_id: "default-box-label-sole",
        default_box_label_template_id: "00000000-0000-4000-8000-000000000101",
        gln: "4601234567890",
        gs1_prefixes: ["46012", "46013"],
        inn: "7701234567",
        logo_asset_id: "00000000-0000-4000-8000-000000000001",
        updated_at: stableUpdatedAt,
        shifts: [
          {
            id: "00000000-0000-4000-8000-000000000111",
            mode: "aggregation",
            status: "planned",
            boxLabelTemplateId: "00000000-0000-4000-8000-000000000101",
          },
          {
            id: "00000000-0000-4000-8000-000000000112",
            mode: "aggregation",
            status: "active",
            boxLabelTemplateId: "00000000-0000-4000-8000-000000000101",
          },
          {
            id: "00000000-0000-4000-8000-000000000113",
            mode: "validation",
            status: "active",
            boxLabelTemplateId: null,
          },
          {
            id: "00000000-0000-4000-8000-000000000114",
            mode: "aggregation",
            status: "closed",
            boxLabelTemplateId: null,
          },
          {
            id: "00000000-0000-4000-8000-000000000115",
            mode: "aggregation",
            status: "planned",
            boxLabelTemplateId: "00000000-0000-4000-8000-000000000101",
          },
        ],
      },
    ]);

    await pool.query(
      "UPDATE org_profiles SET default_box_label_template_id = $2 WHERE tenant_id = $1",
      ["default-box-label-many", "00000000-0000-4000-8000-000000000302"],
    );
    const migrationStatements = (
      await readFile(join(migrationsFolder, "0042_default_box_label_template.sql"), "utf8")
    ).split("--> statement-breakpoint");
    const defaultsStatement = migrationStatements[2];
    const shiftsStatement = migrationStatements[3];
    if (!defaultsStatement || !shiftsStatement) {
      throw new Error("Default box label template migration is missing its data statements");
    }
    await pool.query(defaultsStatement);
    await pool.query(shiftsStatement);

    const preservedDefault = await pool.query(
      `SELECT p.default_box_label_template_id, s.box_label_template_id
       FROM org_profiles AS p
       JOIN shifts AS s ON s.tenant_id = p.tenant_id
       WHERE p.tenant_id = 'default-box-label-many'`,
    );
    expect(preservedDefault.rows).toEqual([
      {
        default_box_label_template_id: "00000000-0000-4000-8000-000000000302",
        box_label_template_id: "00000000-0000-4000-8000-000000000302",
      },
    ]);

    const secondSnapshot = await snapshot();
    await migrate(drizzle(pool), { migrationsFolder });
    expect(await snapshot()).toEqual(secondSnapshot);
  });
});
