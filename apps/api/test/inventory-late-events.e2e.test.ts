import { randomUUID } from "node:crypto";

import { ConflictException, type INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { and, eq } from "drizzle-orm";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { schema, type Db } from "@markiro/db";
import {
  canonicalizeKm,
  inventoryEventBatchDigest,
  kmHash,
  type InventoryEvent,
  type InventoryEventBatchPayload,
} from "@markiro/domain";

import { AppModule } from "../src/app.module";
import { mountAuth, setupAuth, type AuthSetup } from "../src/auth/auth.setup";
import { loadEnv } from "../src/env";
import { listenOnLoopback } from "./support/listen-loopback";
import { signUpAndActivate } from "./support/auth";
import { StationInventorySyncService } from "../src/modules/inventories/station-inventory-sync.service";

const ready = Boolean(
  process.env.DATABASE_URL && process.env.BETTER_AUTH_SECRET && process.env.BETTER_AUTH_URL,
);
const GTIN = "04600000000015";

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof ConflictException)) return undefined;
  const response = error.getResponse();
  return typeof response === "object" && response !== null && "code" in response
    ? String(response.code)
    : undefined;
}

describe.skipIf(!ready)("inventory late events", () => {
  let app: INestApplication | undefined;
  let setup: AuthSetup;
  let db: Db;
  let stationSync: StationInventorySyncService;

  beforeAll(async () => {
    const env = loadEnv();
    setup = setupAuth(env);
    db = setup.db;
    const ref = await Test.createTestingModule({
      imports: [AppModule.forRoot({ ...setup, databaseUrl: env.DATABASE_URL, env })],
    }).compile();
    app = ref.createNestApplication({ bodyParser: false });
    const server = app.getHttpAdapter().getInstance();
    mountAuth(server, setup.auth);
    server.use(express.json());
    await app.init();
    await listenOnLoopback(app);
    stationSync = app.get(StationInventorySyncService);
  });

  afterAll(async () => {
    await app?.close();
  });

  async function seedClosedInventory() {
    const agent = request.agent(app!.getHttpServer());
    const tenantId = await signUpAndActivate(agent);
    const [member] = await db
      .select({ userId: schema.member.userId })
      .from(schema.member)
      .where(eq(schema.member.organizationId, tenantId))
      .limit(1);
    if (!member) throw new Error("Expected inventory actor");
    const productId = randomUUID();
    const lineId = randomUUID();
    const inventoryId = randomUUID();
    const snapshotId = randomUUID();
    const deviceId = randomUUID();
    const operatorId = randomUUID();
    await db.insert(schema.products).values({
      id: productId,
      tenantId,
      gtin14: GTIN,
      name: "Late product",
    });
    await db.insert(schema.lines).values({ id: lineId, tenantId, name: "Late line" });
    await db.insert(schema.employees).values({
      id: operatorId,
      tenantId,
      fullName: "Late operator",
    });
    await db.insert(schema.stationDevices).values({
      id: deviceId,
      tenantId,
      name: "Late station",
      lineId,
    });
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
      createdByUserId: member.userId,
    });
    await db.insert(schema.inventorySnapshots).values({
      id: snapshotId,
      tenantId,
      inventoryId,
      combinedDigest: "b".repeat(64),
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
      fixedByUserId: member.userId,
    });
    await db
      .update(schema.inventories)
      .set({
        status: "closed",
        activeSnapshotId: snapshotId,
        stationManifest: { snapshotRevision: 1 },
        resultRevision: 4,
        startedByUserId: member.userId,
        startedAt: new Date("2026-08-26T08:00:00.000Z"),
        closedByUserId: member.userId,
        closedAt: new Date("2026-08-26T09:00:00.000Z"),
      })
      .where(
        and(eq(schema.inventories.tenantId, tenantId), eq(schema.inventories.id, inventoryId)),
      );
    await db.insert(schema.inventoryDeviceParticipants).values({
      tenantId,
      inventoryId,
      deviceId,
      operatorId,
      configuredLineId: lineId,
      joinMethod: "assigned_line",
    });
    return {
      agent,
      tenantId,
      userId: member.userId,
      inventoryId,
      snapshotId,
      deviceId,
      operatorId,
    };
  }

  function lateBatch(
    fixture: Awaited<ReturnType<typeof seedClosedInventory>>,
    batchId: string,
    deviceSequence = 1,
  ) {
    const canonical = canonicalizeKm(`01${GTIN}21LATE${batchId.toUpperCase()}`);
    const event: InventoryEvent = {
      eventId: randomUUID(),
      deviceSequence,
      operatorId: fixture.operatorId,
      scannedAt: "2026-08-26T09:05:00.000Z",
      kind: "item",
      normalizedIdentity: `item:${kmHash(canonical)}`,
      codeHash: kmHash(canonical),
      canonicalRaw: canonical.raw,
      activeProductionDate: "2026-08-20",
      localVerdict: "unknown",
    };
    const payload: InventoryEventBatchPayload = {
      snapshotId: fixture.snapshotId,
      snapshotRevision: 1,
      sequenceCeiling: deviceSequence,
      pendingEventCount: 0,
      openBoxCount: 0,
      events: [event],
    };
    return { batchId, payloadDigest: inventoryEventBatchDigest(payload), ...payload };
  }

  it("lists tenant-scoped quarantined late batches in bounded newest-first pages", async () => {
    const fixture = await seedClosedInventory();
    await db.insert(schema.inventoryLateEvents).values([
      {
        tenantId: fixture.tenantId,
        inventoryId: fixture.inventoryId,
        deviceId: fixture.deviceId,
        batchId: "late-1",
        payload: { events: [{ eventId: randomUUID() }] },
        payloadDigest: "1".repeat(64),
        receivedAt: new Date("2026-08-26T09:01:00.000Z"),
        closedRevision: 4,
        reason: "INVENTORY_CLOSED",
      },
      {
        tenantId: fixture.tenantId,
        inventoryId: fixture.inventoryId,
        deviceId: fixture.deviceId,
        batchId: "late-2",
        payload: { events: [{ eventId: randomUUID() }, { eventId: randomUUID() }] },
        payloadDigest: "2".repeat(64),
        receivedAt: new Date("2026-08-26T09:02:00.000Z"),
        closedRevision: 4,
        reason: "INVENTORY_COMPLETED",
      },
    ]);
    const response = await fixture.agent
      .get(`/inventories/${fixture.inventoryId}/late-events?page=1&pageSize=1`)
      .expect(200);
    expect(response.body).toMatchObject({ page: 1, pageSize: 1, total: 2, hasMore: true });
    expect(response.body.items).toEqual([
      expect.objectContaining({
        batchId: "late-2",
        eventCount: 2,
        reason: "INVENTORY_COMPLETED",
        resolution: "pending",
        closedRevision: 4,
      }),
    ]);
    expect(response.body.items[0]).not.toHaveProperty("payload");
    expect(response.body.items[0]).not.toHaveProperty("payloadDigest");
  });

  it("denies another tenant and rejects unbounded page sizes", async () => {
    const owner = await seedClosedInventory();
    const foreign = await seedClosedInventory();
    await foreign.agent.get(`/inventories/${owner.inventoryId}/late-events`).expect(404);
    await owner.agent.get(`/inventories/${owner.inventoryId}/late-events?pageSize=101`).expect(400);
  });

  it("explicitly replays retained evidence after reopen and survives a same-cycle revision bump", async () => {
    const fixture = await seedClosedInventory();
    const batch = lateBatch(fixture, `replay-${randomUUID()}`);
    const quarantined = await stationSync.ingest(
      fixture.tenantId,
      fixture.deviceId,
      fixture.inventoryId,
      batch,
    );
    expect(quarantined.outcomes[0]).toMatchObject({
      status: "quarantined",
      reasonCode: "INVENTORY_CLOSED",
    });
    await fixture.agent.post(`/inventories/${fixture.inventoryId}/reopen`).send({}).expect(201);
    await db
      .update(schema.inventories)
      .set({ resultRevision: 6 })
      .where(
        and(
          eq(schema.inventories.tenantId, fixture.tenantId),
          eq(schema.inventories.id, fixture.inventoryId),
        ),
      );
    const [pending] = await db
      .select({ id: schema.inventoryLateEvents.id })
      .from(schema.inventoryLateEvents)
      .where(eq(schema.inventoryLateEvents.batchId, batch.batchId));
    if (!pending) throw new Error("Expected authorized late evidence");
    const replay = await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/late-events/${pending.id}/replay`)
      .send({})
      .expect(201);
    expect(replay.body).toMatchObject({
      lateEventId: pending.id,
      resolution: "replayed",
      result: {
        batchId: batch.batchId,
        resultRevision: 7,
        outcomes: [expect.objectContaining({ status: "applied" })],
      },
    });
    expect(replay.body.result).not.toEqual(quarantined);
    const [late] = await db
      .select({
        resolution: schema.inventoryLateEvents.resolution,
        resolvedAt: schema.inventoryLateEvents.resolvedAt,
        resolvedBy: schema.inventoryLateEvents.resolvedByUserId,
      })
      .from(schema.inventoryLateEvents)
      .where(
        and(
          eq(schema.inventoryLateEvents.tenantId, fixture.tenantId),
          eq(schema.inventoryLateEvents.inventoryId, fixture.inventoryId),
          eq(schema.inventoryLateEvents.batchId, batch.batchId),
        ),
      );
    expect(late).toMatchObject({
      resolution: "replayed",
      resolvedAt: expect.any(Date),
      resolvedBy: fixture.userId,
    });
    expect(
      await db
        .select({ eventId: schema.inventoryScanEvents.eventId })
        .from(schema.inventoryScanEvents)
        .where(eq(schema.inventoryScanEvents.eventId, batch.events[0]!.eventId)),
    ).toHaveLength(1);
    await expect(
      stationSync.ingest(fixture.tenantId, fixture.deviceId, fixture.inventoryId, batch),
    ).resolves.toEqual(replay.body.result);

    const syncedBeforeRetry = await db
      .select({ id: schema.tenantAuditEvents.id })
      .from(schema.tenantAuditEvents)
      .where(
        and(
          eq(schema.tenantAuditEvents.organizationId, fixture.tenantId),
          eq(schema.tenantAuditEvents.targetId, fixture.inventoryId),
          eq(schema.tenantAuditEvents.action, "inventory.station.events_synced"),
        ),
      );
    await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/emergency-close`)
      .send({ reason: "Проверка идемпотентного ответа", acknowledgeBlockers: true })
      .expect(201);
    expect(
      (
        await fixture.agent
          .post(`/inventories/${fixture.inventoryId}/late-events/${pending.id}/replay`)
          .send({})
          .expect(201)
      ).body,
    ).toEqual(replay.body);
    const completedAt = new Date();
    await db
      .update(schema.inventories)
      .set({
        status: "completed",
        completionAcknowledgedByUserId: fixture.userId,
        completionAcknowledgedAt: completedAt,
        completedByUserId: fixture.userId,
        completedAt,
      })
      .where(eq(schema.inventories.id, fixture.inventoryId));
    expect(
      (
        await fixture.agent
          .post(`/inventories/${fixture.inventoryId}/late-events/${pending.id}/replay`)
          .send({})
          .expect(201)
      ).body,
    ).toEqual(replay.body);
    expect(
      await db
        .select({ id: schema.tenantAuditEvents.id })
        .from(schema.tenantAuditEvents)
        .where(
          and(
            eq(schema.tenantAuditEvents.organizationId, fixture.tenantId),
            eq(schema.tenantAuditEvents.targetId, fixture.inventoryId),
            eq(schema.tenantAuditEvents.action, "inventory.station.events_synced"),
          ),
        ),
    ).toHaveLength(syncedBeforeRetry.length);
  });

  it("replays authorized evidence for a participant who already left but keeps ordinary ingest denied", async () => {
    const fixture = await seedClosedInventory();
    const retained = lateBatch(fixture, `left-replay-${randomUUID()}`);
    await stationSync.ingest(fixture.tenantId, fixture.deviceId, fixture.inventoryId, retained);
    await fixture.agent.post(`/inventories/${fixture.inventoryId}/reopen`).send({}).expect(201);
    await db
      .update(schema.inventoryDeviceParticipants)
      .set({ leftAt: new Date() })
      .where(
        and(
          eq(schema.inventoryDeviceParticipants.tenantId, fixture.tenantId),
          eq(schema.inventoryDeviceParticipants.inventoryId, fixture.inventoryId),
          eq(schema.inventoryDeviceParticipants.deviceId, fixture.deviceId),
        ),
      );
    const [late] = await db
      .select({ id: schema.inventoryLateEvents.id })
      .from(schema.inventoryLateEvents)
      .where(eq(schema.inventoryLateEvents.batchId, retained.batchId));
    if (!late) throw new Error("Expected authorized late evidence");

    await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/late-events/${late.id}/replay`)
      .send({})
      .expect(201);
    const ordinary = lateBatch(fixture, `left-ordinary-${randomUUID()}`, 2);
    await expect(
      stationSync.ingest(fixture.tenantId, fixture.deviceId, fixture.inventoryId, ordinary),
    ).rejects.toSatisfy((error: unknown) => errorCode(error) === "INVENTORY_PARTICIPANT_LEFT");
  });

  it("replays authorized same-device batches out of order without weakening ordinary high-water", async () => {
    const fixture = await seedClosedInventory();
    const high = lateBatch(fixture, `late-high-${randomUUID()}`, 20);
    const low = lateBatch(fixture, `late-low-${randomUUID()}`, 10);
    const duplicateSequence = lateBatch(fixture, `late-duplicate-${randomUUID()}`, 20);
    await stationSync.ingest(fixture.tenantId, fixture.deviceId, fixture.inventoryId, high);
    await stationSync.ingest(fixture.tenantId, fixture.deviceId, fixture.inventoryId, low);
    await stationSync.ingest(
      fixture.tenantId,
      fixture.deviceId,
      fixture.inventoryId,
      duplicateSequence,
    );
    await fixture.agent.post(`/inventories/${fixture.inventoryId}/reopen`).send({}).expect(201);
    const retained = await db
      .select({ id: schema.inventoryLateEvents.id, batchId: schema.inventoryLateEvents.batchId })
      .from(schema.inventoryLateEvents)
      .where(eq(schema.inventoryLateEvents.inventoryId, fixture.inventoryId));
    const highId = retained.find((row) => row.batchId === high.batchId)?.id;
    const lowId = retained.find((row) => row.batchId === low.batchId)?.id;
    const duplicateId = retained.find((row) => row.batchId === duplicateSequence.batchId)?.id;
    if (!highId || !lowId || !duplicateId) {
      throw new Error("Expected all authorized late batches");
    }

    await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/late-events/${highId}/replay`)
      .send({})
      .expect(201);
    await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/late-events/${duplicateId}/replay`)
      .send({})
      .expect(409, { code: "INVENTORY_EVENT_ID_OR_SEQUENCE_REUSED" });
    const [stillPending] = await db
      .select({ resolution: schema.inventoryLateEvents.resolution })
      .from(schema.inventoryLateEvents)
      .where(eq(schema.inventoryLateEvents.id, duplicateId));
    expect(stillPending?.resolution).toBe("pending");
    const liveNewer = lateBatch(fixture, `live-newer-${randomUUID()}`, 30);
    await expect(
      stationSync.ingest(fixture.tenantId, fixture.deviceId, fixture.inventoryId, liveNewer),
    ).resolves.toBeDefined();
    await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/late-events/${lowId}/replay`)
      .send({})
      .expect(201);

    const ordinaryOld = lateBatch(fixture, `ordinary-old-${randomUUID()}`, 9);
    await expect(
      stationSync.ingest(fixture.tenantId, fixture.deviceId, fixture.inventoryId, ordinaryOld),
    ).rejects.toSatisfy(
      (error: unknown) => errorCode(error) === "INVENTORY_EVENT_SEQUENCE_BELOW_HIGH_WATER",
    );
  });

  it("keeps malformed retained payload pending and retryable", async () => {
    const fixture = await seedClosedInventory();
    const batch = lateBatch(fixture, `malformed-${randomUUID()}`);
    await stationSync.ingest(fixture.tenantId, fixture.deviceId, fixture.inventoryId, batch);
    await fixture.agent.post(`/inventories/${fixture.inventoryId}/reopen`).send({}).expect(201);
    const [late] = await db
      .select({ id: schema.inventoryLateEvents.id })
      .from(schema.inventoryLateEvents)
      .where(eq(schema.inventoryLateEvents.batchId, batch.batchId));
    if (!late) throw new Error("Expected authorized late evidence");
    await db
      .update(schema.inventoryLateEvents)
      .set({ payload: { batchId: batch.batchId, events: "not-an-array" } })
      .where(eq(schema.inventoryLateEvents.id, late.id));

    await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/late-events/${late.id}/replay`)
      .send({})
      .expect(409, { code: "INVENTORY_LATE_EVENT_PAYLOAD_INVALID" });
    const [pending] = await db
      .select({ resolution: schema.inventoryLateEvents.resolution })
      .from(schema.inventoryLateEvents)
      .where(eq(schema.inventoryLateEvents.id, late.id));
    expect(pending?.resolution).toBe("pending");
  });

  it("revokes replay authorization on close and denies a later status-only hack", async () => {
    const fixture = await seedClosedInventory();
    const batch = lateBatch(fixture, `revoked-${randomUUID()}`);
    await stationSync.ingest(fixture.tenantId, fixture.deviceId, fixture.inventoryId, batch);
    await fixture.agent.post(`/inventories/${fixture.inventoryId}/reopen`).send({}).expect(201);
    const [late] = await db
      .select({ id: schema.inventoryLateEvents.id })
      .from(schema.inventoryLateEvents)
      .where(eq(schema.inventoryLateEvents.batchId, batch.batchId));
    if (!late) throw new Error("Expected authorized late evidence");
    await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/emergency-close`)
      .send({ reason: "Повторное закрытие", acknowledgeBlockers: true })
      .expect(201);
    await db
      .update(schema.inventories)
      .set({ status: "running", closedByUserId: null, closedAt: null })
      .where(eq(schema.inventories.id, fixture.inventoryId));

    await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/late-events/${late.id}/replay`)
      .send({})
      .expect(409, { code: "INVENTORY_LATE_EVENT_REPLAY_NOT_AUTHORIZED" });
    const [pending] = await db
      .select({
        resolution: schema.inventoryLateEvents.resolution,
        replayAuthorizedAt: schema.inventoryLateEvents.replayAuthorizedAt,
      })
      .from(schema.inventoryLateEvents)
      .where(eq(schema.inventoryLateEvents.id, late.id));
    expect(pending).toEqual({ resolution: "pending", replayAuthorizedAt: null });
  });

  it("does not replay quarantined evidence merely because status changed without an admin authorization", async () => {
    const fixture = await seedClosedInventory();
    const batch = lateBatch(fixture, `not-authorized-${randomUUID()}`);
    const quarantined = await stationSync.ingest(
      fixture.tenantId,
      fixture.deviceId,
      fixture.inventoryId,
      batch,
    );
    await db
      .update(schema.inventories)
      .set({ status: "running", closedByUserId: null, closedAt: null })
      .where(
        and(
          eq(schema.inventories.tenantId, fixture.tenantId),
          eq(schema.inventories.id, fixture.inventoryId),
        ),
      );

    await expect(
      stationSync.ingest(fixture.tenantId, fixture.deviceId, fixture.inventoryId, batch),
    ).resolves.toEqual(quarantined);
    const [late] = await db
      .select({
        resolution: schema.inventoryLateEvents.resolution,
        replayAuthorizedAt: schema.inventoryLateEvents.replayAuthorizedAt,
      })
      .from(schema.inventoryLateEvents)
      .where(eq(schema.inventoryLateEvents.batchId, batch.batchId));
    expect(late).toEqual({ resolution: "pending", replayAuthorizedAt: null });
  });

  it("requires a reasoned quarantine decision before completion", async () => {
    const fixture = await seedClosedInventory();
    const batch = lateBatch(fixture, `discard-${randomUUID()}`);
    await stationSync.ingest(fixture.tenantId, fixture.deviceId, fixture.inventoryId, batch);
    await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/complete`)
      .send({ documentsDownloadedAndChecked: true })
      .expect(409, { code: "INVENTORY_LATE_EVENTS_UNRESOLVED", pendingLateEventCount: 1 });
    const [late] = await db
      .select({ id: schema.inventoryLateEvents.id })
      .from(schema.inventoryLateEvents)
      .where(eq(schema.inventoryLateEvents.batchId, batch.batchId));
    if (!late) throw new Error("Expected quarantined batch evidence");
    await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/late-events/discard`)
      .send({ lateEventIds: [late.id], reason: "Проверено, оставить вне результата" })
      .expect(201, { discardedCount: 1 });
    await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/late-events/${late.id}/replay`)
      .send({})
      .expect(409, { code: "INVENTORY_LATE_EVENT_REPLAY_STALE" });
    await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/complete`)
      .send({ documentsDownloadedAndChecked: true })
      .expect(409, { code: "INVENTORY_DOCUMENT_ARTIFACTS_UNAVAILABLE", requiredTask: 8 });
    const [resolved] = await db
      .select({
        resolution: schema.inventoryLateEvents.resolution,
        resolvedBy: schema.inventoryLateEvents.resolvedByUserId,
      })
      .from(schema.inventoryLateEvents)
      .where(eq(schema.inventoryLateEvents.id, late.id));
    expect(resolved).toEqual({ resolution: "discarded", resolvedBy: fixture.userId });
  });

  it("acknowledges a completed late batch only with durable quarantine evidence", async () => {
    const fixture = await seedClosedInventory();
    const completedAt = new Date();
    await db
      .update(schema.inventories)
      .set({
        status: "completed",
        completionAcknowledgedByUserId: fixture.userId,
        completionAcknowledgedAt: completedAt,
        completedByUserId: fixture.userId,
        completedAt,
      })
      .where(
        and(
          eq(schema.inventories.tenantId, fixture.tenantId),
          eq(schema.inventories.id, fixture.inventoryId),
        ),
      );
    const batch = lateBatch(fixture, `completed-${randomUUID()}`);
    const response = await stationSync.ingest(
      fixture.tenantId,
      fixture.deviceId,
      fixture.inventoryId,
      batch,
    );
    expect(response.outcomes).toEqual([
      expect.objectContaining({ status: "quarantined", reasonCode: "INVENTORY_COMPLETED" }),
    ]);
    const rows = await db
      .select({
        reason: schema.inventoryLateEvents.reason,
        closedRevision: schema.inventoryLateEvents.closedRevision,
      })
      .from(schema.inventoryLateEvents)
      .where(
        and(
          eq(schema.inventoryLateEvents.tenantId, fixture.tenantId),
          eq(schema.inventoryLateEvents.inventoryId, fixture.inventoryId),
          eq(schema.inventoryLateEvents.batchId, batch.batchId),
        ),
      );
    expect(rows).toEqual([{ reason: "INVENTORY_COMPLETED", closedRevision: 4 }]);
    const [late] = await db
      .select({ id: schema.inventoryLateEvents.id })
      .from(schema.inventoryLateEvents)
      .where(eq(schema.inventoryLateEvents.batchId, batch.batchId));
    if (!late) throw new Error("Expected completed late event");
    await fixture.agent
      .post(`/inventories/${fixture.inventoryId}/late-events/discard`)
      .send({ lateEventIds: [late.id], reason: "Completed result stays immutable" })
      .expect(409, { code: "INVENTORY_COMPLETED_IMMUTABLE" });
    const [inventory] = await db
      .select({ status: schema.inventories.status })
      .from(schema.inventories)
      .where(eq(schema.inventories.id, fixture.inventoryId));
    expect(inventory?.status).toBe("completed");
    await fixture.agent.post(`/inventories/${fixture.inventoryId}/reopen`).send({}).expect(409, {
      code: "INVENTORY_COMPLETED_IMMUTABLE",
    });
  });
});
