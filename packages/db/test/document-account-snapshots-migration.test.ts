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

describe.skipIf(!databaseUrl)("document account snapshot migration", () => {
  const databaseName = `markiro_document_accounts_${randomUUID().replaceAll("-", "_")}`;
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
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-document-account-migration-"));
    const legacyMigrations = join(temporaryRoot, "migrations");
    await cp(migrationsFolder, legacyMigrations, { recursive: true });
    await rm(join(legacyMigrations, "0062_document_account_snapshots.sql"), { force: true });
    await rm(join(legacyMigrations, "0063_payment_account_evidence.sql"), { force: true });
    await rm(join(legacyMigrations, "meta", "0062_snapshot.json"), { force: true });
    const journalPath = join(legacyMigrations, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
      entries: Array<{ tag: string }>;
    };
    journal.entries = journal.entries.filter(
      (entry) =>
        entry.tag !== "0062_document_account_snapshots" &&
        entry.tag !== "0063_payment_account_evidence",
    );
    await writeFile(journalPath, JSON.stringify(journal));

    await migrate(drizzle(pool), { migrationsFolder: legacyMigrations });
    await pool.query(
      `INSERT INTO organization (id, name, slug, created_at)
       VALUES ('snapshot-tenant', 'Snapshot tenant', 'snapshot-tenant', now())`,
    );
    await pool.query(
      `INSERT INTO platform_users (id, name, email, role, status)
       VALUES ('snapshot-admin', 'Snapshot admin', 'snapshot-admin@example.invalid', 'platform_admin', 'active')`,
    );
    await pool.query(
      `INSERT INTO invoices
         (id, tenant_id, number, status, issue_date, seller_snapshot, buyer_snapshot,
          created_by_platform_user_id, issued_by_platform_user_id, issued_at)
       VALUES
         ('00000000-0000-4000-8000-000000000701', 'snapshot-tenant', 'INV-LEGACY-1',
          'issued', now(), '{"fullName":"Legacy seller"}', '{"fullName":"Legacy buyer"}',
          'snapshot-admin', 'snapshot-admin', now())`,
    );
    await pool.query(
      `INSERT INTO commercial_offers
         (id, tenant_id, family_id, revision, status, number, published_at,
          published_by_platform_user_id, created_by_platform_user_id)
       VALUES
         ('00000000-0000-4000-8000-000000000702', 'snapshot-tenant',
          '00000000-0000-4000-8000-000000000703', 1, 'published', 'KP-LEGACY-1', now(),
          'snapshot-admin', 'snapshot-admin')`,
    );
    await pool.query(
      `INSERT INTO commercial_offer_print_snapshots
         (tenant_id, offer_id, revision, number, published_at, seller_snapshot, buyer_snapshot,
          lines_snapshot, subtotal, vat_total, total)
       VALUES
         ('snapshot-tenant', '00000000-0000-4000-8000-000000000702', 1, 'KP-LEGACY-1', now(),
          '{"fullName":"Legacy seller"}', '{"fullName":"Legacy buyer"}', '[]', 0, 0, 0)`,
    );

    await migrate(drizzle(pool), { migrationsFolder });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (created) await maintenancePool.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`);
    await maintenancePool.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("adds selected account references and nullable immutable snapshots without inventing legacy data", async () => {
    const columns = await pool.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND column_name IN (
           'seller_bank_account_id',
           'seller_bank_account_snapshot',
           'buyer_bank_account_snapshot'
         )
       ORDER BY table_name, column_name`,
    );
    expect(columns.rows).toEqual([
      {
        table_name: "commercial_offer_print_snapshots",
        column_name: "buyer_bank_account_snapshot",
      },
      {
        table_name: "commercial_offer_print_snapshots",
        column_name: "seller_bank_account_snapshot",
      },
      { table_name: "commercial_offers", column_name: "seller_bank_account_id" },
      { table_name: "invoices", column_name: "buyer_bank_account_snapshot" },
      { table_name: "invoices", column_name: "seller_bank_account_id" },
      { table_name: "invoices", column_name: "seller_bank_account_snapshot" },
    ]);

    const legacyInvoice = await pool.query(
      `SELECT seller_bank_account_id, seller_bank_account_snapshot, buyer_bank_account_snapshot
       FROM invoices WHERE number = 'INV-LEGACY-1'`,
    );
    expect(legacyInvoice.rows).toEqual([
      {
        seller_bank_account_id: null,
        seller_bank_account_snapshot: null,
        buyer_bank_account_snapshot: null,
      },
    ]);
    const legacyOffer = await pool.query(
      `SELECT seller_bank_account_id FROM commercial_offers WHERE number = 'KP-LEGACY-1'`,
    );
    expect(legacyOffer.rows).toEqual([{ seller_bank_account_id: null }]);

    const foreignKeys = await pool.query<{ constraint_name: string }>(
      `SELECT constraint_name
       FROM information_schema.table_constraints
       WHERE constraint_schema = 'public'
         AND constraint_type = 'FOREIGN KEY'
         AND constraint_name IN (
           'commercial_offers_seller_account_fk',
           'invoices_seller_bank_account_id_operator_bank_accounts_id_fk'
         )
       ORDER BY constraint_name`,
    );
    expect(foreignKeys.rows.map((row) => row.constraint_name)).toEqual([
      "commercial_offers_seller_account_fk",
      "invoices_seller_bank_account_id_operator_bank_accounts_id_fk",
    ]);
  });
});

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) throw new Error("Unsafe database identifier");
  return `"${identifier}"`;
}
