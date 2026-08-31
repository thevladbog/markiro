import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { copyMigrationsThroughIndex } from "./support/legacy-migrations.js";

const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

describe.skipIf(!databaseUrl)("invoice payment completion migration", () => {
  const maintenancePool = new pg.Pool({ connectionString: databaseUrl });

  afterAll(async () => {
    await maintenancePool.end();
  });

  it("installs the completion trigger on a fresh database", async () => {
    await withScratchDatabase(maintenancePool, async ({ pool }) => {
      await migrate(drizzle(pool), { migrationsFolder });

      const result = await pool.query<{ trigger_name: string }>(
        `SELECT trigger_name
         FROM information_schema.triggers
         WHERE event_object_schema = 'public'
           AND event_object_table = 'billing_payments'
           AND trigger_name = 'billing_payments_record_completion'`,
      );

      expect(result.rows).toEqual([{ trigger_name: "billing_payments_record_completion" }]);
    });
  }, 120_000);

  it("backfills one unambiguous exact-total legacy payment", async () => {
    await withScratchDatabase(maintenancePool, async ({ pool, migrationsThrough0090 }) => {
      await migrate(drizzle(pool), { migrationsFolder: migrationsThrough0090 });
      await seedBillingActors(pool);
      await seedPaidInvoice(pool, {
        invoiceId: "00000000-0000-4000-8000-000000000901",
        number: "INV-COMPLETION-SINGLE",
      });
      await seedManualPayment(pool, {
        paymentId: "00000000-0000-4000-8000-000000000902",
        invoiceId: "00000000-0000-4000-8000-000000000901",
        amount: 100,
      });

      await migrate(drizzle(pool), { migrationsFolder });

      expect(await completionRows(pool)).toEqual([
        {
          invoice_id: "00000000-0000-4000-8000-000000000901",
          billing_payment_id: "00000000-0000-4000-8000-000000000902",
        },
      ]);
    });
  }, 120_000);

  it("rejects a paid invoice with no exact-total legacy payment candidate", async () => {
    await withScratchDatabase(maintenancePool, async ({ pool, migrationsThrough0090 }) => {
      await migrate(drizzle(pool), { migrationsFolder: migrationsThrough0090 });
      await seedBillingActors(pool);
      await seedPaidInvoice(pool, {
        invoiceId: "00000000-0000-4000-8000-000000000911",
        number: "INV-COMPLETION-MISSING",
      });

      await expectMigrationFailure(
        migrate(drizzle(pool), { migrationsFolder }),
        "paid invoice has no exact-total payment candidate",
      );
    });
  }, 120_000);

  it("rejects a paid invoice with multiple exact-total legacy payment candidates", async () => {
    await withScratchDatabase(maintenancePool, async ({ pool, migrationsThrough0090 }) => {
      await migrate(drizzle(pool), { migrationsFolder: migrationsThrough0090 });
      await seedBillingActors(pool);
      const invoiceId = "00000000-0000-4000-8000-000000000921";
      await seedPaidInvoice(pool, { invoiceId, number: "INV-COMPLETION-AMBIGUOUS" });
      await seedManualPayment(pool, {
        paymentId: "00000000-0000-4000-8000-000000000922",
        invoiceId,
        amount: 100,
      });
      await seedManualPayment(pool, {
        paymentId: "00000000-0000-4000-8000-000000000923",
        invoiceId,
        amount: 100,
      });

      await expectMigrationFailure(
        migrate(drizzle(pool), { migrationsFolder }),
        "paid invoice has multiple exact-total payment candidates",
      );
    });
  }, 120_000);

  it("backfills an old completing payment inserted before trigger DDL after waiting for its transaction", async () => {
    await withScratchDatabase(maintenancePool, async ({ pool, migrationsThrough0090 }) => {
      await migrate(drizzle(pool), { migrationsFolder: migrationsThrough0090 });
      await seedBillingActors(pool);
      const invoiceId = "00000000-0000-4000-8000-000000000941";
      const paymentId = "00000000-0000-4000-8000-000000000942";
      await seedIssuedInvoice(pool, {
        invoiceId,
        number: "INV-COMPLETION-PRE-TRIGGER",
      });

      const oldTransaction = await pool.connect();
      const migrationConnection = await pool.connect();
      let oldTransactionOpen = false;
      let migrationPromise: Promise<void> | undefined;
      try {
        await oldTransaction.query("BEGIN");
        oldTransactionOpen = true;
        await oldTransaction.query("SELECT id FROM invoices WHERE id = $1 FOR UPDATE", [invoiceId]);
        await oldTransaction.query(
          `INSERT INTO billing_payments
             (id, tenant_id, invoice_id, source, paid_at, amount, bank_reference,
              platform_user_id, idempotency_key)
           VALUES
             ($1, 'billing-completion-tenant', $2, 'manual', '2026-08-22T12:00:00.000Z',
              100, 'pre-trigger-manual', 'billing-completion-admin', 'pre-trigger-manual')`,
          [paymentId, invoiceId],
        );

        const oldBackendPid = await backendPid(oldTransaction);
        const migrationBackendPid = await backendPid(migrationConnection);
        migrationPromise = migrate(drizzle(migrationConnection), { migrationsFolder });
        void migrationPromise.catch(() => undefined);

        const blockedMigration = await waitForBlockedMigration(
          pool,
          migrationBackendPid,
          oldBackendPid,
        );

        await oldTransaction.query(
          "UPDATE invoices SET status = 'paid', paid_at = '2026-08-22T12:00:00.000Z' WHERE id = $1",
          [invoiceId],
        );
        await oldTransaction.query("COMMIT");
        oldTransactionOpen = false;
        await migrationPromise;

        expect(blockedMigration).toMatchObject({
          wait_event_type: "Lock",
          wait_event: "relation",
        });
        expect(blockedMigration.query.replaceAll(/\s+/g, " ")).toContain(
          'CREATE TRIGGER "billing_payments_record_completion"',
        );
        expect(await completionRows(pool)).toEqual([
          {
            invoice_id: invoiceId,
            billing_payment_id: paymentId,
          },
        ]);
      } finally {
        if (oldTransactionOpen) await oldTransaction.query("ROLLBACK");
        if (migrationPromise) await Promise.allSettled([migrationPromise]);
        oldTransaction.release();
        migrationConnection.release();
      }
    });
  }, 120_000);

  it("captures old manual and imported completions after DDL even when a transaction started first", async () => {
    await withScratchDatabase(maintenancePool, async ({ pool, migrationsThrough0090 }) => {
      await migrate(drizzle(pool), { migrationsFolder: migrationsThrough0090 });
      await seedBillingActors(pool);
      const manualInvoiceId = "00000000-0000-4000-8000-000000000931";
      const importedInvoiceId = "00000000-0000-4000-8000-000000000932";
      await seedIssuedInvoice(pool, {
        invoiceId: manualInvoiceId,
        number: "INV-COMPLETION-ROLLOUT-MANUAL",
      });
      await seedIssuedInvoice(pool, {
        invoiceId: importedInvoiceId,
        number: "INV-COMPLETION-ROLLOUT-IMPORT",
      });
      await pool.query(
        `INSERT INTO payment_imports
           (id, source_checksum, parser_version, status, created_by_platform_user_id)
         VALUES
           ('00000000-0000-4000-8000-000000000933', repeat('c', 64), 'rollout-test', 'ready',
            'billing-completion-admin')`,
      );
      await pool.query(
        `INSERT INTO payment_import_rows
           (id, import_id, source_row_id, operation_date, amount, currency, bank_reference)
         VALUES
           ('00000000-0000-4000-8000-000000000934',
            '00000000-0000-4000-8000-000000000933', 'rollout-import-row',
            '2026-08-20T12:00:00.000Z', 100, 'RUB', 'rollout-import')`,
      );

      const oldManualTransaction = await pool.connect();
      try {
        await oldManualTransaction.query("BEGIN");
        await oldManualTransaction.query("SELECT now()");
        await oldManualTransaction.query(
          "SELECT id FROM billing_payments WHERE idempotency_key = 'rollout-manual'",
        );
        await oldManualTransaction.query("SELECT id FROM invoices WHERE id = $1 FOR UPDATE", [
          manualInvoiceId,
        ]);

        await migrate(drizzle(pool), { migrationsFolder });

        await oldManualTransaction.query(
          `INSERT INTO billing_payments
             (id, tenant_id, invoice_id, source, paid_at, amount, bank_reference,
              platform_user_id, idempotency_key)
           VALUES
             ('00000000-0000-4000-8000-000000000935', 'billing-completion-tenant', $1,
              'manual', '2026-08-21T12:00:00.000Z', 100, 'rollout-manual',
              'billing-completion-admin', 'rollout-manual')`,
          [manualInvoiceId],
        );
        await oldManualTransaction.query(
          "UPDATE invoices SET status = 'paid', paid_at = '2026-08-21T12:00:00.000Z' WHERE id = $1",
          [manualInvoiceId],
        );
        await oldManualTransaction.query("COMMIT");
      } catch (error) {
        await oldManualTransaction.query("ROLLBACK");
        throw error;
      } finally {
        oldManualTransaction.release();
      }

      const oldImportTransaction = await pool.connect();
      try {
        await oldImportTransaction.query("BEGIN");
        await oldImportTransaction.query("SELECT id FROM invoices WHERE id = $1 FOR UPDATE", [
          importedInvoiceId,
        ]);
        await oldImportTransaction.query(
          `INSERT INTO billing_payments
             (id, tenant_id, invoice_id, source, paid_at, amount, bank_reference, import_row_id,
              platform_user_id, idempotency_key)
           VALUES
             ('00000000-0000-4000-8000-000000000936', 'billing-completion-tenant', $1,
              'bank_import', '2026-08-20T12:00:00.000Z', 100, 'rollout-import',
              '00000000-0000-4000-8000-000000000934', 'billing-completion-admin',
              'bank-import:00000000-0000-4000-8000-000000000934')`,
          [importedInvoiceId],
        );
        await oldImportTransaction.query(
          "UPDATE invoices SET status = 'paid', paid_at = '2026-08-20T12:00:00.000Z' WHERE id = $1",
          [importedInvoiceId],
        );
        await oldImportTransaction.query("COMMIT");
      } catch (error) {
        await oldImportTransaction.query("ROLLBACK");
        throw error;
      } finally {
        oldImportTransaction.release();
      }

      expect(await completionRows(pool)).toEqual([
        {
          invoice_id: manualInvoiceId,
          billing_payment_id: "00000000-0000-4000-8000-000000000935",
        },
        {
          invoice_id: importedInvoiceId,
          billing_payment_id: "00000000-0000-4000-8000-000000000936",
        },
      ]);
    });
  }, 120_000);
});

