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

describe.skipIf(!databaseUrl)("National Catalog import migration", () => {
  const databaseName = `markiro_nc_import_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenancePool = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: scratchUrl.toString() });
  let temporaryRoot = "";
  let created = false;
  const tenant = "nc-import-a";
  const otherTenant = "nc-import-b";
  const actor = "nc-import-actor";
  const product = randomUUID();
  const otherProduct = randomUUID();
  const packagingProduct = randomUUID();
  const snapshot = randomUUID();
  const schemaVersion = randomUUID();
  const session = randomUUID();
  const otherSession = randomUUID();
  const item = randomUUID();
  const preview = randomUUID();
  const otherPreview = randomUUID();
  const operation = randomUUID();
  const image = randomUUID();
  const candidate = randomUUID();
  const asset = randomUUID();
  const sourceHash = "a".repeat(64);
  const decision = {
    previewId: preview,
    acceptedEntryIds: [],
    linkAction: "attach",
    photo: { kind: "candidate", candidateId: candidate },
  };

  beforeAll(async () => {
    await maintenancePool.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-nc-import-"));
    const baselineFolder = join(temporaryRoot, "migrations");
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: baselineFolder,
      lastIncludedIndex: 115,
    });
    await migrate(drizzle(pool), { migrationsFolder: baselineFolder });
    await pool.query(
      `INSERT INTO organization (id, name, slug, created_at) VALUES ($1, 'Tenant A', $1, now()), ($2, 'Tenant B', $2, now())`,
      [tenant, otherTenant],
    );
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified, created_at, updated_at) VALUES ($1, 'Migration actor', 'nc-import@example.test', true, now(), now())`,
      [actor],
    );
    await pool.query(
      `INSERT INTO products (id, tenant_id, gtin14, name, external_ref) VALUES ($1, $2, '04601234567893', 'Original product', '1c-original'), ($3, $4, '04601234567893', 'Other tenant product', null), ($5, $2, '14601234567890', 'Packaging product', null)`,
      [product, tenant, otherProduct, otherTenant, packagingProduct],
    );
    await pool.query(
      `INSERT INTO national_catalog_schema_versions (id, scope_key, category_id, category_name, selectors, content_hash, definition, fetched_at) VALUES ($1, 'group:15', 'original-category', 'Original category', '{}', $2, '{}', now())`,
      [schemaVersion, sourceHash],
    );
    await pool.query(
      `INSERT INTO product_regulatory_profiles (tenant_id, product_id, revision, category_id, category_name, schema_version_id, source, confirmed_at) VALUES ($1, $2, 7, 'original-category', 'Original category', $3, 'manual', '2026-08-01T00:00:00Z')`,
      [tenant, product, schemaVersion],
    );
    await pool.query(
      `INSERT INTO product_regulatory_attribute_values (tenant_id, product_id, schema_version_id, attribute_id, value, source, source_ref) VALUES ($1, $2, $3, 'original-attribute', '"Original value"', 'manual', 'original-provenance')`,
      [tenant, product, schemaVersion],
    );
    await pool.query(
      `INSERT INTO national_catalog_card_snapshots (id, tenant_id, product_id, gtin14, card_id, card_status, source_method, payload_format_version, content_hash, payload, fetched_at) VALUES ($1, $2, $3, '04601234567893', 'original-card', 'published', 'feed_product', 2, $4, '{"good_id":"original-card"}', '2026-08-01T00:00:00Z')`,
      [snapshot, tenant, product, sourceHash],
    );
    await migrate(drizzle(pool), { migrationsFolder });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (created) await maintenancePool.query(`DROP DATABASE "${databaseName}"`);
    await maintenancePool.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("adds no confirmed links and preserves exact product, snapshot and manual provenance", async () => {
    expect(
      (await pool.query(`SELECT count(*)::int AS count FROM national_catalog_product_links`)).rows,
    ).toEqual([{ count: 0 }]);
    expect(
      (
        await pool.query(
          `SELECT id, tenant_id, product_id, gtin14, card_id, source_method, payload_format_version, content_hash, payload FROM national_catalog_card_snapshots ORDER BY id`,
        )
      ).rows,
    ).toEqual([
      {
        id: snapshot,
        tenant_id: tenant,
        product_id: product,
        gtin14: "04601234567893",
        card_id: "original-card",
        source_method: "feed_product",
        payload_format_version: 2,
        content_hash: sourceHash,
        payload: { good_id: "original-card" },
      },
    ]);
    expect(
      (await pool.query(`SELECT gtin14, name, external_ref FROM products WHERE id = $1`, [product]))
        .rows,
    ).toEqual([
      { gtin14: "04601234567893", name: "Original product", external_ref: "1c-original" },
    ]);
    expect(
      (
        await pool.query(
          `SELECT revision, category_id, schema_version_id, source, confirmed_at FROM product_regulatory_profiles WHERE tenant_id = $1 AND product_id = $2`,
          [tenant, product],
        )
      ).rows,
    ).toEqual([
      {
        revision: 7,
        category_id: "original-category",
        schema_version_id: schemaVersion,
        source: "manual",
        confirmed_at: new Date("2026-08-01T00:00:00Z"),
      },
    ]);
    expect(
      (
        await pool.query(
          `SELECT value, source, source_ref FROM product_regulatory_attribute_values WHERE tenant_id = $1 AND product_id = $2`,
          [tenant, product],
        )
      ).rows,
    ).toEqual([{ value: "Original value", source: "manual", source_ref: "original-provenance" }]);
  });

  it("allows packaging GTINs on one card and links without a regulatory profile", async () => {
    await pool.query(
      `INSERT INTO national_catalog_product_links (tenant_id, product_id, environment, card_id, bound_gtin14, confirmed_by) VALUES ($1, $2, 'production', 'shared-card', '04601234567893', $4), ($1, $3, 'production', 'shared-card', '14601234567890', $4)`,
      [tenant, product, packagingProduct, actor],
    );
    expect(
      (
        await pool.query(
          `SELECT count(*)::int AS count FROM national_catalog_product_links WHERE tenant_id = $1 AND card_id = 'shared-card'`,
          [tenant],
        )
      ).rows,
    ).toEqual([{ count: 2 }]);
    await expect(
      pool.query(
        `INSERT INTO national_catalog_product_links (tenant_id, product_id, environment, card_id, bound_gtin14, confirmed_by) VALUES ($1, $2, 'sandbox', 'different-card', '04601234567893', $3)`,
        [tenant, product, actor],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await pool.query(
      `UPDATE national_catalog_product_links SET closed_at = now(), closed_by = $3, closed_reason = 'replaced' WHERE tenant_id = $1 AND product_id = $2`,
      [tenant, product, actor],
    );
    await pool.query(
      `INSERT INTO national_catalog_product_links (tenant_id, product_id, environment, card_id, bound_gtin14, confirmed_by, latest_snapshot_id, reviewed_snapshot_id) VALUES ($1, $2, 'production', 'original-card', '04601234567893', $3, $4, $4)`,
      [tenant, product, actor, snapshot],
    );
    expect(
      (
        await pool.query(
          `SELECT count(*)::int AS count FROM national_catalog_product_links WHERE tenant_id = $1 AND product_id = $2`,
          [tenant, product],
        )
      ).rows,
    ).toEqual([{ count: 2 }]);
  });

  it("rejects cross-tenant product links and snapshots from another product", async () => {
    await expect(
      pool.query(
        `INSERT INTO national_catalog_product_links (tenant_id, product_id, environment, card_id, bound_gtin14, confirmed_by) VALUES ($1, $2, 'production', 'foreign', '04601234567893', $3)`,
        [tenant, otherProduct, actor],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    for (const column of ["latest_snapshot_id", "reviewed_snapshot_id"]) {
      await expect(
        pool.query(
          `UPDATE national_catalog_product_links SET ${column} = $3 WHERE tenant_id = $1 AND product_id = $2`,
          [tenant, packagingProduct, snapshot],
        ),
      ).rejects.toMatchObject({ code: "23503" });
    }
  });

  it("stores independent invalid inputs but deduplicates found cards by session and GTIN", async () => {
    await pool.query(
      `INSERT INTO national_catalog_import_sessions (id, tenant_id, actor_id, environment, mode, through_at, expires_at) VALUES ($1, $3, $4, 'production', 'gtins', now(), now() + interval '24 hours'), ($2, $3, $4, 'production', 'own_catalog', now(), now() + interval '24 hours')`,
      [session, otherSession, tenant, actor],
    );
    await pool.query(
      `INSERT INTO national_catalog_import_items (id, tenant_id, session_id, gtin14, card_id, match) VALUES ($1, $2, $3, '04601234567893', 'shared-card', 'existing')`,
      [item, tenant, session],
    );
    await pool.query(
      `INSERT INTO national_catalog_import_items (tenant_id, session_id, gtin14, card_id, match) VALUES ($1, $2, '14601234567890', 'shared-card', 'new')`,
      [tenant, session],
    );
    await pool.query(
      `INSERT INTO national_catalog_import_items (tenant_id, session_id, input, match) VALUES ($1, $2, 'bad-input', 'invalid'), ($1, $2, 'bad-input', 'invalid')`,
      [tenant, session],
    );
    await expect(
      pool.query(
        `INSERT INTO national_catalog_import_items (tenant_id, session_id, gtin14, card_id, match) VALUES ($1, $2, '04601234567893', 'shared-card', 'new')`,
        [tenant, session],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      pool.query(
        `INSERT INTO national_catalog_import_items (tenant_id, session_id, input, match) VALUES ($1, $2, 'bad-input', 'invalid')`,
        [otherTenant, session],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("rejects previews and operation receipts crossing same-tenant sessions", async () => {
    await expect(
      pool.query(
        `INSERT INTO national_catalog_import_previews (tenant_id, session_id, item_id, expires_at, source_hash) VALUES ($1, $2, $3, now() + interval '24 hours', $4)`,
        [tenant, otherSession, item, sourceHash],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await pool.query(
      `INSERT INTO national_catalog_import_previews (id, tenant_id, session_id, item_id, expires_at, source_hash, source, diff) VALUES ($1, $2, $3, $4, now() + interval '24 hours', $5, '{"good_id":"shared-card"}', '[]'), ($6, $2, $3, $4, now() + interval '24 hours', $5, '{"good_id":"shared-card"}', '[]')`,
      [preview, tenant, session, item, sourceHash, otherPreview],
    );
    await pool.query(
      `INSERT INTO national_catalog_import_operations (id, tenant_id, session_id, actor_id, request_id, decision_hash) VALUES ($1, $2, $3, $4, $5, $6)`,
      [operation, tenant, session, actor, randomUUID(), sourceHash],
    );
    await expect(
      pool.query(
        `INSERT INTO national_catalog_import_operation_items (tenant_id, session_id, operation_id, preview_id, decision) VALUES ($1, $2, $3, $4, '{}')`,
        [tenant, otherSession, operation, preview],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("rejects a receipt whose operation and preview belong to different sessions", async () => {
    const otherOperation = randomUUID();
    await pool.query(
      `INSERT INTO national_catalog_import_operations (id, tenant_id, session_id, actor_id, request_id, decision_hash) VALUES ($1, $2, $3, $4, $5, $6)`,
      [otherOperation, tenant, otherSession, actor, randomUUID(), sourceHash],
    );
    await expect(
      pool.query(
        `INSERT INTO national_catalog_import_operation_items (tenant_id, session_id, operation_id, preview_id, decision) VALUES ($1, $2, $3, $4, '{}')`,
        [tenant, otherSession, otherOperation, preview],
      ),
    ).rejects.toMatchObject({ code: "23503", constraint: "nc_import_operation_items_preview_fk" });
  });

  it("stores raw and normalized link observations independently of reviewed values", async () => {
    const observedHash = "b".repeat(64);
    await pool.query(
      `UPDATE national_catalog_product_links SET raw_status = 'provider-new-status', raw_detailed_statuses = ARRAY['provider-detail'], status_keys = ARRAY['unknown']::national_catalog_status_key[], last_attempt_at = '2026-09-08T00:00:00Z', last_success_at = '2026-09-07T00:00:00Z', last_outcome = 'error', observed_meaningful_hash = $3, reviewed_meaningful_hash = $4 WHERE tenant_id = $1 AND product_id = $2 AND closed_at IS NULL`,
      [tenant, product, observedHash, sourceHash],
    );
    expect(
      (
        await pool.query(
          `SELECT raw_status, raw_detailed_statuses, status_keys::text[] AS status_keys, last_attempt_at, last_success_at, last_outcome, observed_meaningful_hash, reviewed_meaningful_hash FROM national_catalog_product_links WHERE tenant_id = $1 AND product_id = $2 AND closed_at IS NULL`,
          [tenant, product],
        )
      ).rows,
    ).toEqual([
      {
        raw_status: "provider-new-status",
        raw_detailed_statuses: ["provider-detail"],
        status_keys: ["unknown"],
        last_attempt_at: new Date("2026-09-08T00:00:00Z"),
        last_success_at: new Date("2026-09-07T00:00:00Z"),
        last_outcome: "error",
        observed_meaningful_hash: observedHash,
        reviewed_meaningful_hash: sourceHash,
      },
    ]);
  });

  it("keeps request identity unique across sessions of a tenant", async () => {
    const requestId = randomUUID();
    await pool.query(
      `INSERT INTO national_catalog_import_operations (tenant_id, session_id, actor_id, request_id, decision_hash) VALUES ($1, $2, $3, $4, $5)`,
      [tenant, session, actor, requestId, sourceHash],
    );
    await expect(
      pool.query(
        `INSERT INTO national_catalog_import_operations (tenant_id, session_id, actor_id, request_id, decision_hash) VALUES ($1, $2, $3, $4, $5)`,
        [tenant, otherSession, actor, requestId, sourceHash],
      ),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("rejects image sources or assets from a different preview or tenant", async () => {
    await pool.query(
      `INSERT INTO media_assets (id, owner_tenant_id, object_key, content_type, byte_size, checksum, width, height) VALUES ($1, $2, 'nc-import/staged.webp', 'image/webp', 100, $3, 100, 100)`,
      [asset, tenant, sourceHash],
    );
    const foreignAsset = randomUUID();
    await pool.query(
      `INSERT INTO media_assets (id, owner_tenant_id, object_key, content_type, byte_size, checksum) VALUES ($1, $2, 'nc-import/foreign.webp', 'image/webp', 100, $3)`,
      [foreignAsset, otherTenant, sourceHash],
    );
    await expect(
      pool.query(
        `INSERT INTO national_catalog_import_images (tenant_id, session_id, preview_id, candidate_id, source_hash, staged_asset_id, expires_at) VALUES ($1, $2, $3, $4, $5, $6, now())`,
        [tenant, session, preview, candidate, sourceHash, foreignAsset],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      pool.query(
        `INSERT INTO national_catalog_import_images (tenant_id, session_id, preview_id, candidate_id, source_hash, expires_at) VALUES ($1, $2, $3, $4, $5, now())`,
        [tenant, otherSession, preview, candidate, sourceHash],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      pool.query(
        `INSERT INTO national_catalog_import_images (tenant_id, session_id, preview_id, candidate_id, source_hash, expires_at) VALUES ($1, $2, $3, $4, $5, now())`,
        [tenant, session, preview, candidate, "b".repeat(64)],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await pool.query(
      `INSERT INTO national_catalog_import_images (id, tenant_id, session_id, preview_id, candidate_id, source_hash, staged_asset_id, checksum, byte_size, width, height, state, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $6, 100, 100, 100, 'ready', now() + interval '24 hours')`,
      [image, tenant, session, preview, candidate, sourceHash, asset],
    );
    await expect(
      pool.query(
        `INSERT INTO national_catalog_import_operation_items (tenant_id, session_id, operation_id, preview_id, decision, accepted_image_id) VALUES ($1, $2, $3, $4, '{}', $5)`,
        [tenant, session, operation, otherPreview, image],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("retains accepted failed-photo receipts and staged bytes beyond temporary expiry", async () => {
    await pool.query(
      `INSERT INTO national_catalog_import_operation_items (tenant_id, session_id, operation_id, preview_id, decision, product_id, product_result, image_result, accepted_image_id, image_retry_eligible) VALUES ($1, $2, $3, $4, $5, $6, 'applied', 'failed', $7, true)`,
      [tenant, session, operation, preview, decision, product, image],
    );
    await pool.query(
      `UPDATE national_catalog_import_sessions SET state = 'expired', started_at = now() - interval '2 days', expires_at = now() - interval '1 day' WHERE id = $1`,
      [session],
    );
    await pool.query(
      `UPDATE national_catalog_import_previews SET expires_at = now() - interval '1 day' WHERE id = $1`,
      [preview],
    );
    await pool.query(
      `UPDATE national_catalog_import_images SET expires_at = now() - interval '1 day' WHERE id = $1`,
      [image],
    );
    for (const [table, id] of [
      ["national_catalog_import_sessions", session],
      ["national_catalog_import_previews", preview],
      ["national_catalog_import_images", image],
      ["media_assets", asset],
      ["national_catalog_import_operations", operation],
    ]) {
      await expect(pool.query(`DELETE FROM ${table} WHERE id = $1`, [id])).rejects.toMatchObject({
        code: "23503",
      });
    }
    expect(
      (
        await pool.query(
          `SELECT decision, product_id, product_result, image_result, accepted_image_id, image_retry_eligible FROM national_catalog_import_operation_items WHERE operation_id = $1`,
          [operation],
        )
      ).rows,
    ).toEqual([
      {
        decision,
        product_id: product,
        product_result: "applied",
        image_result: "failed",
        accepted_image_id: image,
        image_retry_eligible: true,
      },
    ]);
    expect(
      (
        await pool.query(
          `SELECT staged_asset_id FROM national_catalog_import_images WHERE id = $1`,
          [image],
        )
      ).rows,
    ).toEqual([{ staged_asset_id: asset }]);
    await expect(
      pool.query(
        `UPDATE national_catalog_import_operation_items SET accepted_image_id = null WHERE operation_id = $1`,
        [operation],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(`DELETE FROM national_catalog_card_snapshots WHERE id = $1`, [snapshot]),
    ).rejects.toMatchObject({ code: "23503" });
  });

  it("preserves bigint fencing precision and rejects invalid counters and image metadata", async () => {
    await pool.query(
      `INSERT INTO national_catalog_request_leases (tenant_id, owner, fence, lease_until, next_allowed_at) VALUES ($1, $2, 9007199254740993, now(), now())`,
      [tenant, randomUUID()],
    );
    expect(
      (
        await pool.query(
          `SELECT fence::text FROM national_catalog_request_leases WHERE tenant_id = $1`,
          [tenant],
        )
      ).rows,
    ).toEqual([{ fence: "9007199254740993" }]);
    await expect(
      pool.query(`UPDATE national_catalog_request_leases SET fence = -1 WHERE tenant_id = $1`, [
        tenant,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(`UPDATE national_catalog_import_sessions SET loaded = 100001 WHERE id = $1`, [
        session,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(`UPDATE national_catalog_import_images SET width = 1201 WHERE id = $1`, [image]),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(`UPDATE national_catalog_import_images SET staged_asset_id = null WHERE id = $1`, [
        image,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("keeps preparation request IDs idempotent per session and denies cross-tenant sessions", async () => {
    const preparedSession = randomUUID();
    const requestId = randomUUID();
    await pool.query(
      `INSERT INTO national_catalog_import_sessions(id,tenant_id,actor_id,environment,mode,through_at,expires_at) VALUES($1,$2,$3,'sandbox','gtins',now(),now()+interval '24 hours')`,
      [preparedSession, tenant, actor],
    );
    const insert = `INSERT INTO national_catalog_import_preparations(tenant_id,session_id,actor_id,request_id,request_hash,request,checkpoint,expires_at) VALUES($1,$2,$3,$4,$5,'{}','{}',now()+interval '24 hours')`;
    await pool.query(insert, [tenant, preparedSession, actor, requestId, sourceHash]);
    await expect(
      pool.query(insert, [tenant, preparedSession, actor, requestId, sourceHash]),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      pool.query(insert, [otherTenant, preparedSession, actor, randomUUID(), sourceHash]),
    ).rejects.toMatchObject({ code: "23503" });
    expect(
      (
        await pool.query(
          `SELECT count(*)::int AS count FROM national_catalog_import_preparations WHERE tenant_id=$1 AND session_id=$2`,
          [tenant, preparedSession],
        )
      ).rows,
    ).toEqual([{ count: 1 }]);
  });
  it("adds nullable evidence without backfill and freezes actual applied evidence independently of image outcomes", async () => {
    const before = await pool.query(
      `SELECT applied_evidence FROM national_catalog_import_operation_items WHERE operation_id=$1`,
      [operation],
    );
    expect(before.rows).toEqual([{ applied_evidence: null }]);
    const evidence = {
      version: 1,
      snapshotId: snapshot,
      sourceRef: `national-catalog-snapshot:${snapshot}`,
      sourceHash,
      acceptedEntryIds: [],
      acceptedEntries: [],
    };
    await pool.query(
      `UPDATE national_catalog_import_operation_items SET applied_evidence=$2 WHERE operation_id=$1`,
      [operation, evidence],
    );
    await pool.query(
      `UPDATE national_catalog_import_operation_items SET image_error_code='image_conflict' WHERE operation_id=$1`,
      [operation],
    );
    expect(
      (
        await pool.query(
          `SELECT applied_evidence FROM national_catalog_import_operation_items WHERE operation_id=$1`,
          [operation],
        )
      ).rows,
    ).toEqual([{ applied_evidence: evidence }]);
    await expect(
      pool.query(
        `UPDATE national_catalog_import_operation_items SET applied_evidence=null WHERE operation_id=$1`,
        [operation],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        `UPDATE national_catalog_import_operation_items SET decision='{}' WHERE operation_id=$1`,
        [operation],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("adds nullable photo preparation and review evidence without inventing old actors or selectors", async () => {
    const row = await pool.query(
      "SELECT source_id, preparation_actor_id, preparation_checkpoint FROM national_catalog_import_images WHERE id=$1",
      [image],
    );
    expect(row.rows).toEqual([
      { source_id: null, preparation_actor_id: null, preparation_checkpoint: null },
    ]);
    const columns = await pool.query(
      "SELECT column_name,is_nullable FROM information_schema.columns WHERE table_name='national_catalog_product_links' AND column_name='reviewed_photo'",
    );
    expect(columns.rows).toEqual([{ column_name: "reviewed_photo", is_nullable: "YES" }]);
    await expect(
      pool.query(
        "UPDATE national_catalog_import_images SET preparation_actor_id='missing-actor' WHERE id=$1",
        [image],
      ),
    ).rejects.toMatchObject({ code: "23503" });
  });
  it("adds unknown projection/refresh state without inventing reviewed data for legacy links", async () => {
    const columns = await pool.query(
      "SELECT column_name,is_nullable FROM information_schema.columns WHERE table_name='national_catalog_product_links' AND column_name=ANY($1::text[]) ORDER BY column_name",
      [["reviewed_projection", "observed_projection", "refresh_checkpoint", "refresh_error_code"]],
    );
    expect(columns.rows).toEqual(
      [
        "observed_projection",
        "refresh_checkpoint",
        "refresh_error_code",
        "reviewed_projection",
      ].map((column_name) => ({ column_name, is_nullable: "YES" })),
    );
    const result = await pool.query(
      "SELECT reviewed_projection,observed_projection,refresh_checkpoint,refresh_error_code FROM national_catalog_product_links",
    );
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows)
      expect(row).toEqual({
        reviewed_projection: null,
        observed_projection: null,
        refresh_checkpoint: null,
        refresh_error_code: null,
      });
  });
  it("adds independent bounded dispatch fairness keys without manufacturing work receipts", async () => {
    const workId = randomUUID();
    await pool.query(
      "INSERT INTO national_catalog_import_dispatch_attempts(kind,tenant_id,work_id,step_id,attempted_at) VALUES('enumerate',$1,$2,$3,now())",
      [tenant, workId, randomUUID()],
    );
    await expect(
      pool.query(
        "INSERT INTO national_catalog_import_dispatch_attempts(kind,tenant_id,work_id,step_id,attempted_at) VALUES('arbitrary',$1,$2,'step',now())",
        [tenant, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await expect(
      pool.query(
        "INSERT INTO national_catalog_import_dispatch_attempts(kind,tenant_id,work_id,step_id,attempted_at) VALUES('apply','missing-tenant',$1,'product',now())",
        [randomUUID()],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    const before = await pool.query(
      "SELECT count(*)::int AS n FROM national_catalog_import_operations WHERE tenant_id=$1",
      [tenant],
    );
    await pool.query(
      "UPDATE national_catalog_import_dispatch_attempts SET attempted_at=now() WHERE tenant_id=$1",
      [tenant],
    );
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS n FROM national_catalog_import_operations WHERE tenant_id=$1",
          [tenant],
        )
      ).rows,
    ).toEqual(before.rows);
  });
});
