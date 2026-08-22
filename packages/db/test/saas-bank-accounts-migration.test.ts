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

describe.skipIf(!databaseUrl)("SaaS bank-account migration", () => {
  const databaseName = `markiro_banks_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenancePool = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: scratchUrl.toString() });
  let temporaryRoot = "";
  let created = false;

  async function rerunImport(): Promise<void> {
    const migration = await readFile(join(migrationsFolder, "0061_saas_bank_accounts.sql"), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      const sql = statement.trim();
      if (
        sql.startsWith('INSERT INTO "operator_bank_accounts"') ||
        sql.startsWith('INSERT INTO "tenant_bank_accounts"')
      ) {
        await pool.query(sql);
      }
    }
  }

  beforeAll(async () => {
    await maintenancePool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-bank-account-migration-"));
    const legacyMigrations = join(temporaryRoot, "migrations");
    await cp(migrationsFolder, legacyMigrations, { recursive: true });
    await rm(join(legacyMigrations, "0061_saas_bank_accounts.sql"), { force: true });
    await rm(join(legacyMigrations, "0062_document_account_snapshots.sql"), { force: true });
    await rm(join(legacyMigrations, "0063_payment_account_evidence.sql"), { force: true });
    await rm(join(legacyMigrations, "0064_normalize_operator_billing_profile_kind.sql"), {
      force: true,
    });
    await rm(join(legacyMigrations, "meta", "0061_snapshot.json"), { force: true });
    await rm(join(legacyMigrations, "meta", "0064_snapshot.json"), { force: true });
    const journalPath = join(legacyMigrations, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
      entries: Array<{ tag: string }>;
    };
    journal.entries = journal.entries.filter(
      (entry) =>
        entry.tag !== "0061_saas_bank_accounts" &&
        entry.tag !== "0062_document_account_snapshots" &&
        entry.tag !== "0063_payment_account_evidence" &&
        entry.tag !== "0064_normalize_operator_billing_profile_kind",
    );
    await writeFile(journalPath, JSON.stringify(journal));

    await migrate(drizzle(pool), { migrationsFolder: legacyMigrations });
    await pool.query(
      `INSERT INTO organization (id, name, slug, created_at) VALUES
       ('bank-complete', 'Complete', 'bank-complete', now()),
       ('bank-incomplete', 'Incomplete', 'bank-incomplete', now()),
       ('bank-ambiguous', 'Ambiguous', 'bank-ambiguous', now())`,
    );
    await pool.query(
      `INSERT INTO platform_users (id, name, email, role, status)
       VALUES ('bank-admin', 'Bank admin', 'bank-admin@example.invalid', 'platform_admin', 'active')`,
    );
    const complete = JSON.stringify({
      label: "Расчётный",
      settlementAccount: "40702810900000000001",
      bic: "044525225",
      bankName: "ПАО Сбербанк",
      correspondentAccount: "30101810400000000225",
    });
    const incomplete = JSON.stringify({ bic: "044525225", bankName: "ПАО Сбербанк" });
    const ambiguous = JSON.stringify({
      label: "Лишние данные",
      settlementAccount: "40702810900000000002",
      bic: "044525225",
      bankName: "ПАО Сбербанк",
      correspondentAccount: "30101810400000000225",
      account: "40702810900000000003",
    });
    await pool.query(
      `INSERT INTO operator_billing_profiles
         (id, revision, is_current, kind, full_name, display_name, address_raw,
          legal_address_raw, postal_same_as_legal, bank_details, is_confirmed,
          created_by_platform_user_id)
       VALUES ('00000000-0000-4000-8000-000000000621', 1, true, 'legal_entity',
               'ООО Маркиро', 'Маркиро', 'Москва', 'Москва', true, $1::jsonb, false, 'bank-admin')`,
      [complete],
    );
    await pool.query(
      `INSERT INTO tenant_billing_profiles
         (id, tenant_id, revision, is_current, kind, full_name, display_name, address_raw,
          legal_address_raw, postal_same_as_legal, bank_details, is_confirmed,
          created_by_platform_user_id)
       VALUES
         ('00000000-0000-4000-8000-000000000622', 'bank-complete', 1, true, 'individual', 'Complete', 'Complete', 'A', 'A', true, $1::jsonb, false, 'bank-admin'),
         ('00000000-0000-4000-8000-000000000623', 'bank-incomplete', 1, true, 'individual', 'Incomplete', 'Incomplete', 'B', 'B', true, $2::jsonb, false, 'bank-admin'),
         ('00000000-0000-4000-8000-000000000624', 'bank-ambiguous', 1, true, 'individual', 'Ambiguous', 'Ambiguous', 'C', 'C', true, $3::jsonb, false, 'bank-admin')`,
      [complete, incomplete, ambiguous],
    );

    await migrate(drizzle(pool), { migrationsFolder });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (created) await maintenancePool.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`);
    await maintenancePool.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("imports only complete unambiguous current legacy details once", async () => {
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('operator_bank_accounts', 'tenant_bank_accounts')
       ORDER BY table_name`,
    );
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      "operator_bank_accounts",
      "tenant_bank_accounts",
    ]);

    const operator = await pool.query(
      `SELECT label, settlement_account, bic, bank_name, correspondent_account, currency,
              status, is_default, migration_source_profile_id
       FROM operator_bank_accounts`,
    );
    expect(operator.rows).toEqual([
      {
        label: "Расчётный",
        settlement_account: "40702810900000000001",
        bic: "044525225",
        bank_name: "ПАО Сбербанк",
        correspondent_account: "30101810400000000225",
        currency: "RUB",
        status: "active",
        is_default: true,
        migration_source_profile_id: "00000000-0000-4000-8000-000000000621",
      },
    ]);

    const tenants = await pool.query(
      `SELECT tenant_id, count(*)::int AS count
       FROM tenant_bank_accounts
       GROUP BY tenant_id
       ORDER BY tenant_id`,
    );
    expect(tenants.rows).toEqual([{ tenant_id: "bank-complete", count: 1 }]);

    await rerunImport();

    const countsAfterRerun = await pool.query(
      `SELECT
         (SELECT count(*)::int FROM operator_bank_accounts) AS operator_count,
         (SELECT count(*)::int FROM tenant_bank_accounts) AS tenant_count`,
    );
    expect(countsAfterRerun.rows).toEqual([{ operator_count: 1, tenant_count: 1 }]);
  });
});
