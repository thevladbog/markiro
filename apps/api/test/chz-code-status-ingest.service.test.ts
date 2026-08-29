import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createDb, ensurePartitions, schema, type Db } from "@markiro/db";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ChzCodeStatusIngestService,
  CHZ_CODE_STATUS_FULL_SWEEP_INTERVAL_MS,
  CHZ_CODE_STATUS_INGEST_LIMIT,
} from "../src/modules/chz-code-statuses/chz-code-status-ingest.service";

const ready = Boolean(process.env.DATABASE_URL);
const PRODUCT_GTIN = "04600000000015";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

// All scanned/exported test data lives on this one day, well inside a single
// monthly partition, so one `ensurePartitions` call up front covers every
// test in the file.
const BASE_SCANNED_AT = new Date("2026-01-15T00:00:00.000Z");

function t(index: number): Date {
  return new Date(BASE_SCANNED_AT.getTime() + index * 1000);
}

function hash(index: number): string {
  return index.toString(16).padStart(64, "0");
}

describe.skipIf(!ready)("ChzCodeStatusIngestService", () => {
  const databaseName = `markiro_chz_code_status_ingest_${randomUUID().replaceAll("-", "_")}`;
  const maintenanceUrl = process.env.DATABASE_URL ?? "postgres://invalid";
  const scratchUrl = new URL(maintenanceUrl);
  scratchUrl.pathname = `/${databaseName}`;
  scratchUrl.search = "";
  const maintenance = createDb(maintenanceUrl);
  let connection: ReturnType<typeof createDb>;
  let db: Db;
  let service: ChzCodeStatusIngestService;

  let tenantId: string;
  let userId: string;
  let productId: string;
  let lineId: string;
  let shiftId: string;
  let inventoryId: string;
  let snapshotId: string;

  beforeAll(async () => {
    await maintenance.pool.query(`CREATE DATABASE "${databaseName}"`);
    connection = createDb(scratchUrl.toString(), { max: 8 });
    await migrate(connection.db, {
      migrationsFolder: join(__dirname, "../../../packages/db/migrations"),
    });
    db = connection.db;
    service = new ChzCodeStatusIngestService(db);
    await ensurePartitions(db, [BASE_SCANNED_AT]);
  }, 120_000);

  afterAll(async () => {
    await connection?.pool.end();
    await maintenance.pool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    await maintenance.pool.end();
  });

  beforeEach(async () => {
    tenantId = randomUUID();
    userId = randomUUID();
    productId = randomUUID();
    lineId = randomUUID();
    shiftId = randomUUID();
    inventoryId = randomUUID();
    snapshotId = randomUUID();

    await db.insert(schema.organization).values({
      id: tenantId,
      name: "Ingest fixture tenant",
      slug: `ingest-${tenantId}`,
      createdAt: new Date(),
    });
    await db.insert(schema.user).values({
      id: userId,
      name: "Ingest fixture user",
      email: `${randomUUID()}@example.invalid`,
      emailVerified: false,
    });
    await db.insert(schema.products).values({
      id: productId,
      tenantId,
      gtin14: PRODUCT_GTIN,
      name: "Ingest fixture product",
      chzProductGroupCode: 8, // milk
    });
    await db.insert(schema.lines).values({ id: lineId, tenantId, name: "Ingest fixture line" });
    await db.insert(schema.shifts).values({
      id: shiftId,
      tenantId,
      productId,
      lineId,
      mode: "aggregation",
      numberMonthKey: "JAN26",
      numberSeq: 1,
    });
    await db.insert(schema.inventories).values({
      id: inventoryId,
      tenantId,
      number: `INV-${randomUUID()}`,
      productId,
      gtin14Snapshot: PRODUCT_GTIN,
      lineId,
      mode: "check",
      productionDateFrom: "2026-01-01",
      productionDateTo: "2026-01-31",
      createdByUserId: userId,
    });
    await db.insert(schema.inventorySnapshots).values({
      id: snapshotId,
      tenantId,
      inventoryId,
      combinedDigest: "0".repeat(64),
      productName: "Ingest fixture product",
      lineName: "Ingest fixture line",
      emittedCount: 0,
      introducedCount: 0,
      appliedCount: 0,
      retiredCount: 0,
      writtenOffCount: 0,
      disaggregationCount: 0,
      protectedCount: 0,
      expectedCount: 0,
      packageCount: 0,
      looseCount: 0,
      fixedByUserId: userId,
    });
  });

  async function seedCode(input: {
    codeHash: string;
    gtin14: string;
    scannedAt: Date;
  }): Promise<void> {
    await db.insert(schema.codes).values({
      tenantId,
      codeHash: input.codeHash,
      shiftId,
      gtin14: input.gtin14,
      serial: `S-${input.codeHash.slice(0, 12)}`,
      canonicalRaw: `01${input.gtin14}21${input.codeHash.slice(0, 20)}`,
      scannedAt: input.scannedAt,
    });
  }

  async function seedSnapshotCode(codeHash: string, gtin14: string): Promise<void> {
    await db.insert(schema.inventorySnapshotCodes).values({
      tenantId,
      snapshotId,
      canonicalRaw: `01${gtin14}21${codeHash.slice(0, 20)}`,
      codeHash,
      gtin14,
      serial: codeHash.slice(0, 12),
      sourceStatus: "INTRODUCED",
      sourceProductionDate: "2026-01-15",
      expected: false,
      protected: false,
    });
  }

  async function clearProductGroup(gtin14: string): Promise<void> {
    await db
      .update(schema.products)
      .set({ chzProductGroupCode: null })
      .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.gtin14, gtin14)));
  }

  async function rowsFor(id: string) {
    return db
      .select()
      .from(schema.chzCodeStatuses)
      .where(eq(schema.chzCodeStatuses.tenantId, id))
      .orderBy(schema.chzCodeStatuses.codeHash);
  }

  it("creates one status row per code and resolves its product group", async () => {
    await seedCode({ codeHash: HASH_A, gtin14: PRODUCT_GTIN, scannedAt: t(1) });

    const result = await service.run(tenantId);

    expect(result.inserted).toBe(1);
    const [row] = await rowsFor(tenantId);
    expect(row).toMatchObject({ codeHash: HASH_A, chzProductGroupCode: 8 });
    // Due immediately: a code nobody has asked ЧЗ about is maximally stale.
    expect(row!.nextRefreshAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("yields one row for a code scanned twice", async () => {
    await seedCode({ codeHash: HASH_A, gtin14: PRODUCT_GTIN, scannedAt: t(1) });
    await seedCode({ codeHash: HASH_A, gtin14: PRODUCT_GTIN, scannedAt: t(2) });

    await service.run(tenantId);

    expect(await rowsFor(tenantId)).toHaveLength(1);
  });

  it("stores a code whose product has no ChZ group, and leaves it unaskable", async () => {
    await clearProductGroup(PRODUCT_GTIN);
    await seedCode({ codeHash: HASH_B, gtin14: PRODUCT_GTIN, scannedAt: t(1) });

    await service.run(tenantId);

    const [row] = await rowsFor(tenantId);
    // Stored so the operator can be told it exists and why it is stuck;
    // null group so the refresh query's partial index excludes it.
    expect(row).toMatchObject({ codeHash: HASH_B, chzProductGroupCode: null });
  });

  it("advances the watermark and does not re-read what it already walked", async () => {
    await seedCode({ codeHash: HASH_A, gtin14: PRODUCT_GTIN, scannedAt: t(1) });
    const first = await service.run(tenantId);
    expect(first.inserted).toBe(1);

    const second = await service.run(tenantId);
    expect(second.inserted).toBe(0);
    expect(second.watermark?.getTime()).toBe(first.watermark?.getTime());
  });

  it("picks up a code scanned after the last walk", async () => {
    await seedCode({ codeHash: HASH_A, gtin14: PRODUCT_GTIN, scannedAt: t(1) });
    await service.run(tenantId);
    await seedCode({ codeHash: HASH_B, gtin14: PRODUCT_GTIN, scannedAt: t(2) });

    const result = await service.run(tenantId);

    expect(result.inserted).toBe(1);
    expect((await rowsFor(tenantId)).map((row) => row.codeHash).sort()).toEqual(
      [HASH_A, HASH_B].sort(),
    );
  });

  it("reports that it is not caught up when it hits the per-pass limit", async () => {
    for (let index = 0; index < CHZ_CODE_STATUS_INGEST_LIMIT + 1; index += 1) {
      await seedCode({ codeHash: hash(index), gtin14: PRODUCT_GTIN, scannedAt: t(index) });
    }

    const result = await service.run(tenantId);

    expect(result.inserted).toBe(CHZ_CODE_STATUS_INGEST_LIMIT);
    expect(result.caughtUp).toBe(false);
  }, 180_000);

  it("also picks up codes that arrived through an inventory export, not a scan", async () => {
    // A tenant whose history predates Markiro is bootstrapped from an ordered
    // export, and those codes land in `inventory_snapshot_codes` — never in
    // `codes`. Walking only the scan table would leave exactly the population
    // this feature exists to stop re-importing invisible to it.
    await seedSnapshotCode(HASH_C, PRODUCT_GTIN);

    await service.run(tenantId);

    expect((await rowsFor(tenantId)).map((row) => row.codeHash)).toContain(HASH_C);
  });

  it("yields one row for a code that was both scanned and exported", async () => {
    await seedCode({ codeHash: HASH_A, gtin14: PRODUCT_GTIN, scannedAt: t(1) });
    await seedSnapshotCode(HASH_A, PRODUCT_GTIN);

    await service.run(tenantId);

    expect(await rowsFor(tenantId)).toHaveLength(1);
  });

  async function forceFullSweepDue(): Promise<void> {
    await db
      .update(schema.chzCodeStatusCursors)
      .set({ lastFullSweepAt: new Date(Date.now() - CHZ_CODE_STATUS_FULL_SWEEP_INTERVAL_MS - 1) })
      .where(eq(schema.chzCodeStatusCursors.tenantId, tenantId));
  }

  it("misses a code committed behind the cursor via the cursor walk, but the full sweep catches it", async () => {
    // Advance the cursor with an ordinary scan. The first pass also runs the
    // full sweep (nothing has run yet for this tenant), so it starts primed.
    await seedCode({ codeHash: HASH_A, gtin14: PRODUCT_GTIN, scannedAt: t(5) });
    await service.run(tenantId);

    // Simulate an offline-then-sync device: a code committed with a
    // `scanned_at` behind the cursor. That is normal Station behaviour, not
    // corrupt input -- see `WINDOW_PAST_MS` in `station-scans.service.ts`,
    // which accepts a `scannedAt` up to three years in the past for exactly
    // this reason.
    await seedCode({ codeHash: HASH_B, gtin14: PRODUCT_GTIN, scannedAt: t(1) });

    // The very next pass: the sweep just ran, so it is not due, and the
    // cursor walk's `scannedAt > t(5)` misses B outright.
    const missed = await service.run(tenantId);
    expect(missed.inserted).toBe(0);
    expect((await rowsFor(tenantId)).map((row) => row.codeHash)).not.toContain(HASH_B);

    // Once the sweep is due, the full anti-join finds B with no help from
    // the cursor at all.
    await forceFullSweepDue();
    const caught = await service.run(tenantId);
    expect(caught.inserted).toBe(1);
    expect((await rowsFor(tenantId)).map((row) => row.codeHash).sort()).toEqual(
      [HASH_A, HASH_B].sort(),
    );
  });

  it("does not run the full sweep twice within its interval", async () => {
    await seedCode({ codeHash: HASH_A, gtin14: PRODUCT_GTIN, scannedAt: t(5) });
    await service.run(tenantId); // first pass: nothing has swept yet, so it runs

    const [afterFirst] = await db
      .select({ lastFullSweepAt: schema.chzCodeStatusCursors.lastFullSweepAt })
      .from(schema.chzCodeStatusCursors)
      .where(eq(schema.chzCodeStatusCursors.tenantId, tenantId));
    expect(afterFirst?.lastFullSweepAt).not.toBeNull();

    // A code behind the cursor, added right after: only a sweep could find
    // it, and the sweep should not be due again yet.
    await seedCode({ codeHash: HASH_B, gtin14: PRODUCT_GTIN, scannedAt: t(1) });
    await service.run(tenantId);

    const [afterSecond] = await db
      .select({ lastFullSweepAt: schema.chzCodeStatusCursors.lastFullSweepAt })
      .from(schema.chzCodeStatusCursors)
      .where(eq(schema.chzCodeStatusCursors.tenantId, tenantId));

    expect(afterSecond?.lastFullSweepAt?.getTime()).toBe(afterFirst?.lastFullSweepAt?.getTime());
    expect((await rowsFor(tenantId)).map((row) => row.codeHash)).not.toContain(HASH_B);
  });

  it("terminates when a limit-filling batch shares one scanned_at, and does not skip a later row afterward", async () => {
    // The degenerate case the escalation loop in `walkCodes` exists for:
    // every row in a limit-filling batch shares one `scanned_at`, so there
    // is no timestamp in the batch a cursor could safely stop at. Without
    // the loop this would never advance and the pass would spin forever.
    const sharedScannedAt = t(0);
    for (let index = 0; index < CHZ_CODE_STATUS_INGEST_LIMIT + 1; index += 1) {
      await seedCode({ codeHash: hash(index), gtin14: PRODUCT_GTIN, scannedAt: sharedScannedAt });
    }

    const result = await service.run(tenantId);

    // The loop drains the whole degenerate batch rather than looping
    // forever -- forward progress on the cursor takes priority over the
    // pass's nominal budget when the two conflict (see walkCodes's doc).
    expect(result.inserted).toBe(CHZ_CODE_STATUS_INGEST_LIMIT + 1);
    expect(result.watermark?.getTime()).toBe(sharedScannedAt.getTime());
    // The escalation spent more than the pass's nominal budget on the
    // cursor walk alone, so the other two phases correctly report
    // themselves unable to run this pass.
    expect(result.caughtUp).toBe(false);

    // A later-timestamped row must not be skipped by wherever the cursor
    // landed.
    await seedCode({ codeHash: HASH_A, gtin14: PRODUCT_GTIN, scannedAt: t(1) });
    const second = await service.run(tenantId);

    expect(second.inserted).toBe(1);
    expect((await rowsFor(tenantId)).map((row) => row.codeHash)).toContain(HASH_A);
  }, 180_000);
});
