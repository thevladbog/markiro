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

describe.skipIf(!databaseUrl)("payment account evidence migration", () => {
  const databaseName = `markiro_payment_evidence_${randomUUID().replaceAll("-", "_")}`;
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
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-payment-evidence-migration-"));
    const legacyMigrations = join(temporaryRoot, "migrations");
    await cp(migrationsFolder, legacyMigrations, { recursive: true });
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
    await rm(join(legacyMigrations, "meta", "0063_snapshot.json"), { force: true });
    await rm(join(legacyMigrations, "meta", "0064_snapshot.json"), { force: true });
    await rm(join(legacyMigrations, "meta", "0065_snapshot.json"), { force: true });
    const journalPath = join(legacyMigrations, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
      entries: Array<{ tag: string }>;
    };
    journal.entries = journal.entries.filter(
      (entry) =>
        entry.tag !== "0063_payment_account_evidence" &&
        entry.tag !== "0064_normalize_operator_billing_profile_kind" &&
        entry.tag !== "0065_saas_party_actual_addresses" &&
        entry.tag !== "0066_panoramic_hemingway" &&
        entry.tag !== "0067_flashy_outlaw_kid" &&
        entry.tag !== "0068_inventory_protected_date_precedence",
    );
    await writeFile(journalPath, JSON.stringify(journal));

    await migrate(drizzle(pool), { migrationsFolder: legacyMigrations });
    await pool.query(
      `INSERT INTO organization (id, name, slug, created_at)
       VALUES ('payment-evidence-tenant', 'Payment evidence tenant', 'payment-evidence-tenant', now())`,
    );
    await pool.query(
      `INSERT INTO platform_users (id, name, email, role, status)
       VALUES ('payment-evidence-admin', 'Payment evidence admin', 'payment-evidence@example.invalid', 'platform_admin', 'active')`,
    );
    await pool.query(
      `INSERT INTO invoices
         (id, tenant_id, number, status, created_by_platform_user_id)
       VALUES
         ('00000000-0000-4000-8000-000000000801', 'payment-evidence-tenant', 'INV-LEGACY-PAYMENT',
          'draft', 'payment-evidence-admin')`,
    );
    await pool.query(
      `INSERT INTO payment_imports
         (id, source_checksum, parser_version, status, created_by_platform_user_id)
       VALUES
         ('00000000-0000-4000-8000-000000000802', repeat('a', 64), 'legacy', 'ready',
          'payment-evidence-admin')`,
    );
    await pool.query(
      `INSERT INTO payment_import_rows
         (id, import_id, source_row_id, amount, currency)
       VALUES
         ('00000000-0000-4000-8000-000000000803',
          '00000000-0000-4000-8000-000000000802', '1', 10, 'RUB')`,
    );
    await pool.query(
      `INSERT INTO payment_matches
         (import_row_id, tenant_id, invoice_id, status, score, reason)
       VALUES
         ('00000000-0000-4000-8000-000000000803', 'payment-evidence-tenant',
          '00000000-0000-4000-8000-000000000801', 'suggested', 90, 'legacy')`,
    );

    await migrate(drizzle(pool), { migrationsFolder });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (created) await maintenancePool.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`);
    await maintenancePool.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("adds a tenant-scoped account reference and nullable evidence without inventing legacy data", async () => {
    const columns = await pool.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'payment_matches'
         AND column_name IN ('tenant_bank_account_id', 'payer_account_evidence')
       ORDER BY column_name`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "payer_account_evidence",
      "tenant_bank_account_id",
    ]);

    const legacy = await pool.query(
      `SELECT tenant_bank_account_id, payer_account_evidence
       FROM payment_matches WHERE reason = 'legacy'`,
    );
    expect(legacy.rows).toEqual([{ tenant_bank_account_id: null, payer_account_evidence: null }]);

    const foreignKeys = await pool.query<{ constraint_name: string }>(
      `SELECT constraint_name
       FROM information_schema.table_constraints
       WHERE constraint_schema = 'public'
         AND constraint_type = 'FOREIGN KEY'
         AND constraint_name = 'payment_matches_tenant_account_fk'`,
    );
    expect(foreignKeys.rows).toEqual([{ constraint_name: "payment_matches_tenant_account_fk" }]);
  });
});

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) throw new Error("Unsafe database identifier");
  return `"${identifier}"`;
}
