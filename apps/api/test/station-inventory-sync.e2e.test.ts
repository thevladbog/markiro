import { randomUUID } from "node:crypto";

import { ConflictException, NotFoundException } from "@nestjs/common";
import { and, asc, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDb, schema } from "@markiro/db";
import {
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

    const mutated = { ...request, payloadDigest: "f".repeat(64) };
    await expect(service.ingest(tenantId, deviceAId, inventoryId, mutated)).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "INVENTORY_BATCH_DIGEST_CONFLICT",
    );
    await expect(service.ingest(tenantId, deviceAId, inventoryId, mutated)).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "INVENTORY_BATCH_DIGEST_CONFLICT",
    );
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
