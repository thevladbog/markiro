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
const migrationPath = fileURLToPath(
  new URL("../migrations/0030_saas_catalog_subscriptions.sql", import.meta.url),
);

describe("SaaS migration contract", () => {
  it("contains database-enforced append-only and published-version guards", async () => {
    const migration = await readFile(migrationPath, "utf8");
    expect(migration).toContain("reject_published_catalog_version_mutation");
    expect(migration).toContain("reject_published_catalog_effect_mutation");
    expect(migration).toContain("reject_published_offer_mutation");
    expect(migration).toContain("reject_published_offer_line_mutation");
    expect(migration).toContain("reject_append_only_mutation");
  });
});

describe.skipIf(!databaseUrl)("SaaS migration behavior", () => {
  const databaseName = `markiro_saas_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenancePool = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: scratchUrl.toString() });
  let temporaryRoot = "";
  let created = false;

  function quoteIdentifier(identifier: string): string {
    if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
      throw new Error("Unsafe temporary database identifier");
    }
    return `"${identifier}"`;
  }

  beforeAll(async () => {
    await maintenancePool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-saas-migration-"));
    const legacyMigrations = join(temporaryRoot, "migrations");
    await cp(migrationsFolder, legacyMigrations, { recursive: true });
    await rm(join(legacyMigrations, "0030_saas_catalog_subscriptions.sql"));
    await rm(join(legacyMigrations, "meta", "0030_snapshot.json"));
    const journalPath = join(legacyMigrations, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
      entries: Array<{ tag: string }>;
    };
    journal.entries = journal.entries.filter(
      (entry) => entry.tag !== "0030_saas_catalog_subscriptions",
    );
    await writeFile(journalPath, JSON.stringify(journal));

    await migrate(drizzle(pool), { migrationsFolder: legacyMigrations });
    await pool.query(
      "INSERT INTO organization (id, name, slug, created_at) VALUES ($1, $2, $3, $4)",
      ["existing-unmanaged", "Existing unmanaged", "existing-unmanaged", new Date()],
    );
    await migrate(drizzle(pool), { migrationsFolder });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (created) {
      await maintenancePool.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`);
    }
    await maintenancePool.end();
    if (temporaryRoot) {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("preserves existing organizations as unmanaged tenants", async () => {
    const result = await pool.query(
      "SELECT count(*)::int AS count FROM tenant_subscriptions WHERE tenant_id = $1",
      ["existing-unmanaged"],
    );
    expect(result.rows[0]?.count).toBe(0);
  });

  it("rejects update and deletion of a published catalog version", async () => {
    const catalogItemId = randomUUID();
    const versionId = randomUUID();
    await pool.query(
      "INSERT INTO catalog_items (id, code, name_ru, name_en, kind) VALUES ($1, $2, $3, $4, 'service')",
      [catalogItemId, `service-${catalogItemId}`, "Услуга", "Service"],
    );
    await pool.query(
      "INSERT INTO catalog_item_versions (id, catalog_item_id, kind, version, status, name_ru, name_en, unit, billing_mode, unit_price, vat_included, published_at) VALUES ($1, $2, 'service', 1, 'published', $3, $4, 'service', 'one_time', '100.00', true, now())",
      [versionId, catalogItemId, "Услуга", "Service"],
    );

    await expect(
      pool.query("UPDATE catalog_item_versions SET name_en = 'Changed' WHERE id = $1", [versionId]),
    ).rejects.toThrow();
    await expect(
      pool.query("DELETE FROM catalog_item_versions WHERE id = $1", [versionId]),
    ).rejects.toThrow();
  });

  it("rejects a second current subscription for one tenant", async () => {
    const catalogItemId = randomUUID();
    const versionId = randomUUID();
    await pool.query(
      "INSERT INTO catalog_items (id, code, name_ru, name_en, kind) VALUES ($1, $2, $3, $4, 'plan')",
      [catalogItemId, `plan-${catalogItemId}`, "План", "Plan"],
    );
    await pool.query(
      "INSERT INTO catalog_item_versions (id, catalog_item_id, kind, version, status, name_ru, name_en, unit, billing_mode, billing_period, unit_price, vat_included, published_at) VALUES ($1, $2, 'plan', 1, 'published', $3, $4, 'subscription', 'recurring', 'month', '100.00', true, now())",
      [versionId, catalogItemId, "План", "Plan"],
    );
    await pool.query(
      "INSERT INTO tenant_subscriptions (tenant_id, plan_version_id, status, source) VALUES ($1, $2, 'active', 'manual')",
      ["existing-unmanaged", versionId],
    );

    await expect(
      pool.query(
        "INSERT INTO tenant_subscriptions (tenant_id, plan_version_id, status, source) VALUES ($1, $2, 'trial', 'demo')",
        ["existing-unmanaged", versionId],
      ),
    ).rejects.toThrow();
  });

  it("rejects a negative add-on effect", async () => {
    const catalogItemId = randomUUID();
    const versionId = randomUUID();
    await pool.query(
      "INSERT INTO catalog_items (id, code, name_ru, name_en, kind) VALUES ($1, $2, $3, $4, 'addon')",
      [catalogItemId, `addon-${catalogItemId}`, "Дополнение", "Add-on"],
    );
    await pool.query(
      "INSERT INTO catalog_item_versions (id, catalog_item_id, kind, version, status, name_ru, name_en, unit, billing_mode, billing_period, unit_price, vat_included) VALUES ($1, $2, 'addon', 1, 'draft', $3, $4, 'unit', 'recurring', 'month', '100.00', true)",
      [versionId, catalogItemId, "Дополнение", "Add-on"],
    );

    await expect(
      pool.query(
        "INSERT INTO addon_entitlements (catalog_version_id, entitlement_key, quota_increment, feature_enabled) VALUES ($1, 'lines', -1, false)",
        [versionId],
      ),
    ).rejects.toThrow();
  });
});
