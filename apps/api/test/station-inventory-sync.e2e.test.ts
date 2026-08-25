import { randomUUID } from "node:crypto";

import { ConflictException, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb, schema } from "@markiro/db";
import {
  buildSscc,
  canonicalizeKm,
  inventoryEventBatchDigest,
  kmHash,
  type InventoryEvent,
  type InventoryEventBatch,
  type InventoryEventBatchPayload,
} from "@markiro/domain";

import { StationInventorySyncService } from "../src/modules/inventories/station-inventory-sync.service";

const databaseUrl = process.env.INVENTORY_TEST_DATABASE_URL;
const GTIN = "04600000000015";
const OTHER_GTIN = "04600682000013";
const SSCC = "346006820000000014";
const GS = "\u001d";

function raw(serial: string, gtin14 = GTIN): string {
  return `01${gtin14}21${serial}${GS}91KEY${GS}92SIGNATURE`;
}

function code(serial: string, gtin14 = GTIN) {
  const canonical = canonicalizeKm(raw(serial, gtin14));
  return { canonical, codeHash: kmHash(canonical) };
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof ConflictException)) return undefined;
  const response = error.getResponse();
  return typeof response === "object" && response !== null && "code" in response
    ? String(response.code)
    : undefined;
}

describe.skipIf(!databaseUrl)("station inventory sync against isolated PostgreSQL", () => {
  const { db, pool } = createDb(databaseUrl ?? "", { max: 8 });
  const service = new StationInventorySyncService(db);
  const tenantId = `station-sync-${randomUUID()}`;
  const foreignTenantId = `station-sync-foreign-${randomUUID()}`;
  const userId = `station-sync-user-${randomUUID()}`;
  const inventoryId = randomUUID();
  const snapshotId = randomUUID();
  const productId = randomUUID();
  const lineId = randomUUID();
  const operatorId = randomUUID();
  const deviceAId = randomUUID();
  const deviceBId = randomUUID();
  const foreignDeviceId = randomUUID();
  const knownA = code("KNOWN-A");
  const knownB = code("KNOWN-B");
  let sequenceA = 0;
  let sequenceB = 0;

  function event(
    device: "a" | "b",
    values: Partial<InventoryEvent> & Pick<InventoryEvent, "scannedAt">,
  ): InventoryEvent {
    const item =
      values.kind === "known_box" || values.kind === "old_box"
        ? code("DEFAULT").canonical
        : values.canonicalRaw
          ? canonicalizeKm(values.canonicalRaw)
          : code("DEFAULT").canonical;
    const deviceSequence = device === "a" ? ++sequenceA : ++sequenceB;
    return {
      eventId: randomUUID(),
      deviceSequence,
      operatorId,
      kind: "item",
      normalizedIdentity: `item:${kmHash(item)}`,
      codeHash: kmHash(item),
      canonicalRaw: item.raw,
      activeProductionDate: "2026-08-20",
      localVerdict: "expected",
      ...values,
    };
  }

  function batch(
    batchId: string,
    events: InventoryEvent[],
    overrides: Partial<InventoryEventBatchPayload> = {},
  ): InventoryEventBatch {
    const payload: InventoryEventBatchPayload = {
      snapshotId,
      snapshotRevision: 1,
      sequenceCeiling: events.at(-1)?.deviceSequence ?? 1,
      pendingEventCount: 0,
      openBoxCount: 0,
      events,
      ...overrides,
    };
    return { batchId, payloadDigest: inventoryEventBatchDigest(payload), ...payload };
  }

  function serviceWithExpandedClaimCounts(counts: readonly number[]) {
    const candidate = new StationInventorySyncService(db);
    let index = 0;
    Object.defineProperty(candidate, "validateAndExpand", {
      value: async () => {
        const claims: unknown[] = [];
        claims.length = counts[index++] ?? 0;
        return claims;
      },
    });
    return candidate;
  }

  beforeAll(async () => {
    await db.insert(schema.organization).values([
      {
        id: tenantId,
        name: "Station sync",
        slug: `${tenantId}-${randomUUID()}`,
        createdAt: new Date(),
      },
      {
        id: foreignTenantId,
        name: "Foreign station sync",
        slug: `${foreignTenantId}-${randomUUID()}`,
        createdAt: new Date(),
      },
    ]);
    await db.insert(schema.user).values({
      id: userId,
      name: "Station sync",
      email: `${randomUUID()}@example.invalid`,
      emailVerified: false,
    });
    await db
      .insert(schema.products)
      .values({ id: productId, tenantId, gtin14: GTIN, name: "Product" });
    await db.insert(schema.lines).values({ id: lineId, tenantId, name: "Line" });
    await db.insert(schema.employees).values({ id: operatorId, tenantId, fullName: "Operator" });
    await db.insert(schema.stationDevices).values([
      { id: deviceAId, tenantId, name: "Station A", lineId },
      { id: deviceBId, tenantId, name: "Station B", lineId },
      { id: foreignDeviceId, tenantId: foreignTenantId, name: "Foreign station" },
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
      createdByUserId: userId,
    });
    await db.insert(schema.inventorySnapshots).values({
      id: snapshotId,
      tenantId,
      inventoryId,
      combinedDigest: "0".repeat(64),
      emittedCount: 0,
      introducedCount: 2,
      appliedCount: 0,
      retiredCount: 0,
      writtenOffCount: 0,
      disaggregationCount: 0,
      protectedCount: 0,
      expectedCount: 2,
      packageCount: 1,
      looseCount: 0,
      fixedByUserId: userId,
    });
    await db.insert(schema.inventorySnapshotCodes).values([
      {
        tenantId,
        snapshotId,
        canonicalRaw: knownA.canonical.raw,
        codeHash: knownA.codeHash,
        gtin14: GTIN,
        serial: knownA.canonical.serial,
        sourceStatus: "INTRODUCED",
        sourceProductionDate: "2026-08-20",
        parentSscc: SSCC,
        expected: true,
        protected: false,
      },
      {
        tenantId,
        snapshotId,
        canonicalRaw: knownB.canonical.raw,
        codeHash: knownB.codeHash,
        gtin14: GTIN,
        serial: knownB.canonical.serial,
        sourceStatus: "INTRODUCED",
        sourceProductionDate: "2026-08-20",
        parentSscc: SSCC,
        expected: true,
        protected: false,
      },
    ]);
    await db
      .update(schema.inventories)
      .set({
        status: "running",
        activeSnapshotId: snapshotId,
        stationManifest: { snapshotRevision: 1 },
        startedAt: new Date(),
        startedByUserId: userId,
      })
      .where(
        and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)),
      );
    await db.insert(schema.inventoryDeviceParticipants).values([
      {
        tenantId,
        inventoryId,
        deviceId: deviceAId,
        operatorId,
        configuredLineId: lineId,
        joinMethod: "assigned_line",
      },
      {
        tenantId,
        inventoryId,
        deviceId: deviceBId,
        operatorId,
        configuredLineId: lineId,
        joinMethod: "assigned_line",
      },
    ]);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("commits an exact replay result and gives a stable conflict for a mutated batch identity", async () => {
    const scan = code("REPLAY");
    const request = batch("replay", [
      event("a", { scannedAt: "2026-08-25T08:00:00.000Z", canonicalRaw: scan.canonical.raw }),
    ]);

    const first = await service.ingest(tenantId, deviceAId, inventoryId, request);
    const replay = await service.ingest(tenantId, deviceAId, inventoryId, request);
    expect(replay).toEqual(first);
    expect(
      await db
        .select()
        .from(schema.inventoryScanEvents)
        .where(eq(schema.inventoryScanEvents.eventId, request.events[0]!.eventId)),
    ).toHaveLength(1);

    const renamedReplay = await service.ingest(tenantId, deviceAId, inventoryId, {
      ...request,
      batchId: "replay-renamed",
    });
    expect(renamedReplay).toEqual({
      ...first,
      batchId: "replay-renamed",
      outcomes: first.outcomes.map((outcome) => ({
        ...outcome,
        status: "replay",
        reasonCode: "BATCH_REPLAY",
      })),
    });
    await expect(
      service.ingest(tenantId, deviceAId, inventoryId, {
        ...request,
        batchId: "replay-renamed",
      }),
    ).resolves.toEqual(renamedReplay);
    expect(
      await db
        .select()
        .from(schema.inventoryScanEvents)
        .where(eq(schema.inventoryScanEvents.eventId, request.events[0]!.eventId)),
    ).toHaveLength(1);

    const replacementScan = code("REPLAY-RENAMED-MUTATION");
    const rebound = batch("replay-renamed", [
      event("a", {
        scannedAt: "2026-08-25T08:00:01.000Z",
        canonicalRaw: replacementScan.canonical.raw,
      }),
    ]);
    await expect(service.ingest(tenantId, deviceAId, inventoryId, rebound)).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "INVENTORY_BATCH_DIGEST_CONFLICT",
    );
    expect(
      await db
        .select()
        .from(schema.inventoryScanEvents)
        .where(eq(schema.inventoryScanEvents.eventId, rebound.events[0]!.eventId)),
    ).toHaveLength(0);

    const mutated = { ...request, payloadDigest: "f".repeat(64) };
    await expect(service.ingest(tenantId, deviceAId, inventoryId, mutated)).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "INVENTORY_BATCH_DIGEST_CONFLICT",
    );
    await expect(service.ingest(tenantId, deviceAId, inventoryId, mutated)).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "INVENTORY_BATCH_DIGEST_CONFLICT",
    );
  });

  it("rejects 10,001 expanded claims for one known box before any business write", async () => {
    const oversized = serviceWithExpandedClaimCounts([10_001]);
    const request = batch("oversized-known-box", [
      event("a", {
        scannedAt: "2026-08-25T08:10:00.000Z",
        kind: "known_box",
        normalizedIdentity: `known_box:${SSCC}`,
        codeHash: null,
        canonicalRaw: SSCC,
      }),
    ]);
    await expect(oversized.ingest(tenantId, deviceAId, inventoryId, request)).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "INVENTORY_EVENT_CLAIM_LIMIT_EXCEEDED",
    );
    expect(
      await db
        .select()
        .from(schema.inventoryScanBatches)
        .where(eq(schema.inventoryScanBatches.batchId, request.batchId)),
    ).toHaveLength(0);
  });

  it("rejects aggregate expanded claims above the frozen batch cap before any business write", async () => {
    const oversized = serviceWithExpandedClaimCounts([6_000, 6_000]);
    const request = batch("oversized-claim-batch", [
      event("a", {
        scannedAt: "2026-08-25T08:11:00.000Z",
        kind: "known_box",
        normalizedIdentity: `known_box:${SSCC}`,
        codeHash: null,
        canonicalRaw: SSCC,
      }),
      event("a", {
        scannedAt: "2026-08-25T08:11:01.000Z",
        kind: "known_box",
        normalizedIdentity: `known_box:${SSCC}`,
        codeHash: null,
        canonicalRaw: SSCC,
      }),
    ]);
    await expect(oversized.ingest(tenantId, deviceAId, inventoryId, request)).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "INVENTORY_BATCH_CLAIM_LIMIT_EXCEEDED",
    );
    expect(
      await db
        .select()
        .from(schema.inventoryScanBatches)
        .where(eq(schema.inventoryScanBatches.batchId, request.batchId)),
    ).toHaveLength(0);
  });

  it("resolves a reversed pair inside one batch by scannedAt and reports its final authoritative outcomes", async () => {
    const scan = code("INTRA-BATCH");
    const later = event("a", {
      scannedAt: "2026-08-25T09:00:02.000Z",
      canonicalRaw: scan.canonical.raw,
    });
    const earlier = event("a", {
      scannedAt: "2026-08-25T09:00:01.000Z",
      canonicalRaw: scan.canonical.raw,
    });

    const response = await service.ingest(
      tenantId,
      deviceAId,
      inventoryId,
      batch("intra-batch-order", [later, earlier]),
    );

    expect(response.outcomes).toEqual([
      expect.objectContaining({ eventId: later.eventId, status: "duplicate", claimedCount: 0 }),
      expect.objectContaining({ eventId: earlier.eventId, status: "applied", claimedCount: 1 }),
    ]);
    const evidence = await db
      .select({
        eventId: schema.inventoryScanEvents.eventId,
        verdict: schema.inventoryScanEvents.authoritativeVerdict,
      })
      .from(schema.inventoryScanEvents)
      .where(
        and(
          eq(schema.inventoryScanEvents.tenantId, tenantId),
          eq(schema.inventoryScanEvents.inventoryId, inventoryId),
          eq(schema.inventoryScanEvents.deviceId, deviceAId),
          eq(schema.inventoryScanEvents.batchId, "intra-batch-order"),
        ),
      )
      .orderBy(asc(schema.inventoryScanEvents.deviceSequence));
    expect(evidence).toEqual([
      { eventId: later.eventId, verdict: "duplicate" },
      { eventId: earlier.eventId, verdict: "applied" },
    ]);
  });

  it("serializes concurrent terminals and keeps the deterministic tuple winner", async () => {
    const scan = code("CONCURRENT");
    const sameTime = "2026-08-25T10:00:00.000Z";
    const eventA = event("a", { scannedAt: sameTime, canonicalRaw: scan.canonical.raw });
    const eventB = event("b", { scannedAt: sameTime, canonicalRaw: scan.canonical.raw });

    await Promise.all([
      service.ingest(tenantId, deviceAId, inventoryId, batch("concurrent-a", [eventA])),
      service.ingest(tenantId, deviceBId, inventoryId, batch("concurrent-b", [eventB])),
    ]);

    const [result] = await db
      .select({
        eventId: schema.inventoryCodeResults.firstAcceptedEventId,
        deviceId: schema.inventoryCodeResults.winningDeviceId,
      })
      .from(schema.inventoryCodeResults)
      .where(
        and(
          eq(schema.inventoryCodeResults.tenantId, tenantId),
          eq(schema.inventoryCodeResults.inventoryId, inventoryId),
          eq(schema.inventoryCodeResults.codeHash, scan.codeHash),
        ),
      );
    const expected = [
      { eventId: eventA.eventId, deviceId: deviceAId },
      { eventId: eventB.eventId, deviceId: deviceBId },
    ].sort(
      (left, right) =>
        left.deviceId.localeCompare(right.deviceId) || left.eventId.localeCompare(right.eventId),
    )[0];
    expect(result).toEqual(expected);
  });

  it("rejects per-code evidence attributed to a winner device from another tenant", async () => {
    const scan = code("FOREIGN-WINNER-DEVICE");
    const request = batch("foreign-winner-device", [
      event("a", { scannedAt: "2026-08-25T08:20:00.000Z", canonicalRaw: scan.canonical.raw }),
    ]);
    await service.ingest(tenantId, deviceAId, inventoryId, request);
    const codeHash = "e".repeat(64);
    try {
      await expect(
        db.insert(schema.inventoryEventClaimOutcomes).values({
          tenantId,
          inventoryId,
          sourceEventId: request.events[0]!.eventId,
          codeHash,
          status: "claimed",
          winningEventId: request.events[0]!.eventId,
          winningDeviceId: foreignDeviceId,
          winningScannedAt: new Date(request.events[0]!.scannedAt),
        }),
      ).rejects.toThrow();
    } finally {
      await db
        .delete(schema.inventoryEventClaimOutcomes)
        .where(
          and(
            eq(schema.inventoryEventClaimOutcomes.tenantId, tenantId),
            eq(schema.inventoryEventClaimOutcomes.inventoryId, inventoryId),
            eq(schema.inventoryEventClaimOutcomes.codeHash, codeHash),
          ),
        );
    }
  });

  it("rejects evidence whose duplicated winner device disagrees with its winning event", async () => {
    const scan = code("INCONSISTENT-WINNER-DEVICE");
    const request = batch("inconsistent-winner-device", [
      event("a", { scannedAt: "2026-08-25T08:21:00.000Z", canonicalRaw: scan.canonical.raw }),
    ]);
    await service.ingest(tenantId, deviceAId, inventoryId, request);
    const codeHash = "d".repeat(64);
    try {
      await expect(
        db.insert(schema.inventoryEventClaimOutcomes).values({
          tenantId,
          inventoryId,
          sourceEventId: request.events[0]!.eventId,
          codeHash,
          status: "claimed",
          winningEventId: request.events[0]!.eventId,
          winningDeviceId: deviceBId,
          winningScannedAt: new Date(request.events[0]!.scannedAt),
        }),
      ).rejects.toThrow();
    } finally {
      await db
        .delete(schema.inventoryEventClaimOutcomes)
        .where(
          and(
            eq(schema.inventoryEventClaimOutcomes.tenantId, tenantId),
            eq(schema.inventoryEventClaimOutcomes.inventoryId, inventoryId),
            eq(schema.inventoryEventClaimOutcomes.codeHash, codeHash),
          ),
        );
    }
  });

  it("expands a known box on the server and returns a mixed applied/conflict result without losing evidence", async () => {
    const child = event("a", {
      scannedAt: "2026-08-25T11:00:00.000Z",
      canonicalRaw: knownA.canonical.raw,
    });
    await service.ingest(tenantId, deviceAId, inventoryId, batch("known-child", [child]));
    const box = event("b", {
      scannedAt: "2026-08-25T11:01:00.000Z",
      kind: "known_box",
      normalizedIdentity: `known_box:${SSCC}`,
      codeHash: null,
      canonicalRaw: SSCC,
      localVerdict: "expected",
    });

    const response = await service.ingest(
      tenantId,
      deviceBId,
      inventoryId,
      batch("known-box", [box], { pendingEventCount: 3, openBoxCount: 2 }),
    );
    expect(response.outcomes).toEqual([
      expect.objectContaining({
        eventId: box.eventId,
        status: "applied",
        claimedCount: 1,
        conflictCount: 1,
        claims: [
          {
            codeHash: knownA.codeHash,
            status: "duplicate",
            winner: expect.objectContaining({ eventId: child.eventId, codeHash: knownA.codeHash }),
          },
          {
            codeHash: knownB.codeHash,
            status: "claimed",
            winner: expect.objectContaining({ eventId: box.eventId, codeHash: knownB.codeHash }),
          },
        ],
      }),
    ]);
    const rows = await db
      .select({
        codeHash: schema.inventoryCodeResults.codeHash,
        eventId: schema.inventoryCodeResults.firstAcceptedEventId,
      })
      .from(schema.inventoryCodeResults)
      .where(
        and(
          eq(schema.inventoryCodeResults.tenantId, tenantId),
          eq(schema.inventoryCodeResults.inventoryId, inventoryId),
        ),
      );
    expect(rows).toEqual(
      expect.arrayContaining([
        { codeHash: knownA.codeHash, eventId: child.eventId },
        { codeHash: knownB.codeHash, eventId: box.eventId },
      ]),
    );
    const [participant] = await db
      .select({
        pending: schema.inventoryDeviceParticipants.pendingEventCount,
        open: schema.inventoryDeviceParticipants.openBoxCount,
      })
      .from(schema.inventoryDeviceParticipants)
      .where(
        and(
          eq(schema.inventoryDeviceParticipants.tenantId, tenantId),
          eq(schema.inventoryDeviceParticipants.inventoryId, inventoryId),
          eq(schema.inventoryDeviceParticipants.deviceId, deviceBId),
        ),
      );
    expect(participant).toEqual({ pending: 3, open: 2 });
    const [audit] = await db
      .select({
        action: schema.tenantAuditEvents.action,
        outcome: schema.tenantAuditEvents.outcome,
        after: schema.tenantAuditEvents.after,
      })
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, tenantId),
          eq(schema.tenantAuditEvents.action, "inventory.station.events_synced"),
          eq(schema.tenantAuditEvents.targetId, inventoryId),
        ),
      )
      .orderBy(desc(schema.tenantAuditEvents.createdAt));
    expect(audit).toMatchObject({
      action: "inventory.station.events_synced",
      outcome: "success",
      after: {
        tenantId,
        inventoryId,
        deviceId: deviceBId,
        operatorId,
        snapshotId,
        snapshotRevision: 1,
        batchId: "known-box",
        eventCount: 1,
        pendingEventCount: 3,
        openBoxCount: 2,
      },
    });

    const displacement = event("a", {
      scannedAt: "2026-08-25T10:59:00.000Z",
      canonicalRaw: knownB.canonical.raw,
    });
    await service.ingest(
      tenantId,
      deviceAId,
      inventoryId,
      batch("known-box-displacement", [displacement]),
    );
    const claimEvidence = await db
      .select({
        codeHash: schema.inventoryEventClaimOutcomes.codeHash,
        status: schema.inventoryEventClaimOutcomes.status,
        winningEventId: schema.inventoryEventClaimOutcomes.winningEventId,
      })
      .from(schema.inventoryEventClaimOutcomes)
      .where(eq(schema.inventoryEventClaimOutcomes.sourceEventId, box.eventId))
      .orderBy(asc(schema.inventoryEventClaimOutcomes.codeHash));
    expect(claimEvidence).toEqual([
      { codeHash: knownA.codeHash, status: "duplicate", winningEventId: child.eventId },
      { codeHash: knownB.codeHash, status: "duplicate", winningEventId: displacement.eventId },
    ]);
    const [boxEvidence] = await db
      .select({ verdict: schema.inventoryScanEvents.authoritativeVerdict })
      .from(schema.inventoryScanEvents)
      .where(eq(schema.inventoryScanEvents.eventId, box.eventId));
    expect(boxEvidence).toEqual({ verdict: "duplicate" });
  });

  it("lazily reconstructs strict pre-0074 item and partial-box evidence before later displacement", async () => {
    const legacySscc = buildSscc(3, "4600682", 41);
    const legacyA = code("LEGACY-BOX-A");
    const legacyB = code("LEGACY-BOX-B");
    const legacyC = code("LEGACY-BOX-C");
    await db.insert(schema.inventorySnapshotCodes).values(
      [legacyA, legacyB, legacyC].map((item) => ({
        tenantId,
        snapshotId,
        canonicalRaw: item.canonical.raw,
        codeHash: item.codeHash,
        gtin14: GTIN,
        serial: item.canonical.serial,
        sourceStatus: "INTRODUCED" as const,
        sourceProductionDate: "2026-08-20",
        parentSscc: legacySscc,
        expected: true,
        protected: false,
      })),
    );
    const itemRequest = batch("legacy-item", [
      event("a", {
        scannedAt: "2026-08-25T08:30:00.000Z",
        canonicalRaw: legacyA.canonical.raw,
      }),
    ]);
    await service.ingest(tenantId, deviceAId, inventoryId, itemRequest);
    const boxRequest = batch("legacy-partial-box", [
      event("b", {
        scannedAt: "2026-08-25T09:30:00.000Z",
        kind: "known_box",
        normalizedIdentity: `known_box:${legacySscc}`,
        codeHash: null,
        canonicalRaw: legacySscc,
      }),
    ]);
    const boxResponse = await service.ingest(tenantId, deviceBId, inventoryId, boxRequest);
    expect(boxResponse.outcomes[0]).toMatchObject({ claimedCount: 2, conflictCount: 1 });

    await db
      .delete(schema.inventoryEventClaimOutcomes)
      .where(
        and(
          eq(schema.inventoryEventClaimOutcomes.tenantId, tenantId),
          eq(schema.inventoryEventClaimOutcomes.inventoryId, inventoryId),
          eq(schema.inventoryEventClaimOutcomes.sourceEventId, boxRequest.events[0]!.eventId),
        ),
      );
    await db
      .update(schema.inventoryScanEvents)
      .set({ firstWinningEventId: boxRequest.events[0]!.eventId })
      .where(eq(schema.inventoryScanEvents.eventId, boxRequest.events[0]!.eventId));
    await db
      .update(schema.inventoryScanBatches)
      .set({
        result: {
          ...boxResponse,
          outcomes: boxResponse.outcomes.map((outcome) => ({
            eventId: outcome.eventId,
            status: outcome.status,
            reasonCode: outcome.reasonCode,
            firstWinningEventId: boxRequest.events[0]!.eventId,
          })),
        },
      })
      .where(
        and(
          eq(schema.inventoryScanBatches.tenantId, tenantId),
          eq(schema.inventoryScanBatches.inventoryId, inventoryId),
          eq(schema.inventoryScanBatches.deviceId, deviceBId),
          eq(schema.inventoryScanBatches.batchId, boxRequest.batchId),
        ),
      );

    const upgradedReplay = await service.ingest(tenantId, deviceBId, inventoryId, boxRequest);
    expect(upgradedReplay.outcomes[0]).toMatchObject({
      status: "applied",
      claimedCount: 2,
      conflictCount: 1,
    });
    expect(upgradedReplay.outcomes[0]!.claims).toHaveLength(3);

    const displacement = batch("legacy-child-displacement", [
      event("a", {
        scannedAt: "2026-08-25T09:00:00.000Z",
        canonicalRaw: legacyB.canonical.raw,
      }),
    ]);
    await service.ingest(tenantId, deviceAId, inventoryId, displacement);
    expect(
      await db
        .select({
          codeHash: schema.inventoryEventClaimOutcomes.codeHash,
          status: schema.inventoryEventClaimOutcomes.status,
        })
        .from(schema.inventoryEventClaimOutcomes)
        .where(
          and(
            eq(schema.inventoryEventClaimOutcomes.tenantId, tenantId),
            eq(schema.inventoryEventClaimOutcomes.inventoryId, inventoryId),
            eq(schema.inventoryEventClaimOutcomes.sourceEventId, boxRequest.events[0]!.eventId),
          ),
        )
        .orderBy(asc(schema.inventoryEventClaimOutcomes.codeHash)),
    ).toEqual(
      [
        { codeHash: legacyA.codeHash, status: "duplicate" },
        { codeHash: legacyB.codeHash, status: "duplicate" },
        { codeHash: legacyC.codeHash, status: "claimed" },
      ].sort((left, right) => left.codeHash.localeCompare(right.codeHash)),
    );
    expect(
      await db
        .select({ verdict: schema.inventoryScanEvents.authoritativeVerdict })
        .from(schema.inventoryScanEvents)
        .where(eq(schema.inventoryScanEvents.eventId, boxRequest.events[0]!.eventId)),
    ).toEqual([{ verdict: "applied" }]);
  });

  it("enforces a monotonic accepted device sequence high-water while allowing gaps", async () => {
    const scan10 = code("HIGH-WATER-10");
    const event10 = {
      ...event("a", { scannedAt: "2026-08-25T11:30:00.000Z", canonicalRaw: scan10.canonical.raw }),
      deviceSequence: 1_000,
    };
    await expect(
      service.ingest(tenantId, deviceAId, inventoryId, batch("high-water-10", [event10])),
    ).resolves.toBeDefined();

    const scan5 = code("HIGH-WATER-5");
    const event5 = {
      ...event("a", { scannedAt: "2026-08-25T11:31:00.000Z", canonicalRaw: scan5.canonical.raw }),
      deviceSequence: 999,
    };
    await expect(
      service.ingest(tenantId, deviceAId, inventoryId, batch("high-water-5", [event5])),
    ).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "INVENTORY_EVENT_SEQUENCE_BELOW_HIGH_WATER",
    );

    const scan12 = code("HIGH-WATER-12");
    const event12 = {
      ...event("a", { scannedAt: "2026-08-25T11:32:00.000Z", canonicalRaw: scan12.canonical.raw }),
      deviceSequence: 1_002,
    };
    await expect(
      service.ingest(tenantId, deviceAId, inventoryId, batch("high-water-12", [event12])),
    ).resolves.toBeDefined();
  });

  it("denies foreign tenant/device scope and rejects immutable snapshot, operator, GTIN, and date facts", async () => {
    const valid = event("a", { scannedAt: "2026-08-25T12:00:00.000Z", canonicalRaw: raw("FACTS") });
    await expect(
      service.ingest(foreignTenantId, foreignDeviceId, inventoryId, batch("foreign", [valid])),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.ingest(tenantId, foreignDeviceId, inventoryId, batch("foreign-device", [valid])),
    ).rejects.toBeInstanceOf(NotFoundException);

    const wrongSnapshot = batch("wrong-snapshot", [valid], { snapshotId: randomUUID() });
    await expect(service.ingest(tenantId, deviceAId, inventoryId, wrongSnapshot)).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "INVENTORY_SNAPSHOT_MISMATCH",
    );
    const wrongOperator = batch("wrong-operator", [
      { ...valid, eventId: randomUUID(), operatorId: randomUUID() },
    ]);
    await expect(service.ingest(tenantId, deviceAId, inventoryId, wrongOperator)).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "INVENTORY_PARTICIPANT_OPERATOR_MISMATCH",
    );
    const other = code("OTHER-GTIN", OTHER_GTIN);
    const wrongGtin = batch("wrong-gtin", [
      {
        ...valid,
        eventId: randomUUID(),
        canonicalRaw: other.canonical.raw,
        codeHash: other.codeHash,
        normalizedIdentity: `item:${other.codeHash}`,
      },
    ]);
    await expect(service.ingest(tenantId, deviceAId, inventoryId, wrongGtin)).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "INVENTORY_EVENT_GTIN_MISMATCH",
    );
    const wrongDate = batch("wrong-date", [
      { ...valid, eventId: randomUUID(), activeProductionDate: "2026-09-01" },
    ]);
    await expect(service.ingest(tenantId, deviceAId, inventoryId, wrongDate)).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "INVENTORY_EVENT_PRODUCTION_DATE_MISMATCH",
    );
  });

  it("pages monotonic claim and correction progress only for an active participant", async () => {
    const first = await service.progress(tenantId, deviceBId, inventoryId, { limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const second = await service.progress(tenantId, deviceBId, inventoryId, {
      limit: 200,
      cursor: first.nextCursor!,
    });
    expect(second.items.length).toBeGreaterThan(0);
    expect(second.items.every((item) => item.revision >= first.items[0]!.revision)).toBe(true);

    const revision = second.resultRevision + 1;
    await db
      .update(schema.inventories)
      .set({ resultRevision: revision })
      .where(
        and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)),
      );
    await db.insert(schema.inventoryProgressChanges).values({
      tenantId,
      inventoryId,
      snapshotId,
      resultRevision: revision,
      kind: "correction",
      codeHash: knownB.codeHash,
      classification: "voided",
    });
    const correction = await service.progress(tenantId, deviceBId, inventoryId, {
      limit: 200,
      cursor: second.nextCursor!,
    });
    expect(correction.items).toEqual([
      expect.objectContaining({
        kind: "correction",
        revision,
        codeHash: knownB.codeHash,
        winner: null,
      }),
    ]);
    const replay = await service.progress(tenantId, deviceBId, inventoryId, {
      limit: 200,
      cursor: second.nextCursor!,
    });
    expect(replay).toEqual(correction);
  });

  it("leaves only with zero client and stored blockers and never closes the inventory", async () => {
    await db
      .update(schema.inventoryDeviceParticipants)
      .set({ pendingEventCount: 1, openBoxCount: 0 })
      .where(
        and(
          eq(schema.inventoryDeviceParticipants.tenantId, tenantId),
          eq(schema.inventoryDeviceParticipants.inventoryId, inventoryId),
          eq(schema.inventoryDeviceParticipants.deviceId, deviceAId),
        ),
      );
    await expect(
      service.leave(tenantId, deviceAId, inventoryId, { pendingEventCount: 0, openBoxCount: 0 }),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "INVENTORY_LEAVE_PENDING_WORK");
    await db
      .update(schema.inventoryDeviceParticipants)
      .set({ pendingEventCount: 0, openBoxCount: 0 })
      .where(
        and(
          eq(schema.inventoryDeviceParticipants.tenantId, tenantId),
          eq(schema.inventoryDeviceParticipants.inventoryId, inventoryId),
          eq(schema.inventoryDeviceParticipants.deviceId, deviceAId),
        ),
      );

    await expect(
      service.leave(tenantId, deviceAId, inventoryId, { pendingEventCount: 0, openBoxCount: 0 }),
    ).resolves.toEqual({ outcome: "left" });
    await expect(
      service.leave(tenantId, deviceAId, inventoryId, { pendingEventCount: 0, openBoxCount: 0 }),
    ).resolves.toEqual({ outcome: "left" });
    const [inventory] = await db
      .select({ status: schema.inventories.status })
      .from(schema.inventories)
      .where(
        and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)),
      );
    expect(inventory?.status).toBe("running");
  });

  it("owns repack boxes and membership on the server across real competing devices", async () => {
    const repackInventoryId = randomUUID();
    const repackSnapshotId = randomUUID();
    const raceCode = code(`REPACK-${randomUUID()}`);
    const issuerPrefix = "460068200";
    const oldSscc = buildSscc(0, issuerPrefix, 900);
    const ssccA = buildSscc(0, issuerPrefix, 101);
    const ssccB = buildSscc(0, issuerPrefix, 201);
    const boxLabelTemplateId = randomUUID();
    const boxAId = randomUUID();
    const boxBId = randomUUID();

    await db.insert(schema.labelTemplates).values({
      id: boxLabelTemplateId,
      tenantId,
      name: "Frozen repack box",
      spec: {},
    });
    await db.insert(schema.inventories).values({
      id: repackInventoryId,
      tenantId,
      number: `INV-REPACK-${randomUUID()}`,
      productId,
      gtin14Snapshot: GTIN,
      lineId,
      mode: "repack",
      boxLabelTemplateId,
      productionDateFrom: "2026-08-01",
      productionDateTo: "2026-08-31",
      createdByUserId: userId,
    });
    await db.insert(schema.inventorySnapshots).values({
      id: repackSnapshotId,
      tenantId,
      inventoryId: repackInventoryId,
      combinedDigest: "1".repeat(64),
      emittedCount: 0,
      introducedCount: 1,
      appliedCount: 0,
      retiredCount: 0,
      writtenOffCount: 0,
      disaggregationCount: 0,
      protectedCount: 0,
      expectedCount: 1,
      packageCount: 1,
      looseCount: 0,
      fixedByUserId: userId,
    });
    await db.insert(schema.inventorySnapshotCodes).values({
      tenantId,
      snapshotId: repackSnapshotId,
      canonicalRaw: raceCode.canonical.raw,
      codeHash: raceCode.codeHash,
      gtin14: GTIN,
      serial: raceCode.canonical.serial,
      sourceStatus: "INTRODUCED",
      sourceProductionDate: "2026-08-20",
      parentSscc: oldSscc,
      expected: true,
      protected: false,
    });
    await db
      .update(schema.inventories)
      .set({
        status: "running",
        activeSnapshotId: repackSnapshotId,
        stationManifest: { snapshotRevision: 1, mode: "repack", boxCapacity: 2 },
        startedAt: new Date(),
        startedByUserId: userId,
      })
      .where(
        and(
          eq(schema.inventories.tenantId, tenantId),
          eq(schema.inventories.id, repackInventoryId),
        ),
      );
    await db.insert(schema.inventoryDeviceParticipants).values([
      {
        tenantId,
        inventoryId: repackInventoryId,
        deviceId: deviceAId,
        operatorId,
        configuredLineId: lineId,
        joinMethod: "assigned_line",
      },
      {
        tenantId,
        inventoryId: repackInventoryId,
        deviceId: deviceBId,
        operatorId,
        configuredLineId: lineId,
        joinMethod: "assigned_line",
      },
    ]);
    await db.insert(schema.ssccBlocks).values([
      {
        tenantId,
        deviceId: deviceAId,
        issuerPrefix,
        extensionDigit: 0,
        allocationOrder: 101,
        fromSerial: 100,
        toSerial: 199,
      },
      {
        tenantId,
        deviceId: deviceBId,
        issuerPrefix,
        extensionDigit: 0,
        allocationOrder: 102,
        fromSerial: 200,
        toSerial: 299,
      },
    ]);

    const repackEvent = (
      device: "a" | "b",
      values: Partial<InventoryEvent> & Pick<InventoryEvent, "scannedAt">,
    ): InventoryEvent => event(device, values);
    const repackBatch = (
      batchId: string,
      events: InventoryEvent[],
      openBoxCount: number,
    ): InventoryEventBatch => {
      const payload: InventoryEventBatchPayload = {
        snapshotId: repackSnapshotId,
        snapshotRevision: 1,
        sequenceCeiling: events.at(-1)!.deviceSequence,
        pendingEventCount: 0,
        openBoxCount,
        events,
      };
      return { batchId, payloadDigest: inventoryEventBatchDigest(payload), ...payload };
    };
    const open = (device: "a" | "b", boxId: string, newSscc: string) =>
      repackEvent(device, {
        scannedAt: "2026-08-25T12:00:00.000Z",
        kind: "old_box",
        normalizedIdentity: `old_box:${oldSscc}`,
        codeHash: null,
        canonicalRaw: oldSscc,
        activeProductionDate: "2026-08-20",
        localVerdict: "unknown",
        repack: {
          action: "open-box",
          boxId,
          oldSscc,
          newSscc,
          capacity: 2,
          productionDate: "2026-08-20",
        },
      });

    const openedA = open("a", boxAId, ssccA);
    const openedB = open("b", boxBId, ssccB);
    const openARequest = repackBatch("repack-open-a", [openedA], 1);
    const openAResponse = await service.ingest(
      tenantId,
      deviceAId,
      repackInventoryId,
      openARequest,
    );
    await expect(
      service.ingest(tenantId, deviceAId, repackInventoryId, openARequest),
    ).resolves.toEqual(openAResponse);
    const openBRequest = repackBatch("repack-open-b", [openedB], 1);
    const openBResponse = await service.ingest(
      tenantId,
      deviceBId,
      repackInventoryId,
      openBRequest,
    );
    await expect(
      service.ingest(tenantId, deviceBId, repackInventoryId, openBRequest),
    ).resolves.toEqual(openBResponse);
    expect(
      await db
        .select({
          id: schema.inventoryRepackBoxes.id,
          owner: schema.inventoryRepackBoxes.ownerDeviceId,
          capacity: schema.inventoryRepackBoxes.capacity,
          productionDate: schema.inventoryRepackBoxes.productionDate,
        })
        .from(schema.inventoryRepackBoxes)
        .where(eq(schema.inventoryRepackBoxes.inventoryId, repackInventoryId))
        .orderBy(asc(schema.inventoryRepackBoxes.ownerDeviceId)),
    ).toEqual(
      expect.arrayContaining([
        { id: boxAId, owner: deviceAId, capacity: 2, productionDate: "2026-08-20" },
        { id: boxBId, owner: deviceBId, capacity: 2, productionDate: "2026-08-20" },
      ]),
    );

    const add = (device: "a" | "b", boxId: string, itemId: string, scannedAt: string) =>
      repackEvent(device, {
        scannedAt,
        canonicalRaw: raceCode.canonical.raw,
        codeHash: raceCode.codeHash,
        normalizedIdentity: `item:${raceCode.codeHash}`,
        repack: { action: "add-item", boxId, itemId, position: 1, closeBox: false },
      });
    const winningItemId = randomUUID();
    const losingItemId = randomUUID();
    const winner = add("a", boxAId, winningItemId, "2026-08-25T12:00:01.000Z");
    const loser = add("b", boxBId, losingItemId, "2026-08-25T12:00:02.000Z");
    await Promise.all([
      service.ingest(
        tenantId,
        deviceAId,
        repackInventoryId,
        repackBatch("repack-race-a", [winner], 1),
      ),
      service.ingest(
        tenantId,
        deviceBId,
        repackInventoryId,
        repackBatch("repack-race-b", [loser], 1),
      ),
    ]);
    expect(
      await db
        .select({ id: schema.inventoryRepackItems.id, boxId: schema.inventoryRepackItems.boxId })
        .from(schema.inventoryRepackItems)
        .where(eq(schema.inventoryRepackItems.inventoryId, repackInventoryId)),
    ).toEqual([{ id: winningItemId, boxId: boxAId }]);
    expect(
      await db
        .select({ id: schema.inventoryRepackBoxes.id, state: schema.inventoryRepackBoxes.state })
        .from(schema.inventoryRepackBoxes)
        .where(eq(schema.inventoryRepackBoxes.inventoryId, repackInventoryId))
        .orderBy(asc(schema.inventoryRepackBoxes.id)),
    ).toEqual(
      expect.arrayContaining([
        { id: boxAId, state: "open" },
        { id: boxBId, state: "invalidated" },
      ]),
    );

    const staleReservedSerialBoxId = randomUUID();
    const staleReservedSerial = open(
      "b",
      staleReservedSerialBoxId,
      buildSscc(0, issuerPrefix, 200),
    );
    await expect(
      service.ingest(
        tenantId,
        deviceBId,
        repackInventoryId,
        repackBatch("repack-stale-reserved-serial", [staleReservedSerial], 0),
      ),
    ).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "INVENTORY_REPACK_SSCC_NOT_RESERVED",
    );
    expect(
      await db
        .select({ id: schema.inventoryRepackBoxes.id })
        .from(schema.inventoryRepackBoxes)
        .where(eq(schema.inventoryRepackBoxes.id, staleReservedSerialBoxId)),
    ).toEqual([]);

    const forgedOldContextBoxId = randomUUID();
    const forgedOldContext = open("b", forgedOldContextBoxId, buildSscc(0, issuerPrefix, 202));
    if (forgedOldContext.repack?.action !== "open-box") {
      throw new Error("test setup did not create an open-box mutation");
    }
    const forgedOldContextRequest = repackBatch("repack-forged-old-context", [forgedOldContext], 0);
    // Exercise the service boundary independently of the DTO/domain parser.
    // The shared contract test above proves the forged digest cannot be made
    // canonical; the server must still refuse a bypassed/malformed caller.
    forgedOldContext.repack = {
      ...forgedOldContext.repack,
      oldSscc: buildSscc(0, issuerPrefix, 901),
    };
    await expect(
      service.ingest(tenantId, deviceBId, repackInventoryId, forgedOldContextRequest),
    ).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "INVENTORY_EVENT_IDENTITY_INVALID",
    );
    expect(
      await db
        .select({ id: schema.inventoryRepackBoxes.id })
        .from(schema.inventoryRepackBoxes)
        .where(eq(schema.inventoryRepackBoxes.id, forgedOldContextBoxId)),
    ).toEqual([]);

    const removedAt = "2026-08-25T12:00:03.000Z";
    const remove = repackEvent("a", {
      scannedAt: removedAt,
      kind: "repack_action",
      normalizedIdentity: `repack_action:remove-last:${boxAId}`,
      codeHash: null,
      canonicalRaw: null,
      localVerdict: "repack-action",
      repack: { action: "remove-last", boxId: boxAId, itemId: winningItemId, changedAt: removedAt },
    });
    await service.ingest(
      tenantId,
      deviceAId,
      repackInventoryId,
      repackBatch("repack-remove", [remove], 1),
    );
    const replacementItemId = randomUUID();
    const replacement = add("a", boxAId, replacementItemId, "2026-08-25T12:00:04.000Z");
    replacement.localVerdict = "duplicate";
    await service.ingest(
      tenantId,
      deviceAId,
      repackInventoryId,
      repackBatch("repack-reattach", [replacement], 1),
    );
    expect(
      await db
        .select({ id: schema.inventoryRepackItems.id })
        .from(schema.inventoryRepackItems)
        .where(
          and(
            eq(schema.inventoryRepackItems.inventoryId, repackInventoryId),
            eq(schema.inventoryRepackItems.boxId, boxAId),
            isNull(schema.inventoryRepackItems.removedAt),
          ),
        ),
    ).toEqual([{ id: replacementItemId }]);
    expect(
      await db
        .select({ state: schema.inventoryRepackBoxes.state })
        .from(schema.inventoryRepackBoxes)
        .where(eq(schema.inventoryRepackBoxes.id, boxAId)),
    ).toEqual([{ state: "open" }]);

    const forgedCapacity = open("b", randomUUID(), buildSscc(0, issuerPrefix, 202));
    if (forgedCapacity.repack?.action !== "open-box") {
      throw new Error("test setup did not create an open-box mutation");
    }
    forgedCapacity.repack = {
      ...forgedCapacity.repack,
      action: "open-box",
      capacity: 999,
    };
    await expect(
      service.ingest(
        tenantId,
        deviceBId,
        repackInventoryId,
        repackBatch("repack-forged-capacity", [forgedCapacity], 0),
      ),
    ).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "INVENTORY_REPACK_FROZEN_FACT_MISMATCH",
    );

    const foreignReservationBoxId = randomUUID();
    const foreignReservation = open("b", foreignReservationBoxId, buildSscc(0, issuerPrefix, 102));
    await expect(
      service.ingest(
        tenantId,
        deviceBId,
        repackInventoryId,
        repackBatch("repack-foreign-reservation", [foreignReservation], 0),
      ),
    ).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "INVENTORY_REPACK_SSCC_NOT_RESERVED",
    );
    expect(
      await db
        .select({ id: schema.inventoryRepackBoxes.id })
        .from(schema.inventoryRepackBoxes)
        .where(eq(schema.inventoryRepackBoxes.id, foreignReservationBoxId)),
    ).toEqual([]);

    await expect(
      service.leave(tenantId, deviceAId, repackInventoryId, {
        pendingEventCount: 0,
        openBoxCount: 1,
      }),
    ).resolves.toEqual({ outcome: "left" });
    expect(
      await db
        .select({ state: schema.inventoryRepackBoxes.state })
        .from(schema.inventoryRepackBoxes)
        .where(eq(schema.inventoryRepackBoxes.id, boxAId)),
    ).toEqual([{ state: "open" }]);
  });

  it("quarantines a recognized late batch exactly once after close and rejects malformed late facts", async () => {
    await db
      .update(schema.inventories)
      .set({ status: "closed", closedAt: new Date(), closedByUserId: userId })
      .where(
        and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)),
      );
    const before = await db
      .select({ revision: schema.inventories.resultRevision })
      .from(schema.inventories)
      .where(
        and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)),
      );
    await db
      .update(schema.inventoryDeviceParticipants)
      .set({ pendingEventCount: 9, openBoxCount: 4 })
      .where(
        and(
          eq(schema.inventoryDeviceParticipants.tenantId, tenantId),
          eq(schema.inventoryDeviceParticipants.inventoryId, inventoryId),
          eq(schema.inventoryDeviceParticipants.deviceId, deviceBId),
        ),
      );
    const late = batch(
      "late",
      [event("b", { scannedAt: "2026-08-25T13:00:00.000Z", canonicalRaw: raw("LATE") })],
      { pendingEventCount: 0, openBoxCount: 0 },
    );
    const response = await service.ingest(tenantId, deviceBId, inventoryId, late);
    expect(response.outcomes).toEqual([
      expect.objectContaining({
        eventId: late.events[0]!.eventId,
        status: "quarantined",
        reasonCode: "INVENTORY_CLOSED",
      }),
    ]);
    await expect(service.ingest(tenantId, deviceBId, inventoryId, late)).resolves.toEqual(response);
    const rows = await db
      .select()
      .from(schema.inventoryLateEvents)
      .where(
        and(
          eq(schema.inventoryLateEvents.tenantId, tenantId),
          eq(schema.inventoryLateEvents.inventoryId, inventoryId),
          eq(schema.inventoryLateEvents.batchId, "late"),
        ),
      );
    expect(rows).toHaveLength(1);
    const quarantines = await db
      .select({ after: schema.tenantAuditEvents.after })
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, tenantId),
          eq(schema.tenantAuditEvents.action, "inventory.station.events_quarantined"),
          eq(schema.tenantAuditEvents.targetId, inventoryId),
        ),
      );
    expect(quarantines).toEqual([
      {
        after: expect.objectContaining({
          tenantId,
          inventoryId,
          deviceId: deviceBId,
          operatorId,
          snapshotId,
          snapshotRevision: 1,
          batchId: "late",
          eventCount: 1,
          reason: "INVENTORY_CLOSED",
          closedRevision: before[0]!.revision,
        }),
      },
    ]);
    const after = await db
      .select({ revision: schema.inventories.resultRevision })
      .from(schema.inventories)
      .where(
        and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)),
      );
    expect(after).toEqual(before);
    const [participantAfterQuarantine] = await db
      .select({
        pending: schema.inventoryDeviceParticipants.pendingEventCount,
        open: schema.inventoryDeviceParticipants.openBoxCount,
      })
      .from(schema.inventoryDeviceParticipants)
      .where(
        and(
          eq(schema.inventoryDeviceParticipants.tenantId, tenantId),
          eq(schema.inventoryDeviceParticipants.inventoryId, inventoryId),
          eq(schema.inventoryDeviceParticipants.deviceId, deviceBId),
        ),
      );
    expect(participantAfterQuarantine).toEqual({ pending: 0, open: 0 });

    const other = code("LATE-WRONG-GTIN", OTHER_GTIN);
    const malformed = batch("late-malformed", [
      event("b", {
        scannedAt: "2026-08-25T13:01:00.000Z",
        canonicalRaw: other.canonical.raw,
        codeHash: other.codeHash,
        normalizedIdentity: `item:${other.codeHash}`,
      }),
    ]);
    await expect(service.ingest(tenantId, deviceBId, inventoryId, malformed)).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "INVENTORY_EVENT_GTIN_MISMATCH",
    );

    await db
      .update(schema.inventories)
      .set({ status: "running" })
      .where(
        and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)),
      );
    await expect(
      service.leave(tenantId, deviceBId, inventoryId, { pendingEventCount: 0, openBoxCount: 0 }),
    ).resolves.toEqual({ outcome: "left" });
    const [reopened] = await db
      .select({ status: schema.inventories.status })
      .from(schema.inventories)
      .where(
        and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)),
      );
    expect(reopened).toEqual({ status: "running" });
  });
});
