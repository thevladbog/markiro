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

describe.skipIf(!databaseUrl)("tenant billing workflow migration", () => {
  const databaseName = `markiro_tenant_billing_${randomUUID().replaceAll("-", "_")}`;
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
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-tenant-billing-migration-"));
    const legacyMigrations = join(temporaryRoot, "migrations");
    await cp(migrationsFolder, legacyMigrations, { recursive: true });
    await rm(join(legacyMigrations, "0066_tenant_billing_experience.sql"));
    await rm(join(legacyMigrations, "meta", "0066_snapshot.json"));

    const journalPath = join(legacyMigrations, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
      entries: Array<{ tag: string }>;
    };
    journal.entries = journal.entries.filter(
      (entry) => entry.tag !== "0066_tenant_billing_experience",
    );
    await writeFile(journalPath, JSON.stringify(journal));

    await migrate(drizzle(pool), { migrationsFolder: legacyMigrations });
    await pool.query(
      `INSERT INTO organization (id, name, slug, created_at)
       VALUES
         ('billing-migration-a', 'Billing migration A', 'billing-migration-a', now()),
         ('billing-migration-b', 'Billing migration B', 'billing-migration-b', now())`,
    );
    await pool.query(
      `INSERT INTO platform_users (id, name, email, role, status)
       VALUES ('billing-migration-admin', 'Billing migration admin',
               'billing-migration-admin@example.invalid', 'platform_admin', 'active')`,
    );
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
       VALUES ('billing-migration-user', 'Billing migration user',
               'billing-migration-user@example.invalid', true, now(), now())`,
    );
    await pool.query(
      `INSERT INTO invoices
         (id, tenant_id, number, status, issue_date, seller_snapshot, buyer_snapshot,
          created_by_platform_user_id, issued_by_platform_user_id, issued_at, paid_at)
       VALUES
         ('00000000-0000-4000-8000-000000000801', 'billing-migration-a',
          'INV-BILLING-LEGACY-1', 'paid', now(), '{}', '{}', 'billing-migration-admin',
          'billing-migration-admin', now(), now())`,
    );
    await pool.query(
      `INSERT INTO billing_payments
         (id, tenant_id, invoice_id, source, paid_at, amount, bank_reference,
          platform_user_id, idempotency_key)
       VALUES
         ('00000000-0000-4000-8000-000000000802', 'billing-migration-a',
          '00000000-0000-4000-8000-000000000801', 'manual', now(), 100, 'legacy-payment',
          'billing-migration-admin', 'legacy-payment-idempotency')`,
    );

    await migrate(drizzle(pool), { migrationsFolder });
    await pool.query(
      `INSERT INTO tenant_billing_requests
         (id, tenant_id, number, type, description, idempotency_key, created_by_user_id)
       VALUES
         ('00000000-0000-4000-8000-000000000806', 'billing-migration-a', 'BR-000001',
          'other', 'Tenant A isolation fixture',
          '00000000-0000-4000-8000-000000000807', 'billing-migration-user'),
         ('00000000-0000-4000-8000-000000000811', 'billing-migration-b', 'BR-000002',
          'other', 'Tenant B isolation fixture',
          '00000000-0000-4000-8000-000000000812', 'billing-migration-user')`,
    );
    await pool.query(
      `INSERT INTO invoices
         (id, tenant_id, number, status, created_by_platform_user_id)
       VALUES
         ('00000000-0000-4000-8000-000000000808', 'billing-migration-b',
          'INV-BILLING-FOREIGN-1', 'draft', 'billing-migration-admin')`,
    );
    await pool.query(
      `INSERT INTO commercial_offers
         (id, tenant_id, revision, number, created_by_platform_user_id)
       VALUES
         ('00000000-0000-4000-8000-000000000809', 'billing-migration-b', 1,
          'KP-BILLING-FOREIGN-1', 'billing-migration-admin')`,
    );
    await pool.query(
      `INSERT INTO billing_acts
         (id, tenant_id, number, status, period_start, period_end, created_by_platform_user_id)
       VALUES
         ('00000000-0000-4000-8000-000000000810', 'billing-migration-b',
          'ACT-BILLING-FOREIGN-1', 'draft', '2026-08-01', '2026-08-31',
          'billing-migration-admin')`,
    );
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (created) await maintenancePool.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`);
    await maintenancePool.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("preserves a paid invoice and its confirmed payment", async () => {
    const result = await pool.query(
      `SELECT i.number, i.status, p.amount::text AS amount, p.bank_reference
       FROM invoices i
       JOIN billing_payments p ON p.tenant_id = i.tenant_id AND p.invoice_id = i.id
       WHERE i.id = '00000000-0000-4000-8000-000000000801'`,
    );

    expect(result.rows).toEqual([
      {
        number: "INV-BILLING-LEGACY-1",
        status: "paid",
        amount: "100.00",
        bank_reference: "legacy-payment",
      },
    ]);
  });

  it("allows multiple confirmed payments for the same issued invoice", async () => {
    await pool.query(
      `INSERT INTO invoices
         (id, tenant_id, number, status, issue_date, seller_snapshot, buyer_snapshot,
          created_by_platform_user_id, issued_by_platform_user_id, issued_at)
       VALUES
         ('00000000-0000-4000-8000-000000000803', 'billing-migration-a',
          'INV-BILLING-MULTI-1', 'issued', now(), '{}', '{}', 'billing-migration-admin',
          'billing-migration-admin', now())`,
    );
    await pool.query(
      `INSERT INTO billing_payments
         (id, tenant_id, invoice_id, source, paid_at, amount, bank_reference,
          platform_user_id, idempotency_key)
       VALUES
         ('00000000-0000-4000-8000-000000000804', 'billing-migration-a',
          '00000000-0000-4000-8000-000000000803', 'manual', now(), 40, 'multi-payment-1',
          'billing-migration-admin', 'multi-payment-idempotency-1'),
         ('00000000-0000-4000-8000-000000000805', 'billing-migration-a',
          '00000000-0000-4000-8000-000000000803', 'manual', now(), 60, 'multi-payment-2',
          'billing-migration-admin', 'multi-payment-idempotency-2')`,
    );

    const result = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
       FROM billing_payments
       WHERE tenant_id = 'billing-migration-a'
         AND invoice_id = '00000000-0000-4000-8000-000000000803'`,
    );
    expect(result.rows).toEqual([{ count: 2 }]);
  });

  it("rejects a request link whose typed target belongs to another tenant", async () => {
    await expectForeignKeyViolation(
      pool.query(
        `INSERT INTO tenant_billing_request_links
           (tenant_id, request_id, invoice_id)
         VALUES
           ('billing-migration-a', '00000000-0000-4000-8000-000000000806',
            '00000000-0000-4000-8000-000000000808')`,
      ),
      "tenant_billing_request_links_tenant_invoice_fk",
    );
  });

  it("rejects cross-tenant request events and attachments", async () => {
    await expectForeignKeyViolation(
      pool.query(
        `INSERT INTO tenant_billing_request_events
           (tenant_id, request_id, kind, actor_kind, idempotency_key)
         VALUES
           ('billing-migration-b', '00000000-0000-4000-8000-000000000806',
            'created', 'system', '00000000-0000-4000-8000-000000000813')`,
      ),
      "tenant_billing_request_events_tenant_request_fk",
    );

    await expectForeignKeyViolation(
      pool.query(
        `INSERT INTO tenant_billing_request_attachments
           (tenant_id, request_id, file_name, content_type, byte_size, sha256, object_key,
            uploaded_by_user_id)
         VALUES
           ('billing-migration-b', '00000000-0000-4000-8000-000000000806',
            'foreign.pdf', 'application/pdf', 1, 'fixture-sha256',
            'tenant-billing/foreign-attachment', 'billing-migration-user')`,
      ),
      "tenant_billing_request_attachments_tenant_request_fk",
    );
  });

  it("rejects cross-tenant offer decisions and invoice offer provenance", async () => {
    await expectForeignKeyViolation(
      pool.query(
        `INSERT INTO commercial_offer_decisions
           (tenant_id, offer_id, decision, actor_user_id, idempotency_key)
         VALUES
           ('billing-migration-a', '00000000-0000-4000-8000-000000000809',
            'accepted', 'billing-migration-user',
            '00000000-0000-4000-8000-000000000814')`,
      ),
      "commercial_offer_decisions_tenant_offer_fk",
    );

    await expectForeignKeyViolation(
      pool.query(
        `INSERT INTO invoices
           (tenant_id, number, status, source_offer_id, created_by_platform_user_id)
         VALUES
           ('billing-migration-a', 'INV-BILLING-CROSS-OFFER-1', 'draft',
            '00000000-0000-4000-8000-000000000809', 'billing-migration-admin')`,
      ),
      "invoices_tenant_source_offer_fk",
    );
  });

  it("rejects cross-tenant acts and act documents", async () => {
    await expectForeignKeyViolation(
      pool.query(
        `INSERT INTO billing_acts
           (tenant_id, request_id, number, status, period_start, period_end,
            created_by_platform_user_id)
         VALUES
           ('billing-migration-a', '00000000-0000-4000-8000-000000000811',
            'ACT-BILLING-CROSS-REQUEST-1', 'draft', '2026-08-01', '2026-08-31',
            'billing-migration-admin')`,
      ),
      "billing_acts_tenant_request_fk",
    );

    await expectForeignKeyViolation(
      pool.query(
        `INSERT INTO billing_act_documents
           (tenant_id, act_id, revision, object_key, content_type, sha256, byte_size,
            uploaded_by_platform_user_id)
         VALUES
           ('billing-migration-a', '00000000-0000-4000-8000-000000000810', 1,
            'tenant-billing/foreign-act-document', 'application/pdf', 'fixture-sha256', 1,
            'billing-migration-admin')`,
      ),
      "billing_act_documents_tenant_act_fk",
    );
  });

  it("supports cancellation before or after issue with consistent issue audit pairs", async () => {
    await pool.query(
      `INSERT INTO billing_acts
         (id, tenant_id, number, status, period_start, period_end, created_by_platform_user_id,
          cancelled_by_platform_user_id, cancelled_at)
       VALUES
         ('00000000-0000-4000-8000-000000000815', 'billing-migration-a',
          'ACT-BILLING-CANCEL-BEFORE-ISSUE', 'cancelled', '2026-08-01', '2026-08-31',
          'billing-migration-admin', 'billing-migration-admin', now())`,
    );
    await pool.query(
      `INSERT INTO billing_acts
         (id, tenant_id, number, status, period_start, period_end, created_by_platform_user_id,
          issued_by_platform_user_id, issued_at, cancelled_by_platform_user_id, cancelled_at)
       VALUES
         ('00000000-0000-4000-8000-000000000816', 'billing-migration-a',
          'ACT-BILLING-CANCEL-AFTER-ISSUE', 'cancelled', '2026-08-01', '2026-08-31',
          'billing-migration-admin', 'billing-migration-admin', now(),
          'billing-migration-admin', now())`,
    );

    const rows = await pool.query(
      `SELECT number, issued_by_platform_user_id IS NOT NULL AS was_issued
       FROM billing_acts
       WHERE id IN (
         '00000000-0000-4000-8000-000000000815',
         '00000000-0000-4000-8000-000000000816'
       )
       ORDER BY number`,
    );
    expect(rows.rows).toEqual([
      { number: "ACT-BILLING-CANCEL-AFTER-ISSUE", was_issued: true },
      { number: "ACT-BILLING-CANCEL-BEFORE-ISSUE", was_issued: false },
    ]);

    await expect(
      pool.query(
        `INSERT INTO billing_acts
           (tenant_id, number, status, period_start, period_end, created_by_platform_user_id,
            issued_by_platform_user_id, cancelled_by_platform_user_id, cancelled_at)
         VALUES
           ('billing-migration-a', 'ACT-BILLING-CANCEL-PARTIAL-ACTOR', 'cancelled',
            '2026-08-01', '2026-08-31', 'billing-migration-admin',
            'billing-migration-admin', 'billing-migration-admin', now())`,
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "billing_acts_issue_shape_check",
    });

    await expect(
      pool.query(
        `INSERT INTO billing_acts
           (tenant_id, number, status, period_start, period_end, created_by_platform_user_id,
            issued_at, cancelled_by_platform_user_id, cancelled_at)
         VALUES
           ('billing-migration-a', 'ACT-BILLING-CANCEL-PARTIAL-TIME', 'cancelled',
            '2026-08-01', '2026-08-31', 'billing-migration-admin', now(),
            'billing-migration-admin', now())`,
      ),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "billing_acts_issue_shape_check",
    });
  });
});

async function expectForeignKeyViolation(
  query: Promise<unknown>,
  constraint: string,
): Promise<void> {
  await expect(query).rejects.toMatchObject({ code: "23503", constraint });
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) throw new Error("Unsafe database identifier");
  return `"${identifier}"`;
}
