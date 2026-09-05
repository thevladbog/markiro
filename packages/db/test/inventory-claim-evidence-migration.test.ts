import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { schema } from "../src/index.js";
import { copyMigrationsThroughIndex } from "./support/legacy-migrations.js";

const databaseUrl = process.env.DATABASE_URL;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

describe.skipIf(!databaseUrl)("inventory claim evidence migration", () => {
  const databaseName = `markiro_inventory_claims_${randomUUID().replaceAll("-", "_")}`;
  const scratchUrl = new URL(databaseUrl ?? "postgres://invalid");
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenancePool = new pg.Pool({ connectionString: databaseUrl });
  const pool = new pg.Pool({ connectionString: scratchUrl.toString() });
  const db = drizzle(pool);
  let temporaryRoot = "";
  let created = false;

  const tenantId = `claim-migration-${randomUUID()}`;
  const userId = `claim-user-${randomUUID()}`;
  const productId = randomUUID();
  const lineId = randomUUID();
  const operatorId = randomUUID();
  const deviceAId = randomUUID();
  const deviceBId = randomUUID();
  const inventoryId = randomUUID();
  const snapshotId = randomUUID();
  const itemEventId = randomUUID();
  const boxEventId = randomUUID();
  const itemHash = "a".repeat(64);
  const boxHashB = "b".repeat(64);
  const boxHashC = "c".repeat(64);
  const sscc = "346006820000000014";

  beforeAll(async () => {
    await maintenancePool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    created = true;
    temporaryRoot = await mkdtemp(join(tmpdir(), "markiro-inventory-claims-migration-"));
    const legacyMigrations = join(temporaryRoot, "migrations");
    await copyMigrationsThroughIndex({
      sourceFolder: migrationsFolder,
      targetFolder: legacyMigrations,
      lastIncludedIndex: 73,
    });
    await migrate(db, { migrationsFolder: legacyMigrations });

    await db.insert(schema.organization).values({
      id: tenantId,
      name: "Claim migration",
      slug: `${tenantId}-${randomUUID()}`,
      createdAt: new Date(),
    });
    // This fixture intentionally stops at 0073: do not insert fields from the
    // current user model (0114 adds two_factor_enabled).
    await pool.query(
      `INSERT INTO "user" (id, name, email, email_verified) VALUES ($1, $2, $3, false)`,
      [userId, "Claim migration", `${randomUUID()}@example.invalid`],
    );
    // Raw SQL, not `schema.products`: this scratch DB is pinned at migration
    // 73, while the live schema object keeps gaining columns (e.g. 0085's
    // `archived`) that drizzle would list in the INSERT but do not exist here.
    await pool.query(`insert into products (id, tenant_id, gtin14, name) values ($1, $2, $3, $4)`, [
      productId,
      tenantId,
      "04600000000015",
      "Product",
    ]);
    await db.insert(schema.lines).values({ id: lineId, tenantId, name: "Line" });
    await db.insert(schema.employees).values({ id: operatorId, tenantId, fullName: "Operator" });
    await db.insert(schema.stationDevices).values([
      { id: deviceAId, tenantId, name: "Station A", lineId },
      { id: deviceBId, tenantId, name: "Station B", lineId },
    ]);
    // Keep this legacy fixture independent from columns added after migration
    // 73, just like the product insert above.
    await pool.query(
      `INSERT INTO inventories
         (id, tenant_id, number, product_id, gtin14_snapshot, line_id, mode,
          production_date_from, production_date_to, created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'check', $7, $8, $9)`,
      [
        inventoryId,
        tenantId,
        `INV-${randomUUID()}`,
        productId,
        "04600000000015",
        lineId,
        "2026-08-01",
        "2026-08-31",
        userId,
      ],
    );
    await pool.query(
      `INSERT INTO inventory_snapshots
         (id, tenant_id, inventory_id, combined_digest, emitted_count, introduced_count,
          applied_count, retired_count, written_off_count, disaggregation_count,
          protected_count, expected_count, package_count, loose_count, fixed_by_user_id)
       VALUES ($1, $2, $3, $4, 0, 3, 0, 0, 0, 0, 0, 3, 1, 0, $5)`,
      [snapshotId, tenantId, inventoryId, "0".repeat(64), userId],
    );
    await db.insert(schema.inventorySnapshotCodes).values(
      [itemHash, boxHashB, boxHashC].map((codeHash, index) => ({
        tenantId,
        snapshotId,
        canonicalRaw: `legacy-code-${index}`,
        codeHash,
        gtin14: "04600000000015",
        serial: `legacy-${index}`,
        sourceStatus: "INTRODUCED" as const,
        sourceProductionDate: "2026-08-20",
        parentSscc: sscc,
        expected: true,
        protected: false,
      })),
    );
    await db
      .update(schema.inventories)
      .set({
        status: "running",
        activeSnapshotId: snapshotId,
        stationManifest: { snapshotRevision: 1 },
        startedAt: new Date(),
        startedByUserId: userId,
      })
      .where(eq(schema.inventories.id, inventoryId));
    await db.insert(schema.inventoryScanBatches).values([
      {
        tenantId,
        inventoryId,
        deviceId: deviceAId,
        batchId: "legacy-item",
        payloadDigest: "1".repeat(64),
        sequenceCeiling: 1n,
        outcome: "applied",
        result: legacyResult("legacy-item", "1".repeat(64), itemEventId, itemEventId),
      },
      {
        tenantId,
        inventoryId,
        deviceId: deviceBId,
        batchId: "legacy-box",
        payloadDigest: "2".repeat(64),
        sequenceCeiling: 1n,
        outcome: "applied",
        result: legacyResult("legacy-box", "2".repeat(64), boxEventId, boxEventId),
      },
    ]);
    await db.insert(schema.inventoryScanEvents).values([
      {
        eventId: itemEventId,
        tenantId,
        inventoryId,
        batchId: "legacy-item",
        deviceId: deviceAId,
        deviceSequence: 1n,
        operatorId,
        scannedAt: new Date("2026-08-25T08:00:00.000Z"),
        kind: "item",
        normalizedIdentity: `item:${itemHash}`,
        codeHash: itemHash,
        rawPayload: "legacy-item",
        activeProductionDate: "2026-08-20",
        snapshotRevision: 1,
        localVerdict: "expected",
        authoritativeVerdict: "applied",
        firstWinningEventId: itemEventId,
      },
      {
        eventId: boxEventId,
        tenantId,
        inventoryId,
        batchId: "legacy-box",
        deviceId: deviceBId,
        deviceSequence: 1n,
        operatorId,
        scannedAt: new Date("2026-08-25T09:00:00.000Z"),
        kind: "known_box",
        normalizedIdentity: `known_box:${sscc}`,
        rawPayload: sscc,
        activeProductionDate: "2026-08-20",
        snapshotRevision: 1,
        localVerdict: "expected",
        authoritativeVerdict: "applied",
        firstWinningEventId: boxEventId,
      },
    ]);
    await db
      .insert(schema.inventoryCodeResults)
      .values([
        result(itemHash, itemEventId, deviceAId, "2026-08-25T08:00:00.000Z"),
        result(boxHashB, boxEventId, deviceBId, "2026-08-25T09:00:00.000Z"),
        result(boxHashC, boxEventId, deviceBId, "2026-08-25T09:00:00.000Z"),
      ]);

    await migrate(db, { migrationsFolder });
  }, 120_000);

  afterAll(async () => {
    await pool.end();
    if (created) await maintenancePool.query(`DROP DATABASE ${quoteIdentifier(databaseName)}`);
    await maintenancePool.end();
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  });

  it("reconstructs item and partially-winning known-box evidence from real 0073 state idempotently", async () => {
    await migrate(db, { migrationsFolder });
    const rows = await pool.query<{
      source_event_id: string;
      code_hash: string;
      status: string;
      winning_event_id: string;
    }>(
      `SELECT source_event_id, code_hash, status, winning_event_id
         FROM inventory_event_claim_outcomes
        WHERE tenant_id = $1 AND inventory_id = $2
        ORDER BY source_event_id, code_hash`,
      [tenantId, inventoryId],
    );
    expect(rows.rows).toEqual(
      [
        {
          source_event_id: itemEventId,
          code_hash: itemHash,
          status: "claimed",
          winning_event_id: itemEventId,
        },
        {
          source_event_id: boxEventId,
          code_hash: itemHash,
          status: "duplicate",
          winning_event_id: itemEventId,
        },
        {
          source_event_id: boxEventId,
          code_hash: boxHashB,
          status: "claimed",
          winning_event_id: boxEventId,
        },
        {
          source_event_id: boxEventId,
          code_hash: boxHashC,
          status: "claimed",
          winning_event_id: boxEventId,
        },
      ].sort((left, right) =>
        `${left.source_event_id}:${left.code_hash}`.localeCompare(
          `${right.source_event_id}:${right.code_hash}`,
        ),
      ),
    );
  });

  function result(codeHash: string, eventId: string, deviceId: string, scannedAt: string) {
    return {
      tenantId,
      inventoryId,
      codeHash,
      snapshotId,
      firstAcceptedEventId: eventId,
      winningDeviceId: deviceId,
      winningScannedAt: new Date(scannedAt),
      observedProductionDate: "2026-08-20",
      classification: "expected" as const,
      originClassification: "expected" as const,
    };
  }

  function legacyResult(batchId: string, digest: string, eventId: string, winnerId: string) {
    return {
      inventoryId,
      snapshotId,
      snapshotRevision: 1,
      batchId,
      payloadDigest: digest,
      sequenceCeiling: 1,
      resultRevision: 1,
      outcomes: [
        {
          eventId,
          status: "applied",
          reasonCode: "CLAIM_APPLIED",
          firstWinningEventId: winnerId,
        },
      ],
    };
  }
});

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(identifier)) throw new Error("Unsafe temporary database name");
  return `"${identifier}"`;
}
