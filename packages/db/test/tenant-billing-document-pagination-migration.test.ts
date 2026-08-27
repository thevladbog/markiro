import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
const indexNames = [
  "billing_act_documents_tenant_created_id_idx",
  "commercial_offer_documents_tenant_created_id_idx",
] as const;
const originalMigrationTimestamp = 1_787_859_000_000;
const originalMigrationHash = "f1d1b9a161fce1cc0e810cf0a97c34678731ffa18ecff89852cd8c7461cea633";

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) {
    throw new Error("Unsafe temporary database identifier");
  }
  return `"${identifier}"`;
}

describe("tenant billing document pagination migration metadata", () => {
  it("keeps the Drizzle snapshot chain contiguous through migration 0068", async () => {
    const [previousText, currentText, journalText] = await Promise.all([
      readFile(new URL("../migrations/meta/0067_snapshot.json", import.meta.url), "utf8"),
      readFile(new URL("../migrations/meta/0068_snapshot.json", import.meta.url), "utf8"),
      readFile(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8"),
    ]);
    const previous = JSON.parse(previousText) as { id: string };
    const current = JSON.parse(currentText) as { id: string; prevId: string };
    const journal = JSON.parse(journalText) as {
      entries: Array<{ idx: number; tag: string; when: number }>;
    };

    expect(current.id).not.toBe(previous.id);
    expect(current.prevId).toBe(previous.id);
    expect(journal.entries.at(-1)).toMatchObject({
      idx: 68,
      tag: "0068_tenant_billing_document_pagination_indexes",
      when: originalMigrationTimestamp,
    });
  });
});

describe.skipIf(!databaseUrl)("tenant billing document pagination migration", () => {
  const databaseName = `markiro_billing_document_indexes_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenancePool = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: scratchUrl.toString() });

  beforeAll(async () => {
    await maintenancePool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await migrate(drizzle(pool), { migrationsFolder });
    await pool.query(
      `INSERT INTO organization (id, name, slug, created_at)
       VALUES ('billing-index-tenant', 'Billing index tenant', 'billing-index-tenant', now())`,
    );
    await pool.query(
      `INSERT INTO platform_users
         (id, name, email, role, status, two_factor_enabled, created_at, updated_at)
       VALUES
         ('billing-index-actor', 'Billing index actor', 'billing-index@example.invalid',
          'platform_admin', 'active', true, now(), now())`,
    );
    await pool.query(
      `INSERT INTO commercial_offers
         (id, tenant_id, family_id, revision, status, number, total,
          created_by_platform_user_id, created_at, updated_at)
       VALUES
         ('00000000-0000-4000-8000-000000000001', 'billing-index-tenant',
          '00000000-0000-4000-8000-000000000002', 1, 'draft', 'IDX-OFFER', 0,
          'billing-index-actor', now(), now())`,
    );
    await pool.query(
      `INSERT INTO billing_acts
         (id, tenant_id, number, status, period_start, period_end,
          created_by_platform_user_id, created_at, updated_at)
       VALUES
         ('00000000-0000-4000-8000-000000000003', 'billing-index-tenant', 'IDX-ACT',
          'draft', '2026-01-01', '2026-12-31', 'billing-index-actor', now(), now())`,
    );
    await pool.query(
      `INSERT INTO commercial_offer_documents
         (id, tenant_id, offer_id, revision, format, status, renderer_version,
          created_at, updated_at)
       SELECT
         ('00000000-0000-4001-8000-' || lpad(series::text, 12, '0'))::uuid,
         'billing-index-tenant', '00000000-0000-4000-8000-000000000001',
         series, 'pdf', 'pending', 'index-proof',
         '2026-01-01T00:00:00Z'::timestamptz + series * interval '1 minute',
         '2026-01-01T00:00:00Z'::timestamptz + series * interval '1 minute'
       FROM generate_series(1, 2000) AS series`,
    );
    await pool.query(
      `INSERT INTO billing_act_documents
         (id, tenant_id, act_id, revision, is_current, object_key, content_type,
          sha256, byte_size, uploaded_by_platform_user_id, created_at)
       SELECT
         ('00000000-0000-4002-8000-' || lpad(series::text, 12, '0'))::uuid,
         'billing-index-tenant', '00000000-0000-4000-8000-000000000003',
         series, false,
         'tenant-billing/billing-index-tenant/acts/00000000-0000-4000-8000-000000000003/' ||
           ('00000000-0000-4002-8000-' || lpad(series::text, 12, '0')) || '.pdf',
         'application/pdf', repeat('a', 64), 1, 'billing-index-actor',
         '2026-01-01T00:00:00Z'::timestamptz + series * interval '1 minute'
       FROM generate_series(1, 2000) AS series`,
    );
    await pool.query("ANALYZE commercial_offer_documents");
    await pool.query("ANALYZE billing_act_documents");
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    await maintenancePool.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)}`);
    await maintenancePool.end();
  });

  it("records 0068 with its original Drizzle timestamp and SQL hash", async () => {
    const result = await pool.query<{
      id: number;
      hash: string;
      created_at: string;
    }>(
      `SELECT id, hash, created_at
       FROM drizzle.__drizzle_migrations
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    );

    expect(result.rows).toEqual([
      {
        id: 69,
        hash: originalMigrationHash,
        created_at: String(originalMigrationTimestamp),
      },
    ]);
  });

  it("installs both indexes with the exact tenant/date/id column order", async () => {
    const result = await pool.query<{
      table_name: string;
      index_name: string;
      columns: string[];
    }>(
      `SELECT table_relation.relname AS table_name,
              index_relation.relname AS index_name,
              json_agg(attribute.attname ORDER BY key_column.ordinality) AS columns
       FROM pg_index AS index_metadata
       JOIN pg_class AS index_relation ON index_relation.oid = index_metadata.indexrelid
       JOIN pg_class AS table_relation ON table_relation.oid = index_metadata.indrelid
       CROSS JOIN LATERAL
         unnest(index_metadata.indkey::smallint[]) WITH ORDINALITY AS key_column(attnum, ordinality)
       JOIN pg_attribute AS attribute
         ON attribute.attrelid = table_relation.oid AND attribute.attnum = key_column.attnum
       WHERE index_relation.relname = ANY($1::text[])
       GROUP BY table_relation.relname, index_relation.relname
       ORDER BY index_relation.relname`,
      [[...indexNames]],
    );

    expect(result.rows).toEqual([
      {
        table_name: "billing_act_documents",
        index_name: "billing_act_documents_tenant_created_id_idx",
        columns: ["tenant_id", "created_at", "id"],
      },
      {
        table_name: "commercial_offer_documents",
        index_name: "commercial_offer_documents_tenant_created_id_idx",
        columns: ["tenant_id", "created_at", "id"],
      },
    ]);
  });

  it("uses both indexes for the tenant/date/order access path under a bounded planner probe", async () => {
    await pool.query("SET enable_seqscan = off");
    await pool.query("SET enable_bitmapscan = off");
    for (const [tableName, indexName] of [
      ["commercial_offer_documents", "commercial_offer_documents_tenant_created_id_idx"],
      ["billing_act_documents", "billing_act_documents_tenant_created_id_idx"],
    ] as const) {
      const result = await pool.query<Record<"QUERY PLAN", unknown>>(
        `EXPLAIN (FORMAT JSON, COSTS OFF)
         SELECT id, created_at
         FROM ${tableName}
         WHERE tenant_id = $1
           AND created_at >= $2::timestamptz
           AND created_at <= $3::timestamptz
         ORDER BY created_at DESC, id DESC
         LIMIT 25`,
        ["billing-index-tenant", "2026-01-01T00:00:00Z", "2026-12-31T23:59:59Z"],
      );
      const plan = JSON.stringify(result.rows[0]?.["QUERY PLAN"]);
      expect(plan, tableName).toContain(indexName);
      expect(plan, tableName).toContain('"Scan Direction":"Backward"');
    }
  });

  it("does not reapply 0068 when the database records its original timestamp and hash", async () => {
    const originalRecord = await pool.query<{
      id: number;
      hash: string;
      created_at: string;
    }>(
      `UPDATE drizzle.__drizzle_migrations
       SET hash = $1, created_at = $2
       WHERE id = (
         SELECT id
         FROM drizzle.__drizzle_migrations
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       )
       RETURNING id, hash, created_at`,
      [originalMigrationHash, originalMigrationTimestamp],
    );
    expect(originalRecord.rows).toEqual([
      {
        id: 69,
        hash: originalMigrationHash,
        created_at: String(originalMigrationTimestamp),
      },
    ]);

    const migrationsBefore = await pool.query<{
      id: number;
      hash: string;
      created_at: string;
    }>(
      `SELECT id, hash, created_at
       FROM drizzle.__drizzle_migrations
       ORDER BY id`,
    );
    const indexesBefore = await pool.query<{
      oid: string;
      index_name: string;
      definition: string;
    }>(
      `SELECT index_relation.oid::text AS oid,
              index_relation.relname AS index_name,
              pg_get_indexdef(index_relation.oid) AS definition
       FROM pg_class AS index_relation
       WHERE index_relation.relname = ANY($1::text[])
       ORDER BY index_relation.relname`,
      [[...indexNames]],
    );
    expect(indexesBefore.rows).toHaveLength(indexNames.length);

    await migrate(drizzle(pool), { migrationsFolder });

    const migrationsAfter = await pool.query<{
      id: number;
      hash: string;
      created_at: string;
    }>(
      `SELECT id, hash, created_at
       FROM drizzle.__drizzle_migrations
       ORDER BY id`,
    );
    const indexesAfter = await pool.query<{
      oid: string;
      index_name: string;
      definition: string;
    }>(
      `SELECT index_relation.oid::text AS oid,
              index_relation.relname AS index_name,
              pg_get_indexdef(index_relation.oid) AS definition
       FROM pg_class AS index_relation
       WHERE index_relation.relname = ANY($1::text[])
       ORDER BY index_relation.relname`,
      [[...indexNames]],
    );

    expect(migrationsAfter.rows).toEqual(migrationsBefore.rows);
    expect(indexesAfter.rows).toEqual(indexesBefore.rows);
  });
});
