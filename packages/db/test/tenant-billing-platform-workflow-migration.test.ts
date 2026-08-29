import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { copyMigrationsThroughIndex } from "./support/legacy-migrations.js";

const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

describe("tenant billing platform workflow migration metadata", () => {
  it("keeps the snapshot chain contiguous through 0094", async () => {
    const [previousText, currentText, journalText] = await Promise.all([
      readFile(new URL("../migrations/meta/0093_snapshot.json", import.meta.url), "utf8"),
      readFile(new URL("../migrations/meta/0094_snapshot.json", import.meta.url), "utf8"),
      readFile(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8"),
    ]);
    const previous = JSON.parse(previousText) as { id: string };
    const current = JSON.parse(currentText) as { prevId: string };
    const journal = JSON.parse(journalText) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    expect(current.prevId).toBe(previous.id);
    expect(journal.entries.find(({ idx }) => idx === 94)).toMatchObject({
      idx: 94,
      tag: "0094_tenant_billing_platform_workflow",
    });
  });
});

describe.skipIf(!databaseUrl)("tenant billing platform workflow migration", () => {
  const databaseName = `markiro_billing_platform_${randomUUID().replaceAll("-", "_")}`;
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
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-billing-platform-migration-"));
    const migrationsThrough0093 = join(temporaryRoot, "migrations");
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: migrationsThrough0093,
      lastIncludedIndex: 93,
    });
    await migrate(drizzle(pool), { migrationsFolder: migrationsThrough0093 });

    await pool.query(`
      INSERT INTO organization (id, name, slug, created_at)
      VALUES ('billing-platform', 'Billing platform', 'billing-platform', now());
      INSERT INTO platform_users (id, name, email, role, status)
      VALUES ('billing-platform-user', 'Platform', 'platform-workflow@example.invalid',
              'platform_admin', 'active');
      INSERT INTO billing_acts
        (id, tenant_id, number, period_start, period_end, created_by_platform_user_id)
      VALUES ('00000000-0000-4000-8000-000000000a01', 'billing-platform', 'ACT-LEGACY',
              '2026-07-01', '2026-07-31', 'billing-platform-user');
      INSERT INTO billing_act_documents
        (id, tenant_id, act_id, revision, object_key, content_type, sha256, byte_size,
         uploaded_by_platform_user_id, created_at)
      VALUES ('00000000-0000-4000-8000-000000000a02', 'billing-platform',
              '00000000-0000-4000-8000-000000000a01', 1,
              'tenant-billing/billing-platform/acts/00000000-0000-4000-8000-000000000a01/00000000-0000-4000-8000-000000000a02.pdf',
              'application/pdf', '${"a".repeat(64)}', 42, 'billing-platform-user',
              '2026-08-27T12:00:00Z');
    `);

    await migrate(drizzle(pool), { migrationsFolder });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (created) await maintenancePool.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`);
    await maintenancePool.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("backfills legacy act documents as ready and defaults new intents to pending", async () => {
    const legacy = await pool.query(
      `SELECT state, ready_at, created_at, updated_at
       FROM billing_act_documents
       WHERE id = '00000000-0000-4000-8000-000000000a02'`,
    );
    expect(legacy.rows).toEqual([
      {
        state: "ready",
        ready_at: new Date("2026-08-27T12:00:00.000Z"),
        created_at: new Date("2026-08-27T12:00:00.000Z"),
        updated_at: new Date("2026-08-27T12:00:00.000Z"),
      },
    ]);
    await pool.query(
      `INSERT INTO billing_acts
         (id, tenant_id, number, period_start, period_end, created_by_platform_user_id)
       VALUES ('00000000-0000-4000-8000-000000000a06', 'billing-platform', 'ACT-PENDING',
               '2026-08-01', '2026-08-31', 'billing-platform-user')`,
    );
    const pending = await pool.query(
      `INSERT INTO billing_act_documents
         (tenant_id, act_id, revision, object_key, content_type, sha256, byte_size,
          uploaded_by_platform_user_id)
       VALUES ('billing-platform', '00000000-0000-4000-8000-000000000a06', 1,
               'tenant-billing/billing-platform/acts/00000000-0000-4000-8000-000000000a06/00000000-0000-4000-8000-000000000a03.pdf',
               'application/pdf', '${"b".repeat(64)}', 43, 'billing-platform-user')
       RETURNING state, ready_at`,
    );
    expect(pending.rows).toEqual([{ state: "pending", ready_at: null }]);
  });

  it("enforces tenant-scoped mutation keys, payload hashes, and committed results", async () => {
    const key = "00000000-0000-4000-8000-000000000a04";
    await pool.query(
      `INSERT INTO platform_billing_mutation_idempotency
         (tenant_id, idempotency_key, operation, target_id, payload_hash, state, result_id,
          result, actor_platform_user_id)
       VALUES ('billing-platform', $1, 'act.create', 'billing-platform', $2, 'committed', $3,
               '{"id":"00000000-0000-4000-8000-000000000a01"}'::jsonb,
               'billing-platform-user')`,
      [key, "c".repeat(64), "00000000-0000-4000-8000-000000000a01"],
    );
    await expect(
      pool.query(
        `INSERT INTO platform_billing_mutation_idempotency
           (tenant_id, idempotency_key, operation, target_id, payload_hash,
            actor_platform_user_id)
         VALUES ('billing-platform', $1, 'act.cancel', 'other', $2,
                 'billing-platform-user')`,
        [key, "d".repeat(64)],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      pool.query(
        `INSERT INTO platform_billing_mutation_idempotency
           (tenant_id, idempotency_key, operation, target_id, payload_hash,
            actor_platform_user_id)
         VALUES ('billing-platform', $1, 'act.issue', 'target', 'not-a-hash',
                 'billing-platform-user')`,
        ["00000000-0000-4000-8000-000000000a05"],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
