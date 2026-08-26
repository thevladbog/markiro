import { randomUUID } from "node:crypto";

import type { INestApplication } from "@nestjs/common";
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

  function lateBatch(fixture: Awaited<ReturnType<typeof seedClosedInventory>>, batchId: string) {
    const canonical = canonicalizeKm(`01${GTIN}21LATE${batchId.toUpperCase()}`);
    const event: InventoryEvent = {
      eventId: randomUUID(),
      deviceSequence: 1,
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
      sequenceCeiling: 1,
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

  it("reprocesses an exact quarantined batch only after reopen and resolves evidence after actual replay", async () => {
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

    const replayed = await stationSync.ingest(
      fixture.tenantId,
      fixture.deviceId,
      fixture.inventoryId,
      batch,
    );
    expect(replayed.outcomes[0]).toMatchObject({ status: "applied" });
    expect(replayed).not.toEqual(quarantined);
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
    ).resolves.toEqual(replayed);
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
      .post(`/inventories/${fixture.inventoryId}/complete`)
      .send({ documentsDownloadedAndChecked: true })
      .expect(201);
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
