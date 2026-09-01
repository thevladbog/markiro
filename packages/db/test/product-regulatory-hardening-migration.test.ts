import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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

describe.skipIf(!databaseUrl)("product regulatory hardening migration", () => {
  const databaseName = `markiro_regulatory_hardening_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenancePool = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: scratchUrl.toString() });
  let temporaryRoot = "";
  let created = false;

  const tenantId = "product-regulatory-hardening";
  const productId = "00000000-0000-4000-8000-000000010801";
  const nonPositiveRevisionProductId = "00000000-0000-4000-8000-000000010807";
  const schemaVersionId = "00000000-0000-4000-8000-000000010802";
  const snapshotId = "00000000-0000-4000-8000-000000010803";
  const appliedProposalId = "00000000-0000-4000-8000-000000010804";
  const previewProposalId = "00000000-0000-4000-8000-000000010805";
  const invalidSelectionProposalId = "00000000-0000-4000-8000-000000010806";
  const selectedIds = [
    "00000000-0000-4000-8000-000000010811",
    "00000000-0000-4000-8000-000000010812",
  ];
  const contentHash = "a".repeat(64);

  beforeAll(async () => {
    await maintenancePool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-regulatory-hardening-"));
    const migrationsThrough0107 = join(temporaryRoot, "migrations");
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: migrationsThrough0107,
      lastIncludedIndex: 107,
    });
    await migrate(drizzle(pool), { migrationsFolder: migrationsThrough0107 });

    await pool.query(
      `INSERT INTO organization (id, name, slug, created_at)
       VALUES ($1, 'Regulatory hardening migration', $1, now())`,
      [tenantId],
    );
    await pool.query(
      `INSERT INTO products
         (id, tenant_id, gtin14, name, chz_product_group_code, egais_code)
       VALUES
         ($1, $2, '00000000010801', 'Legacy regulatory product', 15,
          'legacy-value-must-remain'),
         ($3, $2, '00000000010802', 'Invalid legacy revision', 15, null)`,
      [productId, tenantId, nonPositiveRevisionProductId],
    );
    await pool.query(
      `INSERT INTO national_catalog_schema_versions
         (id, scope_key, category_id, category_name, selectors, content_hash, definition,
          status, fetched_at, validated_at, activated_at)
       VALUES
         ($1, 'group:15', 'legacy-category', 'Legacy category', '{}'::jsonb, $2,
          '{"formatVersion":1,"fields":[]}'::jsonb, 'active',
          '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')`,
      [schemaVersionId, contentHash],
    );
    await pool.query(
      `INSERT INTO product_regulatory_profiles
         (tenant_id, product_id, revision, category_id, category_name, schema_version_id,
          source, confirmed_at)
       VALUES
         ($1, $2, 7, 'legacy-category', 'Legacy category', $3, 'manual',
          '2026-08-01T01:00:00Z'),
         ($1, $4, -2, 'legacy-category', 'Legacy category', $3, 'migration',
          '2026-08-01T01:30:00Z')`,
      [tenantId, productId, schemaVersionId, nonPositiveRevisionProductId],
    );
    await pool.query(
      `INSERT INTO product_regulatory_proposals
         (id, tenant_id, product_id, source, source_ref, base_revision, diff, status,
          created_at, applied_at)
       VALUES
         ($1, $2, $3, 'manual', $4, 6, '{"formatVersion":1}'::jsonb, 'applied',
          '2026-08-01T02:00:00Z', '2026-08-01T03:00:00Z'),
         ($5, $2, $3, 'manual', null, 7, '{"formatVersion":1}'::jsonb, 'preview',
          '2026-08-02T02:00:00Z', null),
         ($6, $2, $3, 'manual', 'not-json', 6, '{"formatVersion":1}'::jsonb, 'applied',
          '2026-08-01T04:00:00Z', '2026-08-01T05:00:00Z')`,
      [
        appliedProposalId,
        tenantId,
        productId,
        JSON.stringify(selectedIds),
        previewProposalId,
        invalidSelectionProposalId,
      ],
    );
    await pool.query(
      `INSERT INTO national_catalog_card_snapshots
         (id, tenant_id, product_id, gtin14, card_id, card_status, etag, content_hash,
          payload, fetched_at)
       VALUES
         ($1, $2, $3, '00000000010801', 'legacy-card', 'published', 'legacy-etag', $4,
          '{"results":[{"good_id":"legacy-card"}]}'::jsonb, '2026-08-01T06:00:00Z')`,
      [snapshotId, tenantId, productId, "b".repeat(64)],
    );

    await migrate(drizzle(pool), { migrationsFolder });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (created) await maintenancePool.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`);
    await maintenancePool.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("replaces global schema hash uniqueness with scope-local uniqueness", async () => {
    await expect(
      pool.query(
        `INSERT INTO national_catalog_schema_versions
           (scope_key, category_id, category_name, selectors, content_hash, definition,
            status, fetched_at)
         VALUES
           ('group:16', 'same-content', 'Same content', '{}'::jsonb, $1,
            '{"formatVersion":1,"fields":[]}'::jsonb, 'observed', now())`,
        [contentHash],
      ),
    ).resolves.toBeDefined();

    await expect(
      pool.query(
        `INSERT INTO national_catalog_schema_versions
           (scope_key, category_id, category_name, selectors, content_hash, definition,
            status, fetched_at)
         VALUES
           ('group:15', 'duplicate-content', 'Duplicate content', '{}'::jsonb, $1,
            '{"formatVersion":1,"fields":[]}'::jsonb, 'observed', now())`,
        [contentHash],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("preserves the current profile and creates one explicit migration history row", async () => {
    const profile = await pool.query(
      `SELECT revision, category_id, schema_version_id
       FROM product_regulatory_profiles
       WHERE tenant_id = $1 AND product_id = $2`,
      [tenantId, productId],
    );
    expect(profile.rows).toEqual([
      { revision: 7, category_id: "legacy-category", schema_version_id: schemaVersionId },
    ]);

    const history = await pool.query(
      `SELECT proposal_id, prior_category_id, prior_schema_version_id,
              next_category_id, next_schema_version_id, resulting_revision,
              source, source_ref, actor_id, created_at
       FROM product_regulatory_binding_history
       WHERE tenant_id = $1 AND product_id = $2`,
      [tenantId, productId],
    );
    expect(history.rows).toEqual([
      {
        proposal_id: null,
        prior_category_id: null,
        prior_schema_version_id: null,
        next_category_id: "legacy-category",
        next_schema_version_id: schemaVersionId,
        resulting_revision: 7,
        source: "migration",
        source_ref: null,
        actor_id: null,
        created_at: new Date("2026-08-01T01:00:00Z"),
      },
    ]);
  });

  it("normalizes a non-positive legacy profile revision before history backfill", async () => {
    const profile = await pool.query(
      `SELECT revision
       FROM product_regulatory_profiles
       WHERE tenant_id = $1 AND product_id = $2`,
      [tenantId, nonPositiveRevisionProductId],
    );
    const history = await pool.query(
      `SELECT resulting_revision
       FROM product_regulatory_binding_history
       WHERE tenant_id = $1 AND product_id = $2`,
      [tenantId, nonPositiveRevisionProductId],
    );

    expect(profile.rows).toEqual([{ revision: 1 }]);
    expect(history.rows).toEqual([{ resulting_revision: 1 }]);
  });

  it("classifies legacy proposals, gives them deterministic expiry, and separates replay data", async () => {
    const proposals = await pool.query(
      `SELECT id, kind, source_ref, applied_selection, applied_selection_hash, expires_at
       FROM product_regulatory_proposals
       WHERE tenant_id = $1 AND product_id = $2
       ORDER BY id`,
      [tenantId, productId],
    );
    expect(proposals.rows).toEqual([
      {
        id: appliedProposalId,
        kind: "category_change",
        source_ref: null,
        applied_selection: selectedIds,
        applied_selection_hash: null,
        expires_at: new Date("2026-08-02T02:00:00Z"),
      },
      {
        id: previewProposalId,
        kind: "category_change",
        source_ref: null,
        applied_selection: null,
        applied_selection_hash: null,
        expires_at: new Date("2026-08-03T02:00:00Z"),
      },
      {
        id: invalidSelectionProposalId,
        kind: "category_change",
        source_ref: "not-json",
        applied_selection: null,
        applied_selection_hash: null,
        expires_at: new Date("2026-08-02T04:00:00Z"),
      },
    ]);
  });

  it("marks whole-envelope snapshots as legacy without changing their payload", async () => {
    const snapshot = await pool.query(
      `SELECT source_method, payload_format_version, payload
       FROM national_catalog_card_snapshots
       WHERE id = $1`,
      [snapshotId],
    );
    expect(snapshot.rows).toEqual([
      {
        source_method: "legacy_unknown",
        payload_format_version: 1,
        payload: { results: [{ good_id: "legacy-card" }] },
      },
    ]);
  });

  it("deduplicates immutable card content within an exact card and read method", async () => {
    const sharedHash = "c".repeat(64);
    await expect(
      pool.query(
        `INSERT INTO national_catalog_card_snapshots
           (tenant_id, product_id, gtin14, card_id, card_status, source_method,
            payload_format_version, content_hash, payload, fetched_at)
         VALUES
           ($1, $2, '00000000010801', 'same-card', 'published', 'feed_product', 2,
            $3, '{"good_id":1}'::jsonb, now()),
           ($1, $2, '00000000010801', 'same-card', 'published', 'product', 2,
            $3, '{"good_id":1}'::jsonb, now()),
           ($1, $2, '00000000010801', 'another-card', 'published', 'feed_product', 2,
            $3, '{"good_id":1}'::jsonb, now())`,
        [tenantId, productId, sharedHash],
      ),
    ).resolves.toBeDefined();

    await expect(
      pool.query(
        `INSERT INTO national_catalog_card_snapshots
           (tenant_id, product_id, gtin14, card_id, card_status, source_method,
            payload_format_version, content_hash, payload, fetched_at)
         VALUES ($1, $2, '00000000010801', 'same-card', 'published', 'feed_product', 2,
           $3, '{"good_id":1}'::jsonb, now())`,
        [tenantId, productId, sharedHash],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("does not rewrite compatibility data on the source product", async () => {
    const product = await pool.query(`SELECT egais_code FROM products WHERE id = $1`, [productId]);
    expect(product.rows).toEqual([{ egais_code: "legacy-value-must-remain" }]);
  });
});

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
