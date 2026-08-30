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

  it("re-resolves a null product group once the product is given one, without counting it as a new discovery", async () => {
    await clearProductGroup(PRODUCT_GTIN);
    // The reachable path final review Finding 1 is about: a tenant
    // bootstrapped from an ordered export for a product nobody has grouped
    // yet. `walkSnapshotCodes` stores the code with a null group.
    await seedSnapshotCode(HASH_B, PRODUCT_GTIN);
    const first = await service.run(tenantId);
    expect(first.inserted).toBe(1);
    const [beforeGroup] = await rowsFor(tenantId);
    expect(beforeGroup).toMatchObject({ codeHash: HASH_B, chzProductGroupCode: null });

    // The operator gives the product a ЧЗ group. Nothing about
    // `chz_code_statuses` changes by itself: the sweep and the snapshot walk
    // both exclude rows that already exist, so only a fresh sighting of this
    // exact code can revisit it.
    await db
      .update(schema.products)
      .set({ chzProductGroupCode: 8 })
      .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.gtin14, PRODUCT_GTIN)));

    // The Station later scans the same physical code -- an ordinary event,
    // not a special re-ingest trigger. `walkCodes` has no cursor yet (the
    // first pass found nothing in `codes`), so it picks this up.
    await seedCode({ codeHash: HASH_B, gtin14: PRODUCT_GTIN, scannedAt: t(1) });
    const second = await service.run(tenantId);

    // Re-resolving an existing row's group is not a new discovery.
    expect(second.inserted).toBe(0);
    const [afterGroup] = await rowsFor(tenantId);
    expect(afterGroup).toMatchObject({ codeHash: HASH_B, chzProductGroupCode: 8 });
    // Due immediately: a code that just became askable is maximally stale.
    expect(afterGroup!.nextRefreshAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("re-resolves a snapshot-only code's null group via the daily sweep, without waiting for a scan that will never come", async () => {
    await clearProductGroup(PRODUCT_GTIN);
    // The population final review flagged as still unreachable: a code that
    // lives only in `inventory_snapshot_codes` (a bootstrap import) for a
    // product that had no ЧЗ group at import time. Unlike a `codes` row,
    // this one has no "next scan" to fall back on -- `shifts.service.ts`
    // blocks opening a shift for a draft product -- so only the sweep can
    // ever revisit it.
    await seedSnapshotCode(HASH_B, PRODUCT_GTIN);
    const first = await service.run(tenantId);
    expect(first.inserted).toBe(1);
    const [beforeGroup] = await rowsFor(tenantId);
    expect(beforeGroup).toMatchObject({ codeHash: HASH_B, chzProductGroupCode: null });

    // The operator gives the product a ЧЗ group. No ordinary pass changes
    // anything: `walkSnapshotCodes` (the per-pass anti-join) still excludes
    // this row because it already exists.
    await db
      .update(schema.products)
      .set({ chzProductGroupCode: 8 })
      .where(and(eq(schema.products.tenantId, tenantId), eq(schema.products.gtin14, PRODUCT_GTIN)));

    const ordinaryPass = await service.run(tenantId);
    expect(ordinaryPass.inserted).toBe(0);
    const [stillUngrouped] = await rowsFor(tenantId);
    expect(stillUngrouped).toMatchObject({ codeHash: HASH_B, chzProductGroupCode: null });

    // Once the sweep is due, its widened anti-join over
    // `inventory_snapshot_codes` re-feeds the row and `insertStatuses`
    // re-resolves the now-assigned group.
    await forceFullSweepDue();
    const sweepPass = await service.run(tenantId);

    // Re-resolving an existing row's group is not a new discovery.
    expect(sweepPass.inserted).toBe(0);
    const [afterGroup] = await rowsFor(tenantId);
    expect(afterGroup).toMatchObject({ codeHash: HASH_B, chzProductGroupCode: 8 });
    // Due immediately: a code that just became askable is maximally stale.
    expect(afterGroup!.nextRefreshAt.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("leaves an already-grouped, already-checked row untouched by the same widened sweep", async () => {
    // The sweep's widened predicate must not disturb a row that is already
    // settled: one with a group, and with ЧЗ facts the refresh service
    // already wrote. Both `sweepCodes` and `sweepSnapshotCodes` share
    // `insertStatuses`'s `setWhere`, so a settled row from either source
    // must survive a sweep pass unchanged.
    await seedCode({ codeHash: HASH_A, gtin14: PRODUCT_GTIN, scannedAt: t(1) });
    await seedSnapshotCode(HASH_C, PRODUCT_GTIN);
    await service.run(tenantId);

    const checkedAt = new Date("2026-01-10T00:00:00.000Z");
    await db
      .update(schema.chzCodeStatuses)
      .set({ status: "APPLIED", checkedAt })
      .where(eq(schema.chzCodeStatuses.tenantId, tenantId));

    await forceFullSweepDue();
    const sweepPass = await service.run(tenantId);

    expect(sweepPass.inserted).toBe(0);
    const rows = await rowsFor(tenantId);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({ chzProductGroupCode: 8, status: "APPLIED" });
      expect(row.checkedAt?.getTime()).toBe(checkedAt.getTime());
    }
  });

  it("leaves a settled row untouched -- group and ЧЗ facts alike -- when the same code is scanned again", async () => {
    await seedCode({ codeHash: HASH_A, gtin14: PRODUCT_GTIN, scannedAt: t(1) });
    await service.run(tenantId);
    const [before] = await rowsFor(tenantId);
    expect(before).toMatchObject({ codeHash: HASH_A, chzProductGroupCode: 8 });

    // Only the refresh service ever sets these; a spurious touch by ingest
    // would be visible here.
    const checkedAt = new Date("2026-01-10T00:00:00.000Z");
    await db
      .update(schema.chzCodeStatuses)
      .set({ status: "APPLIED", checkedAt })
      .where(
        and(
          eq(schema.chzCodeStatuses.tenantId, tenantId),
          eq(schema.chzCodeStatuses.codeHash, HASH_A),
        ),
      );

    await seedCode({ codeHash: HASH_A, gtin14: PRODUCT_GTIN, scannedAt: t(2) });
    const result = await service.run(tenantId);

    expect(result.inserted).toBe(0);
    const [after] = await rowsFor(tenantId);
    expect(after).toMatchObject({ codeHash: HASH_A, chzProductGroupCode: 8, status: "APPLIED" });
    expect(after!.checkedAt?.getTime()).toBe(checkedAt.getTime());
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
    // The sweep runs first on the initial pass and will consume budget,
    // so we force it to not be due by giving the tenant an old lastFullSweepAt.
    const sharedScannedAt = t(0);
    for (let index = 0; index < CHZ_CODE_STATUS_INGEST_LIMIT + 1; index += 1) {
      await seedCode({ codeHash: hash(index), gtin14: PRODUCT_GTIN, scannedAt: sharedScannedAt });
    }

    // Pre-populate the cursor so the sweep doesn't run.
    await db.insert(schema.chzCodeStatusCursors).values({
      tenantId,
      lastFullSweepAt: new Date(),
    });

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

  it("runs the due sweep even when the cursor walk fills the budget on consecutive passes", async () => {
    // A tenant backfilling from deep history can fill the cursor walk's
    // entire budget on every pass. The sweep is the correctness backstop
    // that catches codes that arrived behind the cursor (normal for a
    // Station syncing after an outage), and it must not starve for the
    // entire backfill. The sweep runs first so it gets first claim on the
    // budget, cost-free in the steady state because it is rare.

    // Prime the cursor, marking the first sweep as done and cursor at t(-1).
    // Use t(-1) so that the walk starts from before all the codes.
    for (let index = 0; index < CHZ_CODE_STATUS_INGEST_LIMIT; index += 1) {
      await seedCode({ codeHash: hash(index), gtin14: PRODUCT_GTIN, scannedAt: t(index) });
    }

    // Pre-populate the cursor to prevent the sweep from running on first pass.
    await db.insert(schema.chzCodeStatusCursors).values({
      tenantId,
      lastScannedAt: new Date(BASE_SCANNED_AT.getTime() - 1000),
      lastFullSweepAt: new Date(),
    });

    const first = await service.run(tenantId);
    expect(first.inserted).toBe(CHZ_CODE_STATUS_INGEST_LIMIT);

    // Simulate an offline-then-sync device: a code committed with a
    // `scanned_at` behind the cursor. The cursor walk's strict `>` would
    // skip it forever, but the sweep (if it runs) will find it.
    await seedCode({ codeHash: HASH_A, gtin14: PRODUCT_GTIN, scannedAt: t(0) });

    // Add more codes after the cursor to fill the walk budget again.
    for (
      let index = CHZ_CODE_STATUS_INGEST_LIMIT;
      index < 2 * CHZ_CODE_STATUS_INGEST_LIMIT;
      index += 1
    ) {
      await seedCode({ codeHash: hash(index), gtin14: PRODUCT_GTIN, scannedAt: t(index) });
    }

    // The second pass: the cursor walk fills the budget on its own, the
    // sweep is still hot, so it should not run. HASH_A stays undetected.
    await service.run(tenantId);
    expect((await rowsFor(tenantId)).map((row) => row.codeHash)).not.toContain(HASH_A);

    // Force the sweep to be due.
    await forceFullSweepDue();

    // The third pass: the cursor walk would fill the budget, but the sweep
    // is now due. Because the sweep runs first, it gets budget and executes
    // before the walk could fill everything. The sweep runs and finds HASH_A.
    const third = await service.run(tenantId);
    expect(third.inserted).toBeGreaterThanOrEqual(1);
    expect((await rowsFor(tenantId)).map((row) => row.codeHash)).toContain(HASH_A);
  }, 300_000);

  it("discriminates sweep-first from cursor-first: finds a code planted behind the cursor even though the cursor walk alone could fill the whole budget", async () => {
    // The test above does not actually pin down phase order: by the pass the
    // sweep is forced due, the cursor walk's own backlog is down to two rows
    // -- nowhere near the budget -- so the sweep runs with almost the whole
    // budget left under either ordering. This test is built so the two
    // orderings diverge on a single pass: the cursor walk *alone*, if it ran
    // first with the full budget, would consume every row of it, while a
    // code sits planted behind the cursor where only the sweep can find it.
    // Sweep-first (the current order) spends budget on the sweep before the
    // walk gets a chance to exhaust it, so the planted code is found this
    // pass. Cursor-first would spend the entire budget on the walk and
    // never reach the sweep this pass, missing it.
    const limit = 5;

    // Sorts first among every codeHash seeded below (hex, zero-padded), so
    // the sweep's `order by codeHash` always returns it within any
    // truncated batch, however small.
    const plantedHash = hash(0);
    await seedCode({ codeHash: plantedHash, gtin14: PRODUCT_GTIN, scannedAt: t(-1) });

    // Exactly `limit` codes strictly ahead of the cursor -- on their own
    // enough for the cursor walk to fill the whole budget if it ran first.
    for (let index = 1; index <= limit; index += 1) {
      await seedCode({ codeHash: hash(index), gtin14: PRODUCT_GTIN, scannedAt: t(index) });
    }

    // The cursor sits between the planted code and the "ahead" codes. No
    // sweep has ever run for this tenant, so it is due on this very first
    // pass without needing `forceFullSweepDue`.
    await db.insert(schema.chzCodeStatusCursors).values({ tenantId, lastScannedAt: t(0) });

    const result = await service.run(tenantId, { limit });

    expect(result.inserted).toBeGreaterThanOrEqual(1);
    expect((await rowsFor(tenantId)).map((row) => row.codeHash)).toContain(plantedHash);
  });

  it("does not throw when the sweep consumes the whole budget, leaving the cursor walk a zero limit", async () => {
    // Before the reorder, the cursor walk always ran with at least some
    // budget left by earlier phases. Now the sweep runs first and can
    // legitimately spend the entire budget itself, leaving `walkCodes`
    // called with `limit: 0` for the first time. `walkCodes` fetches an
    // empty batch in that case and its `rows.length > 0` guard must skip
    // straight past `rows[0]!.scannedAt` rather than throw.
    const limit = 3;
    for (let index = 1; index <= limit; index += 1) {
      await seedCode({ codeHash: hash(index), gtin14: PRODUCT_GTIN, scannedAt: t(index) });
    }

    const result = await service.run(tenantId, { limit });

    // The sweep alone filled the budget (3 codes, limit 3), so the pass is
    // honestly not caught up, and the walk -- called with nothing left to
    // spend -- must not have advanced the cursor.
    expect(result.inserted).toBe(limit);
    expect(result.caughtUp).toBe(false);
    expect(result.watermark).toBeNull();

    const [cursorRow] = await db
      .select({ lastScannedAt: schema.chzCodeStatusCursors.lastScannedAt })
      .from(schema.chzCodeStatusCursors)
      .where(eq(schema.chzCodeStatusCursors.tenantId, tenantId));
    expect(cursorRow?.lastScannedAt ?? null).toBeNull();
  });
});
