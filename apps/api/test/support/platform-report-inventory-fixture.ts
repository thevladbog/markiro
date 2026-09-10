import { randomUUID } from "node:crypto";
import { schema, type Db } from "@markiro/db";
import { eq } from "drizzle-orm";

export async function seedReportInventory(
  db: Db,
  scope: { tenant: string; product: string; line: string; operator: string; user: string },
) {
  const { tenant, product, line, operator, user } = scope;
  const inventory = randomUUID();
  const snapshot = randomUUID();
  const device = randomUUID();
  const box = randomUUID();
  const at = new Date("2026-09-01T10:00:00Z");
  const events = Array.from({ length: 6 }, () => randomUUID());
  const first = events[0]!;
  const known = events[1]!;
  const duplicate = events[2]!;
  const outside = events[5]!;
  await db.insert(schema.inventories).values({
    id: inventory,
    tenantId: tenant,
    number: "INV-2",
    productId: product,
    gtin14Snapshot: "00012345678901",
    lineId: line,
    mode: "check",
    productionDateFrom: "2026-08-01",
    productionDateTo: "2026-09-01",
    createdByUserId: user,
    createdAt: new Date("2026-08-01"),
  });
  await db.insert(schema.inventorySnapshots).values({
    id: snapshot,
    tenantId: tenant,
    inventoryId: inventory,
    combinedDigest: "a".repeat(64),
    productName: "Snapshot product",
    lineName: "Snapshot line",
    emittedCount: 0,
    introducedCount: 4,
    appliedCount: 0,
    retiredCount: 0,
    writtenOffCount: 0,
    disaggregationCount: 0,
    protectedCount: 1,
    expectedCount: 3,
    packageCount: 1,
    looseCount: 3,
    fixedByUserId: user,
  });
  await db
    .update(schema.inventories)
    .set({
      activeSnapshotId: snapshot,
      status: "completed",
      stationManifest: {},
      completedByUserId: user,
      completedAt: at,
      completionAcknowledgedByUserId: user,
      completionAcknowledgedAt: at,
    })
    .where(eq(schema.inventories.id, inventory));
  await db
    .insert(schema.stationDevices)
    .values({ id: device, tenantId: tenant, name: "Report fixture" });
  await db.insert(schema.inventoryScanBatches).values({
    tenantId: tenant,
    inventoryId: inventory,
    deviceId: device,
    batchId: "batch",
    payloadDigest: "a".repeat(64),
    sequenceCeiling: 6n,
    outcome: "applied",
    result: {},
  });
  await db.insert(schema.inventoryScanEvents).values(
    events.map((eventId, index) => ({
      eventId,
      tenantId: tenant,
      inventoryId: inventory,
      batchId: "batch",
      deviceId: device,
      deviceSequence: BigInt(index),
      operatorId: operator,
      scannedAt: index === 5 ? new Date("2026-09-01T21:00:00Z") : at,
      kind: index === 1 ? ("known_box" as const) : ("item" as const),
      normalizedIdentity: `identity-${index}`,
      rawPayload: "inventory-raw-secret",
      snapshotRevision: 1,
      localVerdict: "ok",
      authoritativeVerdict: ["applied", "applied", "duplicate", "rejected", "pending", "applied"][
        index
      ]!,
    })),
  );
  await db.insert(schema.inventorySnapshotCodes).values(
    ["a", "b", "c", "d"].map((letter) => ({
      tenantId: tenant,
      snapshotId: snapshot,
      canonicalRaw: "snapshot-raw-secret",
      codeHash: letter.repeat(64),
      gtin14: "00012345678901",
      serial: letter,
      sourceStatus: "INTRODUCED" as const,
      sourceState: letter === "d" ? "MOVING_BY_UD" : null,
      sourceProductionDate: "2026-09-01",
      expected: letter !== "d",
      protected: letter === "d",
    })),
  );
  for (const [letter, classification, originClassification, eventId] of [
    ["a", "expected", "expected", first],
    ["c", "voided", "expected", known],
    ["d", "protected", "protected", known],
    ["e", "unknown", "unknown", outside],
  ] as const) {
    await db.insert(schema.inventoryCodeResults).values({
      tenantId: tenant,
      inventoryId: inventory,
      codeHash: letter.repeat(64),
      snapshotId: classification === "unknown" ? null : snapshot,
      firstAcceptedEventId: eventId,
      winningDeviceId: device,
      winningScannedAt: at,
      classification,
      originClassification,
    });
  }
  for (const [letter, sourceEventId, winningEventId, status] of [
    ["a", first, first, "claimed"],
    ["d", known, known, "claimed"],
    ["a", duplicate, first, "duplicate"],
    ["d", duplicate, known, "duplicate"],
    ["e", outside, outside, "claimed"],
  ] as const) {
    await db.insert(schema.inventoryEventClaimOutcomes).values({
      tenantId: tenant,
      inventoryId: inventory,
      sourceEventId,
      codeHash: letter.repeat(64),
      status,
      winningEventId,
      winningDeviceId: device,
      winningScannedAt: winningEventId === outside ? new Date("2026-09-01T21:00:00Z") : at,
    });
  }
  await db.insert(schema.inventoryRepackBoxes).values({
    id: box,
    tenantId: tenant,
    inventoryId: inventory,
    ownerDeviceId: device,
    newSscc: "000000000000000099",
    capacity: 10,
    productionDate: "2026-09-01",
    state: "closed",
    openedAt: new Date("2026-08-20"),
    closedAt: at,
    printState: "printed",
    printAttemptCount: 5,
    printedAt: new Date("2026-09-02"),
  });
  for (const [index, [kind, result]] of (
    [
      ["initial", "printed"],
      ["initial", "failed"],
      ["reprint", "printed"],
      ["reprint", "failed"],
      ["reprint", "printed"],
    ] as const
  ).entries()) {
    await db.insert(schema.inventoryRepackPrintAttempts).values({
      id: randomUUID(),
      tenantId: tenant,
      inventoryId: inventory,
      boxId: box,
      sourceEventId: first,
      kind,
      attemptNumber: index + 1,
      result,
      errorCode: result === "failed" ? "transport_failed" : null,
      attemptedAt: at,
      completedAt: index === 4 ? new Date("2026-09-01T21:00:00Z") : at,
    });
  }
  return inventory;
}