async function withScratchDatabase(
  maintenancePool: pg.Pool,
  run: (context: { pool: pg.Pool; migrationsThrough0090: string }) => Promise<void>,
): Promise<void> {
  const databaseName = `markiro_payment_completion_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const pool = new pg.Pool({ connectionString: scratchUrl.toString() });
  const temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-payment-completion-migration-"));
  const migrationsThrough0090 = join(temporaryRoot, "migrations");
  let created = false;
  try {
    await maintenancePool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    created = true;
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: migrationsThrough0090,
      lastIncludedIndex: 90,
    });
    await run({ pool, migrationsThrough0090 });
  } finally {
    await pool.end();
    if (created) await maintenancePool.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function seedBillingActors(pool: pg.Pool): Promise<void> {
  await pool.query(
    `INSERT INTO organization (id, name, slug, created_at)
     VALUES ('billing-completion-tenant', 'Billing completion tenant', 'billing-completion', now())`,
  );
  await pool.query(
    `INSERT INTO platform_users (id, name, email, role, status)
     VALUES ('billing-completion-admin', 'Billing completion admin',
             'billing-completion-admin@example.invalid', 'platform_admin', 'active')`,
  );
}

async function seedPaidInvoice(
  pool: pg.Pool,
  input: { invoiceId: string; number: string },
): Promise<void> {
  await seedInvoice(pool, { ...input, status: "paid" });
}

async function seedIssuedInvoice(
  pool: pg.Pool,
  input: { invoiceId: string; number: string },
): Promise<void> {
  await seedInvoice(pool, { ...input, status: "issued" });
}

async function seedInvoice(
  pool: pg.Pool,
  input: { invoiceId: string; number: string; status: "issued" | "paid" },
): Promise<void> {
  await pool.query(
    `INSERT INTO invoices
       (id, tenant_id, number, status, issue_date, seller_snapshot, buyer_snapshot, total,
        created_by_platform_user_id, issued_by_platform_user_id, issued_at, paid_at)
     VALUES
       ($1, 'billing-completion-tenant', $2, $3::invoice_status, now(), '{}', '{}', 100,
        'billing-completion-admin', 'billing-completion-admin', now(),
        CASE WHEN $3::text = 'paid' THEN now() ELSE NULL END)`,
    [input.invoiceId, input.number, input.status],
  );
}

async function seedManualPayment(
  pool: pg.Pool,
  input: { paymentId: string; invoiceId: string; amount: number },
): Promise<void> {
  await pool.query(
    `INSERT INTO billing_payments
       (id, tenant_id, invoice_id, source, paid_at, amount, bank_reference,
        platform_user_id, idempotency_key)
     VALUES
       ($1::text::uuid, 'billing-completion-tenant', $2::text::uuid, 'manual', now(), $3,
        $1::text, 'billing-completion-admin', $1::text)`,
    [input.paymentId, input.invoiceId, input.amount],
  );
}

async function completionRows(
  pool: pg.Pool,
): Promise<Array<{ invoice_id: string; billing_payment_id: string }>> {
  const result = await pool.query<{ invoice_id: string; billing_payment_id: string }>(
    `SELECT invoice_id, billing_payment_id
     FROM invoice_payment_completions
     ORDER BY invoice_id`,
  );
  return result.rows;
}

async function expectMigrationFailure(promise: Promise<void>, message: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const messages: string[] = [];
    let current: unknown = error;
    while (current instanceof Error) {
      messages.push(current.message);
      current = current.cause;
    }
    expect(messages.join("\n")).toContain(message);
    return;
  }
  throw new Error(`Expected migration to fail with: ${message}`);
}

async function backendPid(client: pg.PoolClient): Promise<number> {
  const result = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  const pid = result.rows[0]?.pid;
  if (pid === undefined) throw new Error("PostgreSQL did not return a backend PID");
  return pid;
}

async function waitForBlockedMigration(
  pool: pg.Pool,
  migrationBackendPid: number,
  oldBackendPid: number,
): Promise<{ query: string; wait_event_type: string | null; wait_event: string | null }> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{
      query: string;
      wait_event_type: string | null;
      wait_event: string | null;
      blocked_by_old_transaction: boolean;
    }>(
      `SELECT query, wait_event_type, wait_event,
              $1 = ANY(pg_blocking_pids(pid)) AS blocked_by_old_transaction
       FROM pg_stat_activity
       WHERE pid = $2`,
      [oldBackendPid, migrationBackendPid],
    );
    const row = result.rows[0];
    // Both halves of the sample have to agree before it is worth returning.
    // `pg_blocking_pids()` reads the lock manager directly, while wait_event_type
    // and wait_event come from the wait state the backend advertises in shared
    // memory, and the two disagree for a moment as the backend enters the wait.
    // Returning on `blocked_by_old_transaction` alone therefore hands back a row
    // whose wait columns are still null, and the caller asserts on exactly those.
    if (row?.blocked_by_old_transaction && row.wait_event_type !== null) return row;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(
    `Timed out waiting for migration backend ${migrationBackendPid} to be blocked by old transaction ${oldBackendPid}`,
  );
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) throw new Error("Unsafe database identifier");
  return `"${identifier}"`;
}
