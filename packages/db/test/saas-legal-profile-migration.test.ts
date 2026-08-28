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

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) throw new Error("Unsafe database identifier");
  return `"${identifier}"`;
}

describe.skipIf(!databaseUrl)("SaaS legal-profile migration", () => {
  const databaseName = `markiro_legal_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenancePool = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: scratchUrl.toString() });
  let temporaryRoot = "";
  let created = false;

  beforeAll(async () => {
    await maintenancePool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-legal-profile-migration-"));
    const legacyMigrations = join(temporaryRoot, "migrations");
    await cp(migrationsFolder, legacyMigrations, { recursive: true });
    await rm(join(legacyMigrations, "0060_saas_legal_profiles.sql"), { force: true });
    await rm(join(legacyMigrations, "0061_saas_bank_accounts.sql"), { force: true });
    await rm(join(legacyMigrations, "0062_document_account_snapshots.sql"), { force: true });
    await rm(join(legacyMigrations, "0063_payment_account_evidence.sql"), { force: true });
    await rm(join(legacyMigrations, "0064_normalize_operator_billing_profile_kind.sql"), {
      force: true,
    });
    await rm(join(legacyMigrations, "0065_saas_party_actual_addresses.sql"), { force: true });
    await rm(join(legacyMigrations, "0066_panoramic_hemingway.sql"), { force: true });
    await rm(join(legacyMigrations, "0067_flashy_outlaw_kid.sql"), { force: true });
    await rm(join(legacyMigrations, "0068_inventory_protected_date_precedence.sql"), {
      force: true,
    });
    await rm(join(legacyMigrations, "0069_inventory_station_manifest.sql"), { force: true });
    await rm(join(legacyMigrations, "0070_curious_big_bertha.sql"), { force: true });
    await rm(join(legacyMigrations, "meta", "0060_snapshot.json"), { force: true });
    await rm(join(legacyMigrations, "meta", "0061_snapshot.json"), { force: true });
    await rm(join(legacyMigrations, "meta", "0064_snapshot.json"), { force: true });
    await rm(join(legacyMigrations, "meta", "0065_snapshot.json"), { force: true });
    await rm(join(legacyMigrations, "meta", "0069_snapshot.json"), { force: true });
    await rm(join(legacyMigrations, "meta", "0070_snapshot.json"), { force: true });
    const journalPath = join(legacyMigrations, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
      entries: Array<{ tag: string }>;
    };
    journal.entries = journal.entries.filter((entry) => Number(entry.tag.slice(0, 4)) < 60);
    await writeFile(journalPath, JSON.stringify(journal));

    await migrate(drizzle(pool), { migrationsFolder: legacyMigrations });
    await pool.query(
      "INSERT INTO organization (id, name, slug, created_at) VALUES ('legal-tenant', 'Legal tenant', 'legal-tenant', now())",
    );
    await pool.query(
      "INSERT INTO platform_users (id, name, email, role, status) VALUES ('legal-admin', 'Legal admin', 'legal-admin@example.invalid', 'platform_admin', 'active')",
    );
    await pool.query(
      `INSERT INTO operator_billing_profiles
         (id, revision, is_current, kind, display_name, inn, kpp, ogrn, address_raw, address, created_by_platform_user_id)
       VALUES
         ('00000000-0000-4000-8000-000000000601', 1, true, 'individual', 'Маркиро', '7700000000', '770001001', '1027700000000', 'г Москва', '{"city":"Москва"}'::jsonb, 'legal-admin')`,
    );
    await pool.query(
      `INSERT INTO tenant_billing_profiles
         (id, tenant_id, revision, is_current, kind, display_name, address_raw, address, created_by_platform_user_id)
       VALUES
         ('00000000-0000-4000-8000-000000000602', 'legal-tenant', 1, true, 'individual', 'Иванов И. И.', 'г Казань', '{"city":"Казань"}'::jsonb, 'legal-admin')`,
    );

    await migrate(drizzle(pool), { migrationsFolder });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (created) await maintenancePool.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`);
    await maintenancePool.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("adds legal, actual, postal, and confirmation columns and safely backfills legacy profiles", async () => {
    const columns = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name IN ('operator_billing_profiles', 'tenant_billing_profiles')
         AND column_name IN (
           'full_name', 'legal_address_raw', 'legal_address',
           'actual_same_as_legal', 'actual_address_raw', 'actual_address', 'postal_same_as_legal',
           'postal_address_raw', 'postal_address', 'is_confirmed',
           'confirmed_by_platform_user_id', 'confirmed_at'
         )
       ORDER BY table_name, column_name`,
    );
    expect(columns.rows).toHaveLength(24);

    const operator = await pool.query(
      `SELECT kind, full_name, legal_address_raw, legal_address,
              actual_same_as_legal, actual_address_raw, actual_address, postal_same_as_legal,
              postal_address_raw, postal_address, is_confirmed,
              confirmed_by_platform_user_id, confirmed_at
       FROM operator_billing_profiles
       WHERE id = '00000000-0000-4000-8000-000000000601'`,
    );
    expect(operator.rows).toHaveLength(1);
    expect(operator.rows[0]).toMatchObject({
      kind: "legal_entity",
      full_name: "Маркиро",
      legal_address_raw: "г Москва",
      legal_address: { value: "г Москва", city: "Москва" },
      actual_same_as_legal: true,
      actual_address_raw: null,
      actual_address: null,
      postal_same_as_legal: false,
      postal_address_raw: null,
      postal_address: null,
      is_confirmed: false,
      confirmed_by_platform_user_id: null,
      confirmed_at: null,
    });
    const constraints = await pool.query<{ constraint_name: string }>(
      `SELECT constraint_name
       FROM information_schema.table_constraints
       WHERE constraint_schema = 'public'
         AND table_name = 'operator_billing_profiles'
         AND constraint_name = 'operator_billing_profiles_legal_entity_check'`,
    );
    expect(constraints.rows).toEqual([]);

    await expect(
      pool.query(
        `INSERT INTO operator_billing_profiles
           (id, revision, is_current, kind, full_name, display_name, address_raw,
            legal_address_raw, actual_same_as_legal, actual_address_raw, created_by_platform_user_id)
         VALUES
           ('00000000-0000-4000-8000-000000000603', 2, false, 'individual', 'Иван Иванов',
            'Иван Иванов', 'г Москва', 'г Москва', true, 'г Казань', 'legal-admin')`,
      ),
    ).rejects.toThrow("operator_billing_profiles_actual_same_check");
  });
});
