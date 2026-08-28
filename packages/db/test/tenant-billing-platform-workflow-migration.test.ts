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

describe("tenant billing platform workflow migration metadata", () => {
  it("keeps the snapshot chain contiguous through 0070", async () => {
    const [previousText, currentText, journalText] = await Promise.all([
      readFile(new URL("../migrations/meta/0069_snapshot.json", import.meta.url), "utf8"),
      readFile(new URL("../migrations/meta/0070_snapshot.json", import.meta.url), "utf8"),
      readFile(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8"),
    ]);
    const previous = JSON.parse(previousText) as { id: string };
    const current = JSON.parse(currentText) as { prevId: string };
    const journal = JSON.parse(journalText) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    expect(current.prevId).toBe(previous.id);
    expect(journal.entries.find(({ idx }) => idx === 70)).toMatchObject({
      idx: 70,
      tag: "0070_tenant_billing_platform_workflow",
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
    const migrationsThrough0069 = join(temporaryRoot, "migrations");
    await cp(migrationsFolder, migrationsThrough0069, { recursive: true });
    await rm(join(migrationsThrough0069, "0070_tenant_billing_platform_workflow.sql"), {
      force: true,
    });
    await rm(join(migrationsThrough0069, "0071_tenant_billing_target_cardinality.sql"), {
      force: true,
    });
    await rm(join(migrationsThrough0069, "meta", "0070_snapshot.json"), { force: true });
    await rm(join(migrationsThrough0069, "meta", "0071_snapshot.json"), { force: true });
    const journalPath = join(migrationsThrough0069, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
      entries: Array<{ tag: string }>;
    };
    journal.entries = journal.entries.filter(
      (entry) =>
        entry.tag !== "0070_tenant_billing_platform_workflow" &&
        entry.tag !== "0071_tenant_billing_target_cardinality",
    );
    await writeFile(journalPath, JSON.stringify(journal));
    await migrate(drizzle(pool), { migrationsFolder: migrationsThrough0069 });

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
