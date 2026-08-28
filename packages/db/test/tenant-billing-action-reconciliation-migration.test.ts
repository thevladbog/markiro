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

describe.skipIf(!databaseUrl)("tenant billing action reconciliation migration", () => {
  const databaseName = `markiro_billing_reconcile_${randomUUID().replaceAll("-", "_")}`;
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
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-billing-reconcile-migration-"));
    const migrationsThrough0068 = join(temporaryRoot, "migrations");
    await cp(migrationsFolder, migrationsThrough0068, { recursive: true });
    await rm(join(migrationsThrough0068, "0069_tenant_billing_action_reconciliation.sql"));
    await rm(join(migrationsThrough0068, "0070_tenant_billing_platform_workflow.sql"));
    await rm(join(migrationsThrough0068, "0071_tenant_billing_target_cardinality.sql"));
    await rm(join(migrationsThrough0068, "0072_tenant_billing_stale_family_repair.sql"));
    await rm(join(migrationsThrough0068, "0073_tenant_billing_notification_delivery.sql"));
    await rm(join(migrationsThrough0068, "0074_tenant_billing_attachment_idempotency.sql"));
    await rm(join(migrationsThrough0068, "meta", "0069_snapshot.json"));
    await rm(join(migrationsThrough0068, "meta", "0070_snapshot.json"));
    await rm(join(migrationsThrough0068, "meta", "0071_snapshot.json"));
    await rm(join(migrationsThrough0068, "meta", "0072_snapshot.json"));
    await rm(join(migrationsThrough0068, "meta", "0073_snapshot.json"));
    await rm(join(migrationsThrough0068, "meta", "0074_snapshot.json"));
    const journalPath = join(migrationsThrough0068, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
      entries: Array<{ tag: string }>;
    };
    journal.entries = journal.entries.filter(
      (entry) =>
        entry.tag !== "0069_tenant_billing_action_reconciliation" &&
        entry.tag !== "0070_tenant_billing_platform_workflow" &&
        entry.tag !== "0071_tenant_billing_target_cardinality" &&
        entry.tag !== "0072_tenant_billing_stale_family_repair" &&
        entry.tag !== "0073_tenant_billing_notification_delivery" &&
        entry.tag !== "0074_tenant_billing_attachment_idempotency",
    );
    await writeFile(journalPath, JSON.stringify(journal));
    await migrate(drizzle(pool), { migrationsFolder: migrationsThrough0068 });

    await pool.query(`
      INSERT INTO organization (id, name, slug, created_at)
      VALUES ('billing-reconcile', 'Billing reconcile', 'billing-reconcile', now());
      INSERT INTO platform_users (id, name, email, role, status)
      VALUES ('billing-reconcile-platform', 'Platform', 'platform-reconcile@example.invalid',
              'platform_admin', 'active');
      INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at)
      VALUES ('billing-reconcile-user', 'User', 'user-reconcile@example.invalid', true, now(), now());
      INSERT INTO commercial_offers
        (id, tenant_id, revision, status, number, published_at, created_by_platform_user_id)
      VALUES ('00000000-0000-4000-8000-000000000901', 'billing-reconcile', 1, 'published',
              'OFFER-RECONCILE', now(), 'billing-reconcile-platform');
      INSERT INTO tenant_billing_requests
        (id, tenant_id, number, type, description, idempotency_key, created_by_user_id)
      VALUES ('00000000-0000-4000-8000-000000000902', 'billing-reconcile', 'BR-RECONCILE',
              'documents', 'Existing attachment', '00000000-0000-4000-8000-000000000903',
              'billing-reconcile-user');
      INSERT INTO tenant_billing_request_attachments
        (id, tenant_id, request_id, file_name, content_type, byte_size, sha256, object_key,
         uploaded_by_user_id, created_at)
      VALUES ('00000000-0000-4000-8000-000000000904', 'billing-reconcile',
              '00000000-0000-4000-8000-000000000902', 'existing.pdf', 'application/pdf', 1,
              'existing-sha',
              'tenant-billing/billing-reconcile/requests/00000000-0000-4000-8000-000000000902/00000000-0000-4000-8000-000000000904',
              'billing-reconcile-user', '2026-08-27T12:00:00Z');
      INSERT INTO commercial_offer_decisions
        (id, tenant_id, offer_id, decision, actor_user_id, idempotency_key, created_at)
      VALUES ('00000000-0000-4000-8000-000000000905', 'billing-reconcile',
              '00000000-0000-4000-8000-000000000901', 'accepted', 'billing-reconcile-user',
              '00000000-0000-4000-8000-000000000906', '2026-08-27T12:00:00Z');
    `);

    await migrate(drizzle(pool), { migrationsFolder });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (created) await maintenancePool.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`);
    await maintenancePool.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("upgrades existing attachments to ready and backfills canonical decision keys", async () => {
    const attachments = await pool.query(
      `SELECT state, ready_at, created_at, idempotency_key::text
       FROM tenant_billing_request_attachments
       WHERE id = '00000000-0000-4000-8000-000000000904'`,
    );
    expect(attachments.rows).toEqual([
      {
        state: "ready",
        ready_at: new Date("2026-08-27T12:00:00.000Z"),
        created_at: new Date("2026-08-27T12:00:00.000Z"),
        idempotency_key: "00000000-0000-4000-8000-000000000904",
      },
    ]);
    const keys = await pool.query(
      `SELECT tenant_id, idempotency_key::text, offer_id::text, decision, message,
              decision_id::text
       FROM commercial_offer_decision_idempotency`,
    );
    expect(keys.rows).toEqual([
      {
        tenant_id: "billing-reconcile",
        idempotency_key: "00000000-0000-4000-8000-000000000906",
        offer_id: "00000000-0000-4000-8000-000000000901",
        decision: "accepted",
        message: null,
        decision_id: "00000000-0000-4000-8000-000000000905",
      },
    ]);
  });

  it("defaults new attachment intents to pending after preserving legacy readiness", async () => {
    const inserted = await pool.query(
      `INSERT INTO tenant_billing_request_attachments
         (tenant_id, request_id, idempotency_key, file_name, content_type, byte_size, sha256, object_key,
          uploaded_by_user_id)
       VALUES ('billing-reconcile', '00000000-0000-4000-8000-000000000902',
               '00000000-0000-4000-8000-000000000907', 'pending.txt',
               'text/plain', 1, 'pending-sha',
               'tenant-billing/billing-reconcile/requests/00000000-0000-4000-8000-000000000902/00000000-0000-4000-8000-000000000907',
               'billing-reconcile-user')
       RETURNING state, ready_at`,
    );
    expect(inserted.rows).toEqual([{ state: "pending", ready_at: null }]);
  });
});

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
