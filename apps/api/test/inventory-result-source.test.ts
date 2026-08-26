import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";

import { createDb, schema } from "@markiro/db";
import { canonicalizeKm, kmHash } from "@markiro/domain";

import { InventoryResultSourceService } from "../src/modules/inventories/inventory-result-source.service";

const databaseUrl = process.env.INVENTORY_TEST_DATABASE_URL;
const GTIN = "04600000000015";

describe.skipIf(!databaseUrl)("closed inventory result source", () => {
  const { db, pool } = createDb(databaseUrl ?? "");
  const service = new InventoryResultSourceService(db);
  const tenantId = `inventory-source-${randomUUID()}`;
  const foreignTenantId = `inventory-source-foreign-${randomUUID()}`;
  const userId = `inventory-source-user-${randomUUID()}`;
  const inventoryId = randomUUID();
  const snapshotId = randomUUID();
  const productId = randomUUID();
  const lineId = randomUUID();
  const operatorId = randomUUID();
  const deviceAId = randomUUID();
  const deviceBId = randomUUID();
  const verifiedEventId = randomUUID();
  const protectedEventId = randomUUID();
  const ineligibleEventId = randomUUID();
  const unknownEventId = randomUUID();
  const voidedEventId = randomUUID();
  const duplicateEventId = randomUUID();
  const oldBoxEventId = randomUUID();
  const verifiedHash = "1".repeat(64);
  const missingHash = "2".repeat(64);
  const protectedFoundHash = "3".repeat(64);
  const protectedMissingHash = "4".repeat(64);
  const ineligibleHash = "5".repeat(64);
  const unknownCanonical = canonicalizeKm(`01${GTIN}21UNKNOWN-SOURCE`);
  const unknownHash = kmHash(unknownCanonical);
  const voidedHash = "7".repeat(64);
  const sourceSscc = "046000000000000015";
  const oldSscc = "146000000000000012";
  const newSscc = "246000000000000019";
  const invalidatedSscc = "346000000000000016";

  beforeAll(async () => {
    await db.insert(schema.organization).values([
      {
        id: tenantId,
        name: "Inventory source tenant",
        slug: `${tenantId}-${randomUUID()}`,
        createdAt: new Date(),
      },
      {
        id: foreignTenantId,
        name: "Inventory source foreign tenant",
        slug: `${foreignTenantId}-${randomUUID()}`,
        createdAt: new Date(),
      },
    ]);
    await db.insert(schema.user).values({
      id: userId,
      name: "Inventory source user",
      email: `${randomUUID()}@example.invalid`,
      emailVerified: false,
    });
    await db.insert(schema.products).values({
      id: productId,
      tenantId,
      gtin14: GTIN,
      name: "Inventory source product",
    });
    await db.insert(schema.lines).values({ id: lineId, tenantId, name: "Inventory source line" });
    await db.insert(schema.employees).values({
      id: operatorId,
      tenantId,
      fullName: "Inventory source operator",
    });
    await db.insert(schema.stationDevices).values([
      { id: deviceAId, tenantId, name: "Terminal A", lineId },
      { id: deviceBId, tenantId, name: "Terminal B", lineId },
    ]);
    await db.insert(schema.inventories).values({
      id: inventoryId,
      tenantId,
      number: `INV-${randomUUID()}`,
      productId,
      gtin14Snapshot: GTIN,
      lineId,
      mode: "check",
      productionDateFrom: "2026-08-01",
      productionDateTo: "2026-08-31",
      boxLabelTemplateId: null,
      status: "draft",
      createdByUserId: userId,
    });
    await db.insert(schema.inventorySnapshots).values({
      id: snapshotId,
      tenantId,
      inventoryId,
      combinedDigest: "a".repeat(64),
      emittedCount: 1,
      introducedCount: 6,
      appliedCount: 0,
      retiredCount: 1,
      writtenOffCount: 0,
      disaggregationCount: 0,
      protectedCount: 2,
      expectedCount: 3,
      packageCount: 1,
      looseCount: 5,
      fixedByUserId: userId,
    });
    await db.insert(schema.inventorySnapshotCodes).values([
      snapshotCode(verifiedHash, "VERIFIED", {
        expected: true,
        parentSscc: sourceSscc,
        sourceProductionDate: "2026-08-05",
      }),
      snapshotCode(missingHash, "MISSING", {
        expected: true,
        sourceProductionDate: "2026-08-06",
      }),
      snapshotCode(protectedFoundHash, "PROTECTED-FOUND", {
        protected: true,
        sourceState: "MOVING_BY_UD",
      }),
      snapshotCode(protectedMissingHash, "PROTECTED-MISSING", {
        protected: true,
        sourceState: "MOVING_BY_UD",
      }),
      snapshotCode(ineligibleHash, "INELIGIBLE", { sourceStatus: "RETIRED" }),
      snapshotCode(voidedHash, "VOIDED", {
        expected: true,
        sourceProductionDate: "2026-08-07",
      }),
    ]);
    await db
      .update(schema.inventories)
      .set({
        status: "running",
        activeSnapshotId: snapshotId,
        stationManifest: { snapshotRevision: 1 },
        resultRevision: 7,
        startedByUserId: userId,
        startedAt: new Date("2026-08-20T09:00:00.000Z"),
      })
      .where(
        and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)),
      );
    await db
      .insert(schema.inventoryScanBatches)
      .values([batch(deviceAId, "source-a", 10n), batch(deviceBId, "source-b", 10n)]);
    await db.insert(schema.inventoryScanEvents).values([
      scanEvent(verifiedEventId, deviceAId, "source-a", 1n, verifiedHash, "2026-08-05"),
      scanEvent(protectedEventId, deviceAId, "source-a", 2n, protectedFoundHash, "2026-08-05"),
      scanEvent(ineligibleEventId, deviceAId, "source-a", 3n, ineligibleHash, "2026-08-05"),
      scanEvent(unknownEventId, deviceAId, "source-a", 4n, unknownHash, "2026-08-05", {
        rawPayload: unknownCanonical.raw,
      }),
      scanEvent(voidedEventId, deviceAId, "source-a", 5n, voidedHash, "2026-08-05"),
      scanEvent(duplicateEventId, deviceBId, "source-b", 1n, verifiedHash, "2026-08-05", {
        scannedAt: new Date("2026-08-20T10:01:00.000Z"),
        authoritativeVerdict: "duplicate",
      }),
      scanEvent(oldBoxEventId, deviceBId, "source-b", 2n, null, "2026-08-05", {
        kind: "old_box",
        normalizedIdentity: `old_box:${oldSscc}`,
        rawPayload: oldSscc,
      }),
    ]);
    await db
      .insert(schema.inventoryCodeResults)
      .values([
        result(verifiedEventId, deviceAId, verifiedHash, "expected", snapshotId, "2026-08-08"),
        result(protectedEventId, deviceAId, protectedFoundHash, "protected", snapshotId),
        result(ineligibleEventId, deviceAId, ineligibleHash, "ineligible", snapshotId),
        result(unknownEventId, deviceAId, unknownHash, "unknown", null),
        result(
          voidedEventId,
          deviceAId,
          voidedHash,
          "voided",
          snapshotId,
          "2026-08-07",
          "expected",
        ),
      ]);
    await db.insert(schema.inventoryEventClaimOutcomes).values([
      {
        tenantId,
        inventoryId,
        sourceEventId: verifiedEventId,
        codeHash: verifiedHash,
        status: "claimed",
        winningEventId: verifiedEventId,
        winningDeviceId: deviceAId,
        winningScannedAt: new Date("2026-08-20T10:00:00.000Z"),
      },
      {
        tenantId,
        inventoryId,
        sourceEventId: duplicateEventId,
        codeHash: verifiedHash,
        status: "duplicate",
        winningEventId: verifiedEventId,
        winningDeviceId: deviceAId,
        winningScannedAt: new Date("2026-08-20T10:00:00.000Z"),
      },
    ]);
    const [verifiedResult] = await db
      .select({ id: schema.inventoryCodeResults.id })
      .from(schema.inventoryCodeResults)
      .where(
        and(
          eq(schema.inventoryCodeResults.tenantId, tenantId),
          eq(schema.inventoryCodeResults.codeHash, verifiedHash),
        ),
      );
    if (!verifiedResult) throw new Error("Expected verified result fixture");
    const closedBoxId = randomUUID();
    await db.insert(schema.inventoryRepackBoxes).values([
      {
        id: closedBoxId,
        tenantId,
        inventoryId,
        oldSsccContext: oldSscc,
        newSscc,
        ownerDeviceId: deviceAId,
        capacity: 12,
        productionDate: "2026-08-08",
        state: "closed",
        printState: "pending",
        closedAt: new Date("2026-08-20T11:00:00.000Z"),
      },
      {
        tenantId,
        inventoryId,
        newSscc: invalidatedSscc,
        ownerDeviceId: deviceBId,
        capacity: 12,
        productionDate: "2026-08-09",
        state: "invalidated",
        printState: "not_ready",
        invalidatedAt: new Date("2026-08-20T11:30:00.000Z"),
      },
    ]);
    await db.insert(schema.inventoryRepackItems).values({
      tenantId,
      inventoryId,
      boxId: closedBoxId,
      resultId: verifiedResult.id,
      sourceEventId: verifiedEventId,
      position: 1,
      productionDate: "2026-08-08",
      activeObservedProductionDate: "2026-08-08",
    });
  });

  afterAll(async () => {
    await pool.end();
  });

  function snapshotCode(
    codeHash: string,
    serial: string,
    overrides: Partial<typeof schema.inventorySnapshotCodes.$inferInsert> = {},
  ): typeof schema.inventorySnapshotCodes.$inferInsert {
    return {
      tenantId,
      snapshotId,
      canonicalRaw: `01${GTIN}21${serial}`,
      codeHash,
      gtin14: GTIN,
      serial,
      sourceStatus: "INTRODUCED",
      sourceState: null,
      sourceProductionDate: null,
      parentSscc: null,
      expected: false,
      protected: false,
      ...overrides,
    };
  }

  function batch(deviceId: string, batchId: string, sequenceCeiling: bigint) {
    return {
      tenantId,
      inventoryId,
      deviceId,
      batchId,
      payloadDigest: (deviceId === deviceAId ? "b" : "c").repeat(64),
      sequenceCeiling,
      outcome: "applied" as const,
      result: {},
    };
  }

  function scanEvent(
    eventId: string,
    deviceId: string,
    batchId: string,
    deviceSequence: bigint,
    codeHash: string | null,
    activeProductionDate: string,
    overrides: Partial<typeof schema.inventoryScanEvents.$inferInsert> = {},
  ): typeof schema.inventoryScanEvents.$inferInsert {
    return {
      eventId,
      tenantId,
      inventoryId,
      batchId,
      deviceId,
      deviceSequence,
      operatorId,
      scannedAt: new Date("2026-08-20T10:00:00.000Z"),
      kind: "item",
      normalizedIdentity: `item:${codeHash}`,
      codeHash,
      rawPayload: codeHash === null ? null : `01${GTIN}21UNKNOWN-${codeHash[0]}`,
      activeProductionDate,
      snapshotRevision: 1,
      localVerdict: "expected",
      authoritativeVerdict: "applied",
      ...overrides,
    };
  }

  function result(
    eventId: string,
    deviceId: string,
    codeHash: string,
    classification: "expected" | "protected" | "ineligible" | "unknown" | "voided",
    resultSnapshotId: string | null,
    observedProductionDate = "2026-08-05",
    originClassification: "expected" | "protected" | "ineligible" | "unknown" = classification ===
    "voided"
      ? "expected"
      : classification,
  ): typeof schema.inventoryCodeResults.$inferInsert {
    return {
      tenantId,
      inventoryId,
      codeHash,
      snapshotId: resultSnapshotId,
      firstAcceptedEventId: eventId,
      winningDeviceId: deviceId,
      winningScannedAt: new Date("2026-08-20T10:00:00.000Z"),
      observedProductionDate,
      classification,
      originClassification,
    };
  }

  it("rejects a running projection and cross-tenant UUID possession", async () => {
    await expect(service.load(tenantId, inventoryId)).rejects.toMatchObject({
      code: "INVENTORY_RESULT_NOT_CLOSED",
    });
    await expect(service.load(foreignTenantId, inventoryId)).rejects.toMatchObject({
      code: "INVENTORY_RESULT_NOT_CLOSED",
    });
  });

  it("loads one closed revision with deterministic classified groups", async () => {
    await db
      .update(schema.inventories)
      .set({
        status: "closed",
        closedByUserId: userId,
        closedAt: new Date("2026-08-20T12:00:00.000Z"),
      })
      .where(
        and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)),
      );

    const frozen = await service.load(tenantId, inventoryId);

    expect(frozen).toMatchObject({
      inventoryId,
      snapshotId,
      resultRevision: 7,
      expected: [
        { codeHash: verifiedHash, classification: "expected" },
        { codeHash: missingHash, classification: "expected" },
        { codeHash: voidedHash, classification: "voided" },
      ],
      verified: [{ codeHash: verifiedHash }],
      writeOffCandidates: [{ codeHash: missingHash }],
      protected: [
        { codeHash: protectedFoundHash, found: true },
        { codeHash: protectedMissingHash, found: false },
      ],
      ineligible: [{ codeHash: ineligibleHash }],
      unknown: [{ codeHash: unknownHash }],
      oldBoxes: [{ sscc: oldSscc, winner: { terminalId: deviceBId } }],
      newBoxes: [
        { sscc: newSscc, state: "closed", codeHashes: [verifiedHash] },
        { sscc: invalidatedSscc, state: "invalidated", codeHashes: [] },
      ],
    });
    expect(frozen.verified[0]?.winner).toMatchObject({
      terminalId: deviceAId,
      scannedAt: "2026-08-20T10:00:00.000Z",
    });
    expect(frozen.verified).toHaveLength(1);
    expect(frozen.unknown).toEqual([
      expect.objectContaining({
        codeHash: unknownHash,
        canonicalRaw: unknownCanonical.raw,
        gtin14: GTIN,
        serial: "UNKNOWN-SOURCE",
      }),
    ]);
    expect(frozen.observedDateGroups.map((group) => group.observedProductionDate)).toEqual([
      "2026-08-05",
      "2026-08-08",
    ]);
    expect(frozen.observedDateGroups[1]?.codeHashes).toEqual([verifiedHash]);
  });

  it("keeps a closed result source stable after a terminal display-name change", async () => {
    const beforeRename = await service.load(tenantId, inventoryId);

    await db
      .update(schema.stationDevices)
      .set({ name: "Renamed after inventory close" })
      .where(eq(schema.stationDevices.tenantId, tenantId));

    const afterRename = await service.load(tenantId, inventoryId);
    expect(afterRename).toEqual({
      ...beforeRename,
      sourceSnapshotStartedAt: afterRename.sourceSnapshotStartedAt,
    });
  });

  it("rejects cross-tenant UUID possession after the inventory is closed", async () => {
    await expect(service.load(foreignTenantId, inventoryId)).rejects.toMatchObject({
      code: "INVENTORY_RESULT_NOT_CLOSED",
    });
  });
});
